import type { TuningConfig } from './tuning.js';
import {
  ChatMemoryConsolidator,
  type MemoryConsolidationRunConfig,
  type MemoryConsolidationRunResult,
} from './chatMemoryConsolidation.js';

type ConsolidationTuning = TuningConfig['memoryConsolidation'];

export interface MemoryConsolidationSchedulerOptions {
  getConfig: () => ConsolidationTuning;
  log?: (message: string) => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface MemoryConsolidationSchedulerStatus {
  running: boolean;
  inFlight: boolean;
  lastResult?: MemoryConsolidationRunResult;
}

export class MemoryConsolidationScheduler {
  private timer: unknown;
  private running = false;
  private generation = 0;
  private abortController: AbortController | null = null;
  private inFlight: Promise<MemoryConsolidationRunResult> | null = null;
  private lastResult: MemoryConsolidationRunResult | undefined;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(
    private readonly consolidator: ChatMemoryConsolidator,
    private readonly options: MemoryConsolidationSchedulerOptions,
  ) {
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.scheduleNext();
  }

  stop(): void {
    if (!this.running && !this.inFlight) return;
    this.running = false;
    this.generation += 1;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.abortController?.abort('memory_consolidation_scheduler_stopped');
    this.abortController = null;
  }

  status(): MemoryConsolidationSchedulerStatus {
    return {
      running: this.running,
      inFlight: this.inFlight !== null,
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
    };
  }

  /** 测试和显式运维入口；仍受 enabled、单飞与停止门约束。 */
  runNow(): Promise<MemoryConsolidationRunResult> {
    if (!this.running) return Promise.resolve(emptySchedulerResult('idle'));
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const config = this.options.getConfig();
    if (!config.enabled) return Promise.resolve(emptySchedulerResult('idle'));
    const abortController = new AbortController();
    this.abortController = abortController;
    const promise = this.consolidator.runOnce(
      runConfig(config),
      abortController.signal,
      () => this.running && this.generation === generation && !abortController.signal.aborted,
    ).then(result => {
      this.lastResult = result;
      if (result.status === 'committed') {
        this.options.log?.(`周期记忆整理完成：${result.processed} 条消息，${result.added + result.replaced + result.reinforced} 条事实变更`);
      } else if (result.status === 'retry') {
        this.options.log?.(`周期记忆整理保留待重试：${result.error ?? 'unknown'}`);
      }
      return result;
    }).finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
      if (this.abortController === abortController) this.abortController = null;
    });
    this.inFlight = promise;
    return promise;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const intervalMs = Math.max(1, Math.floor(this.options.getConfig().intervalMs));
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.runNow().finally(() => this.scheduleNext());
    }, intervalMs);
    (this.timer as { unref?: () => void } | undefined)?.unref?.();
  }
}

function runConfig(config: ConsolidationTuning): MemoryConsolidationRunConfig {
  return {
    batchMessages: config.batchSize,
    batchChars: config.maxBatchChars,
    activeFactLimit: config.activeFactLimit,
    maxOperations: config.maxOperationsPerBatch,
    timeoutMs: config.requestTimeoutMs,
  };
}

function emptySchedulerResult(status: MemoryConsolidationRunResult['status']): MemoryConsolidationRunResult {
  return { status, processed: 0, added: 0, reinforced: 0, replaced: 0, candidates: 0, ignored: 0 };
}
