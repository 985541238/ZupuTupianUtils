import { Task } from './task.entity';
import { TaskImage } from './task-image.entity';
import { pageText, readOcr } from './ocr-utils';
import { signPath } from '../common/secret';

export const SCHEMA_VERSION = '1.0';

/** 第三方取图链接，30 天有效；没配置对外地址时返回 null */
export function signedImageUrl(publicBaseUrl: string, pageId: number): string | null {
  if (!publicBaseUrl) return null;
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const sig = signPath(`pages/${pageId}`, exp);
  return `${publicBaseUrl}/public/pages/${pageId}/image?exp=${exp}&sig=${sig}`;
}

/**
 * 推送协议 v1（导出 JSON 用同一格式）。只加字段不改字段；升级时 schema_version 变化。
 * pageNos: 页 id → 在整本书里的页序号（从 1 开始）
 */
export function buildPayload(
  task: Task,
  pages: TaskImage[],
  pageNos: Map<number, number>,
  imageUrl: (p: TaskImage) => string | null,
) {
  return {
    schema_version: SCHEMA_VERSION,
    task_id: String(task.id),
    book_title: task.name,
    surname: task.surname,
    remark: task.remark || '',
    generated_at: new Date().toISOString(),
    page_count: pages.length,
    pages: pages.map((p) => {
      const ocr = readOcr(p.ocrJson);
      return {
        page_id: String(p.id),
        page_no: pageNos.get(Number(p.id)) ?? null,
        file_name: p.fileName,
        side: p.side === 'R' ? 'right' : p.side === 'L' ? 'left' : null,
        image_url: imageUrl(p),
        text: pageText(ocr),
        columns: ocr.columns.map((c) => c.text),
        uncertain_chars: ocr.uncertain.map((u) => ({
          column: u.col,
          index: u.index,
          char: u.char,
          candidates: u.candidates || [],
        })),
        edited_by_human: !!p.edited,
        approved: p.status === 'approved',
      };
    }),
  };
}
