import type { WorldStateView } from '../../types.js';
import {
  assertGoalAgentStateV1,
  cloneGoalAgentState,
  isGoalAgentTerminalPhase,
  type GoalAgentStateV1,
} from './goalAgentState.js';
import type { GoalAgentModelPort, GoalAgentTools } from './goalAgentRuntimeContracts.js';
import type { GoalAgentSessionStorePort } from './goalAgentSessionStore.js';
import type { GoalAgentLoopEvent } from './goalAgentEvents.js';
import type { GoalAgentSkillKnowledgePort } from '../../skills/goalAgentSkillKnowledge.js';
import type { GoalAgentDomainKnowledgePort } from '../../knowledge/domainKnowledge.js';
import type { GoalCapabilityKnowledgePort } from '../../decision/goalAgentPort/goalCapabilityRouter.js';
import type { ColdStartPlannerPort } from '../planner/planGraphBuilder.js';
import {
  GoalAgentRoundToolRuntime,
  type GoalAgentRoundToolReceipt,
} from './goalAgentRoundTools.js';
import {
  GoalAgentDeadlineExceededError,
  SYSTEM_GOAL_AGENT_DEADLINE_CLOCK,
  runWithGoalAgentDeadline,
  type GoalAgentDeadlineClock,
  type GoalAgentDeadlineScope,
} from './goalAgentDeadline.js';
import {
  assessGoalAgentMonitorSignal,
  parseGoalAgentMonitoringAdvice,
  type GoalAgentMonitorSignal,
  type GoalAgentMonitoringAdvice,
} from './goalAgentMonitoring.js';
import {
  computeOwnerFeedback,
  type GoalAgentOwnerFeedback,
  type GoalAgentOwnerFeedbackKind,
} from './goalAgentOwnerFeedback.js';

export interface GoalAgentRoundLoopOptions {
  store: GoalAgentSessionStorePort;
  model: GoalAgentModelPort;
  profileId: string;
  tools?: GoalAgentTools;
  skills?: GoalAgentSkillKnowledgePort;
  domainKnowledge?: GoalAgentDomainKnowledgePort;
  capabilities?: GoalCapabilityKnowledgePort;
  planMilestones?: ColdStartPlannerPort;
  publish?: (event: GoalAgentLoopEvent) => void;
  now?: () => string;
  nowMs?: () => number;
  maxRoundsPerRun?: number;
  roundTimeoutMs?: number;
  sessionTimeoutMs?: number;
  deadlineClock?: GoalAgentDeadlineClock;
}

export interface GoalAgentRoundRunOptions {
  maxRounds?: number;
}

export interface GoalAgentRoundMonitorResult {
  state: GoalAgentStateV1;
  cognitiveTriggered: boolean;
  advice?: GoalAgentMonitoringAdvice;
}

/**
 * Production GoalAgent harness: one append-only session and one repeated
 * model -> tool -> result round. There is no cognitive node router here.
 */
export class GoalAgentRoundLoop {
  private readonly tools: GoalAgentTools;
  private readonly toolRuntime: GoalAgentRoundToolRuntime;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly maxRoundsPerRun: number;
  private readonly deadlineClock: GoalAgentDeadlineClock;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, { epoch: number; controller: AbortController }>();
  /** BUG-CROSS-80 · 每个会话已发过的主人反馈 kind（防重复打扰）。 */
  private readonly sentFeedbackKinds = new Map<string, Set<GoalAgentOwnerFeedbackKind>>();
  /** BUG-CROSS-80 · 每个会话连续未调用 action_execute 的轮数（观察/搜索循环检测）。 */
  private readonly inactiveRoundsBySession = new Map<string, number>();

  constructor(private readonly options: GoalAgentRoundLoopOptions) {
    this.tools = options.tools ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.maxRoundsPerRun = options.maxRoundsPerRun ?? 24;
    this.deadlineClock = options.deadlineClock ?? SYSTEM_GOAL_AGENT_DEADLINE_CLOCK;
    if (!Number.isInteger(this.maxRoundsPerRun) || this.maxRoundsPerRun < 1) {
      throw new Error('GoalAgent maxRoundsPerRun must be a positive integer');
    }
    this.toolRuntime = new GoalAgentRoundToolRuntime({
      profileId: options.profileId,
      tools: this.tools,
      skills: options.skills,
      domainKnowledge: options.domainKnowledge,
      capabilities: options.capabilities,
      planMilestones: options.planMilestones,
      now: this.now,
    });
  }

  registeredTools(): string[] {
    return this.toolRuntime.names();
  }

  create(input: GoalAgentStateV1): GoalAgentStateV1 {
    const state = cloneGoalAgentState(input);
    state.phase = 'running';
    state.activeNode = 'round';
    this.options.store.create(state);
    this.publish('goalagent.session.created', state, {
      requestId: state.requestId,
      runtime: 'continuous_round_loop',
      tools: this.toolRuntime.names(),
    });
    return cloneGoalAgentState(state);
  }

  snapshot(sessionId: string): GoalAgentStateV1 | null {
    const state = this.options.store.get(sessionId);
    return state ? cloneGoalAgentState(state) : null;
  }

  run(sessionId: string, options: GoalAgentRoundRunOptions = {}): Promise<GoalAgentStateV1> {
    return this.serialized(sessionId, () => this.runInternal(sessionId, options));
  }

  step(sessionId: string): Promise<GoalAgentStateV1> {
    return this.run(sessionId, { maxRounds: 1 });
  }

  restoreActive(options: GoalAgentRoundRunOptions = {}): Promise<GoalAgentStateV1[]> {
    return Promise.all(this.options.store.listActive()
      .filter(state => state.mode === 'planned_goal')
      .map(state => this.run(state.sessionId, options)));
  }

  async monitor(signal: GoalAgentMonitorSignal): Promise<GoalAgentRoundMonitorResult> {
    return this.serialized(signal.sessionId, async () => {
      const current = this.requireActive(signal.sessionId);
      const probe = assessGoalAgentMonitorSignal(signal);
      this.publish('goalagent.monitor.sampled', current, { probe });
      if (!probe.meaningful) return { state: current, cognitiveTriggered: false };
      const controller = this.controllerFor(current.sessionId, current.epoch);
      const deadline = this.deadlineFor(current);
      try {
        const response = await runWithGoalAgentDeadline({
          controller,
          scope: deadline.scope,
          timeoutMs: deadline.timeoutMs,
          clock: this.deadlineClock,
          operation: () => this.options.model.invoke({
            sessionId: current.sessionId,
            expectedRevision: current.revision,
            node: 'round',
            instruction: [
              'Current Step role: monitor a persistent goal inside the same GoalAgent session.',
              'Return JSON only: {"decision":"continue|replan|recover|need_owner|fail","summary":"..."}.',
              `Monitoring probe: ${JSON.stringify(probe)}`,
            ].join('\n'),
            historyInstruction: `Monitor persistent change: ${probe.change}`,
            state: current,
            toolChoice: 'none',
            parse: content => parseGoalAgentMonitoringAdvice(content, probe),
            signal: controller.signal,
          }),
        });
        const next = cloneGoalAgentState(current);
        next.revision += 1;
        next.updatedAt = this.now();
        next.phase = 'running';
        next.activeNode = 'round';
        next.budget = structuredClone(response.budget);
        next.cognition = {
          ...next.cognition,
          activeNode: 'monitor',
          objective: 'monitor persistent goal change',
          nodeTurn: current.cognition.nodeTurn + 1,
          outcomeKind: 'monitoring_advice',
          evidenceRefs: [...new Set([...current.cognition.evidenceRefs, ...probe.evidenceRefs])],
        };
        appendTimeline(next, 'model_call', response.value.summary, [...probe.evidenceRefs], {
          role: 'monitor', modelCallIndex: response.modelCallIndex, decision: response.value.decision,
        });
        const persisted = this.options.store.commit({
          expectedRevision: current.revision,
          expectedEpoch: current.epoch,
          state: next,
          messages: response.messagesToAppend,
          ...(response.compaction ? { compaction: response.compaction } : {}),
        });
        this.publish('goalagent.monitor.advised', persisted, { advice: response.value });
        return { state: persisted, cognitiveTriggered: true, advice: response.value };
      } catch (error) {
        if (error instanceof GoalAgentDeadlineExceededError) {
          return { state: this.commitTimedOut(current, error), cognitiveTriggered: true };
        }
        throw error;
      }
    });
  }

  refreshPersistentObservation(
    sessionId: string,
    world: WorldStateView,
    summary: string,
    evidenceRefs: readonly string[],
  ): Promise<GoalAgentStateV1> {
    return this.serialized(sessionId, async () => {
      const current = this.requireActive(sessionId);
      if (current.mode !== 'persistent_monitor') throw new Error(`monitor observation requires persistent mode: ${sessionId}`);
      const next = cloneGoalAgentState(current);
      next.revision += 1;
      next.updatedAt = this.now();
      next.phase = 'running';
      next.activeNode = 'round';
      next.world = {
        latest: structuredClone(world),
        beforeAction: current.world.latest ? structuredClone(current.world.latest) : null,
        observedAt: next.updatedAt,
      };
      appendTimeline(next, 'observation', summary.trim() || 'persistent observation refreshed', [...new Set(evidenceRefs)], { source: 'watchdog' });
      const persisted = this.options.store.commit({ expectedRevision: current.revision, expectedEpoch: current.epoch, state: next });
      this.publish('goalagent.monitor.observation_refreshed', persisted, { evidenceRefs: [...new Set(evidenceRefs)] });
      return persisted;
    });
  }

  completeExternal(sessionId: string, summary: string, evidenceRefs: readonly string[] = []): Promise<GoalAgentStateV1> {
    return this.terminalize(sessionId, 'completed', summary || 'persistent capability completed', [...evidenceRefs]);
  }

  cancel(sessionId: string, summary: string): Promise<GoalAgentStateV1> {
    this.abortActive(sessionId);
    return this.terminalize(sessionId, 'cancelled', summary || 'cancelled', []);
  }

  fail(sessionId: string, summary: string, evidenceRefs: string[] = []): Promise<GoalAgentStateV1> {
    this.abortActive(sessionId);
    return this.terminalize(sessionId, 'failed', summary || 'GoalAgent round loop failed', evidenceRefs);
  }

  resumeOwner(sessionId: string, answer: string): Promise<GoalAgentStateV1> {
    return this.serialized(sessionId, async () => {
      const current = this.requireActive(sessionId);
      if (current.phase !== 'paused_owner') throw new Error('only paused_owner session can resume');
      if (!answer.trim()) throw new Error('owner answer is required');
      const next = cloneGoalAgentState(current);
      next.revision += 1;
      next.epoch += 1;
      next.updatedAt = this.now();
      next.phase = 'running';
      next.activeNode = 'round';
      next.request = {
        ...next.request,
        requestText: [next.request.requestText.trim(), answer.trim()].filter(Boolean).join('；玩家补充：'),
      };
      next.owner = { question: null, answer: answer.trim(), requestedAt: current.owner.requestedAt, answeredAt: next.updatedAt };
      next.interpretation.clarificationReason = null;
      next.verdict = null;
      appendTimeline(next, 'transition', 'owner answer received; continue same round loop', [], { role: roleFor(next) });
      const persisted = this.options.store.commit({
        expectedRevision: current.revision,
        expectedEpoch: current.epoch,
        state: next,
        messages: [{ role: 'user', content: `[GoalAgent owner answer]\n${answer.trim()}` }],
      });
      this.publish('goalagent.session.resumed', persisted, { runtime: 'continuous_round_loop' });
      return persisted;
    });
  }

  dispose(): void {
    for (const value of this.aborts.values()) value.controller.abort();
    this.aborts.clear();
  }

  private async runInternal(sessionId: string, options: GoalAgentRoundRunOptions): Promise<GoalAgentStateV1> {
    const maxRounds = options.maxRounds ?? this.maxRoundsPerRun;
    if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('maxRounds must be a positive integer');
    let state = this.requireExisting(sessionId);
    for (let round = 0; round < maxRounds; round += 1) {
      if (isGoalAgentTerminalPhase(state.phase) || state.phase === 'paused_owner') return state;
      const stepRole = roleFor(state);
      const controller = this.controllerFor(state.sessionId, state.epoch);
      const deadline = this.deadlineFor(state);
      try {
        const response = await runWithGoalAgentDeadline({
          controller,
          scope: deadline.scope,
          timeoutMs: deadline.timeoutMs,
          clock: this.deadlineClock,
          operation: () => this.options.model.invoke({
            sessionId: state.sessionId,
            expectedRevision: state.revision,
            node: 'round',
            instruction: roundInstruction(state),
            historyInstruction: `Continue the same GoalAgent goal. Current Step objective: ${stepRole}.`,
            state,
            tools: this.toolRuntime.schemas(),
            parse: (content, toolCalls) => ({ content: content.trim(), toolCalls: toolCalls ?? [] }),
            signal: controller.signal,
          }),
        });
        if (controller.signal.aborted) return this.requireExisting(sessionId);
        const next = cloneGoalAgentState(state);
        next.revision = state.revision + 1;
        next.updatedAt = this.now();
        next.budget = structuredClone(response.budget);
        const messages = response.messagesToAppend.map(message => structuredClone(message));
        next.cognition = {
          ...next.cognition,
          activeNode: null,
          objective: stepRole,
          nodeTurn: state.cognition.nodeTurn + 1,
          outcomeKind: null,
          toolTraceRefs: [...new Set([
            ...state.cognition.toolTraceRefs,
            ...response.toolCalls.map(call => `tool:round:${call.id}:${call.name}`),
          ])],
        };
        const receipts: Array<{ callId: string; name: string; receipt: GoalAgentRoundToolReceipt }> = [];
        for (const call of response.toolCalls) {
          const receipt = await this.toolRuntime.execute(call, next, controller.signal);
          receipts.push({ callId: call.id, name: call.name, receipt });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(receipt.content),
          });
          appendTimeline(next, 'tool_call', receipt.summary, receipt.evidenceRefs, {
            callId: call.id,
            tool: call.name,
            ok: receipt.content.ok === true,
          });
          if (next.terminal || next.phase === 'paused_owner') break;
        }
        if (response.toolCalls.length === 0) this.handlePlainResponse(next, response.value.content, messages);
        if (!next.terminal && next.phase !== 'paused_owner') {
          next.phase = 'running';
          next.activeNode = 'round';
        }
        appendTimeline(next, 'model_call', `round ${response.modelCallIndex}: ${stepRole}`, receipts.flatMap(value => value.receipt.evidenceRefs), {
          modelCallIndex: response.modelCallIndex,
          role: stepRole,
          toolCalls: response.toolCalls.map(call => call.name),
        });
        assertGoalAgentStateV1(next);
        state = this.options.store.commit({
          expectedRevision: state.revision,
          expectedEpoch: state.epoch,
          state: next,
          messages,
          ...(response.compaction ? { compaction: response.compaction } : {}),
        });
        const terminal = isGoalAgentTerminalPhase(state.phase);
        this.publish(terminal ? 'goalagent.session.terminal' : 'goalagent.round.completed', state, {
          runtime: 'continuous_round_loop',
          modelCallIndex: response.modelCallIndex,
          role: stepRole,
          summary: receipts.at(-1)?.receipt.summary ?? response.value.content,
          evidenceRefs: [...new Set(receipts.flatMap(value => value.receipt.evidenceRefs))],
          tools: receipts.map(value => ({ name: value.name, callId: value.callId, ok: value.receipt.content.ok === true })),
          ...(terminal ? { outcome: state.terminal?.outcome } : {}),
        });
        // BUG-CROSS-80 · 每轮提交后判定主人反馈（空搜索/预算/缺料求助），命中即经事件投影
        const feedback = this.evaluateOwnerFeedback(state, receipts);
        if (feedback) {
          this.publish('goalagent.owner.feedback', state, { feedback });
        }
        if (terminal || state.phase === 'paused_owner') return state;
      } catch (error) {
        if (error instanceof GoalAgentDeadlineExceededError) return this.commitTimedOut(state, error);
        if (controller.signal.aborted) return this.requireExisting(sessionId);
        this.publish('goalagent.round.failed', state, { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    this.publish('goalagent.run.yielded', state, { reason: 'round_budget' });
    return state;
  }

  /** BUG-CROSS-80 · 汇总本轮证据判定主人反馈，每个 kind 每会话只发一次。 */
  private evaluateOwnerFeedback(
    state: GoalAgentStateV1,
    receipts: Array<{ callId: string; name: string; receipt: GoalAgentRoundToolReceipt }>,
  ): GoalAgentOwnerFeedback | null {
    const sent = this.sentFeedbackKinds.get(state.sessionId) ?? new Set<GoalAgentOwnerFeedbackKind>();
    const actionListReceipt = receipts.find(value => value.name === 'action_list');
    const candidates = actionListReceipt?.receipt.content.candidates;
    const lastCandidateCount = Array.isArray(candidates) ? candidates.length : null;
    const acted = receipts.some(value => value.name === 'action_execute');
    const inactiveRounds = acted
      ? 0
      : (this.inactiveRoundsBySession.get(state.sessionId) ?? 0) + 1;
    this.inactiveRoundsBySession.set(state.sessionId, inactiveRounds);
    const feedback = computeOwnerFeedback({
      state,
      emptySearchStreak: this.toolRuntime.emptySearchStreak(state.sessionId),
      lastCandidateCount,
      inactiveRounds,
      alreadySentKinds: sent,
    });
    if (feedback) {
      sent.add(feedback.kind);
      this.sentFeedbackKinds.set(state.sessionId, sent);
    }
    return feedback;
  }

  private handlePlainResponse(
    state: GoalAgentStateV1,
    content: string,
    messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string; tool_call_id?: string }>,
  ): void {
    if (state.request.requestKind === 'query' && state.world.latest && content.trim()) {
      const evidenceRefs = [`world:${state.world.latest.tick}:${state.world.latest.timestamp}`];
      state.verdict = {
        decision: 'complete', summary: content.trim(), machineCriteriaSatisfied: true,
        ownerActionable: false, retryable: false, evidenceRefs,
      };
      state.terminal = {
        outcome: 'completed', summary: content.trim(), completedAt: this.now(), evidenceRefs,
      };
      state.phase = 'completed';
      state.activeNode = 'round';
      return;
    }
    messages.push({
      role: 'user',
      content: [
        '[GoalAgent harness correction]',
        'The task is not machine-complete. Plain text cannot execute or finish a game task.',
        `Continue by calling the required real tool for Step role ${roleFor(state)}.`,
      ].join('\n'),
    });
  }

  private terminalize(
    sessionId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    summary: string,
    evidenceRefs: string[],
  ): Promise<GoalAgentStateV1> {
    return this.serialized(sessionId, async () => {
      const current = this.requireActive(sessionId);
      const next = cloneGoalAgentState(current);
      next.revision += 1;
      next.epoch += 1;
      next.updatedAt = this.now();
      next.phase = outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed';
      next.activeNode = 'round';
      next.terminal = {
        outcome,
        summary: summary.trim(),
        completedAt: next.updatedAt,
        evidenceRefs: [...new Set(evidenceRefs)],
      };
      if (outcome === 'failed') {
        next.verdict = {
          decision: 'fail', summary: next.terminal.summary, machineCriteriaSatisfied: false,
          ownerActionable: false, retryable: false, evidenceRefs: [...next.terminal.evidenceRefs],
        };
      }
      appendTimeline(next, 'terminal', next.terminal.summary, next.terminal.evidenceRefs, { outcome });
      const persisted = this.options.store.commit({ expectedRevision: current.revision, expectedEpoch: current.epoch, state: next });
      this.publish('goalagent.session.terminal', persisted, { outcome, runtime: 'continuous_round_loop' });
      return persisted;
    });
  }

  private commitTimedOut(current: GoalAgentStateV1, error: GoalAgentDeadlineExceededError): GoalAgentStateV1 {
    const next = cloneGoalAgentState(current);
    const evidenceRef = `deadline:${error.scope}:${current.sessionId}:${current.epoch}:${current.revision}:round`;
    next.revision += 1;
    next.epoch += 1;
    next.updatedAt = this.now();
    next.phase = 'timed_out';
    next.activeNode = 'round';
    next.verdict = {
      decision: 'fail', summary: error.message, machineCriteriaSatisfied: false,
      ownerActionable: false, retryable: false, evidenceRefs: [evidenceRef],
    };
    next.terminal = { outcome: 'timed_out', summary: error.message, completedAt: next.updatedAt, evidenceRefs: [evidenceRef] };
    appendTimeline(next, 'terminal', error.message, [evidenceRef], { deadlineScope: error.scope, timeoutMs: error.timeoutMs });
    const persisted = this.options.store.commit({ expectedRevision: current.revision, expectedEpoch: current.epoch, state: next });
    this.publish('goalagent.session.terminal', persisted, { outcome: 'timed_out', runtime: 'continuous_round_loop' });
    return persisted;
  }

  private deadlineFor(state: Readonly<GoalAgentStateV1>): { scope: GoalAgentDeadlineScope; timeoutMs: number } {
    const roundTimeoutMs = positiveTimeout(this.options.roundTimeoutMs, 120_000);
    if (this.options.sessionTimeoutMs === undefined) return { scope: 'node', timeoutMs: roundTimeoutMs };
    const sessionTimeoutMs = positiveTimeout(this.options.sessionTimeoutMs, 1_800_000);
    const remaining = sessionTimeoutMs - Math.max(0, this.nowMs() - Date.parse(state.createdAt));
    return remaining <= roundTimeoutMs
      ? { scope: 'session', timeoutMs: Math.max(1, remaining) }
      : { scope: 'node', timeoutMs: roundTimeoutMs };
  }

  private controllerFor(sessionId: string, epoch: number): AbortController {
    const existing = this.aborts.get(sessionId);
    if (existing?.epoch === epoch) return existing.controller;
    existing?.controller.abort();
    const controller = new AbortController();
    this.aborts.set(sessionId, { epoch, controller });
    return controller;
  }

  private abortActive(sessionId: string): void {
    this.aborts.get(sessionId)?.controller.abort();
  }

  private requireActive(sessionId: string): GoalAgentStateV1 {
    const state = this.options.store.getActive(sessionId);
    if (!state) throw new Error(`active GoalAgent session not found: ${sessionId}`);
    return state;
  }

  private requireExisting(sessionId: string): GoalAgentStateV1 {
    const state = this.options.store.get(sessionId);
    if (!state) throw new Error(`GoalAgent session not found: ${sessionId}`);
    return state;
  }

  private publish(type: string, state: GoalAgentStateV1, payload: Record<string, unknown>): void {
    this.options.publish?.({
      type,
      sessionId: state.sessionId,
      revision: state.revision,
      epoch: state.epoch,
      phase: state.phase,
      node: 'round',
      payload,
    });
  }

  private serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.locks.set(sessionId, tail);
    return current.finally(() => {
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId);
    });
  }
}

function roundInstruction(state: Readonly<GoalAgentStateV1>): string {
  return [
    `Current Step objective: ${roleFor(state)}.`,
    'Choose the next useful tool from the registered schemas based on the committed session history and current state snapshot.',
    'Simple tasks do not require a plan; use plan tools only when they materially help maintain multi-step work.',
    'A physical task cannot be completed by plain text. Only fresh receipts and the machine root verifier can commit completion.',
    'Treat typed failures as evidence: inspect, search relevant skills or capabilities when useful, and choose a materially different next action.',
    'Ask the owner only when required information is unavailable from tools and the owner must make a real choice.',
  ].join('\n');
}

function roleFor(state: Readonly<GoalAgentStateV1>): string {
  if (state.request.requestKind === 'query') return state.world.latest ? 'answer from observed facts' : 'observe query facts';
  if (!state.rootGoal) return 'understand and create the root goal';
  if (!state.world.latest) return 'observe the current world';
  if (state.action.result?.ok === false || state.verdict?.decision === 'revise_action' || state.verdict?.decision === 'replan') {
    return 'recover from typed failure evidence';
  }
  return state.plan.graph
    ? 'choose and execute the next real action for the maintained plan'
    : 'decide whether to act directly or maintain a multi-step plan';
}

function appendTimeline(
  state: GoalAgentStateV1,
  kind: GoalAgentStateV1['context']['timeline'][number]['kind'],
  summary: string,
  evidenceRefs: string[],
  data?: Record<string, unknown>,
): void {
  state.context.timeline.push({
    sequence: state.context.timeline.length + 1,
    node: 'round',
    phase: state.phase,
    kind,
    summary,
    stateRevision: state.revision,
    occurredAt: state.updatedAt,
    evidenceRefs: [...new Set(evidenceRefs)],
    ...(data ? { data: structuredClone(data) } : {}),
  });
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error('GoalAgent timeout must be positive');
  return resolved;
}
