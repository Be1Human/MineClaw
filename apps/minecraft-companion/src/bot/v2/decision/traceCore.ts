/**
 * FEAT-CROSS-28 · Trace core (design §5.8).
 * Precise, reconcilable request projection per model call: base system
 * id/hash, tools schema hash, actual outbound messages, per-event
 * visibility/omittedReason mapping and correlation causality chains. Trace
 * records existence and the model-visible surface are explicitly separate.
 */
import type { BaseSystemPrompt } from './baseSystemPrompt.js';
import type { ContextVisibility } from './runtimeContextEvent.js';

export type SurfaceMapEntry =
  | { readonly eventId: string; readonly target: 'system' | 'tool' | 'user' | 'assistant' | 'developer' | 'context'; readonly visibility: 'model_visible' }
  | { readonly eventId: string; readonly target: null; readonly visibility: Exclude<ContextVisibility, 'model_visible'>; readonly omittedReason: string };

export interface RequestProjection {
  readonly callId: string;
  readonly agent: 'mainbrain' | 'goalagent';
  readonly model: string;
  readonly provider: string;
  readonly baseSystemId: string;
  readonly baseSystemHash: string;
  readonly toolsSchemaHash: string;
  readonly roleMapping: Readonly<Record<string, string>>;
  readonly messages: readonly { readonly role: string; readonly contentPreview: string }[];
  readonly surfaceMap: readonly SurfaceMapEntry[];
  readonly correlationId?: string;
  readonly causalityChain: readonly string[];
}

function sha256(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return String(hash >>> 0).padStart(8, '0');
}

export function toolsSchemaHash(schemas: readonly { readonly name: string; readonly schema: string }[]): string {
  return sha256(schemas.map(entry => `${entry.name}:${entry.schema}`).sort().join('|'));
}

export function buildRequestProjection(input: {
  readonly callId: string;
  readonly agent: 'mainbrain' | 'goalagent';
  readonly model: string;
  readonly provider: string;
  readonly base: BaseSystemPrompt;
  readonly tools: readonly { readonly name: string; readonly schema: string }[];
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly surfaceMap?: readonly SurfaceMapEntry[];
  readonly correlationId?: string;
  readonly causalityChain?: readonly string[];
}): RequestProjection {
  return Object.freeze({
    callId: input.callId,
    agent: input.agent,
    model: input.model,
    provider: input.provider,
    baseSystemId: input.base.id,
    baseSystemHash: input.base.hash,
    toolsSchemaHash: toolsSchemaHash(input.tools),
    roleMapping: Object.freeze({ system: 'system', user: 'user', assistant: 'assistant', tool: 'tool' }),
    messages: Object.freeze(input.messages.map(message => ({
      role: message.role,
      contentPreview: message.content.slice(0, 120),
    }))),
    surfaceMap: Object.freeze(input.surfaceMap ?? []),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    causalityChain: Object.freeze(input.causalityChain ?? []),
  });
}

/** Classify a trace event's model visibility: records exist, but only mapped entries are visible. */
export function projectVisibility(eventId: string, omittedReason: string | undefined, target: 'system' | 'tool' | 'user' | 'assistant' | 'developer' | 'context'): SurfaceMapEntry {
  if (omittedReason) {
    return { eventId, target: null, visibility: 'audit_only', omittedReason };
  }
  return { eventId, target, visibility: 'model_visible' };
}

/** Causality chain: follow correlationId across query/answer/trace events. */
export function buildCausalityChain(correlationId: string, events: readonly { readonly id: string; readonly correlationId?: string }[], rootId: string): readonly string[] {
  const chain = [rootId];
  for (const event of events) {
    if (event.correlationId === correlationId && !chain.includes(event.id)) chain.push(event.id);
  }
  return Object.freeze(chain);
}

/** Omitted-entry reconciliation predicate: trace shows it, surface omits it, reason recorded. */
export function assertNoSilentOmission(projection: RequestProjection, auditEventIds: readonly string[]): boolean {
  const mapped = new Set(projection.surfaceMap.map(entry => entry.eventId));
  return auditEventIds.every(id => mapped.has(id));
}
