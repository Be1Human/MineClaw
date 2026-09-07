import type { ModelContextProfileResolution } from '../../../../llm/modelContextProfile.js';
import type { CanonicalLlmMessage, CanonicalLlmTool } from './types.js';
import type { ExactModelRequest } from './apiCodec.js';
import {
  ContextBudgetPlanner,
  ContextBudgetPolicySnapshotter,
  type AgentContextPolicyConfigV1,
  type ContextBudgetDecisionV1,
  type FrozenContextBudgetPolicyV1,
} from './contextBudget.js';
import {
  RequestTokenMeter,
  type TokenMeasureReconciliation,
  type TokenMeasureV1,
} from './requestTokenMeter.js';

export type ContextSegmentKind = 'stable_system' | 'tool_catalog' | 'compaction_summary'
  | 'history_round' | 'retrieval' | 'dynamic_state' | 'current_instruction';

export interface ContextSegmentV1 {
  id: string;
  kind: ContextSegmentKind;
  retention: 'required' | 'compactable' | 'optional';
  atomicGroupId?: string;
  sourceRefs: readonly string[];
  messages: readonly CanonicalLlmMessage[];
}

export interface ContextCandidateV1 {
  segments: readonly ContextSegmentV1[];
  tools: readonly CanonicalLlmTool[];
  toolChoice?: 'auto' | 'none' | { name: string };
  temperature?: number;
  requestedOutputTokens: number;
}

export interface ContextReductionRequestV1 {
  candidate: Readonly<ContextCandidateV1>;
  policy: Readonly<FrozenContextBudgetPolicyV1>;
  decision: Readonly<ContextBudgetDecisionV1>;
  targetTokens: number;
  signal?: AbortSignal;
}

export type ContextReductionResultV1<TProposal = unknown> =
  | { kind: 'reduced'; segments: readonly ContextSegmentV1[]; proposal?: TProposal }
  | { kind: 'insufficient'; reason: string }
  | { kind: 'cancelled'; reason?: string };

export interface AgentContextReducer<TProposal = unknown> {
  reduce(request: Readonly<ContextReductionRequestV1>): Promise<ContextReductionResultV1<TProposal>>;
}

export interface PreparedGovernedRequest<TPrepared> {
  exact: Readonly<ExactModelRequest>;
  prepared: TPrepared;
}

export interface GovernedDispatchResult<TResult> {
  value: TResult;
  actualInputTokens?: number;
}

/** Transport owns codec and provider details; governance only consumes exact wire requests. */
export interface GovernedLlmTransport<TPrepared, TResult> {
  profile(): ModelContextProfileResolution;
  prepare(candidate: Readonly<ContextCandidateV1>): PreparedGovernedRequest<TPrepared>;
  dispatch(prepared: TPrepared, signal?: AbortSignal): Promise<GovernedDispatchResult<TResult>>;
}

export interface GovernanceReceiptV1 {
  profileId: string;
  policyRevision: string;
  measureBefore: Readonly<TokenMeasureV1>;
  measureAfter?: Readonly<TokenMeasureV1>;
  decision: Readonly<ContextBudgetDecisionV1>;
  reconciliation?: Readonly<TokenMeasureReconciliation>;
  reduced: boolean;
}

export type GovernedLlmResult<TResult, TProposal = unknown> =
  | { kind: 'completed'; result: TResult; receipt: Readonly<GovernanceReceiptV1>; proposal?: TProposal }
  | {
      kind: 'rejected' | 'cancelled' | 'failed';
      reason: string;
      detail?: string;
      decision?: Readonly<ContextBudgetDecisionV1>;
    };

export interface GovernedLlmPortOptions<TPrepared, TResult, TProposal> {
  purpose: string;
  policy: () => Readonly<AgentContextPolicyConfigV1>;
  transport: GovernedLlmTransport<TPrepared, TResult>;
  reducer?: AgentContextReducer<TProposal>;
  meter?: RequestTokenMeter;
  planner?: ContextBudgetPlanner;
  policySnapshotter?: ContextBudgetPolicySnapshotter;
}

/**
 * Enforces prepare → measure → plan → optional reduce → reprepare/remeasure → dispatch.
 * It never writes Agent state; reducer proposals are returned for an Agent-owned atomic commit.
 */
export class GovernedLlmPort<TPrepared, TResult, TProposal = unknown> {
  private readonly meter: RequestTokenMeter;
  private readonly planner: ContextBudgetPlanner;
  private readonly policySnapshotter: ContextBudgetPolicySnapshotter;

  constructor(private readonly options: GovernedLlmPortOptions<TPrepared, TResult, TProposal>) {
    this.meter = options.meter ?? new RequestTokenMeter();
    this.planner = options.planner ?? new ContextBudgetPlanner();
    this.policySnapshotter = options.policySnapshotter ?? new ContextBudgetPolicySnapshotter();
  }

  async call(candidate: Readonly<ContextCandidateV1>, signal?: AbortSignal): Promise<GovernedLlmResult<TResult, TProposal>> {
    if (signal?.aborted) return { kind: 'cancelled', reason: 'caller_abort' };
    const candidateProblem = validateCandidate(candidate);
    if (candidateProblem) return { kind: 'rejected', reason: 'context_candidate_invalid', detail: candidateProblem };

    const profileResolution = this.options.transport.profile();
    if (profileResolution.kind === 'unresolved') {
      return { kind: 'rejected', reason: 'model_context_profile_unresolved', detail: profileResolution.detail };
    }
    const policyResolution = this.policySnapshotter.snapshot(this.options.policy(), this.options.purpose);
    if (policyResolution.kind === 'unavailable') {
      return { kind: 'rejected', reason: 'context_budget_policy_unavailable', detail: policyResolution.detail };
    }
    const policy = policyResolution.policy;

    let prepared: PreparedGovernedRequest<TPrepared>;
    let requiredPrepared: PreparedGovernedRequest<TPrepared>;
    try {
      prepared = this.options.transport.prepare(candidate);
      requiredPrepared = this.options.transport.prepare(requiredCandidate(candidate));
    } catch (error) {
      return { kind: 'failed', reason: 'context_prepare_failed', detail: (error as Error).message };
    }
    if (signal?.aborted) return { kind: 'cancelled', reason: 'caller_abort' };

    const measured = this.meter.measure({ profile: profileResolution.profile, request: prepared.exact });
    if (measured.kind === 'unavailable') {
      return { kind: 'rejected', reason: 'token_meter_unavailable', detail: measured.detail };
    }
    const requiredMeasured = this.meter.measure({ profile: profileResolution.profile, request: requiredPrepared.exact });
    if (requiredMeasured.kind === 'unavailable') {
      return { kind: 'rejected', reason: 'token_meter_unavailable', detail: requiredMeasured.detail };
    }
    let decision = this.planner.plan({
      profile: profileResolution.profile,
      measure: measured.measure,
      policy,
      requestedOutputTokens: candidate.requestedOutputTokens,
      requiredSurfaceUpperBoundTokens: requiredMeasured.measure.upperBoundTokens,
    });
    if (decision.action === 'reject') return { kind: 'rejected', reason: decision.reason, decision };

    let finalPrepared = prepared;
    let measureAfter: Readonly<TokenMeasureV1> | undefined;
    let proposal: TProposal | undefined;
    if (decision.action === 'reduce') {
      if (!this.options.reducer) return { kind: 'rejected', reason: 'context_reducer_unavailable', decision };
      let reduction: ContextReductionResultV1<TProposal>;
      try {
        reduction = await this.options.reducer.reduce({ candidate, policy, decision, targetTokens: decision.targetTokens, signal });
      } catch (error) {
        return { kind: 'failed', reason: 'context_reducer_failed', detail: (error as Error).message, decision };
      }
      if (signal?.aborted || reduction.kind === 'cancelled') {
        return { kind: 'cancelled', reason: reduction.kind === 'cancelled' ? reduction.reason ?? 'reducer_cancelled' : 'caller_abort' };
      }
      if (reduction.kind === 'insufficient') {
        return { kind: 'rejected', reason: 'context_reduction_insufficient', detail: reduction.reason, decision };
      }
      const reductionProblem = validateReduction(candidate.segments, reduction.segments);
      if (reductionProblem) {
        return { kind: 'rejected', reason: 'context_reducer_contract_violation', detail: reductionProblem, decision };
      }
      const reducedCandidate = Object.freeze({ ...candidate, segments: Object.freeze([...reduction.segments]) });
      try {
        finalPrepared = this.options.transport.prepare(reducedCandidate);
      } catch (error) {
        return { kind: 'failed', reason: 'context_reprepare_failed', detail: (error as Error).message, decision };
      }
      if (signal?.aborted) return { kind: 'cancelled', reason: 'caller_abort' };
      const remeasured = this.meter.measure({ profile: profileResolution.profile, request: finalPrepared.exact });
      if (remeasured.kind === 'unavailable') {
        return { kind: 'rejected', reason: 'token_meter_unavailable', detail: remeasured.detail, decision };
      }
      measureAfter = remeasured.measure;
      decision = this.planner.plan({
        profile: profileResolution.profile,
        measure: measured.measure,
        measureAfter,
        policy,
        requestedOutputTokens: candidate.requestedOutputTokens,
        requiredSurfaceUpperBoundTokens: requiredMeasured.measure.upperBoundTokens,
      });
      if (decision.action !== 'keep') return { kind: 'rejected', reason: decision.reason, decision };
      proposal = reduction.proposal;
    }

    if (signal?.aborted) return { kind: 'cancelled', reason: 'caller_abort' };
    try {
      const dispatched = await this.options.transport.dispatch(finalPrepared.prepared, signal);
      const reconciliation = dispatched.actualInputTokens === undefined
        ? undefined
        : this.meter.reconcile(measureAfter ?? measured.measure, dispatched.actualInputTokens);
      return {
        kind: 'completed',
        result: dispatched.value,
        receipt: Object.freeze({
          profileId: profileResolution.profile.profileId,
          policyRevision: policy.revision,
          measureBefore: measured.measure,
          ...(measureAfter ? { measureAfter } : {}),
          decision,
          ...(reconciliation ? { reconciliation } : {}),
          reduced: Boolean(measureAfter),
        }),
        ...(proposal !== undefined ? { proposal } : {}),
      };
    } catch (error) {
      if (signal?.aborted) return { kind: 'cancelled', reason: 'caller_abort' };
      return { kind: 'failed', reason: 'provider_dispatch_failed', detail: (error as Error).message, decision };
    }
  }
}

function requiredCandidate(candidate: Readonly<ContextCandidateV1>): Readonly<ContextCandidateV1> {
  return Object.freeze({
    ...candidate,
    segments: Object.freeze(candidate.segments.filter(segment => segment.retention === 'required')),
  });
}

function validateCandidate(candidate: Readonly<ContextCandidateV1>): string | null {
  if (!Number.isSafeInteger(candidate.requestedOutputTokens) || candidate.requestedOutputTokens < 0) {
    return 'requestedOutputTokens must be a non-negative safe integer';
  }
  const ids = new Set<string>();
  for (const segment of candidate.segments) {
    if (!segment.id.trim()) return 'segment id is required';
    if (ids.has(segment.id)) return `duplicate segment id: ${segment.id}`;
    ids.add(segment.id);
    if (!Array.isArray(segment.messages) || !Array.isArray(segment.sourceRefs)) return `segment ${segment.id} has invalid arrays`;
  }
  return validateAtomicGroups(candidate.segments, candidate.segments);
}

function validateReduction(
  original: readonly ContextSegmentV1[],
  reduced: readonly ContextSegmentV1[],
): string | null {
  const originalById = new Map(original.map(segment => [segment.id, segment]));
  const reducedIds = new Set<string>();
  const retainedOriginalIds: string[] = [];
  for (const segment of reduced) {
    if (!segment.id.trim() || reducedIds.has(segment.id)) return `duplicate or empty reduced segment id: ${segment.id}`;
    reducedIds.add(segment.id);
    const source = originalById.get(segment.id);
    if (!source) {
      if (segment.kind !== 'compaction_summary') return `reducer added non-summary segment: ${segment.id}`;
      if (segment.retention === 'optional') return `summary segment cannot be optional: ${segment.id}`;
      if (!segment.sourceRefs.length) return `summary segment requires sourceRefs: ${segment.id}`;
      continue;
    }
    retainedOriginalIds.push(segment.id);
    if (fingerprint(source) !== fingerprint(segment)) return `reducer mutated retained segment: ${segment.id}`;
  }
  for (const segment of original) {
    if (segment.retention === 'required' && !reducedIds.has(segment.id)) return `reducer removed required segment: ${segment.id}`;
  }
  const expectedOrder = original.filter(segment => reducedIds.has(segment.id)).map(segment => segment.id);
  if (retainedOriginalIds.join('\u0000') !== expectedOrder.join('\u0000')) return 'reducer reordered original segments';
  return validateAtomicGroups(original, reduced);
}

function validateAtomicGroups(
  original: readonly ContextSegmentV1[],
  reduced: readonly ContextSegmentV1[],
): string | null {
  const reducedIds = new Set(reduced.map(segment => segment.id));
  const groups = new Map<string, string[]>();
  for (const segment of original) {
    if (!segment.atomicGroupId) continue;
    const members = groups.get(segment.atomicGroupId) ?? [];
    members.push(segment.id);
    groups.set(segment.atomicGroupId, members);
  }
  for (const [groupId, members] of groups) {
    const retained = members.filter(id => reducedIds.has(id));
    if (retained.length > 0 && retained.length !== members.length) return `atomic group split: ${groupId}`;
  }
  return null;
}

function fingerprint(segment: Readonly<ContextSegmentV1>): string {
  return JSON.stringify({
    id: segment.id,
    kind: segment.kind,
    retention: segment.retention,
    atomicGroupId: segment.atomicGroupId ?? null,
    sourceRefs: segment.sourceRefs,
    messages: segment.messages,
  });
}
