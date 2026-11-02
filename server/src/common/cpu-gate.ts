/**
 * 图片处理（Python 子进程）的全局闸门：
 * - 总并发 = PY_CONCURRENCY（默认 = CPU 核数，最少 1）
 * - 批量处理最多占 总并发-1 路（至少 1 路），始终给用户点开审阅的预览留一个空位
 * - 预览优先于批量排队
 * 两核机器上还跑着别的服务时，可在 .env 里设 PY_CONCURRENCY=1 进一步压低。
 */
import * as os from 'os';

type Kind = 'interactive' | 'batch';
type Waiter = { kind: Kind; grant: () => void };

class CpuGate {
  private running = 0;
  private runningBatch = 0;
  private waiters: Waiter[] = [];

  private get total() {
    const n = Number(process.env.PY_CONCURRENCY);
    return n > 0 ? Math.floor(n) : Math.max(1, os.cpus().length);
  }
  private get batchMax() {
    return Math.max(1, this.total - 1);
  }
  private canRun(kind: Kind) {
    if (this.running >= this.total) return false;
    if (kind === 'batch' && this.runningBatch >= this.batchMax) return false;
    return true;
  }
  private take(kind: Kind) {
    this.running++;
    if (kind === 'batch') this.runningBatch++;
  }

  /** 拿到名额后返回释放函数；务必在 finally 里调用 */
  acquire(kind: Kind): Promise<() => void> {
    return new Promise((resolve) => {
      const make = () => {
        let done = false;
        return () => {
          if (done) return;
          done = true;
          this.running--;
          if (kind === 'batch') this.runningBatch--;
          this.pump();
        };
      };
      if (this.waiters.length === 0 && this.canRun(kind)) {
        this.take(kind);
        resolve(make());
        return;
      }
      this.waiters.push({
        kind,
        grant: () => {
          this.take(kind);
          resolve(make());
        },
      });
      this.pump();
    });
  }

  private pump() {
    // 预览优先，其次按先来后到
    for (const want of ['interactive', 'batch'] as Kind[]) {
      for (let i = 0; i < this.waiters.length; ) {
        const w = this.waiters[i];
        if (w.kind === want && this.canRun(w.kind)) {
          this.waiters.splice(i, 1);
          w.grant();
        } else {
          i++;
        }
      }
    }
  }

  stats() {
    return { running: this.running, runningBatch: this.runningBatch, waiting: this.waiters.length };
  }
}

export const cpuGate = new CpuGate();
