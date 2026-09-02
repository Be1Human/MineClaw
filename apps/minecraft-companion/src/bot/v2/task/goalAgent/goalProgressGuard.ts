import { createHash } from 'node:crypto';
import { jsonSnapshot } from '../../infra/jsonSnapshot.js';
import { tuning } from '../../infra/tuning.js';
import type { GoalProgressState } from '../contracts/goalProgress.js';
import { legacyProgressFacts } from './legacyProgressFacts.js';
import { observationIsFresh } from '../goalRunner/worldFactValidation.js';
import { stableJson } from './goalAgentJson.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';
import type { GoalProgressGuidance, GoalProgressPolicyPort } from './ports/goalProgressPort.js';

export function goalProgress(state: GoalAgentStateV1): GoalProgressState {
  return state.progress ??= { schema: 'mineclaw.goal-progress/v1', mode: 'running', rounds: 0, noProgressRounds: 0, totalNoProgressRounds: 0,
    recoveryAttempts: 0, recoveryStartedRound: 0, emptySearchStreak: 0, inactiveRounds: 0, sentFeedbackKinds: [], fingerprint: null,
    seenFingerprints: [], lastProgressAt: null, catalogVersion: '', waitStartedAt: null, waiting: null };
}

/** One deterministic guard on committed round state; not a second planner or runner. */
export class GoalProgressGuard {
  constructor(private readonly policy?: GoalProgressPolicyPort) {}

  afterRound(state: GoalAgentStateV1, now: number, catalogVersion: string, acted: boolean): string | null {
    const progress = goalProgress(state); progress.catalogVersion = catalogVersion;
    progress.rounds++; progress.inactiveRounds = acted ? 0 : progress.inactiveRounds + 1;
    if (state.terminal || state.phase === 'paused_owner' || state.mode !== 'planned_goal') return null;
    const cfg = tuning().goalProgress;
    if (!cfg.enabled) return null;
    if (!validConfig()) return this.fail(state, 'invalid_progress_guard_configuration', now);
    const fingerprint = this.fingerprint(state);
    const fresh = fingerprint !== progress.fingerprint && !progress.seenFingerprints.includes(fingerprint);
    const initialized = progress.fingerprint !== null;
    progress.fingerprint = fingerprint;
    if (fresh) {
      if (progress.seenFingerprints.length >= cfg.maxFingerprints) return this.fail(state, 'progress_history_budget_exceeded', now);
      progress.seenFingerprints.push(fingerprint);
      if (initialized) {
        progress.noProgressRounds = 0; progress.lastProgressAt = now; progress.mode = 'running'; progress.waiting = null;
        return 'meaningful_progress';
      }
    }
    progress.noProgressRounds++; progress.totalNoProgressRounds++;
    if (progress.mode === 'recovery' && progress.rounds - progress.recoveryStartedRound < cfg.recoveryRounds) return null;
    if (progress.noProgressRounds < cfg.noProgressRounds) return null;
    const guidance = this.guidance(state);
    if (guidance) return this.applyGuidance(state, guidance, now);
    if (progress.recoveryAttempts >= cfg.maxRecoveryAttempts || state.budget.recoveries >= state.budget.maxRecoveries) {
      return this.fail(state, 'no_validated_path_after_bounded_recovery', now);
    }
    progress.mode = 'recovery'; progress.recoveryAttempts++; progress.recoveryStartedRound = progress.rounds;
    state.budget.recoveries++;
    state.verdict = { decision: 'replan', summary: '重复尝试没有可验证进展；进入有界恢复，须尝试不同的合法路径。',
      machineCriteriaSatisfied: false, ownerActionable: false, retryable: true, evidenceRefs: ['goalagent:no_progress'] };
    return 'bounded_recovery';
  }

  pollWaiting(state: GoalAgentStateV1, now: number): string | null {
    const progress = goalProgress(state), wait = progress.waiting;
    if (!wait || state.terminal) return null;
    if (!validConfig()) return this.fail(state, 'invalid_progress_guard_configuration', now);
    const cfg = tuning().goalProgress;
    wait.deadlineAt = Math.min(wait.deadlineAt, progress.waitStartedAt! + cfg.maxWaitMs);
    if (now >= wait.deadlineAt || wait.checks >= cfg.maxWaitChecks) return this.fail(state, 'world_wait_budget_exhausted', now, wait.evidenceRefs);
    wait.checks++;
    const fingerprint = this.fingerprint(state);
    const guidance = this.guidance(state);
    if (guidance && guidance.kind !== 'wait') return this.applyGuidance(state, guidance, now);
    if (fingerprint !== wait.fingerprint && !progress.seenFingerprints.includes(fingerprint)) {
      if (progress.seenFingerprints.length >= cfg.maxFingerprints) return this.fail(state, 'progress_history_budget_exceeded', now);
      progress.fingerprint = fingerprint; progress.seenFingerprints.push(fingerprint); progress.noProgressRounds = 0;
      progress.lastProgressAt = now; progress.mode = 'running'; progress.waiting = null;
      return 'wait_observed_progress';
    }
    wait.nextCheckAt = Math.min(now + cfg.waitPollMs, wait.deadlineAt);
    return 'wait_checked_no_progress';
  }

  private guidance(state: Readonly<GoalAgentStateV1>): GoalProgressGuidance | null {
    return this.policy?.assess(state) ?? null;
  }

  private applyGuidance(state: GoalAgentStateV1, guidance: GoalProgressGuidance, now: number): string {
    const progress = goalProgress(state);
    if (!guidance.reason?.trim() || !guidance.evidenceRefs?.length) return this.fail(state, 'progress_guidance_without_evidence', now);
    if (guidance.kind === 'unsupported') return this.fail(state, `unsupported_capability:${guidance.reason}`, now, guidance.evidenceRefs);
    if (guidance.kind === 'needs_owner') {
      if (!guidance.question.trim()) return this.fail(state, 'owner_guidance_without_question', now);
      progress.mode = 'paused_owner'; progress.waiting = null; state.phase = 'paused_owner';
      state.owner = { question: guidance.question, answer: null, requestedAt: new Date(now).toISOString(), answeredAt: null };
      state.interpretation.clarificationReason = guidance.reason;
      state.verdict = { decision: 'need_owner', summary: guidance.reason, machineCriteriaSatisfied: false, ownerActionable: true, retryable: true, evidenceRefs: [...guidance.evidenceRefs] };
      return 'scope_requires_owner';
    }
    if (!state.rootGoal || !state.world.latest || !guidance.key.trim()
      || !observationIsFresh(state.world.latest.timestamp, now, tuning().goalEvidence.maxWorldAgeMs)
      || !observationIsFresh(guidance.observedAt, now, tuning().goalEvidence.maxWorldAgeMs)) return this.fail(state, 'world_wait_requires_fresh_supported_condition', now);
    const cfg = tuning().goalProgress;
    progress.waitStartedAt ??= now;
    const deadlineAt = progress.waitStartedAt + cfg.maxWaitMs;
    if (now >= deadlineAt) return this.fail(state, 'world_wait_budget_exhausted', now, guidance.evidenceRefs);
    progress.mode = 'waiting_world';
    progress.waiting = { key: guidance.key, reason: guidance.reason, fingerprint: this.fingerprint(state), deadlineAt,
      nextCheckAt: Math.min(now + cfg.waitPollMs, deadlineAt), checks: progress.waiting?.checks ?? 0, evidenceRefs: [...guidance.evidenceRefs] };
    state.verdict = { decision: 'continue', summary: guidance.reason, machineCriteriaSatisfied: false, ownerActionable: false, retryable: true, evidenceRefs: [...guidance.evidenceRefs] };
    return 'bounded_world_wait';
  }

  private fingerprint(state: Readonly<GoalAgentStateV1>): string {
    const completed = state.plan.graph?.nodes.filter(node => node.state === 'satisfied').map(node => node.goal.metadata?.structuredSuccessCriteria ?? node.postconditions) ?? [];
    return createHash('sha256').update(stableJson({ root: state.goal.signature?.key ?? state.rootGoal ?? state.requestId,
      catalog: state.progress?.catalogVersion ?? '', completed: completed.map(stableJson).sort(),
      facts: stripTelemetry(this.policy?.project(state) ?? legacyProgressFacts(state)),
    })).digest('hex');
  }

  private fail(state: GoalAgentStateV1, reason: string, now: number, refs: string[] = []): string {
    const progress = goalProgress(state); progress.mode = 'failed'; progress.waiting = null;
    const evidenceRefs = [...new Set(['goalagent:no_progress', ...refs])];
    state.phase = 'failed'; state.activeNode = 'round';
    state.verdict = { decision: 'fail', summary: reason, machineCriteriaSatisfied: false, ownerActionable: false, retryable: false, evidenceRefs };
    state.terminal = { outcome: 'failed', summary: reason, completedAt: new Date(now).toISOString(), evidenceRefs };
    return reason;
  }
}

function validConfig(): boolean {
  const cfg = tuning().goalProgress;
  return [cfg.noProgressRounds, cfg.recoveryRounds, cfg.maxRecoveryAttempts, cfg.maxFingerprints, cfg.waitPollMs, cfg.maxWaitMs, cfg.maxWaitChecks, cfg.waitObservationTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0);
}

/** Freshness is validated elsewhere; changing an observation clock is not task progress. */
function stripTelemetry(value: unknown): unknown {
  if (value === undefined) return null;
  const detached = jsonSnapshot(value);
  const strip = (item: any): any => Array.isArray(item) ? item.map(strip) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).filter(([key]) => !['tick', 'timestamp', 'observedAt', 'evidenceRefs', 'receiptId', 'planRevision'].includes(key)).map(([key, content]) => [key, strip(content)])) : item;
  return strip(detached);
}
