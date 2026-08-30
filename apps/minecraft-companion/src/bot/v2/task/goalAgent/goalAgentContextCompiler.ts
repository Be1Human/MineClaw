import type { LLMChatMessage } from '../../cognitive/llm/types.js';
import type { GoalAgentNodeId, GoalAgentStateV1 } from './goalAgentState.js';
import type {
  TraceContextOmission,
  TraceContextSourceRef,
} from '../../infra/llmTrace/index.js';
import {
  buildGamePresenceContext,
  type GamePresenceState,
} from '../../gamePresenceContext.js';

export interface GoalAgentContextCompilerOptions {
  maxHistoryCharacters?: number;
  systemIdentity?: string;
  getGamePresence?: () => GamePresenceState;
}

export interface CompiledGoalAgentContext {
  messages: LLMChatMessage[];
  instructionMessage: LLMChatMessage;
  projectedHistoryMessages: number;
  omittedHistoryMessages: number;
  compaction?: GoalAgentCompactionProposal;
  contextSources: {
    selected: TraceContextSourceRef[];
    omitted: TraceContextOmission[];
  };
}

export interface GoalAgentCompactionProposal {
  summary: string;
  omittedMessages: number;
  throughMessageIndex: number;
}

const MINECRAFT_WORLD_COGNITION = [
  'Interpret player messages in the Minecraft gameplay context first, unless the conversation clearly indicates a non-game topic.',
  'Ground references such as "this in your hand", "the one in your inventory", and "that one nearby" in fresh world observations before deciding what object or action the player means.',
  'Player language may contain colloquialisms, omissions, abbreviations, typos, homophones, or speech-recognition errors. Infer the intended Minecraft concept from the requested action, deictic references, conversation context, controlled catalogs, and observed world evidence; for example, "稿子" may mean "镐子/pickaxe" in a Minecraft action context.',
  'When fresh evidence supports one clear valid referent, use it and continue. Ask the player only when two or more materially different valid interpretations remain, or required information is unavailable from tools.',
  'Never invent Minecraft items, recipes, world state, actions, or completion. Controlled catalogs, tool receipts, machine observations, safety gates, and success criteria override linguistic inference.',
] as const;

function defaultSystemIdentity(presence: GamePresenceState): string {
  return [
    buildGamePresenceContext(presence),
    ...MINECRAFT_WORLD_COGNITION,
    'You are the GoalAgent inside MineClaw.',
    'You operate one continuous model-tool-result loop in one append-only session.',
    'Choose and call real tools directly; planning and recovery are optional Step objectives, never fixed routes.',
    'Tool receipts, machine observations, safety gates, and success criteria override guesses or plain-text claims.',
  ].join(' ');
}

// Keep enough recent turns for tool continuity while leaving room for the
// current node's often-large instruction inside the session token budget.
const DEFAULT_MAX_HISTORY_CHARACTERS = 10_000;

export class GoalAgentContextCompiler {
  private readonly maxHistoryCharacters: number;
  private readonly customSystemIdentity: string | null;
  private readonly getGamePresence: () => GamePresenceState;

  constructor(options: GoalAgentContextCompilerOptions = {}) {
    this.maxHistoryCharacters = options.maxHistoryCharacters ?? DEFAULT_MAX_HISTORY_CHARACTERS;
    if (!Number.isInteger(this.maxHistoryCharacters) || this.maxHistoryCharacters < 2_000) {
      throw new Error('GoalAgent maxHistoryCharacters must be an integer >= 2000');
    }
    this.customSystemIdentity = options.systemIdentity?.trim() || null;
    this.getGamePresence = options.getGamePresence
      ?? (() => ({ embodied: true, ownerObservation: 'unknown' }));
  }

  compile(input: {
    state: Readonly<GoalAgentStateV1>;
    node: GoalAgentNodeId;
    instruction: string;
    /** Raw committed tail derived from the SessionEventLog after its compaction boundary. */
    historyMessages: readonly LLMChatMessage[];
    compaction?: { summary: string; throughMessageIndex: number };
  }): CompiledGoalAgentContext {
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error('GoalAgent node instruction is required');
    const history = projectHistory(
      [...input.historyMessages],
      this.maxHistoryCharacters,
    );
    const compaction = history.omitted > 0
      ? {
          summary: compactionSummary(input.state, input.compaction?.summary, history.omittedMessages),
          omittedMessages: history.omitted,
          throughMessageIndex: (input.compaction?.throughMessageIndex ?? 0) + history.omitted,
        }
      : undefined;
    const compactionSurface = compaction?.summary ?? input.compaction?.summary;
    const instructionMessage: LLMChatMessage = {
      role: 'user',
      content: `[GoalAgent node=${input.node} stateRevision=${input.state.revision} epoch=${input.state.epoch}]\n${instruction}`,
    };
    const systemIdentity = this.customSystemIdentity
      ?? defaultSystemIdentity(this.getGamePresence());
    const messages: LLMChatMessage[] = [
      { role: 'system', content: systemIdentity },
      ...(compactionSurface ? [{ role: 'system' as const, content: compactionSurface }] : []),
      ...history.messages,
      { role: 'user', content: sharedStateProjection(input.state) },
      instructionMessage,
    ];
    const historyStartIndex = compactionSurface ? 2 : 1;
    const dynamicStateIndex = messages.length - 2;
    return {
      messages,
      instructionMessage,
      projectedHistoryMessages: history.messages.length,
      omittedHistoryMessages: history.omitted,
      contextSources: {
        selected: [
          { kind: 'system_identity', ref: 'goalagent:identity/v1', messageIndexes: [0] },
          ...(compactionSurface
            ? [{
                kind: 'compaction_summary',
                ref: `goalagent:${input.state.sessionId}:compaction:${compaction?.throughMessageIndex ?? input.compaction?.throughMessageIndex ?? 0}`,
                characters: compactionSurface.length,
                messageIndexes: [1],
              }]
            : []),
          ...(history.messages.length > 0
            ? [{
                kind: 'session_event_log',
                ref: `goalagent:${input.state.sessionId}:messages:selected:${history.messages.length}`,
                characters: history.messages.reduce((total, message) => total + messageSize(message), 0),
                messageIndexes: history.messages.map((_message, index) => index + historyStartIndex),
              }]
            : []),
          {
            kind: 'shared_state',
            ref: `goalagent:${input.state.sessionId}:revision:${input.state.revision}`,
            version: String(input.state.revision),
            messageIndexes: [dynamicStateIndex],
          },
          {
            kind: 'node_instruction',
            ref: `goalagent:${input.node}:revision:${input.state.revision}`,
            messageIndexes: [messages.length - 1],
          },
        ],
        omitted: [
          ...(history.omittedByBudget > 0 ? [{
              kind: 'session_event_log',
              ref: `goalagent:${input.state.sessionId}:history:over-budget:${history.omittedByBudget}`,
              reason: 'compacted_by_history_character_budget',
            }] : []),
        ],
      },
      ...(compaction ? { compaction } : {}),
    };
  }
}

function projectHistory(
  messages: LLMChatMessage[],
  maxCharacters: number,
): {
  messages: LLMChatMessage[];
  omittedMessages: LLMChatMessage[];
  omitted: number;
  omittedByBudget: number;
} {
  const turns = groupHistoryTurns(messages);
  let remaining = maxCharacters;
  const selectedTurns: LLMChatMessage[][] = [];
  let selectedMessages = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const size = turn.reduce((total, message) => total + messageSize(message), 0);
    if (size > remaining) break;
    selectedTurns.push(turn.map(message => structuredClone(message)));
    selectedMessages += turn.length;
    remaining -= size;
    if (remaining <= 0) break;
  }
  selectedTurns.reverse();
  const omittedCount = turns.reduce((total, turn) => total + turn.length, 0) - selectedMessages;
  return {
    messages: selectedTurns.flat(),
    omittedMessages: turns.slice(0, turns.length - selectedTurns.length).flat().map(message => structuredClone(message)),
    omitted: omittedCount,
    omittedByBudget: omittedCount,
  };
}

function groupHistoryTurns(messages: LLMChatMessage[]): LLMChatMessage[][] {
  const turns: LLMChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || turns.length === 0) {
      turns.push([message]);
    } else {
      turns[turns.length - 1].push(message);
    }
  }
  return turns;
}

function sharedStateProjection(state: Readonly<GoalAgentStateV1>): string {
  const inventory = state.world.latest?.inventory.items
    .filter(item => item.count > 0)
    .map(item => `${item.name}x${item.count}`)
    .join(', ') || 'unknown';
  const activePlanNode = state.plan.graph?.nodes.find(node => node.id === state.plan.activeNodeId);
  const terminal = state.terminal ? `${state.terminal.outcome}: ${state.terminal.summary}` : 'none';
  return [
    `Shared GoalAgent state for session ${state.sessionId}.`,
    `Request: ${state.request.requestText}`,
    `Runtime state: ${state.phase}.`,
    `Plan revision/active task: ${state.plan.revision}/${activePlanNode?.goal.goalText ?? state.plan.activeNodeId ?? 'none'}.`,
    `Inventory: ${inventory}.`,
    `Last action: ${state.action.proposal?.action ?? 'none'}; result: ${state.action.result?.detail ?? 'none'}.`,
    `Last critic verdict: ${state.verdict?.decision ?? 'none'} (${state.verdict?.summary ?? 'none'}).`,
    `Budget: llm ${state.budget.llmCalls}/${state.budget.maxLlmCalls}, actions ${state.budget.actions}/${state.budget.maxActions}, recoveries ${state.budget.recoveries}/${state.budget.maxRecoveries}, replans ${state.budget.graphReplans}/${state.budget.maxGraphReplans}.`,
    `Token telemetry: ${state.budget.promptTokens + state.budget.completionTokens}/${state.budget.maxTotalTokens ?? 'unlimited'}.`,
    `Terminal: ${terminal}.`,
  ].filter(Boolean).join('\n');
}

function compactionSummary(
  state: Readonly<GoalAgentStateV1>,
  previousSummary: string | undefined,
  omitted: readonly LLMChatMessage[],
): string {
  const previous = parsePreviousCompaction(previousSummary);
  const attempts = new Map<string, Record<string, unknown>>();
  for (const value of Array.isArray(previous.attempts) ? previous.attempts : []) {
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).callId === 'string') {
      attempts.set(String((value as Record<string, unknown>).callId), structuredClone(value as Record<string, unknown>));
    }
  }
  for (const message of omitted) {
    for (const call of message.tool_calls ?? []) {
      attempts.set(call.id, {
        callId: call.id,
        tool: call.function.name,
        argumentsDigest: shortDigest(call.function.arguments),
      });
    }
    if (message.role === 'tool' && message.tool_call_id) {
      const existing = attempts.get(message.tool_call_id) ?? { callId: message.tool_call_id, tool: 'unknown' };
      attempts.set(message.tool_call_id, {
        ...existing,
        result: compactToolResult(message.content),
      });
    }
  }
  const activePlanNode = state.plan.graph?.nodes.find(node => node.id === state.plan.activeNodeId);
  const previousEvidence = Array.isArray(previous.evidenceRefs)
    ? previous.evidenceRefs.filter((value): value is string => typeof value === 'string')
    : [];
  return `[GoalAgent compaction/v1]\n${JSON.stringify({
    request: state.request.requestText,
    rootGoal: state.rootGoal?.goalText ?? null,
    constraints: state.rootGoal?.constraints ?? [],
    successCriteria: state.rootGoal?.successCriteria ?? [],
    planRevision: state.plan.revision,
    activeTask: activePlanNode?.goal.goalText ?? state.plan.activeNodeId,
    completedTasks: state.plan.graph?.nodes.filter(node => node.state === 'satisfied').map(node => node.id) ?? [],
    pendingTasks: state.plan.graph?.nodes.filter(node => !['satisfied', 'cancelled'].includes(node.state)).map(node => node.id) ?? [],
    lastAction: state.action.proposal?.action ?? null,
    lastActionResult: state.action.result?.detail ?? null,
    lastVerdict: state.verdict?.decision ?? null,
    attempts: [...attempts.values()].slice(-32),
    evidenceRefs: [...new Set([
      ...previousEvidence,
      ...state.interpretation.evidenceRefs,
      ...(state.action.result?.evidenceRefs ?? []),
      ...(state.verdict?.evidenceRefs ?? []),
    ])],
    budget: state.budget,
    compacted: {
      messages: compactedMessageCount(previous) + omitted.length,
      previousCheckpoint: previousSummary
        ? { present: true, characters: previousSummary.length, digest: shortDigest(previousSummary) }
        : undefined,
    },
  })}`;
}

function parsePreviousCompaction(summary: string | undefined): Record<string, unknown> {
  if (!summary) return {};
  const body = summary.includes('\n') ? summary.slice(summary.indexOf('\n') + 1) : summary;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function compactedMessageCount(previous: Record<string, unknown>): number {
  const compacted = previous.compacted;
  if (!compacted || typeof compacted !== 'object') return 0;
  const messages = (compacted as Record<string, unknown>).messages;
  return typeof messages === 'number' && Number.isFinite(messages) ? Math.max(0, Math.floor(messages)) : 0;
}

function compactToolResult(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const failure = parsed.failure && typeof parsed.failure === 'object'
      ? parsed.failure as Record<string, unknown>
      : parsed.result && typeof parsed.result === 'object'
        && (parsed.result as Record<string, unknown>).failure
        && typeof (parsed.result as Record<string, unknown>).failure === 'object'
          ? (parsed.result as Record<string, unknown>).failure as Record<string, unknown>
          : undefined;
    return {
      ok: parsed.ok === true,
      ...(typeof parsed.detail === 'string' ? { detail: parsed.detail.slice(0, 240) } : {}),
      ...(failure ? {
        failure: {
          ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
          ...(typeof failure.category === 'string' ? { category: failure.category } : {}),
          ...(typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {}),
        },
      } : {}),
      contentDigest: shortDigest(content),
    };
  } catch {
    return { contentExcerpt: content.slice(0, 240), contentDigest: shortDigest(content) };
  }
}

function shortDigest(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function messageSize(message: LLMChatMessage): number {
  return message.content.length + JSON.stringify(message.tool_calls ?? []).length + (message.tool_call_id?.length ?? 0) + 16;
}
