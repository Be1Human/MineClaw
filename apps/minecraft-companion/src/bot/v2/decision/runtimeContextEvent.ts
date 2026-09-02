/**
 * FEAT-CROSS-28 · Runtime context event + message surface compiler (design §5.7).
 * Runtime context is NEVER placed into the base system: chats stay user/assistant,
 * tool results stay native tool messages for the issuing agent, and knowledge
 * answers/state/memory/task progress become controlled RuntimeContextEvents that
 * the compiler maps to provider-appropriate context roles, preserving their
 * original identity in the trace.
 */
import type { KnowledgeAnswerV1 } from './goalAgentPort/knowledgeQueryContracts.js';
import type { BaseSystemPrompt } from './baseSystemPrompt.js';

export type RuntimeContextSource = 'knowledge_answer' | 'runtime_snapshot' | 'memory' | 'task_progress';
export type RuntimeContextTrust = 'machine_validated' | 'retrieved' | 'generated';
export type ContextVisibility = 'model_visible' | 'audit_only' | 'compacted' | 'cross_agent_summary';

export interface RuntimeContextEventV1 {
  readonly kind: 'runtime_context';
  readonly source: RuntimeContextSource;
  readonly trust: RuntimeContextTrust;
  readonly schema: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidenceRefs: readonly string[];
  readonly causationId: string;
  readonly visibility: ContextVisibility;
  readonly emittedAt: string;
}

export function knowledgeAnswerContextEvent(answer: KnowledgeAnswerV1): RuntimeContextEventV1 {
  return Object.freeze({
    kind: 'runtime_context',
    source: 'knowledge_answer',
    trust: 'machine_validated',
    schema: 'mineclaw.knowledge-answer/v1',
    payload: Object.freeze({
      outcome: answer.outcome,
      facts: answer.facts.map(fact => Object.freeze({
        factKind: fact.factKind,
        payload: fact.payload,
        complete: fact.complete,
        truncated: fact.truncated,
      })),
      completeness: answer.completeness,
      clarification: answer.clarification ?? null,
    }),
    evidenceRefs: Object.freeze(answer.evidenceRefs.map(ref => ref.ref)),
    causationId: answer.correlationId,
    visibility: 'model_visible',
    emittedAt: answer.observedAt,
  });
}

export interface CompiledSurface {
  readonly base: BaseSystemPrompt;
  readonly messages: readonly ModelMessage[];
  readonly omitted: readonly { readonly eventId: string; readonly reason: string }[];
  readonly trace: readonly {
    readonly eventId: string;
    readonly visibility: ContextVisibility;
    readonly mappedRole: string;
  }[];
}

export type ModelMessage =
  | { readonly role: 'user' | 'assistant' | 'tool'; readonly content: string; readonly toolCallId?: string }
  | { readonly role: 'developer' | 'context'; readonly content: string };
