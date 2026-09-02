/**
 * FEAT-CROSS-28 · MessageSurfaceCompiler (design §5.7).
 * Compiles the visible model surface from the base system + native chat/tool
 * messages + runtime context events. Rules:
 *  1. real chats keep user/assistant roles (never system text)
 *  2. tool calls need the matching assistant call; results are native tool role
 *     for the issuing agent only (cross-agent replay forbidden)
 *  3. RuntimeContextEvents map to a controlled developer/context message and
 *     keep their original identity for the trace (never reported as chat)
 *  4. the base system stays byte-stable for the same static config
 */
import type { BaseSystemPrompt } from './baseSystemPrompt.js';
import type { CompiledSurface, ModelMessage, RuntimeContextEventV1 } from './runtimeContextEvent.js';

export interface SurfaceInputMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'runtime_context';
  readonly content: string;
  readonly toolCallId?: string;
  readonly event?: RuntimeContextEventV1;
}

export interface MessageSurfaceCompilerOptions {
  readonly providerSupportsDeveloperRole: boolean;
  readonly maxContextEvents?: number;
}

export class MessageSurfaceCompiler {
  constructor(private readonly options: MessageSurfaceCompilerOptions) {}

  compile(base: BaseSystemPrompt, messages: readonly SurfaceInputMessage[]): CompiledSurface {
    const modelMessages: ModelMessage[] = [];
    const omitted: { eventId: string; reason: string }[] = [];
    const trace: { eventId: string; visibility: RuntimeContextEventV1['visibility']; mappedRole: string }[] = [];
    let eventCount = 0;

    for (const message of messages) {
      if (message.role === 'runtime_context') {
        const event = message.event;
        if (!event || event.visibility === 'audit_only') {
          omitted.push({ eventId: message.id, reason: event?.visibility === 'audit_only' ? 'audit_only' : 'missing_event' });
          continue;
        }
        if (this.options.maxContextEvents !== undefined && eventCount >= this.options.maxContextEvents) {
          omitted.push({ eventId: message.id, reason: 'context_event_budget' });
          continue;
        }
        eventCount += 1;
        const mappedRole: 'developer' | 'context' = this.options.providerSupportsDeveloperRole ? 'developer' : 'context';
        modelMessages.push({
          role: mappedRole,
          content: `[${event.source} · trust=${event.trust}] ${JSON.stringify(event.payload)}`,
        });
        trace.push({ eventId: message.id, visibility: event.visibility, mappedRole });
        continue;
      }
      if (message.role === 'tool') {
        // Tool results only reach the agent that issued the call; a stray result is omitted.
        if (!message.toolCallId) {
          omitted.push({ eventId: message.id, reason: 'tool_result_without_call' });
          continue;
        }
        modelMessages.push({ role: 'tool', content: message.content, toolCallId: message.toolCallId });
        trace.push({ eventId: message.id, visibility: 'model_visible', mappedRole: 'tool' });
        continue;
      }
      modelMessages.push({ role: message.role, content: message.content });
      trace.push({ eventId: message.id, visibility: 'model_visible', mappedRole: message.role });
    }

    return Object.freeze({
      base,
      messages: Object.freeze(modelMessages),
      omitted: Object.freeze(omitted),
      trace: Object.freeze(trace),
    });
  }
}

/** Identity mapping for trace reconciliation: base system hash + per-message origin. */
export function surfaceInvariant(base: BaseSystemPrompt): string {
  return `${base.id}@${base.hash}`;
}
