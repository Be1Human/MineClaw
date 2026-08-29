import { randomUUID } from 'node:crypto';
import type {
  GoalReportV2,
  GoalRequestV2,
  GoalStatusProbeV2,
  GoalStatusSnapshotV2,
} from '../../decision/goalAgentPort/contracts.js';
import type { WorldStateView } from '../../types.js';
import type { GoalSuccessCriterion } from '../contracts/goalTypes.js';
import type { GoalAgentLoopEvent } from './goalAgentEvents.js';
import { GoalAgentRoundLoop } from './goalAgentRoundLoop.js';
import { GoalAgentModelRuntime, type GoalAgentModelClient } from './goalAgentModelRuntime.js';
import { GoalAgentSessionStore } from './goalAgentSessionStore.js';
import {
  cloneGoalAgentState,
  createGoalAgentState,
  isGoalAgentTerminalPhase,
  type GoalAgentBudget,
  type GoalAgentStateV1,
} from './goalAgentState.js';
import type { GoalAgentTools } from './goalAgentRuntimeContracts.js';
import type { GoalAgentMonitorSignal, GoalAgentMonitoringAdvice } from './goalAgentMonitoring.js';
import type { GoalAgentSkillKnowledgePort } from '../../skills/goalAgentSkillKnowledge.js';
import type { GoalAgentDomainKnowledgePort } from '../../knowledge/domainKnowledge.js';
import type { GoalCapabilityKnowledgePort } from '../../decision/goalAgentPort/goalCapabilityRouter.js';
import type { ColdStartPlannerPort } from '../planner/planGraphBuilder.js';
import { projectGoalAgentProgressReport } from './goalAgentProgressProjector.js';
import { GoalAgentReflectionWorker } from './goalAgentReflectionWorker.js';

export interface GoalAgentOptions {
  profileId: string;
  stateDbPath: string;
  modelClient: GoalAgentModelClient;
  tools: GoalAgentTools;
  skillKnowledge?: GoalAgentSkillKnowledgePort;
  domainKnowledge?: GoalAgentDomainKnowledgePort;
  capabilityKnowledge?: GoalCapabilityKnowledgePort;
  planMilestones?: ColdStartPlannerPort;
  budget?: Partial<Pick<GoalAgentBudget,
    'maxLlmCalls' | 'maxTotalTokens' | 'maxActions' | 'maxRecoveries' | 'maxGraphReplans'>>;
  nodeTimeoutMs?: number;
  sessionTimeoutMs?: number;
  /** Cooperative scheduling slice; yielding preserves the same GoalAgent session. */
  maxRoundsPerRun?: number;
  publishEvent?: (event: GoalAgentLoopEvent) => void;
  publishReport?: (report: GoalReportV2) => void;
  onState?: (state: Readonly<GoalAgentStateV1>, event: GoalAgentLoopEvent) => void;
  disposeTools?: () => void;
  log?: (message: string) => void;
}

export interface GoalAgentSubmission {
  accepted: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface GoalAgentPersistentMonitorStart {
  world: WorldStateView;
  runtimeRef: string;
  evidenceRefs?: readonly string[];
}

export interface GoalAgentPersistentMonitorResult {
  state: GoalAgentStateV1;
  cognitiveTriggered: boolean;
  advice?: GoalAgentMonitoringAdvice;
}

/**
 * The only public GoalAgent boundary. Production uses one continuous model →
 * tool → result loop; planning, acting and recovery are Step roles, not nodes.
 */
export class GoalAgent {
  private readonly store: GoalAgentSessionStore;
  private readonly loop: GoalAgentRoundLoop;
  private readonly reflection: GoalAgentReflectionWorker;
  private readonly sessionByInteraction = new Map<string, string>();
  private readonly reportRequestBySession = new Map<string, GoalRequestV2>();
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly reflections = new Map<string, Promise<void>>();
  private readonly reportedStop = new Map<string, string>();
  private latestSessionId: string | null = null;
  private closed = false;

  constructor(private readonly options: GoalAgentOptions) {
    if (!options.profileId.trim()) throw new Error('GoalAgent profileId is required');
    this.store = new GoalAgentSessionStore(options.stateDbPath);
    const model = new GoalAgentModelRuntime(options.modelClient, {
      eventLog: this.store,
      trace: trace => options.publishEvent?.({
        type: 'goalagent.model.called',
        sessionId: trace.sessionId,
        revision: trace.contextRevision,
        epoch: trace.epoch,
        phase: this.store.get(trace.sessionId)?.phase ?? 'failed',
        node: trace.node,
        payload: { ...trace },
      }),
    });
    this.reflection = new GoalAgentReflectionWorker({
      model,
      eventLog: this.store,
      experience: options.tools.experience,
      publish: event => this.onLoopEvent(event),
    });
    this.loop = new GoalAgentRoundLoop({
      store: this.store,
      model,
      profileId: options.profileId,
      tools: options.tools,
      skills: options.skillKnowledge,
      domainKnowledge: options.domainKnowledge,
      capabilities: options.capabilityKnowledge,
      planMilestones: options.planMilestones,
      roundTimeoutMs: options.nodeTimeoutMs ?? 120_000,
      sessionTimeoutMs: options.sessionTimeoutMs ?? 1_800_000,
      maxRoundsPerRun: options.maxRoundsPerRun ?? 20,
      publish: event => this.onLoopEvent(event),
    });
    for (const state of this.store.listActive()) {
      this.sessionByInteraction.set(state.interactionSessionId, state.sessionId);
      this.reportRequestBySession.set(state.sessionId, state.request);
      this.latestSessionId = state.sessionId;
    }
  }

  startPersistentMonitor(
    request: GoalRequestV2,
    input: GoalAgentPersistentMonitorStart,
  ): GoalAgentSubmission {
    if (this.closed) return { accepted: false, reason: 'goal_agent_closed' };
    const duplicate = this.store.findByRequestId(request.meta.messageId);
    if (duplicate) {
      return duplicate.mode === 'persistent_monitor'
        ? { accepted: true, details: { sessionId: duplicate.sessionId, deduplicated: true } }
        : { accepted: false, reason: `request_already_owned_by:${duplicate.mode}` };
    }
    const existingId = this.sessionByInteraction.get(request.meta.sessionId);
    const existing = existingId ? this.store.getActive(existingId) : null;
    if (existing) return { accepted: false, reason: `goal_agent_session_busy:${existing.phase}` };

    const sessionId = `goal-${randomUUID()}`;
    const state = createGoalAgentState({
      sessionId,
      interactionSessionId: request.meta.sessionId,
      request,
      mode: 'persistent_monitor',
      budget: this.options.budget,
    });
    state.world = {
      latest: structuredClone(input.world),
      beforeAction: null,
      observedAt: state.createdAt,
    };
    state.cognition.evidenceRefs = [...new Set([
      `handle:${input.runtimeRef}`,
      ...(input.evidenceRefs ?? []),
    ])];
    this.sessionByInteraction.set(state.interactionSessionId, sessionId);
    this.reportRequestBySession.set(sessionId, request);
    this.latestSessionId = sessionId;
    this.loop.create(state);
    return {
      accepted: true,
      details: { sessionId, runtimeRef: input.runtimeRef, mode: state.mode },
    };
  }

  async monitorPersistent(signal: GoalAgentMonitorSignal): Promise<GoalAgentPersistentMonitorResult> {
    const current = this.store.getActive(signal.sessionId);
    if (!current) throw new Error(`active persistent monitor session not found: ${signal.sessionId}`);
    if (current.mode !== 'persistent_monitor') {
      throw new Error(`GoalAgent session is not a persistent monitor: ${signal.sessionId}`);
    }
    if (signal.change !== 'heartbeat') {
      const perception = this.options.tools.perception;
      if (!perception) throw new Error('GoalAgent persistent monitor requires perception');
      const controller = new AbortController();
      const world = await perception.observe(controller.signal);
      await this.loop.refreshPersistentObservation(
        signal.sessionId,
        world,
        signal.summary,
        signal.evidenceRefs,
      );
    }
    return this.loop.monitor(signal);
  }

  async finishPersistentMonitor(
    sessionId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    summary: string,
    evidenceRefs: readonly string[] = [],
  ): Promise<GoalAgentStateV1 | null> {
    const current = this.store.getActive(sessionId);
    if (!current) return this.store.get(sessionId);
    if (current.mode !== 'persistent_monitor') {
      throw new Error(`GoalAgent session is not a persistent monitor: ${sessionId}`);
    }
    if (outcome === 'completed') return this.loop.completeExternal(sessionId, summary, evidenceRefs);
    if (outcome === 'failed') return this.loop.fail(sessionId, summary, [...evidenceRefs]);
    return this.loop.cancel(sessionId, summary);
  }

  submit(request: GoalRequestV2): GoalAgentSubmission {
    if (this.closed) return { accepted: false, reason: 'goal_agent_closed' };
    if (request.requestKind === 'cancel') {
      const cancelled = this.cancelAll(`owner_cancel:${request.requestText.slice(0, 96)}`);
      this.publishReport(request, {
        status: 'completed',
        summary: `已停止 ${cancelled} 条 GoalAgent 执行链。`,
        evidence: [{
          type: 'action_result',
          ref: `cancel:${request.meta.messageId}`,
          observedAt: new Date().toISOString(),
        }],
      });
      return { accepted: true, details: { cancelled } };
    }

    const duplicate=this.store.findByRequestId(request.meta.messageId);
    if(duplicate){
      this.sessionByInteraction.set(request.meta.sessionId,duplicate.sessionId);
      this.reportRequestBySession.set(duplicate.sessionId,request);
      this.latestSessionId=duplicate.sessionId;
      return {accepted:true,details:{sessionId:duplicate.sessionId,deduplicated:true}};
    }

    const existingId = this.sessionByInteraction.get(request.meta.sessionId);
    const existing = existingId ? this.store.getActive(existingId) : null;
    if (existing?.phase === 'paused_owner') {
      this.reportRequestBySession.set(existing.sessionId, request);
      this.latestSessionId = existing.sessionId;
      void this.loop.resumeOwner(existing.sessionId, request.requestText)
        .then(() => this.pump(existing.sessionId))
        .catch(error => this.failPump(existing.sessionId, error));
      return {
        accepted: true,
        details: { sessionId: existing.sessionId, resumed: true, epoch: existing.epoch + 1 },
      };
    }
    if (existing) {
      return { accepted: false, reason: `goal_agent_session_busy:${existing.phase}` };
    }

    const sessionId = `goal-${randomUUID()}`;
    const state = createGoalAgentState({
      sessionId,
      interactionSessionId: request.meta.sessionId,
      request,
      budget: this.options.budget,
    });
    this.sessionByInteraction.set(state.interactionSessionId, sessionId);
    this.reportRequestBySession.set(sessionId, request);
    this.latestSessionId = sessionId;
    this.loop.create(state);
    this.publishReport(request, {
      status: 'running',
      summary: `GoalAgent 已接管：${request.requestText}`,
      progress: { current: 0, milestone: 'resolving' },
      evidence: [{
        type: 'action_result',
        ref: `goalagent:${sessionId}:created`,
        observedAt: state.createdAt,
      }],
    });
    void this.pump(sessionId);
    return { accepted: true, details: { sessionId } };
  }

  restore(): number {
    const active = this.store.listActive();
    for (const state of active) {
      this.sessionByInteraction.set(state.interactionSessionId, state.sessionId);
      this.reportRequestBySession.set(state.sessionId, state.request);
      this.latestSessionId = state.sessionId;
      if (state.mode === 'planned_goal' && state.phase !== 'paused_owner') void this.pump(state.sessionId);
    }
    return active.length;
  }

  cancelAll(reason: string): number {
    const active = this.store.listActive();
    for (const state of active) {
      void this.loop.cancel(state.sessionId, reason)
        .then(terminal => this.reportStop(terminal))
        .catch(error => this.options.log?.(`GoalAgent cancel failed: ${errorText(error)}`));
    }
    return active.length;
  }

  snapshot(sessionOrInteractionId?: string): GoalAgentStateV1 | null {
    const resolved = sessionOrInteractionId
      ? this.sessionByInteraction.get(sessionOrInteractionId) ?? sessionOrInteractionId
      : this.latestSessionId;
    return resolved ? this.loop.snapshot(resolved) : null;
  }

  /** FEAT-CROSS-21 · 只读：根目标判据（完成确认闸复核用）。 */
  getRootCriteria(sessionOrInteractionId: string): readonly GoalSuccessCriterion[] | null {
    const state = this.snapshot(sessionOrInteractionId);
    return state?.rootGoal?.successCriteria ?? null;
  }

  activeCount(): number {
    return this.store.listActive().length;
  }

  inspect(probe: GoalStatusProbeV2): GoalStatusSnapshotV2 {
    const state = this.snapshot(probe.sessionId);
    const observedAt = new Date().toISOString();
    if (!state) {
      return {
        sessionId: probe.sessionId,
        requestId: probe.requestId,
        state: 'unknown',
        stage: 'goalagent_session_not_found',
        evidence: [],
        observedAt,
      };
    }
    const status = statusForPhase(state.phase);
    const evidenceRefs = state.terminal?.evidenceRefs
      ?? state.verdict?.evidenceRefs
      ?? state.action.result?.evidenceRefs
      ?? [];
    const activeTask = state.plan.graph?.nodes.find(node => node.id === state.plan.activeNodeId);
    return {
      sessionId: probe.sessionId,
      requestId: probe.requestId,
      state: status,
      stage: `${state.phase}:${state.activeNode}:plan-r${state.plan.revision}`,
      lastProgressAt: state.updatedAt,
      ...(state.phase === 'paused_owner' && state.owner.question ? { blocker: state.owner.question } : {}),
      ...(status === 'failed' && state.terminal?.summary ? { blocker: state.terminal.summary } : {}),
      ...(activeTask ? { nextAction: activeTask.goal.goalText } : {}),
      runtimeRef: `goalagent:${state.sessionId}:r${state.revision}`,
      evidence: evidenceRefs.map(ref => ({ type: 'root_verdict', ref, observedAt })),
      observedAt,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.loop.dispose();
    const pending = [...this.pumps.values(), ...this.reflections.values()];
    if (pending.length === 0) {
      this.disposeResources();
      return;
    }
    void Promise.allSettled(pending).finally(() => this.disposeResources());
  }

  private pump(sessionId: string): Promise<void> {
    const running = this.pumps.get(sessionId);
    if (running) return running;
    const task = this.runToStop(sessionId).finally(() => {
      if (this.pumps.get(sessionId) === task) this.pumps.delete(sessionId);
    });
    this.pumps.set(sessionId, task);
    return task;
  }

  private async runToStop(sessionId: string): Promise<void> {
    try {
      let state = this.store.get(sessionId);
      if (state?.mode === 'persistent_monitor') return;
      while (state && !isGoalAgentTerminalPhase(state.phase) && state.phase !== 'paused_owner') {
        state = await this.loop.run(sessionId);
      }
      if (state) this.reportStop(state);
    } catch (error) {
      await this.failPump(sessionId, error);
    }
  }

  private async failPump(sessionId: string, error: unknown): Promise<void> {
    const detail = errorText(error);
    this.options.log?.(`GoalAgent loop failed: ${detail}`);
    try {
      const state = this.store.getActive(sessionId)
        ? await this.loop.fail(sessionId, `GoalAgent 内部执行失败：${detail}`, [`error:${detail.slice(0, 160)}`])
        : this.store.get(sessionId);
      if (state) this.reportStop(state);
    } catch (terminalError) {
      this.options.log?.(`GoalAgent terminal commit failed: ${errorText(terminalError)}`);
    }
  }

  private onLoopEvent(event: GoalAgentLoopEvent): void {
    this.options.publishEvent?.(event);
    const state = this.store.get(event.sessionId);
    if (!state) return;
    if (event.type === 'goalagent.session.terminal') this.scheduleReflection(state);
    this.options.onState?.(state, event);
    // BUG-CROSS-80 · 空搜索/预算告警/缺料求助经 R20 通道投影为主人可见的进度事实
    if (event.type === 'goalagent.owner.feedback') {
      const feedback = event.payload.feedback;
      if (feedback && typeof feedback === 'object') {
        const record = feedback as Record<string, unknown>;
        const summary = typeof record.summary === 'string' ? record.summary : '任务遇到障碍';
        const refs = Array.isArray(record.evidenceRefs)
          ? record.evidenceRefs.filter((ref): ref is string => typeof ref === 'string')
          : [];
        const observedAt = state.updatedAt;
        const request = this.reportRequestBySession.get(state.sessionId) ?? state.request;
        this.publishReport(request, {
          status: 'running',
          summary,
          evidence: refs.map(ref => ({ type: 'action_result', ref, observedAt })),
          update: {
            kind: 'obstacle',
            importance: 'critical',
            episodeKey: `${state.sessionId}:feedback:${String(record.kind ?? 'unknown')}`,
            dedupeKey: `${state.sessionId}:feedback:${String(record.kind ?? 'unknown')}:${state.revision}`,
            ownerActionable: record.ownerActionable === true,
            nextAction: summary,
          },
        });
      }
      return;
    }
    const progressReport = projectGoalAgentProgressReport(state, event);
    if (progressReport) {
      const request = this.reportRequestBySession.get(state.sessionId) ?? state.request;
      this.publishReport(request, progressReport);
    }
  }

  private scheduleReflection(state: GoalAgentStateV1): void {
    if (this.reflections.has(state.sessionId)) return;
    const task = this.reflection.consume(cloneGoalAgentState(state)).finally(() => {
      if (this.reflections.get(state.sessionId) === task) this.reflections.delete(state.sessionId);
    });
    this.reflections.set(state.sessionId, task);
  }

  private reportStop(state: GoalAgentStateV1): void {
    const stopKey = `${state.phase}:${state.revision}`;
    if (this.reportedStop.get(state.sessionId) === stopKey) return;
    if (!isGoalAgentTerminalPhase(state.phase) && state.phase !== 'paused_owner') return;
    if (state.mode === 'persistent_monitor') {
      this.reportedStop.set(state.sessionId, stopKey);
      return;
    }
    const request = this.reportRequestBySession.get(state.sessionId) ?? state.request;
    const observedAt = state.updatedAt;
    const evidenceRefs = state.terminal?.evidenceRefs
      ?? state.verdict?.evidenceRefs
      ?? state.action.result?.evidenceRefs
      ?? [];
    if (state.phase === 'paused_owner') {
      this.publishReport(request, {
        status: 'need_clarification',
        summary: state.owner.question ?? 'GoalAgent 需要补充可执行信息。',
        evidence: evidenceRefs.map(ref => ({ type: 'root_verdict', ref, observedAt })),
      });
    } else {
      const outcome = state.terminal?.outcome ?? 'failed';
      this.publishReport(request, {
        status: outcome === 'completed' ? (request.requestKind === 'query' ? 'answered' : 'completed')
          : outcome === 'cancelled' ? 'cancelled' : 'failed',
        summary: state.terminal?.summary ?? state.verdict?.summary ?? `GoalAgent ${outcome}`,
        evidence: evidenceRefs.map(ref => ({ type: 'root_verdict', ref, observedAt })),
      });
    }
    this.reportedStop.set(state.sessionId, stopKey);
  }

  private publishReport(
    request: GoalRequestV2,
    report: Omit<GoalReportV2, 'meta' | 'requestId'>,
  ): void {
    this.options.publishReport?.({
      meta: request.meta,
      requestId: request.meta.messageId,
      ...report,
    });
  }

  private disposeResources():void {
    this.store.close();
    this.options.disposeTools?.();
  }
}

function statusForPhase(phase: GoalAgentStateV1['phase']): GoalStatusSnapshotV2['state'] {
  if (phase === 'ingress') return 'resolving';
  if (phase === 'running') return 'executing';
  if (phase === 'paused_owner') return 'blocked';
  if (phase === 'completed') return 'completed';
  if (phase === 'failed' || phase === 'cancelled' || phase === 'timed_out') return 'failed';
  return 'unknown';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
