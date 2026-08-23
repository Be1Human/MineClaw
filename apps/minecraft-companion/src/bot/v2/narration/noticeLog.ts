/**
 * FEAT-NARR-01 · NoticeLog · 事件通知环形日志
 *
 * 记录中枢实际发出的中性通知；每个 agent loop 把近期通知注入大模型上下文，
 * 让大模型（唯一人格）知道自驱系统刚做/遇到了什么，回答时可自然带出。
 */

export interface NoticeEntry {
  ts: number;
  source: string;
  topic: string;
  text: string;
}

export class NoticeLog {
  private readonly buf: NoticeEntry[] = [];
  private readonly max: number;

  constructor(max = 30) {
    this.max = max;
  }

  record(e: NoticeEntry): void {
    this.buf.push(e);
    if (this.buf.length > this.max) this.buf.shift();
  }

  /** 近期通知 · 可选时间窗 + 条数上限 · 用于注入 LLM 上下文 */
  recent(opts?: { limit?: number; now?: number; windowMs?: number }): NoticeEntry[] {
    let list = this.buf;
    if (opts?.windowMs !== undefined && opts.now !== undefined) {
      const from = opts.now - opts.windowMs;
      list = list.filter((e) => e.ts >= from);
    }
    const limit = opts?.limit ?? 10;
    return list.slice(-limit);
  }

  size(): number {
    return this.buf.length;
  }
}
