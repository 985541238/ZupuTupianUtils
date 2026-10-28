import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Task } from './task.entity';
import { TaskImage } from './task-image.entity';
import { PushConfig, SettingsService } from '../settings/settings.service';
import { buildPayload, signedImageUrl, SCHEMA_VERSION } from './payload';

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(TaskImage) private readonly pages: Repository<TaskImage>,
    private readonly settings: SettingsService,
  ) {}

  /** 推送已通过的页；pageIds 为空 = 本书全部已通过的页。立即返回，后台发送。 */
  async start(userId: number, taskId: number, pageIds?: number[]) {
    const task = await this.tasks.findOne({ where: { id: taskId, userId } });
    if (!task) throw new BadRequestException('任务不存在');
    if (task.pushStatus === 'pushing') throw new ConflictException('正在推送，请等这次推送结束');
    const cfg = await this.settings.getPush();
    if (!cfg.url) throw new BadRequestException('还没有配置推送地址，请先到「配置」页填写');
    const where: any = { taskId, status: 'approved' };
    if (pageIds?.length) where.id = In(pageIds.map(Number));
    const count = await this.pages.count({ where });
    if (!count) throw new BadRequestException('没有已通过的页可以推送，请先在预览审核里点「通过」');
    // 先占住状态，防止重复点击
    const r = await this.tasks.update({ id: taskId, pushStatus: task.pushStatus }, { pushStatus: 'pushing', pushMessage: `正在推送 ${count} 页…` });
    if (!r.affected) throw new ConflictException('正在推送，请等这次推送结束');
    void this.run(taskId, pageIds, cfg).catch(async (e) => {
      this.logger.error(`推送出错 task=${taskId}: ${e}`);
      await this.tasks.update(taskId, { pushStatus: 'failed', pushMessage: '推送出错：' + (e?.message || e) });
    });
    return { ok: true, count };
  }

  private async run(taskId: number, pageIds: number[] | undefined, cfg: PushConfig) {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) return;
    const all = await this.pages.find({ where: { taskId }, order: { sortOrder: 'ASC', id: 'ASC' } });
    const pageNos = new Map<number, number>(all.map((p: TaskImage, i: number) => [Number(p.id), i + 1] as [number, number]));
    const selected = all.filter((p) => p.status === 'approved' && (!pageIds?.length || pageIds.map(Number).includes(Number(p.id))));
    const img = (p: TaskImage) => signedImageUrl(cfg.publicBaseUrl, Number(p.id));

    let ok = 0;
    let fail = 0;
    let lastError = '';
    const batches = cfg.mode === 'page' ? selected.map((p) => [p]) : [selected];
    for (const batch of batches) {
      const payload = buildPayload(task, batch, pageNos, img);
      const idKey = cfg.mode === 'page' ? `${taskId}-${batch[0].id}` : `${taskId}-all`;
      const res = await this.send(cfg, payload, idKey);
      const now = new Date();
      if (res.ok) {
        ok += batch.length;
        await this.pages.update({ id: In(batch.map((p) => p.id)) }, { pushStatus: 'success', pushError: null, pushedAt: now });
      } else {
        fail += batch.length;
        lastError = res.error;
        await this.pages.update({ id: In(batch.map((p) => p.id)) }, { pushStatus: 'failed', pushError: res.error });
      }
      if (cfg.mode === 'page') {
        await this.tasks.update(taskId, { pushMessage: `正在推送… 成功 ${ok} 页，失败 ${fail} 页` });
      }
    }
    const status = fail === 0 ? 'success' : ok === 0 ? 'failed' : 'partial';
    const msg =
      status === 'success'
        ? `已推送 ${ok} 页`
        : status === 'partial'
          ? `成功 ${ok} 页，失败 ${fail} 页：${lastError}`
          : `推送失败：${lastError}`;
    await this.tasks.update(taskId, { pushStatus: status, pushMessage: msg.slice(0, 1000), pushedAt: ok ? new Date() : task.pushedAt });
  }

  /** 发送一次，失败按配置重试，间隔 2、5、10… 秒 */
  private async send(cfg: PushConfig, payload: any, idKey: string): Promise<{ ok: boolean; error: string }> {
    const waits = [2000, 5000, 10000, 20000, 30000];
    let error = '';
    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, waits[Math.min(attempt - 1, waits.length - 1)]));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutSec * 1000);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Zupu-Schema': SCHEMA_VERSION,
          'X-Zupu-Push-Id': idKey,
        };
        for (const h of cfg.headers) headers[h.name] = h.value;
        const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
        if (res.ok) return { ok: true, error: '' };
        let body = '';
        try {
          body = (await res.text()).slice(0, 200);
        } catch {}
        error = `HTTP ${res.status}${body ? '：' + body : ''}`;
        // 4xx（除了 408/429）是数据或鉴权问题，重试也没用
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
      } catch (e: any) {
        error = e?.name === 'AbortError' ? `超时（>${cfg.timeoutSec} 秒）` : '连接失败：' + (e?.cause?.message || e?.message || e);
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error };
  }

  /** 配置页「测试推送」：发一条样例数据 */
  async testPush() {
    const cfg = await this.settings.getPush();
    if (!cfg.url) return { ok: false, error: '请先填写推送地址并保存' };
    const sample = {
      schema_version: SCHEMA_VERSION,
      test: true,
      task_id: 'test',
      book_title: '测试谱书',
      surname: '测',
      remark: '这是一条测试数据，请忽略',
      generated_at: new Date().toISOString(),
      page_count: 1,
      pages: [
        {
          page_id: 'test-1',
          page_no: 1,
          file_name: 'test.jpg',
          side: null,
          image_url: null,
          text: '測試',
          columns: ['測試'],
          uncertain_chars: [],
          edited_by_human: false,
          approved: true,
        },
      ],
    };
    const t = Date.now();
    const res = await this.send({ ...cfg, retries: 0 }, sample, 'test');
    return { ok: res.ok, error: res.error, ms: Date.now() - t };
  }
}
