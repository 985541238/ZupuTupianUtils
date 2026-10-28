import { Injectable } from '@nestjs/common';

/** 业务层通知后台处理器的小信号板，避免两个服务互相依赖 */
@Injectable()
export class WorkerSignal {
  private kickFn: () => void = () => {};
  private thumbFn: (pageId: number) => void = () => {};
  private readonly preparing = new Set<number>();

  onKick(fn: () => void) {
    this.kickFn = fn;
  }

  onThumb(fn: (pageId: number) => void) {
    this.thumbFn = fn;
  }

  kick() {
    setImmediate(() => this.kickFn());
  }

  thumb(pageId: number) {
    setImmediate(() => this.thumbFn(Number(pageId)));
  }

  pausing(_taskId: number) {
    this.kick();
  }

  setPreparing(taskId: number, on: boolean) {
    if (on) this.preparing.add(Number(taskId));
    else this.preparing.delete(Number(taskId));
  }

  isPreparing(taskId: number) {
    return this.preparing.has(Number(taskId));
  }
}
