import type { BusEvent } from '../../types.js';
import type { EventBusV2 } from '../../infra/eventBus.js';
import { ExecutionFactLog, type ExecutionFactContext } from './executionFactLog.js';
import { failureFromLegacy, type FailureEnvelope } from './failureEnvelope.js';

interface TaskFactView {
  id: string;
  kind: string;
  parentId?: string;
  params: Record<string, unknown>;
  feedbackRootId?: string;
}

export interface TaskFactLookup {
  getById(taskId: string): TaskFactView | null;
}

interface OpenSession {
  context: ExecutionFactContext;
  startedAt: number;
}

/**
 * Transitional, one-way adapter from the legacy TaskRuntime terminal bus to
 * execution.* facts. It observes only top-level goal_exec tasks and never
 * changes task state, retries an action, or controls execution.
 */
export class TaskRuntimeFactBridge {
  private readonly sessions = new Map<string, OpenSession>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    bus: EventBusV2,
    private readonly tasks: TaskFactLookup,
    private readonly facts: ExecutionFactLog,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.unsubscribe.push(
      bus.on('task.started', event => this.onStarted(event)),
      bus.on('task.completed', event => this.onTerminal(event, 'succeeded')),
      bus.on('task.failed', event => this.onTerminal(event, 'failed')),
      bus.on('task.cancelled', event => this.onTerminal(event, 'cancelled')),
      bus.on('goalagent.tool_call', event => this.onGoalAgentToolCall(event)),
      bus.on('goalagent.trace', event => this.onGoalAgentTrace(event)),
    );
  }

  close(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.sessions.clear();
  }

  private onStarted(event: BusEvent): void {
    const payload = asRecord(event.payload);
    const taskId = stringValue(payload.taskId);
    if (!taskId || this.sessions.has(taskId)) return;
    const task = this.tasks.getById(taskId);
    if (!task || task.kind !== 'goal_exec' || task.parentId) return;

    const correlationId = task.feedbackRootId || taskId;
    const plannerContext = asRecord(task.params.plannerContext);
    const planRunId = stringValue(plannerContext.planRunId) || taskId;
    const nodeId = stringValue(plannerContext.nodeId) || taskId;
    const planRevision = positiveInteger(plannerContext.planRevision) ?? 1;
    const context: ExecutionFactContext = {
      sessionId: taskId,
      runId: taskId,
      planRunId,
      planRevision,
      nodeId,
      correlationId,
    };
    this.sessions.set(taskId, { context, startedAt: this.now() });
    if (planRunId !== taskId) {
      this.facts.append(context, 'execution.plan.bound', {
        parentGoalText: stringValue(plannerContext.parentGoalText),
        policySnapshotId: stringValue(plannerContext.policySnapshotId) || null,
        experienceMode: stringValue(plannerContext.experienceMode) || null,
        planGraph: isRecord(plannerContext.planGraph) ? plannerContext.planGraph : null,
        source: 'production_planner_gateway',
        evidenceRefs: [event.id],
      });
    }
    this.facts.append(context, 'execution.session.started', {
      goalText: stringValue(task.params.goalText) || task.kind,
      parentGoalText: stringValue(plannerContext.parentGoalText) || null,
      policySnapshotId: stringValue(plannerContext.policySnapshotId) || null,
      taskKind: task.kind,
      source: 'task_runtime_fact_bridge',
      evidenceRefs: [event.id],
    });
    this.facts.append(context, 'execution.state.changed', {
      from: 'accepted',
      to: 'executing',
      source: 'task_runtime_fact_bridge',
    });
  }

  private onTerminal(event: BusEvent, outcome: 'succeeded' | 'failed' | 'cancelled'): void {
    const payload = asRecord(event.payload);
    const taskId = stringValue(payload.taskId);
    if (!taskId) return;
    const session = this.sessions.get(taskId);
    if (!session) return;

    const detail = stringValue(payload.detail) || stringValue(payload.reason)
      || (outcome === 'succeeded' ? 'task runtime postcondition accepted' : outcome);
    const failure = outcome === 'succeeded' ? undefined : failureFromTaskPayload(payload, detail);
    if (failure) failure.evidenceRefs = [event.id];
    this.facts.append(session.context, 'execution.session.terminal', {
      outcome,
      handoff: outcome === 'failed' ? 'graph_replan_required' : 'none',
      verdict: {
        ok: outcome === 'succeeded',
        detail,
        evidenceRefs: [event.id],
      },
      ...(failure ? { failure } : {}),
      elapsedMs: Math.max(0, this.now() - session.startedAt),
      source: 'task_runtime_fact_bridge',
    });
    this.sessions.delete(taskId);
  }

  private onGoalAgentToolCall(event: BusEvent): void {
    const session = this.onlyOpenSession();
    if (!session) return;
    const payload = asRecord(event.payload);
    const action = stringValue(payload.tool);
    if (!action) return;
    this.facts.append(session.context, 'execution.action.proposed', {
      proposal: {
        action,
        args: asRecord(payload.input),
      },
      llmRound: positiveInteger(payload.round),
      source: 'goalagent_trace_bridge',
      evidenceRefs: [event.id],
    });
  }

  private onGoalAgentTrace(event: BusEvent): void {
    const session = this.onlyOpenSession();
    if (!session) return;
    const payload = asRecord(event.payload);
    this.facts.append(session.context, 'execution.progress.observed', {
      progress: {
        outcome: stringValue(payload.outcome) || 'unknown',
        llmRounds: positiveInteger(payload.rounds) ?? 0,
        recoveryAttempts: positiveInteger(payload.attempt) ?? 0,
      },
      source: 'goalagent_trace_bridge',
      evidenceRefs: [event.id],
    });
  }

  private onlyOpenSession(): OpenSession | null {
    if (this.sessions.size !== 1) return null;
    return this.sessions.values().next().value ?? null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function failureFromTaskPayload(payload: Record<string, unknown>, detail: string): FailureEnvelope {
  const code = stringValue(payload.code);
  if (/need_owner|ask_master/i.test(`${code} ${detail}`)) {
    return {
      code: 'decision.need_owner',
      origin: 'decision',
      stage: 'deciding',
      category: 'precondition',
      retryable: true,
      ownerActionable: false,
      evidenceRefs: [],
      detail,
    };
  }
  return failureFromLegacy([code, detail].filter(Boolean).join(': '));
}
