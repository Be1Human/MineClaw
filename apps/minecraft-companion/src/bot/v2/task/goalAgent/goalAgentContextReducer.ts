import { createHash } from 'node:crypto';
import type {
  AgentContextReducer,
  ContextReductionRequestV1,
  ContextReductionResultV1,
  ContextSegmentV1,
} from '../../cognitive/llm/contextGovernance.js';
import type { CanonicalLlmMessage } from '../../cognitive/llm/types.js';
import type { GoalAgentStateV1 } from './goalAgentState.js';

export const GOAL_AGENT_COMPACTION_SCHEMA_V2 = 'mineclaw.goalagent-compaction/v2' as const;

export interface GoalAgentStructuredSummaryV2 {
  goal: {
    request: string;
    rootGoal: string | null;
    constraints: unknown[];
    successCriteria: unknown[];
  };
  plan: {
    revision: number;
    activeTask: string | null;
    completedTasks: string[];
    pendingTasks: string[];
  };
  attempts: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
  receiptEvidence: { refs: string[]; omitted: number; digest?: string };
  waiting: unknown;
  cancellation: { requested: boolean; reason?: string };
  budget: GoalAgentStateV1['budget'];
  compacted: { messages: number; sourceDigest: string };
}

export interface GoalAgentCompactionDraftV2 {
  schema: typeof GOAL_AGENT_COMPACTION_SCHEMA_V2;
  throughMessageIndex: number;
  coveredEventSeq: { from: number; through: number };
  summary: GoalAgentStructuredSummaryV2;
  omittedMessages: number;
  sourceDigest: string;
}

export interface GoalAgentCompactionProposalV2 extends GoalAgentCompactionDraftV2 {
  profileRef: string;
  policyRevision: string;
  tokensBefore: number;
  tokensAfter: number;
}

export class GoalAgentContextReducer implements AgentContextReducer<GoalAgentCompactionDraftV2> {
  constructor(private readonly state: Readonly<GoalAgentStateV1>) {}

  async reduce(
    request: Readonly<ContextReductionRequestV1>,
  ): Promise<ContextReductionResultV1<GoalAgentCompactionDraftV2>> {
    if (request.signal?.aborted) return { kind: 'cancelled', reason: 'caller_abort' };
    const history = request.candidate.segments.filter(segment => segment.kind === 'history_round');
    const optional = request.candidate.segments.filter(segment => segment.retention === 'optional');
    const protectedIds = newestHistoryFloor(history, request.policy.minimumRecentHistoryTokens);
    const removableHistory = history.filter(segment => !protectedIds.has(segment.id));
    const removed = new Set(optional.map(segment => segment.id));
    const previousSummary = request.candidate.segments.find(segment => segment.kind === 'compaction_summary');
    let draft: GoalAgentCompactionDraftV2 | undefined;

    for (const segment of removableHistory) {
      if (request.signal?.aborted) return { kind: 'cancelled', reason: 'caller_abort' };
      removed.add(segment.id);
      if (previousSummary) removed.add(previousSummary.id);
      const compacted = request.candidate.segments.filter(value => removed.has(value.id) && value.retention === 'compactable');
      draft = buildDraft(this.state, compacted, request.policy.maxSummaryTokens);
      const remaining = request.candidate.segments.filter(value => !removed.has(value.id));
      const projected = Math.max(0,
        request.decision.measuredBeforeTokens
        - [...removed].map(id => request.candidate.segments.find(value => value.id === id)).filter(Boolean)
          .reduce((total, value) => total + segmentUpperBound(value!), 0)
        + summaryUpperBound(draft.summary));
      if (projected <= request.targetTokens) break;
    }

    if (!draft && removed.size === 0) return { kind: 'insufficient', reason: 'minimum_recent_history_floor_prevents_reduction' };
    const retained = request.candidate.segments.filter(segment => !removed.has(segment.id));
    if (draft) {
      const summarySegment: ContextSegmentV1 = Object.freeze({
        id: `goalagent:compaction:v2:${draft.throughMessageIndex}:${draft.sourceDigest.slice(0, 12)}`,
        kind: 'compaction_summary',
        retention: 'compactable',
        sourceRefs: Object.freeze([
          `goalagent:message-through:${draft.throughMessageIndex}`,
          `goalagent:event-range:${draft.coveredEventSeq.from}-${draft.coveredEventSeq.through}`,
          `goalagent:source-digest:${draft.sourceDigest}`,
        ]),
        messages: Object.freeze([{ role: 'system' as const, content: [{ kind: 'text' as const, text: renderGoalAgentCompactionSummary(draft.summary) }] }]),
      });
      retained.splice(Math.min(1, retained.length), 0, summarySegment);
    }
    return { kind: 'reduced', segments: retained, ...(draft ? { proposal: draft } : {}) };
  }
}

export function renderGoalAgentCompactionSummary(summary: GoalAgentStructuredSummaryV2): string {
  return `[GoalAgent compaction/v2]\n${JSON.stringify(summary)}`;
}

function newestHistoryFloor(history: readonly ContextSegmentV1[], minimumTokens: number): Set<string> {
  const protectedIds = new Set<string>();
  let tokens = 0;
  for (let index = history.length - 1; index >= 0 && tokens < minimumTokens; index -= 1) {
    protectedIds.add(history[index].id);
    tokens += segmentUpperBound(history[index]);
  }
  return protectedIds;
}

function buildDraft(
  state: Readonly<GoalAgentStateV1>,
  compacted: readonly ContextSegmentV1[],
  maxSummaryTokens: number,
): GoalAgentCompactionDraftV2 {
  const sourceRefs = compacted.flatMap(segment => segment.sourceRefs);
  const messageRefs = sourceRefs.map(parseMessageRef).filter((value): value is { messageIndex: number; eventSeq: number } => Boolean(value));
  const previousRange = sourceRefs.map(parseEventRange).find(Boolean);
  if (messageRefs.length === 0 && !previousRange) throw new Error('GoalAgent compaction requires durable message/event source refs');
  const throughMessageIndex = Math.max(
    previousThrough(sourceRefs),
    ...messageRefs.map(value => value.messageIndex + 1),
  );
  const eventSeqs = messageRefs.map(value => value.eventSeq);
  if (previousRange) eventSeqs.push(previousRange.from, previousRange.through);
  else if (previousThrough(sourceRefs) > 0) eventSeqs.push(1);
  const sourceDigest = digest(JSON.stringify(compacted.map(segment => ({
    id: segment.id, sourceRefs: segment.sourceRefs, messages: segment.messages,
  }))));
  const previous = previousStructuredSummary(compacted);
  const messages = compacted.flatMap(segment => segment.kind === 'history_round' ? segment.messages : []);
  const attempts = mergeAttempts(previous?.attempts ?? [], messages);
  const failures = mergeFailures(previous?.failures ?? [], attempts);
  const evidence = unique([
    ...(previous?.receiptEvidence.refs ?? []),
    ...evidenceFromMessages(messages),
    ...state.interpretation.evidenceRefs,
    ...(state.action.result?.evidenceRefs ?? []),
    ...(state.verdict?.evidenceRefs ?? []),
  ]);
  const active = state.plan.graph?.nodes.find(node => node.id === state.plan.activeNodeId);
  const summary: GoalAgentStructuredSummaryV2 = {
    goal: {
      request: bounded(state.request.requestText),
      rootGoal: state.rootGoal ? bounded(state.rootGoal.goalText) : null,
      constraints: [...structuredClone(state.rootGoal?.constraints ?? state.request.constraints ?? [])],
      successCriteria: [...structuredClone(state.rootGoal?.successCriteria ?? [])],
    },
    plan: {
      revision: state.plan.revision,
      activeTask: active?.goal.goalText ?? state.plan.activeNodeId ?? null,
      completedTasks: state.plan.graph?.nodes.filter(node => node.state === 'satisfied').map(node => node.id) ?? [],
      pendingTasks: state.plan.graph?.nodes.filter(node => !['satisfied', 'cancelled'].includes(node.state)).map(node => node.id) ?? [],
    },
    attempts,
    failures,
    receiptEvidence: { refs: evidence, omitted: previous?.receiptEvidence.omitted ?? 0 },
    waiting: structuredClone(state.progress?.waiting ?? null),
    cancellation: {
      requested: state.request.requestKind === 'cancel' || state.phase === 'cancelled',
      ...(state.terminal?.outcome === 'cancelled' ? { reason: bounded(state.terminal.summary) } : {}),
    },
    budget: structuredClone(state.budget),
    compacted: {
      messages: (previous?.compacted.messages ?? 0) + messages.length,
      sourceDigest,
    },
  };
  fitSummary(summary, maxSummaryTokens);
  return {
    schema: GOAL_AGENT_COMPACTION_SCHEMA_V2,
    throughMessageIndex,
    coveredEventSeq: { from: Math.min(...eventSeqs), through: Math.max(...eventSeqs) },
    summary,
    omittedMessages: messages.length,
    sourceDigest,
  };
}

function previousStructuredSummary(compacted: readonly ContextSegmentV1[]): Pick<GoalAgentStructuredSummaryV2,
  'attempts' | 'failures' | 'receiptEvidence' | 'compacted'> | undefined {
  const segment = compacted.find(value => value.kind === 'compaction_summary');
  const text = segment?.messages.flatMap(message => message.content)
    .find(block => block.kind === 'text') as { kind: 'text'; text: string } | undefined;
  if (!text?.text.includes('\n')) return undefined;
  try {
    const parsed = JSON.parse(text.text.slice(text.text.indexOf('\n') + 1)) as Record<string, unknown>;
    if (text.text.startsWith('[GoalAgent compaction/v2]\n')) {
      return parsed as unknown as GoalAgentStructuredSummaryV2;
    }
    if (!text.text.startsWith('[GoalAgent compaction/v1]\n')) return undefined;
    const compactedV1 = parsed.compacted && typeof parsed.compacted === 'object'
      ? parsed.compacted as Record<string, unknown> : {};
    return {
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts.filter(isRecord).map(value => structuredClone(value)) : [],
      failures: [],
      receiptEvidence: {
        refs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs.filter((value): value is string => typeof value === 'string') : [],
        omitted: 0,
      },
      compacted: {
        messages: typeof compactedV1.messages === 'number' ? Math.max(0, Math.floor(compactedV1.messages)) : 0,
        sourceDigest: typeof compactedV1.digest === 'string' ? compactedV1.digest : digest(text.text),
      },
    };
  } catch { return undefined; }
}

function evidenceFromMessages(messages: readonly CanonicalLlmMessage[]): string[] {
  const refs: string[] = [];
  for (const block of messages.flatMap(message => message.content)) {
    if (block.kind !== 'tool-result') continue;
    try {
      const parsed = JSON.parse(block.output) as Record<string, unknown>;
      const values = [parsed.evidenceRefs,
        parsed.result && typeof parsed.result === 'object' ? (parsed.result as Record<string, unknown>).evidenceRefs : undefined];
      for (const value of values) if (Array.isArray(value)) {
        refs.push(...value.filter((item): item is string => typeof item === 'string'));
      }
    } catch { /* opaque result stays represented by its attempt digest */ }
  }
  return refs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeAttempts(previous: Array<Record<string, unknown>>, messages: readonly CanonicalLlmMessage[]): Array<Record<string, unknown>> {
  const attempts = new Map<string, Record<string, unknown>>();
  for (const value of previous) if (typeof value.callId === 'string') attempts.set(value.callId, structuredClone(value));
  for (const block of messages.flatMap(message => message.content)) {
    if (block.kind === 'tool-call') attempts.set(block.id, {
      callId: block.id, tool: block.name, argumentsDigest: digest(JSON.stringify(block.arguments)),
    });
    if (block.kind === 'tool-result') {
      const prior = attempts.get(block.callId) ?? { callId: block.callId, tool: 'unknown' };
      attempts.set(block.callId, { ...prior, result: compactToolResult(block.output) });
    }
  }
  return [...attempts.values()].slice(-64);
}

function mergeFailures(previous: Array<Record<string, unknown>>, attempts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const failures = [...previous];
  for (const attempt of attempts) {
    const result = attempt.result as Record<string, unknown> | undefined;
    if (!result || result.ok !== false) continue;
    failures.push({ callId: attempt.callId, tool: attempt.tool, ...(result.failure ? { failure: result.failure } : {}), digest: result.digest });
  }
  return failures.slice(-64);
}

function compactToolResult(output: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const nested = parsed.result && typeof parsed.result === 'object' ? parsed.result as Record<string, unknown> : undefined;
    const failure = parsed.failure && typeof parsed.failure === 'object'
      ? parsed.failure as Record<string, unknown>
      : nested?.failure && typeof nested.failure === 'object' ? nested.failure as Record<string, unknown> : undefined;
    return {
      ok: parsed.ok === true,
      ...(typeof parsed.detail === 'string' ? { detail: bounded(parsed.detail, 240) } : {}),
      ...(failure ? { failure: {
        ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
        ...(typeof failure.category === 'string' ? { category: failure.category } : {}),
        ...(typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {}),
      } } : {}),
      digest: digest(output),
    };
  } catch {
    return { ok: false, excerpt: bounded(output, 240), digest: digest(output) };
  }
}

function fitSummary(summary: GoalAgentStructuredSummaryV2, maxTokens: number): void {
  const omittedValues: unknown[] = [];
  while (summaryUpperBound(summary) > maxTokens) {
    if (summary.receiptEvidence.refs.length > 1) omittedValues.push({ evidenceRef: summary.receiptEvidence.refs.shift()! });
    else if (summary.attempts.length > 1) omittedValues.push({ attempt: summary.attempts.shift() });
    else if (summary.failures.length > 1) omittedValues.push({ failure: summary.failures.shift() });
    else if (summary.plan.completedTasks.length > 1) omittedValues.push({ completedTask: summary.plan.completedTasks.shift() });
    else if (summary.plan.pendingTasks.length > 1) omittedValues.push({ pendingTask: summary.plan.pendingTasks.pop() });
    else throw new Error('GoalAgent required structured summary exceeds maxSummaryTokens');
    summary.receiptEvidence.omitted += 1;
    summary.receiptEvidence.digest = digest(JSON.stringify(omittedValues));
  }
}

function summaryUpperBound(summary: GoalAgentStructuredSummaryV2): number {
  return Math.ceil(Buffer.byteLength(renderGoalAgentCompactionSummary(summary), 'utf8') / 3) + 64;
}

function segmentUpperBound(segment: ContextSegmentV1): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(segment.messages), 'utf8') / 3) + 32;
}

function parseMessageRef(ref: string): { messageIndex: number; eventSeq: number } | null {
  const match = /^goalagent:message:(\d+):event:(\d+)$/.exec(ref);
  return match ? { messageIndex: Number(match[1]), eventSeq: Number(match[2]) } : null;
}

function parseEventRange(ref: string): { from: number; through: number } | null {
  const match = /^goalagent:event-range:(\d+)-(\d+)$/.exec(ref);
  return match ? { from: Number(match[1]), through: Number(match[2]) } : null;
}

function previousThrough(refs: readonly string[]): number {
  const values = refs.map(ref => /^goalagent:message-through:(\d+)$/.exec(ref)).filter(Boolean)
    .map(match => Number(match![1]));
  for (const ref of refs) {
    const match = /:compaction:(\d+)$/.exec(ref);
    if (match) values.push(Number(match[1]));
  }
  return Math.max(0, ...values);
}

function bounded(value: string, limit = 512): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…#${digest(value).slice(0, 12)}`;
}

function unique(values: readonly string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
