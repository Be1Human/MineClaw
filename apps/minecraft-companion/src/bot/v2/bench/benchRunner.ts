import type { EventBusV2 } from '../infra/eventBus.js';
import type { ActionRequest, BusEvent } from '../types.js';
import type { TestCard } from './cards.js';
import { RunRecorder, type RunSummary, type RunVerdict } from './runRecorder.js';

export interface BenchRunnerDeps {
  bus: EventBusV2;
  recorder: RunRecorder;
  /** Director 的最小摆场命令执行器；真实服可映射到 game.chat。 */
  setup(command: string): Promise<void> | void;
  submitAction(request: ActionRequest): void;
  createTask(kind: string, params: Record<string, unknown>): { id: string };
  startTask(taskId: string): { ok: boolean; reason?: string };
  judge(card: TestCard, events: readonly BusEvent[]): boolean;
}

/** 单次 TestBench 运行器：所有结束路径均由 finish() 统一归档，避免 bench 状态泄漏。 */
export class BenchRunner {
  private current: { card: TestCard; events: BusEvent[]; timer: ReturnType<typeof setTimeout>; unsub: () => void; runId: string } | null = null;

  constructor(private readonly deps: BenchRunnerDeps) {}

  async start(card: TestCard): Promise<RunSummary> {
    if (this.current) throw new Error(`bench already running: ${this.current.card.id}`);
    const runId = `${card.id}-${Date.now()}`;
    const summary = this.deps.recorder.start(runId, card.id);
    const events: BusEvent[] = [];
    const unsub = this.deps.bus.onAny(event => {
      events.push(event);
      if (this.current?.runId === runId && this.deps.judge(card, events)) this.finish({ status: 'pass' });
    });
    const timer = setTimeout(() => this.finish({ status: 'timeout', reason: `timeout:${card.timeoutMs}` }), card.timeoutMs);
    this.current = { card, events, timer, unsub, runId };
    try {
      for (const command of card.setup) await this.deps.setup(command);
      if (card.launch.type === 'action') {
        this.deps.submitAction(toActionRequest(runId, card));
      } else {
        const task = this.deps.createTask(card.launch.kind, card.launch.params);
        const started = this.deps.startTask(task.id);
        if (!started.ok) this.finish({ status: 'fail', reason: started.reason ?? 'task_start_failed' });
      }
      return summary;
    } catch (error) {
      this.finish({ status: 'fail', reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  abort(reason = 'owner_abort'): RunSummary | null { return this.finish({ status: 'aborted', reason }); }
  active(): string | null { return this.current?.card.id ?? null; }

  private finish(verdict: RunVerdict): RunSummary | null {
    const active = this.current;
    if (!active) return null;
    this.current = null;
    clearTimeout(active.timer);
    active.unsub();
    const summary = this.deps.recorder.stop(verdict);
    if (summary && (verdict.status === 'fail' || verdict.status === 'timeout')) {
      // 归档是诊断旁路，写盘异常不能破坏运行态清理或掩盖原始 verdict。
      try { this.deps.recorder.archiveFailure(summary, active.card); } catch {}
    }
    return summary;
  }
}

function toActionRequest(runId: string, card: TestCard): ActionRequest {
  if (card.launch.type !== 'action') throw new Error('expected action card');
  const action = card.launch;
  return {
    id: `bench-${runId}`, source: `bench:${card.id}`, type: action.action as ActionRequest['type'],
    priority: 55, interrupt_level: 'hard', resource: action.action === 'move_to' ? ['movement'] : [],
    target: action.args as ActionRequest['target'], preconditions: [], timeout_ms: card.timeoutMs,
  };
}
