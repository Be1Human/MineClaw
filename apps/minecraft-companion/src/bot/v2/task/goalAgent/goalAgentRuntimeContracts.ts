import type { LLMChatMessage, LLMToolSchema } from '../../cognitive/llm/types.js';
import type { GoalKnowledgePort } from '../../knowledge/goalTargetKnowledge.js';
import type { GoalAgentNodeId, GoalAgentStateV1 } from './goalAgentState.js';
import type { GoalAgentCompactionProposal } from './goalAgentContextCompiler.js';
import type { MemoryRecord } from '../../memory/contracts.js';
import type { GoalDraftCompilationPort } from './ports/goalDraftPort.js';
import type { GoalPlanAuthorizationPort } from './ports/goalPlanPort.js';
import type { GoalProgressPolicyPort } from './ports/goalProgressPort.js';
import type {
  GoalAgentExecutionPort,
  GoalAgentExperiencePort,
  GoalAgentPerceptionPort,
  GoalAgentReportPort,
  GoalAgentVerificationPort,
} from './ports/index.js';

export interface GoalAgentModelInvocation<T> {
  sessionId: string;
  expectedRevision: number;
  node: GoalAgentNodeId;
  instruction: string;
  /** Compact semantic instruction retained in the derived message surface. */
  historyInstruction?: string;
  state: Readonly<GoalAgentStateV1>;
  tools?: LLMToolSchema[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  parse(content: string, toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): T;
  signal: AbortSignal;
}

export interface GoalAgentModelResponse<T> {
  value: T;
  assistant: LLMChatMessage;
  messagesToAppend: LLMChatMessage[];
  compaction?: GoalAgentCompactionProposal;
  budget: GoalAgentStateV1['budget'];
  promptTokens: number;
  completionTokens: number;
  tokenUsageSource?: 'provider' | 'estimated' | 'mixed';
  modelCallIndex: number;
  contextRevision: number;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

export interface GoalAgentModelPort {
  invoke<T>(invocation: GoalAgentModelInvocation<T>): Promise<GoalAgentModelResponse<T>>;
}

export interface GoalAgentMemoryPort {
  search(input: { query: string; limit: number }): Promise<{
    records: MemoryRecord[];
    evidenceRefs: string[];
    gaps: string[];
    traceId: string;
  }> | {
    records: MemoryRecord[];
    evidenceRefs: string[];
    gaps: string[];
    traceId: string;
  };
  get(ref: string): Promise<MemoryRecord | null> | MemoryRecord | null;
}

export interface GoalAgentTools {
  readonly goals?: GoalDraftCompilationPort;
  readonly plans?: GoalPlanAuthorizationPort;
  readonly progress?: GoalProgressPolicyPort;
  readonly knowledge?: GoalKnowledgePort;
  readonly execution?: GoalAgentExecutionPort;
  readonly experience?: GoalAgentExperiencePort;
  readonly perception?: GoalAgentPerceptionPort;
  readonly reporting?: GoalAgentReportPort;
  readonly verification?: GoalAgentVerificationPort;
  readonly memory?: GoalAgentMemoryPort;
}
