import type { ActionProposal } from '../../atomic/contracts/atomicContractRegistry.js';
import type { GoalRequestV2 } from '../../decision/goalAgentPort/contracts.js';
import type { WorldStateView } from '../../types.js';
import type { GoalContractV1 } from '../contracts/goalContract.js';
import { assertGoalContractV2, type GoalContractV2 } from '../contracts/goalContractV2.js';
import type { WorldFactRequest } from '../contracts/worldFact.js';
import type { GoalProgressState } from '../contracts/goalProgress.js';
import type { FailureEnvelope } from '../contracts/failureEnvelope.js';
import type { PlannerExperienceBundle } from '../planner/experience/plannerExperienceProvider.js';
import type { GoalTargetCandidate } from '../../knowledge/goalTargetKnowledge.js';
import type {
  CommittedAgentGoal,
  ContextSignature,
  GoalSignature,
  PlanGraph,
} from '../planner/plannerContracts.js';

/** Current Step objective metadata; roles never own routing or context. */
export type GoalAgentStepRole =
  | 'understand'
  | 'plan'
  | 'act'
  | 'evaluate'
  | 'recover'
  | 'query'
  | 'monitor';

export type GoalAgentStepOutcomeKind =
  | 'goal_draft'
  | 'plan_proposal'
  | 'action_proposal'
  | 'evaluation_advice'
  | 'recovery_proposal'
  | 'query_result'
  | 'monitoring_advice';

export type GoalAgentEventSource = GoalAgentNodeId | GoalAgentStepRole;

export const GOAL_AGENT_STATE_SCHEMA_V1 = 'mineclaw.goal-agent-state/v1' as const;
export const GOAL_AGENT_STATE_SCHEMA_V2 = 'mineclaw.goal-agent-state/v2' as const;

export type GoalAgentSessionMode = 'planned_goal' | 'persistent_monitor';

export type GoalAgentPhase =
  | 'ingress'
  | 'running'
  | 'paused_owner'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type GoalAgentNodeId =
  | 'ingress'
  | 'round'
  | 'terminal';

export type GoalAgentCriticDecision =
  | 'continue'
  | 'revise_action'
  | 'replan'
  | 'need_owner'
  | 'complete'
  | 'fail';

export interface GoalAgentCriticVerdict {
  decision: GoalAgentCriticDecision;
  summary: string;
  machineCriteriaSatisfied: boolean;
  ownerActionable: boolean;
  retryable: boolean;
  evidenceRefs: string[];
  hint?: string;
}

export interface GoalAgentActionResult {
  executionSessionId: string;
  idempotencyKey: string;
  ok: boolean;
  detail: string;
  startedAt: string;
  completedAt: string;
  failure?: FailureEnvelope;
  evidenceRefs: string[];
}

export interface GoalAgentTimelineEntry {
  sequence: number;
  node: GoalAgentEventSource;
  phase: GoalAgentPhase;
  kind: 'transition' | 'model_call' | 'tool_call' | 'observation' | 'verdict' | 'terminal';
  summary: string;
  stateRevision: number;
  occurredAt: string;
  evidenceRefs: string[];
  data?: Record<string, unknown>;
}

export interface GoalAgentPlanRevision {
  revision: number;
  graph: PlanGraph;
  reason: 'initial' | 'plan_critic' | 'execution_replan';
  createdAt: string;
}

export interface GoalAgentBudget {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  actions: number;
  recoveries: number;
  graphReplans: number;
  maxLlmCalls: number;
  /** Null keeps cumulative token telemetry without using it as a terminal gate. */
  maxTotalTokens: number | null;
  maxActions: number;
  maxRecoveries: number;
  maxGraphReplans: number;
}

export interface GoalAgentTerminal {
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  summary: string;
  completedAt: string;
  evidenceRefs: string[];
  reportId?: string;
  experienceProposalId?: string;
}

export interface GoalAgentStateV1 {
  schema: typeof GOAL_AGENT_STATE_SCHEMA_V1 | typeof GOAL_AGENT_STATE_SCHEMA_V2;
  mode: GoalAgentSessionMode;
  /** Registry Generation pinned by the compiled goal; absent on pre-plugin legacy records (needs_rebind). */
  snapshotRef?: import('../../plugin-sdk/identity.js').RegistrySnapshotRef;
  sessionId: string;
  interactionSessionId: string;
  requestId: string;
  epoch: number;
  revision: number;
  phase: GoalAgentPhase;
  activeNode: GoalAgentNodeId;
  createdAt: string;
  updatedAt: string;

  cognition: {
    activeNode: GoalAgentStepRole | null;
    objective: string;
    nodeTurn: number;
    outcomeKind: GoalAgentStepOutcomeKind | null;
    contextDigest: string;
    memoryRefs: string[];
    knowledgeRefs: string[];
    evidenceRefs: string[];
    toolTraceRefs: string[];
  };

  request: GoalRequestV2;
  rootGoal: GoalContractV1 | GoalContractV2 | null;
  interpretation: {
    candidates: GoalTargetCandidate[];
    evidenceRefs: string[];
    attempts: number;
    lastValidationError: string | null;
    clarificationReason: string | null;
  };
  goal: {
    definition: CommittedAgentGoal | null;
    signature: GoalSignature | null;
    context: ContextSignature | null;
  };
  world: {
    latest: WorldStateView | null;
    beforeAction: WorldStateView | null;
    observedAt: string | null;
    factRequests?: readonly WorldFactRequest[];
  };
  experience: {
    bundle: PlannerExperienceBundle | null;
    refs: string[];
    frozenAt: string | null;
  };
  plan: {
    graph: PlanGraph | null;
    revision: number;
    activeNodeId: string | null;
    history: GoalAgentPlanRevision[];
  };
  action: {
    proposal: ActionProposal | null;
    result: GoalAgentActionResult | null;
    executionSessionId: string | null;
    idempotencyKey: string | null;
  };
  verdict: GoalAgentCriticVerdict | null;
  context: {
    /** Human-facing sparse projection only; model messages live exclusively in SessionEventLog. */
    timeline: GoalAgentTimelineEntry[];
  };
  budget: GoalAgentBudget;
  /** Optional for pre-guard checkpoints; once present, never reset by slicing or replay. */
  progress?: GoalProgressState;
  owner: {
    question: string | null;
    answer: string | null;
    requestedAt: string | null;
    answeredAt: string | null;
  };
  terminal: GoalAgentTerminal | null;
}

export interface CreateGoalAgentStateInput {
  sessionId: string;
  interactionSessionId: string;
  request: GoalRequestV2;
  mode?: GoalAgentSessionMode;
  now?: string;
  /** P1-3 · 插件代快照；缺失=dashboard 前旧记录，执行链按 needs_rebind 处理。 */
  snapshotRef?: import('../../plugin-sdk/identity.js').RegistrySnapshotRef;
  budget?: Partial<Pick<GoalAgentBudget,
    'maxLlmCalls' | 'maxTotalTokens' | 'maxActions' | 'maxRecoveries' | 'maxGraphReplans'>>;
}

const TERMINAL_PHASES = new Set<GoalAgentPhase>(['completed', 'failed', 'cancelled', 'timed_out']);

export function createGoalAgentState(input: CreateGoalAgentStateInput): GoalAgentStateV1 {
  const sessionId = input.sessionId.trim();
  const interactionSessionId = input.interactionSessionId.trim();
  const requestId = input.request.meta.messageId.trim();
  if (!sessionId) throw new Error('GoalAgent sessionId is required');
  if (!interactionSessionId) throw new Error('GoalAgent interactionSessionId is required');
  if (!requestId) throw new Error('GoalAgent requestId is required');
  const now = input.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error('GoalAgent now is invalid');

  const state: GoalAgentStateV1 = {
    schema: GOAL_AGENT_STATE_SCHEMA_V1,
    mode: input.mode ?? 'planned_goal',
    ...(input.snapshotRef ? { snapshotRef: structuredClone(input.snapshotRef) } : {}),
    sessionId,
    interactionSessionId,
    requestId,
    epoch: 1,
    revision: 0,
    phase: 'ingress',
    activeNode: 'ingress',
    createdAt: now,
    updatedAt: now,
    cognition: {
      activeNode: null, objective: '', nodeTurn: 0, outcomeKind: null,
      contextDigest: '', memoryRefs: [], knowledgeRefs: [], evidenceRefs: [], toolTraceRefs: [],
    },
    request: structuredClone(input.request),
    rootGoal: null,
    interpretation: {
      candidates: [],
      evidenceRefs: [],
      attempts: 0,
      lastValidationError: null,
      clarificationReason: null,
    },
    goal: { definition: null, signature: null, context: null },
    world: { latest: null, beforeAction: null, observedAt: null },
    experience: { bundle: null, refs: [], frozenAt: null },
    plan: { graph: null, revision: 0, activeNodeId: null, history: [] },
    action: { proposal: null, result: null, executionSessionId: null, idempotencyKey: null },
    verdict: null,
    context: { timeline: [] },
    budget: {
      llmCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      actions: 0,
      recoveries: 0,
      graphReplans: 0,
      maxLlmCalls: positiveInteger(input.budget?.maxLlmCalls, 80, 'maxLlmCalls'),
      maxTotalTokens: nullablePositiveInteger(input.budget?.maxTotalTokens, null, 'maxTotalTokens'),
      maxActions: positiveInteger(input.budget?.maxActions, 80, 'maxActions'),
      maxRecoveries: positiveInteger(input.budget?.maxRecoveries, 12, 'maxRecoveries'),
      maxGraphReplans: positiveInteger(input.budget?.maxGraphReplans, 6, 'maxGraphReplans'),
    },
    owner: { question: null, answer: null, requestedAt: null, answeredAt: null },
    terminal: null,
  };
  assertGoalAgentStateV1(state);
  return state;
}

export function assertGoalAgentStateV1(state: GoalAgentStateV1): void {
  if (state.schema !== GOAL_AGENT_STATE_SCHEMA_V1 && state.schema !== GOAL_AGENT_STATE_SCHEMA_V2) throw new Error(`unsupported GoalAgent state schema: ${state.schema}`);
  if (state.rootGoal && !['mineclaw.goal/v1', 'mineclaw.goal/v2'].includes(state.rootGoal.schema)) throw new Error('unsupported_goal_contract_schema');
  if (state.rootGoal?.schema === 'mineclaw.goal/v2') {
    if (state.schema !== GOAL_AGENT_STATE_SCHEMA_V2) throw new Error('composed_goal_requires_state_v2');
    assertGoalContractV2(state.rootGoal);
  } else if (state.schema === GOAL_AGENT_STATE_SCHEMA_V2) throw new Error('state_v2_requires_composed_goal');
  if (state.mode !== 'planned_goal' && state.mode !== 'persistent_monitor') {
    throw new Error(`unsupported GoalAgent session mode: ${String(state.mode)}`);
  }
  for (const [field, value] of [
    ['sessionId', state.sessionId],
    ['interactionSessionId', state.interactionSessionId],
    ['requestId', state.requestId],
  ] as const) {
    if (!value.trim()) throw new Error(`GoalAgent ${field} is required`);
  }
  if (!Number.isInteger(state.epoch) || state.epoch < 1) throw new Error('GoalAgent epoch must be >= 1');
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error('GoalAgent revision must be >= 0');
  if (!['ingress', 'running', 'paused_owner', 'completed', 'failed', 'cancelled', 'timed_out'].includes(state.phase)) {
    throw new Error(`unsupported GoalAgent phase: ${String(state.phase)}`);
  }
  if (!['ingress', 'round', 'terminal'].includes(state.activeNode)) {
    throw new Error(`unsupported GoalAgent activeNode: ${String(state.activeNode)}`);
  }
  if (!Number.isInteger(state.cognition.nodeTurn) || state.cognition.nodeTurn < 0) {
    throw new Error('GoalAgent cognition nodeTurn must be a non-negative integer');
  }
  if (Number.isNaN(Date.parse(state.createdAt)) || Number.isNaN(Date.parse(state.updatedAt))) {
    throw new Error('GoalAgent timestamps are invalid');
  }
  if (TERMINAL_PHASES.has(state.phase) !== Boolean(state.terminal)) {
    throw new Error('GoalAgent terminal payload and phase must agree');
  }
  if (!Number.isInteger(state.interpretation.attempts) || state.interpretation.attempts < 0) {
    throw new Error('GoalAgent interpretation attempts must be a non-negative integer');
  }
  if (state.plan.revision < 0 || !Number.isInteger(state.plan.revision)) throw new Error('plan revision must be >= 0');
  if (state.plan.graph && state.plan.revision < 1) throw new Error('a planned graph requires plan revision >= 1');
  if (!state.plan.graph && state.plan.activeNodeId) throw new Error('an active plan node requires a plan graph');
  assertBudget(state.budget);
  if (state.progress) {
    if (state.progress.schema !== 'mineclaw.goal-progress/v1') throw new Error('unsupported_progress_schema');
    for (const key of ['rounds', 'noProgressRounds', 'totalNoProgressRounds', 'recoveryAttempts', 'recoveryStartedRound', 'emptySearchStreak', 'inactiveRounds'] as const) {
      if (!Number.isSafeInteger(state.progress[key]) || state.progress[key] < 0) throw new Error(`invalid_progress_counter:${key}`);
    }
    if (!Array.isArray(state.progress.seenFingerprints) || !Array.isArray(state.progress.sentFeedbackKinds)) throw new Error('invalid_progress_history');
    if (!['running', 'recovery', 'waiting_world', 'paused_owner', 'failed'].includes(state.progress.mode)) throw new Error('invalid_progress_mode');
    if (state.progress.mode === 'waiting_world' && !state.progress.waiting) throw new Error('waiting_condition_missing');
    if (state.progress.waiting && (![state.progress.waiting.nextCheckAt, state.progress.waiting.deadlineAt, state.progress.waitStartedAt].every(value => typeof value === 'number' && Number.isFinite(value))
      || !Number.isSafeInteger(state.progress.waiting.checks) || state.progress.waiting.checks < 0 || !state.progress.waiting.key)) throw new Error('invalid_wait_condition');
  }
  assertTimeline(state.context.timeline, state.revision);
}

/** Upgrade persisted pre-Interpret checkpoints without changing their identity or revision. */
export function migrateGoalAgentStateV1(state: GoalAgentStateV1): GoalAgentStateV1 {
  // v2 never enters the permissive legacy migration that can clear an old goal.
  if (state.schema === GOAL_AGENT_STATE_SCHEMA_V2) { assertGoalAgentStateV1(state); return state; }
  const legacy = state as GoalAgentStateV1 & {
    mode?: GoalAgentSessionMode;
    interpretation?: GoalAgentStateV1['interpretation'];
    cognition?: GoalAgentStateV1['cognition'];
    context: GoalAgentStateV1['context'] & {
      messages?: unknown[];
      eventCursor?: number;
      summary?: string;
    };
    goal?: GoalAgentStateV1['goal'];
    reflection?: unknown;
  };
  if (!legacy.mode) legacy.mode = 'planned_goal';
  if (state.budget.maxTotalTokens === undefined) state.budget.maxTotalTokens = null;
  if (!legacy.cognition) {
    legacy.cognition = {
      activeNode: null, objective: '', nodeTurn: 0, outcomeKind: null,
      contextDigest: '', memoryRefs: [], knowledgeRefs: [], evidenceRefs: [], toolTraceRefs: [],
    };
  }
  if (!legacy.interpretation) {
    legacy.interpretation = {
      candidates: [],
      evidenceRefs: [],
      attempts: 0,
      lastValidationError: null,
      clarificationReason: null,
    };
  }
  delete (legacy.interpretation as GoalAgentStateV1['interpretation'] & { draft?: unknown }).draft;
  if (!legacy.goal) {
    legacy.goal = { definition: null, signature: null, context: null };
    if (!state.terminal && state.mode === 'planned_goal') {
      state.phase = 'ingress';
      state.activeNode = 'ingress';
      state.rootGoal = null;
      state.plan = { graph: null, revision: 0, activeNodeId: null, history: [] };
      state.action = { proposal: null, result: null, executionSessionId: null, idempotencyKey: null };
      state.verdict = null;
    }
  }
  delete legacy.context.messages;
  delete legacy.context.eventCursor;
  delete legacy.context.summary;
  delete legacy.reflection;
  const legacyPhase = String(state.phase);
  if (!['ingress', 'running', 'paused_owner', 'completed', 'failed', 'cancelled', 'timed_out'].includes(legacyPhase)) {
    state.phase = 'running';
  }
  const legacyNode = String(state.activeNode);
  if (!['ingress', 'round', 'terminal'].includes(legacyNode)) state.activeNode = 'round';
  if (state.terminal) state.activeNode = 'round';
  return state;
}

export function cloneGoalAgentState(state: GoalAgentStateV1): GoalAgentStateV1 {
  assertGoalAgentStateV1(state);
  return structuredClone(state);
}

export function isGoalAgentTerminalPhase(phase: GoalAgentPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${field} must be a positive integer`);
  return resolved;
}

function assertBudget(budget: GoalAgentBudget): void {
  for (const [field, value] of Object.entries(budget)) {
    if (field === 'maxTotalTokens' && value === null) continue;
    if (!Number.isInteger(value) || value < 0) throw new Error(`GoalAgent budget ${field} must be a non-negative integer`);
  }
  if (budget.maxLlmCalls < 1 || (budget.maxTotalTokens !== null && budget.maxTotalTokens < 1) || budget.maxActions < 1
    || budget.maxRecoveries < 1 || budget.maxGraphReplans < 1) {
    throw new Error('GoalAgent budget limits must be positive');
  }
}

function nullablePositiveInteger(
  value: number | null | undefined,
  fallback: number | null,
  field: string,
): number | null {
  const resolved = value === undefined ? fallback : value;
  if (resolved === null) return null;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${field} must be null or a positive integer`);
  return resolved;
}

function assertTimeline(timeline: GoalAgentTimelineEntry[], revision: number): void {
  let previousSequence = 0;
  for (const entry of timeline) {
    if (!Number.isInteger(entry.sequence) || entry.sequence !== previousSequence + 1) {
      throw new Error('GoalAgent timeline sequence must be contiguous');
    }
    if (entry.stateRevision > revision) throw new Error('GoalAgent timeline cannot reference a future revision');
    previousSequence = entry.sequence;
  }
}
