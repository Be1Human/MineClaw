/**
 * 🔄 基础设施 · AsyncTaskQueue
 *
 * 将耗时异步任务（如 LLM 调用）解耦出 tick 主循环：
 *   - enqueue(taskFn)   · 立即开始跑（并发），结果写入内部数组
 *   - drainResults()    · Heartbeat ② DrainEvents 时取走已完成的结果并清空
 *
 * 并发数上限 maxConcurrent（默认 4）· 超过则排队等待空位。
 */

export interface TaskResult {
  result?: unknown;
  error?: unknown;
}

export class AsyncTaskQueueClosedError extends Error {
  constructor() {
    super('AsyncTaskQueue is closed');
    this.name = 'AsyncTaskQueueClosedError';
  }
}

export class AsyncTaskQueue {
  private readonly maxConcurrent: number;
  private running = 0;
  private queue: Array<() => Promise<unknown>> = [];
  private completed: TaskResult[] = [];
  private closed = false;

  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
  }

  /** 提交一个异步任务 · 立即开始（有空位）或入队等待 */
  enqueue(taskFn: () => Promise<unknown>): void {
    if (this.closed) throw new AsyncTaskQueueClosedError();
    if (this.running < this.maxConcurrent) {
      this.startTask(taskFn);
    } else {
      this.queue.push(taskFn);
    }
  }

  /** 取走本 tick 已完成的所有结果（同时清空内部缓冲） */
  drainResults(): TaskResult[] {
    const results = this.completed;
    this.completed = [];
    return results;
  }

  /** 当前正在跑的任务数 */
  get activeCount(): number {
    return this.running;
  }

  /** 队列中等待的任务数 */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Runtime 终止时关闭队列；active task 由其所有者的 AbortController 取消。 */
  close(options: { dropPending?: boolean } = {}): void {
    if (this.closed) return;
    this.closed = true;
    if (options.dropPending !== false) this.queue = [];
    // Runtime 已停止，不再需要 Heartbeat 消费已完成结果。
    this.completed = [];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ── private ─────────────────────────────────────────────────────

  private startTask(taskFn: () => Promise<unknown>): void {
    this.running += 1;
    taskFn()
      .then(result => {
        if (!this.closed) this.completed.push({ result });
      })
      .catch((error: unknown) => {
        if (!this.closed) this.completed.push({ error });
      })
      .finally(() => {
        this.running -= 1;
        if (this.closed) return;
        // 有排队任务 · 取出一个启动
        const next = this.queue.shift();
        if (next) this.startTask(next);
      });
  }
}
