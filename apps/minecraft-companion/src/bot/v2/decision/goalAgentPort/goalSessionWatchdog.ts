import { randomUUID } from 'node:crypto';
import type {
  GoalContinuationV2,
  GoalEvidenceV2,
  GoalInteractionMetaV2,
  GoalMessageReceiptV2,
  GoalReportV2,
  GoalRequestV2,
  GoalStatusProbeV2,
  GoalStatusSnapshotV2,
  InteractionSessionV2,
} from './contracts.js';

export interface GoalStatusInspector {
  inspect(probe: GoalStatusProbeV2): Promise<GoalStatusSnapshotV2> | GoalStatusSnapshotV2;
}

export interface RuntimeGoalStatusInspectorDeps {
  goalRuntime: {
    status(): { state: string; sessionId: string | null; running: string | null; remaining: number };
  };
  getExecutionSession?: (sessionId: string) => {
    id: string;
    state: string;
    updatedAt?: number;
    pendingOwnerQuestion?: string;
    terminal?: {
      verdict?: { detail?: string; evidenceRefs?: string[] };
      failure?: { code?: string; detail?: string; evidenceRefs?: string[] };
    };
  } | undefined;
  inspectBehavior?: (probe: GoalStatusProbeV2) => StatusProjection | undefined;
  inspectTask?: (probe: GoalStatusProbeV2) => StatusProjection | undefined;
  now?: () => number;
}

type StatusProjection = Partial<GoalStatusSnapshotV2> & Pick<GoalStatusSnapshotV2, 'state'>;

/** Deterministic status projection over runtime state. This path never invokes an LLM. */
export class RuntimeGoalStatusInspector implements GoalStatusInspector {
  private readonly now: () => number;

  constructor(private readonly deps: RuntimeGoalStatusInspectorDeps) {
    this.now = deps.now ?? Date.now;
  }

  inspect(probe: GoalStatusProbeV2): GoalStatusSnapshotV2 {
    const runtime = this.deps.goalRuntime.status();
    const execution = runtime.sessionId ? this.deps.getExecutionSession?.(runtime.sessionId) : undefined;
    if (execution) return this.fromExecution(probe, execution);

    const behavior = this.deps.inspectBehavior?.(probe);
    if (behavior) return this.complete(probe, behavior);
    const task = this.deps.inspectTask?.(probe);
    if (task) return this.complete(probe, task);

    if (runtime.state === 'paused') {
      return this.complete(probe, {
        state: 'blocked',
        stage: 'goalagent_paused',
        blocker: runtime.running ?? 'GoalAgent paused',
        runtimeRef: runtime.sessionId ? `goalagent:${runtime.sessionId}` : 'goalagent',
      });
    }
    if (runtime.state === 'running') {
      return this.complete(probe, {
        state: 'executing',
        stage: runtime.running ?? 'goalagent_running',
        runtimeRef: runtime.sessionId ? `goalagent:${runtime.sessionId}` : 'goalagent',
      });
    }
    if (runtime.remaining > 0) {
      return this.complete(probe, { state: 'queued', stage: 'goalagent', runtimeRef: 'goalagent' });
    }
    return this.complete(probe, { state: 'unknown', stage: 'runtime_not_observable' });
  }

  private fromExecution(
    probe: GoalStatusProbeV2,
    execution: NonNullable<ReturnType<NonNullable<RuntimeGoalStatusInspectorDeps['getExecutionSession']>>>,
  ): GoalStatusSnapshotV2 {
    const evidenceRefs = execution.terminal?.verdict?.evidenceRefs ??
      execution.terminal?.failure?.evidenceRefs ?? [];
    const observedAt = new Date(this.now()).toISOString();
    const evidence: GoalEvidenceV2[] = evidenceRefs.map(ref => ({
      type: 'root_verdict', ref, observedAt,
    }));
    const state = executionState(execution.state);
    const blocker = execution.pendingOwnerQuestion ?? execution.terminal?.failure?.detail ??
      execution.terminal?.failure?.code ?? execution.terminal?.verdict?.detail;
    return this.complete(probe, {
      state,
      stage: execution.state,
      ...(typeof execution.updatedAt === 'number'
        ? { lastProgressAt: new Date(execution.updatedAt).toISOString() }
        : {}),
      ...(blocker && (state === 'blocked' || state === 'failed') ? { blocker } : {}),
      runtimeRef: `execution:${execution.id}`,
      evidence,
    });
  }

  private complete(
    probe: GoalStatusProbeV2,
    value: StatusProjection,
  ): GoalStatusSnapshotV2 {
    return {
      sessionId: probe.sessionId,
      requestId: probe.requestId,
      state: value.state,
      ...(value.stage ? { stage: value.stage } : {}),
      ...(value.lastProgressAt ? { lastProgressAt: value.lastProgressAt } : {}),
      ...(value.blocker ? { blocker: value.blocker } : {}),
      ...(value.nextAction ? { nextAction: value.nextAction } : {}),
      ...(value.runtimeRef ? { runtimeRef: value.runtimeRef } : {}),
      evidence: value.evidence ?? [],
      observedAt: value.observedAt ?? new Date(this.now()).toISOString(),
    };
  }
}

export interface GoalSessionWatchdogConfig {
  receiptDeadlineMs: number;
  firstReportDeadlineMs: number;
  plannedSilenceMs: number;
  persistentSilenceMs: number;
  probeTimeoutMs: number;
  maxProbeRetries: number;
  visibleProgressIntervalMs: number;
  sessionTtlMs: number;
}

export interface GoalSessionWatchdogDeps {
  inspector: GoalStatusInspector;
  getSession: (sessionId: string) => InteractionSessionV2 | undefined;
  expireSession?: (sessionId: string) => InteractionSessionV2 | undefined;
  nextMessageMeta: (requestId: string, messageId: string, suffix: string) => GoalInteractionMetaV2 | undefined;
  onContinuation?: (continuation: GoalContinuationV2) => void;
  isPersistentRequest?: (request: GoalRequestV2) => boolean;
  onSnapshot?: (observation: GoalWatchdogSnapshotObservation) => void | Promise<void>;
  now?: () => number;
  config?: Partial<GoalSessionWatchdogConfig>;
}

export interface GoalWatchdogSnapshotObservation {
  request: GoalRequestV2;
  probe: GoalStatusProbeV2;
  snapshot: GoalStatusSnapshotV2;
  previousSnapshot: GoalStatusSnapshotV2 | null;
}

type WatchRecord = {
  request: GoalRequestV2;
  requestedAt: number;
  receiptAt?: number;
  lastReportAt?: number;
  lastReportStatus?: GoalReportV2['status'];
  firstReportProbed: boolean;
  lastProbeAt?: number;
  lastSnapshotKey?: string;
  lastSnapshot?: GoalStatusSnapshotV2;
  lastVisibleAt?: number;
  active: boolean;
};

const DEFAULT_CONFIG: GoalSessionWatchdogConfig = {
  receiptDeadlineMs: 3_000,
  firstReportDeadlineMs: 10_000,
  plannedSilenceMs: 30_000,
  persistentSilenceMs: 15_000,
  probeTimeoutMs: 5_000,
  maxProbeRetries: 1,
  visibleProgressIntervalMs: 30_000,
  sessionTtlMs: 15 * 60_000,
};

/** Tracks protocol deadlines and projects runtime truth without changing execution state. */
export class GoalSessionWatchdog {
  private readonly records = new Map<string, WatchRecord>();
  private readonly now: () => number;
  private readonly config: GoalSessionWatchdogConfig;

  constructor(private readonly deps: GoalSessionWatchdogDeps) {
    this.now = deps.now ?? Date.now;
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
  }

  trackRequest(request: GoalRequestV2): void {
    this.records.set(request.meta.messageId, {
      request,
      requestedAt: Date.parse(request.meta.emittedAt) || this.now(),
      firstReportProbed: false,
      active: true,
    });
  }

  recordReceipt(receipt: GoalMessageReceiptV2): void {
    const record = this.records.get(receipt.sourceMessageId);
    if (!record) return;
    record.receiptAt = Date.parse(receipt.meta.emittedAt) || this.now();
    if (receipt.outcome === 'failed' || receipt.outcome === 'ignored') record.active = false;
  }

  recordReport(report: Pick<GoalReportV2, 'requestId' | 'status'> & { meta?: GoalInteractionMetaV2 }): void {
    const record = this.records.get(report.requestId);
    if (!record) return;
    record.lastReportAt = this.now();
    record.lastReportStatus = report.status;
    if (isTerminalReport(report.status)) record.active = false;
  }

  async tick(): Promise<GoalContinuationV2[]> {
    const out: GoalContinuationV2[] = [];
    const now = this.now();
    for (const record of this.records.values()) {
      if (!record.active) continue;
      const declaredExpiry = record.request.meta.expiresAt
        ? Date.parse(record.request.meta.expiresAt)
        : Number.POSITIVE_INFINITY;
      const expiresAt = Math.min(declaredExpiry, record.requestedAt + this.config.sessionTtlMs);
      if (expiresAt <= now) {
        this.deps.expireSession?.(record.request.meta.sessionId);
        const continuation = this.sessionExpired(record);
        if (continuation) out.push(continuation);
        record.active = false;
        continue;
      }
      if (record.receiptAt === undefined) {
        if (now - record.requestedAt >= this.config.receiptDeadlineMs) {
          const continuation = this.receiptTimeout(record);
          if (continuation) out.push(continuation);
          record.active = false;
        }
        continue;
      }
      if (!record.lastReportAt && !record.firstReportProbed &&
          now - record.receiptAt >= this.config.firstReportDeadlineMs) {
        record.firstReportProbed = true;
        const continuation = await this.probe(record, 'first_report_due', false);
        if (continuation) out.push(continuation);
        continue;
      }
      if (record.lastReportStatus === 'running' && record.lastReportAt) {
        const silenceMs = this.deps.isPersistentRequest?.(record.request)
          ? this.config.persistentSilenceMs
          : this.config.plannedSilenceMs;
        const baseline = Math.max(record.lastReportAt, record.lastProbeAt ?? 0);
        if (now - baseline >= silenceMs) {
          const continuation = await this.probe(record, 'silence_due', false);
          if (continuation) out.push(continuation);
        }
      }
    }
    return out;
  }

  async queryStatus(sessionId?: string): Promise<GoalContinuationV2 | null> {
    const record = sessionId
      ? [...this.records.values()].filter(item => item.request.meta.sessionId === sessionId && item.active)
          .sort((a, b) => b.requestedAt - a.requestedAt)[0]
      : [...this.records.values()].filter(item => item.active && item.request.origin === 'player_message')
          .sort((a, b) => b.requestedAt - a.requestedAt)[0];
    return record ? this.probe(record, 'user_requested', true) : null;
  }

  /**
   * MainBrain 工具链仍是同步调用，因此在 Inspector 同步可用时直接返回 fresh snapshot。
   * 异步 Inspector 不在这里阻塞；自动 watchdog/queryStatus 仍负责完整超时与重试语义。
   */
  inspectCurrentStatus(sessionId?: string): GoalStatusSnapshotV2 | null {
    const record = this.latestRecord(sessionId);
    if (!record) return null;
    const probe: GoalStatusProbeV2 = {
      meta: record.request.meta,
      sessionId: record.request.meta.sessionId,
      requestId: record.request.meta.messageId,
      reason: 'user_requested',
    };
    try {
      const inspected = this.deps.inspector.inspect(probe);
      if (isPromiseLike(inspected)) return this.unknownSnapshot(probe, 'async_inspector');
      return {
        ...inspected,
        sessionId: probe.sessionId,
        requestId: probe.requestId,
        evidence: inspected.evidence ?? [],
        observedAt: inspected.observedAt || new Date(this.now()).toISOString(),
      };
    } catch (error) {
      return this.unknownSnapshot(
        probe,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private latestRecord(sessionId?: string): WatchRecord | undefined {
    return [...this.records.values()]
      .filter(item => item.active && (!sessionId || item.request.meta.sessionId === sessionId))
      .filter(item => sessionId !== undefined || item.request.origin === 'player_message')
      .sort((a, b) => b.requestedAt - a.requestedAt)[0];
  }

  private unknownSnapshot(probe: GoalStatusProbeV2, stage: string): GoalStatusSnapshotV2 {
    return {
      sessionId: probe.sessionId,
      requestId: probe.requestId,
      state: 'unknown',
      stage: `communication_delayed:${stage}`,
      evidence: [],
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  private async probe(
    record: WatchRecord,
    reason: GoalStatusProbeV2['reason'],
    bypassThrottle: boolean,
  ): Promise<GoalContinuationV2 | null> {
    record.lastProbeAt = this.now();
    const probe: GoalStatusProbeV2 = {
      meta: record.request.meta,
      sessionId: record.request.meta.sessionId,
      requestId: record.request.meta.messageId,
      reason,
    };
    let snapshot: GoalStatusSnapshotV2 | null = null;
    for (let attempt = 0; attempt <= this.config.maxProbeRetries; attempt += 1) {
      try {
        snapshot = await withTimeout(
          Promise.resolve(this.deps.inspector.inspect(probe)),
          this.config.probeTimeoutMs,
        );
        break;
      } catch {
        // Retry is bounded by maxProbeRetries; runtime execution is intentionally untouched.
      }
    }
    if (!snapshot) return this.communicationDelayed(record, reason);

    const normalized: GoalStatusSnapshotV2 = {
      ...snapshot,
      sessionId: probe.sessionId,
      requestId: probe.requestId,
      evidence: snapshot.evidence ?? [],
      observedAt: snapshot.observedAt || new Date(this.now()).toISOString(),
    };
    const key = snapshotKey(normalized);
    const previousSnapshot = record.lastSnapshot ? structuredClone(record.lastSnapshot) : null;
    record.lastSnapshot = structuredClone(normalized);
    try {
      const notified = this.deps.onSnapshot?.({
        request: record.request,
        probe,
        snapshot: normalized,
        previousSnapshot,
      });
      if (isPromiseLike(notified)) void notified.catch(() => undefined);
    } catch {
      // Snapshot observation is advisory and must not break deterministic status reporting.
    }
    const now = this.now();
    if (!bypassThrottle && record.lastSnapshotKey === key && record.lastVisibleAt !== undefined &&
        now - record.lastVisibleAt < this.config.visibleProgressIntervalMs) return null;
    record.lastSnapshotKey = key;
    record.lastVisibleAt = now;

    const status: GoalReportV2['status'] = normalized.state === 'completed'
      ? 'completed'
      : normalized.state === 'failed'
        ? 'failed'
        : normalized.state === 'unknown'
          ? 'communication_delayed'
          : 'running';
    if (status === 'completed' || status === 'failed') record.active = false;
    return this.continuation(record, status, summaryFor(normalized), normalized.evidence, reason, normalized);
  }

  private receiptTimeout(record: WatchRecord): GoalContinuationV2 | null {
    const observedAt = new Date(this.now()).toISOString();
    return this.continuation(record, 'failed', 'GoalAgent 未在接单期限内确认请求。', [{
      type: 'action_result',
      ref: 'goalagent:receipt_timeout',
      observedAt,
    }], 'receipt_timeout');
  }

  private sessionExpired(record: WatchRecord): GoalContinuationV2 | null {
    const observedAt = new Date(this.now()).toISOString();
    return this.continuation(record, 'failed', 'GoalAgent 会话已超过生命周期上限。', [{
      type: 'action_result',
      ref: 'goalagent:session_expired',
      observedAt,
    }], 'session_expired');
  }

  private communicationDelayed(
    record: WatchRecord,
    trigger: GoalStatusProbeV2['reason'],
  ): GoalContinuationV2 | null {
    return this.continuation(
      record,
      'communication_delayed',
      '暂时无法读取任务运行状态；底层执行未被取消。',
      [],
      'communication_delayed',
      {
        sessionId: record.request.meta.sessionId,
        requestId: record.request.meta.messageId,
        state: 'unknown',
        stage: trigger,
        evidence: [],
        observedAt: new Date(this.now()).toISOString(),
      },
    );
  }

  private continuation(
    record: WatchRecord,
    status: GoalReportV2['status'],
    summary: string,
    evidence: GoalEvidenceV2[],
    reason: NonNullable<GoalContinuationV2['reason']>,
    statusSnapshot?: GoalStatusSnapshotV2,
  ): GoalContinuationV2 | null {
    const session = this.deps.getSession(record.request.meta.sessionId);
    if (!session) return null;
    const messageId = `goal-status-${randomUUID()}`;
    const meta = this.deps.nextMessageMeta(record.request.meta.messageId, messageId, `status:${reason}`) ?? {
      ...record.request.meta,
      messageId,
      causationId: record.request.meta.messageId,
      sequence: record.request.meta.sequence + 1,
      emittedAt: new Date(this.now()).toISOString(),
      idempotencyKey: `${record.request.meta.correlationId}:status:${reason}:${messageId}`,
    };
    const continuation: GoalContinuationV2 = {
      session: pickSession(session),
      triggeringReport: {
        meta,
        requestId: record.request.meta.messageId,
        status,
        summary,
        evidence,
        ...(status === 'running' && statusSnapshot
          ? watchdogProgress(record.request.meta.messageId, statusSnapshot)
          : {}),
      },
      reason,
      ...(statusSnapshot ? { statusSnapshot } : {}),
      allowedDecisions: status === 'communication_delayed' || status === 'running'
        ? ['respond', 'wait']
        : ['respond'],
    };
    this.deps.onContinuation?.(continuation);
    return continuation;
  }
}

function executionState(state: string): GoalStatusSnapshotV2['state'] {
  if (['accepted', 'deciding', 'preparing'].includes(state)) return 'planning';
  if (['executing', 'observing', 'verifying'].includes(state)) return 'executing';
  if (state === 'recovering') return 'recovering';
  if (state === 'paused_owner') return 'blocked';
  if (state === 'succeeded') return 'completed';
  if (state === 'failed' || state === 'cancelled') return 'failed';
  return 'unknown';
}

function isTerminalReport(status: GoalReportV2['status']): boolean {
  return ['answered', 'completed', 'failed', 'need_clarification', 'cancelled'].includes(status);
}

function pickSession(session: InteractionSessionV2): GoalContinuationV2['session'] {
  return {
    sessionId: session.sessionId,
    origin: session.origin,
    originalText: session.originalText,
    desiredOutcome: session.desiredOutcome,
    state: session.state,
    replyObligation: session.replyObligation,
  };
}

function snapshotKey(snapshot: GoalStatusSnapshotV2): string {
  const evidence = snapshot.evidence.map(item => `${item.type}:${item.ref}`).sort().join('|');
  return `${snapshot.sessionId}:${snapshot.state}:${snapshot.stage ?? ''}:${evidence}`;
}

function summaryFor(snapshot: GoalStatusSnapshotV2): string {
  const stage = snapshot.stage ? `，阶段：${snapshot.stage}` : '';
  if (snapshot.state === 'completed') return `任务已完成${stage}`;
  if (snapshot.state === 'failed') return `任务执行失败${snapshot.blocker ? `：${snapshot.blocker}` : stage}`;
  if (snapshot.state === 'blocked') return `任务暂时受阻${snapshot.blocker ? `：${snapshot.blocker}` : stage}`;
  if (snapshot.state === 'recovering') return `任务正在恢复${stage}`;
  if (snapshot.state === 'unknown') return '暂时无法确认任务运行状态。';
  return `任务仍在进行${stage}`;
}

/** 把自动探测事实投影到与 GoalAgent 主动报告相同的通信治理合同。 */
function watchdogProgress(
  requestId: string,
  snapshot: GoalStatusSnapshotV2,
): Pick<GoalReportV2, 'progress' | 'update'> {
  const kind = snapshot.state === 'blocked'
    ? 'obstacle'
    : snapshot.state === 'recovering'
      ? 'recovery'
      : 'milestone';
  const snapshotIdentity = snapshotKey(snapshot);
  return {
    progress: { current: 0, milestone: snapshot.state },
    update: {
      kind,
      importance: snapshot.state === 'blocked' ? 'high' : 'medium',
      episodeKey: `${requestId}:watchdog:${snapshot.state}:${snapshot.stage ?? ''}`,
      dedupeKey: `watchdog:${snapshotIdentity}`,
      ownerActionable: snapshot.state === 'blocked',
      ...(snapshot.nextAction ? { nextAction: snapshot.nextAction } : {}),
    },
  };
}

function withTimeout<T>(value: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return value;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('goal_status_probe_timeout')), timeoutMs);
    value.then(
      result => { clearTimeout(timer); resolve(result); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === 'function';
}
