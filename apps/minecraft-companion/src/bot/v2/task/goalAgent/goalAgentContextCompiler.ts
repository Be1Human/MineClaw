import type { LLMChatMessage } from '../../cognitive/llm/types.js';
import { canonicalizeChatMessages } from '../../cognitive/llm/canonical.js';
import type { ContextSegmentV1 } from '../../cognitive/llm/contextGovernance.js';
import type { GoalAgentNodeId, GoalAgentStateV1 } from './goalAgentState.js';
import type { TraceContextSourceRef } from '../../infra/llmTrace/index.js';
import { buildGamePresenceContext, type GamePresenceState } from '../../gamePresenceContext.js';

export interface GoalAgentContextCompilerOptions {
  systemIdentity?: string;
  getGamePresence?: () => GamePresenceState;
  getProactiveCapabilitiesContext?: () => string;
}

export interface GoalAgentHistoryMessageRef {
  messageIndex: number;
  eventSeq: number;
}

export interface CompiledGoalAgentContext {
  /** Complete pre-governance surface. Capacity decisions never happen here. */
  messages: LLMChatMessage[];
  segments: ContextSegmentV1[];
  instructionMessage: LLMChatMessage;
  projectedHistoryMessages: number;
  contextSources: { selected: TraceContextSourceRef[]; omitted: [] };
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

export class GoalAgentContextCompiler {
  private readonly customSystemIdentity: string | null;
  private readonly getGamePresence: () => GamePresenceState;
  private readonly getProactiveCapabilitiesContext: () => string;

  constructor(options: GoalAgentContextCompilerOptions = {}) {
    this.customSystemIdentity = options.systemIdentity?.trim() || null;
    this.getGamePresence = options.getGamePresence
      ?? (() => ({ embodied: true, ownerObservation: 'unknown' }));
    this.getProactiveCapabilitiesContext = options.getProactiveCapabilitiesContext ?? (() => '');
  }

  compile(input: {
    state: Readonly<GoalAgentStateV1>;
    node: GoalAgentNodeId;
    instruction: string;
    /** Raw committed tail derived from the SessionEventLog after its compaction boundary. */
    historyMessages: readonly LLMChatMessage[];
    historyRefs?: readonly GoalAgentHistoryMessageRef[];
    compaction?: {
      summarySurface: string;
      throughMessageIndex: number;
      coveredEventSeq?: { from: number; through: number };
    };
  }): CompiledGoalAgentContext {
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error('GoalAgent node instruction is required');
    if (input.historyRefs && input.historyRefs.length !== input.historyMessages.length) {
      throw new Error('GoalAgent historyRefs must align one-to-one with historyMessages');
    }

    const systemMessage: LLMChatMessage = {
      role: 'system',
      content: [
        this.customSystemIdentity ?? defaultSystemIdentity(this.getGamePresence()),
        this.getProactiveCapabilitiesContext().trim(),
      ].filter(Boolean).join('\n'),
    };
    const instructionMessage: LLMChatMessage = {
      role: 'user',
      content: `[GoalAgent node=${input.node} stateRevision=${input.state.revision} epoch=${input.state.epoch}]\n${instruction}`,
    };
    const stateMessage: LLMChatMessage = { role: 'user', content: sharedStateProjection(input.state) };
    const segments: ContextSegmentV1[] = [segment({
      id: 'goalagent:stable-system', kind: 'stable_system', retention: 'required',
      sourceRefs: ['goalagent:identity/v1'], messages: [systemMessage],
    })];

    if (input.compaction?.summarySurface) {
      segments.push(segment({
        id: `goalagent:compaction:${input.compaction.throughMessageIndex}`,
        kind: 'compaction_summary',
        retention: 'compactable',
        sourceRefs: [
          `goalagent:${input.state.sessionId}:compaction:${input.compaction.throughMessageIndex}`,
          ...(input.compaction.coveredEventSeq
            ? [`goalagent:event-range:${input.compaction.coveredEventSeq.from}-${input.compaction.coveredEventSeq.through}`]
            : []),
        ],
        messages: [{ role: 'system', content: input.compaction.summarySurface }],
      }));
    }

    for (const history of groupHistoryTurns(input.historyMessages, input.historyRefs)) {
      const firstIndex = history.refs[0]?.messageIndex ?? history.ordinal;
      const lastIndex = history.refs.at(-1)?.messageIndex ?? firstIndex + history.messages.length - 1;
      const id = `goalagent:history:${firstIndex}-${lastIndex}`;
      segments.push(segment({
        id,
        kind: 'history_round',
        retention: hasOpenToolCall(history.messages) ? 'required' : 'compactable',
        atomicGroupId: id,
        sourceRefs: history.refs.length
          ? history.refs.map(ref => `goalagent:message:${ref.messageIndex}:event:${ref.eventSeq}`)
          : [`goalagent:${input.state.sessionId}:history:${firstIndex}-${lastIndex}`],
        messages: history.messages,
      }));
    }

    segments.push(segment({
      id: `goalagent:state:${input.state.revision}`,
      kind: 'dynamic_state',
      retention: 'required',
      sourceRefs: [`goalagent:${input.state.sessionId}:revision:${input.state.revision}`],
      messages: [stateMessage],
    }));
    segments.push(segment({
      id: `goalagent:instruction:${input.node}:${input.state.revision}`,
      kind: 'current_instruction',
      retention: 'required',
      sourceRefs: [`goalagent:${input.node}:revision:${input.state.revision}`],
      messages: [instructionMessage],
    }));

    const messages = [systemMessage,
      ...(input.compaction?.summarySurface ? [{ role: 'system' as const, content: input.compaction.summarySurface }] : []),
      ...input.historyMessages.map(message => structuredClone(message)), stateMessage, instructionMessage];
    let messageIndex = 0;
    const selected = segments.map(value => {
      const indexes = value.messages.map(() => messageIndex++);
      return {
        kind: value.kind,
        ref: value.sourceRefs.join(','),
        characters: JSON.stringify(value.messages).length,
        messageIndexes: indexes,
      } satisfies TraceContextSourceRef;
    });
    return {
      messages,
      segments,
      instructionMessage,
      projectedHistoryMessages: input.historyMessages.length,
      contextSources: { selected, omitted: [] },
    };
  }
}

function segment(input: Omit<ContextSegmentV1, 'messages'> & { messages: readonly LLMChatMessage[] }): ContextSegmentV1 {
  return Object.freeze({ ...input, messages: Object.freeze(canonicalizeChatMessages(input.messages)) });
}

function groupHistoryTurns(
  messages: readonly LLMChatMessage[],
  refs: readonly GoalAgentHistoryMessageRef[] | undefined,
): Array<{ ordinal: number; messages: LLMChatMessage[]; refs: GoalAgentHistoryMessageRef[] }> {
  const turns: Array<{ ordinal: number; messages: LLMChatMessage[]; refs: GoalAgentHistoryMessageRef[] }> = [];
  messages.forEach((message, index) => {
    if (message.role === 'user' || turns.length === 0) turns.push({ ordinal: index, messages: [], refs: [] });
    const turn = turns[turns.length - 1];
    turn.messages.push(structuredClone(message));
    if (refs?.[index]) turn.refs.push(structuredClone(refs[index]));
  });
  return turns;
}

function hasOpenToolCall(messages: readonly LLMChatMessage[]): boolean {
  const pending = new Set(messages.flatMap(message => message.tool_calls ?? []).map(call => call.id));
  for (const message of messages) if (message.role === 'tool' && message.tool_call_id) pending.delete(message.tool_call_id);
  return pending.size > 0;
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
    ...(state.rootGoal?.schema === 'mineclaw.goal/v2' ? [
      `Immutable formal goal: ${JSON.stringify({ schema: state.rootGoal.schema, intent: state.rootGoal.intent, source: state.rootGoal.source, successCriteria: state.rootGoal.successCriteria, scope: state.rootGoal.scope })}`,
    ] : []),
    `Runtime state: ${state.phase}.`,
    ...(state.progress ? [`Progress governance: ${state.progress.mode}; stagnant rounds ${state.progress.noProgressRounds}; used recoveries ${state.progress.recoveryAttempts}.`] : []),
    `Plan revision/active task: ${state.plan.revision}/${activePlanNode?.goal.goalText ?? state.plan.activeNodeId ?? 'none'}.`,
    `Inventory: ${inventory}.`,
    `Last action: ${state.action.proposal?.action ?? 'none'}; result: ${state.action.result?.detail ?? 'none'}.`,
    `Last critic verdict: ${state.verdict?.decision ?? 'none'} (${state.verdict?.summary ?? 'none'}).`,
    `Budget: llm ${state.budget.llmCalls}/${state.budget.maxLlmCalls}, actions ${state.budget.actions}/${state.budget.maxActions}, recoveries ${state.budget.recoveries}/${state.budget.maxRecoveries}, replans ${state.budget.graphReplans}/${state.budget.maxGraphReplans}.`,
    `Token telemetry: ${state.budget.promptTokens + state.budget.completionTokens}/${state.budget.maxTotalTokens ?? 'unlimited'}.`,
    `Terminal: ${terminal}.`,
  ].filter(Boolean).join('\n');
}
