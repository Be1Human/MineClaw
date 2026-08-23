export type BrainNoticeStatus = 'info' | 'progress' | 'success' | 'fail' | 'cancelled';

export interface BrainNoticeInput {
  source: string;
  topic: string;
  label: string;
  detail?: string;
  status?: BrainNoticeStatus;
  wake?: boolean;
  dedupeKey?: string;
}

export interface BrainNotice extends BrainNoticeInput {
  id: string;
  createdAt: number;
  generation: number;
}

/** Bounded, deduplicated fact inbox consumed only by MainBrain turns. */
export class BrainNoticeInbox {
  private queue: BrainNotice[] = [];
  private readonly seen = new Map<string, number>();
  private seq = 0;
  private generation = 0;

  constructor(private readonly maxSize = 200) {}

  submit(input: BrainNoticeInput): BrainNotice | null {
    const now = Date.now();
    this.pruneSeen(now);
    if (input.dedupeKey && this.seen.has(input.dedupeKey)) return null;

    const notice: BrainNotice = {
      ...input,
      detail: input.detail?.trim() ?? '',
      status: input.status ?? 'info',
      wake: input.wake ?? false,
      id: `notice-${++this.seq}-${now}`,
      createdAt: now,
      generation: this.generation,
    };
    this.queue.push(notice);
    if (this.queue.length > this.maxSize) this.queue.shift();
    if (input.dedupeKey) this.seen.set(input.dedupeKey, now);
    return notice;
  }

  size(): number {
    return this.queue.length;
  }

  peek(): BrainNotice[] {
    return this.queue;
  }

  hasWakeNotice(): boolean {
    return this.queue.some(notice => notice.wake);
  }

  drain(): BrainNotice[] {
    const batch = this.queue;
    this.queue = [];
    return batch;
  }

  requeueFront(batch: BrainNotice[]): void {
    const currentGeneration = this.generation;
    const valid = batch.filter(notice => notice.generation === currentGeneration);
    if (valid.length > 0) this.queue = [...valid, ...this.queue].slice(-this.maxSize);
  }

  clear(): void {
    this.generation += 1;
    this.queue = [];
  }

  private pruneSeen(now: number): void {
    const ttl = 10 * 60_000;
    for (const [key, at] of this.seen) {
      if (now - at > ttl) this.seen.delete(key);
    }
    while (this.seen.size > this.maxSize * 4) {
      const first = this.seen.keys().next().value as string | undefined;
      if (!first) break;
      this.seen.delete(first);
    }
  }
}
