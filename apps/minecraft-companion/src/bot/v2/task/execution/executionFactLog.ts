import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EXECUTION_FACT_SCHEMA_V1,
  type ExecutionFactContextV1,
  type ExecutionFactEnvelopeV1,
  type ExecutionFactPageV1,
} from '../contracts/executionFactsV1.js';

export { EXECUTION_FACT_SCHEMA_V1 } from '../contracts/executionFactsV1.js';
export type { ExecutionFactEnvelopeV1 } from '../contracts/executionFactsV1.js';
export type ExecutionFactContext = ExecutionFactContextV1;

export interface ExecutionFactLogOptions {
  filePath?: string;
  codeRevision: string;
  configRevision: string;
  now?: () => Date;
  eventId?: () => string;
}

export type ExecutionFactPage = ExecutionFactPageV1;

/** Append-only JSONL fact source. Disk append is the commit point; wakeups happen afterwards. */
export class ExecutionFactLog {
  private readonly facts: ExecutionFactEnvelopeV1[] = [];
  private readonly sequenceBySession = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private readonly eventId: () => string;

  constructor(private readonly options: ExecutionFactLogOptions) {
    this.now = options.now ?? (() => new Date());
    this.eventId = options.eventId ?? randomUUID;
    this.load();
  }

  append(
    context: ExecutionFactContext,
    eventType: string,
    payload: Record<string, unknown>,
    causationId?: string,
  ): ExecutionFactEnvelopeV1 {
    const sequence = (this.sequenceBySession.get(context.sessionId) ?? 0) + 1;
    const fact: ExecutionFactEnvelopeV1 = {
      schema: EXECUTION_FACT_SCHEMA_V1,
      eventId: this.eventId(),
      eventType,
      sessionId: context.sessionId,
      runId: context.runId,
      planRunId: context.planRunId,
      planRevision: context.planRevision,
      nodeId: context.nodeId,
      sequence,
      occurredAt: this.now().toISOString(),
      codeRevision: this.options.codeRevision,
      configRevision: this.options.configRevision,
      correlationId: context.correlationId,
      payload: { ...payload },
      ...(causationId ? { causationId } : {}),
    };
    if (this.options.filePath) {
      mkdirSync(dirname(this.options.filePath), { recursive: true });
      appendFileSync(this.options.filePath, `${JSON.stringify(fact)}\n`, 'utf8');
    }
    this.facts.push(fact);
    this.sequenceBySession.set(context.sessionId, sequence);
    for (const listener of this.listeners) listener();
    return fact;
  }

  async readAfter(cursor: string | null, limit: number): Promise<ExecutionFactPage> {
    const offset = parseCursor(cursor);
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
    const facts = this.facts.slice(offset, offset + safeLimit);
    const nextOffset = offset + facts.length;
    return {
      facts: facts.map(fact => ({ ...fact, payload: { ...fact.payload } })),
      // Cursor is the durable consumer checkpoint, not a "has more" flag.
      // Returning it at the tail prevents the next wakeup from replaying from zero.
      nextCursor: String(nextOffset),
    };
  }

  subscribeWakeup(handler: () => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  all(): ExecutionFactEnvelopeV1[] {
    return this.facts.map(fact => ({ ...fact, payload: { ...fact.payload } }));
  }

  private load(): void {
    if (!this.options.filePath || !existsSync(this.options.filePath)) return;
    const lines = readFileSync(this.options.filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const [index, line] of lines.entries()) {
      let fact: ExecutionFactEnvelopeV1;
      try {
        fact = JSON.parse(line) as ExecutionFactEnvelopeV1;
      } catch (error) {
        throw new Error(`invalid execution fact JSONL at line ${index + 1}: ${String(error)}`);
      }
      if (fact.schema !== EXECUTION_FACT_SCHEMA_V1 || !fact.sessionId || !Number.isInteger(fact.sequence)) {
        throw new Error(`invalid execution fact envelope at line ${index + 1}`);
      }
      const expected = (this.sequenceBySession.get(fact.sessionId) ?? 0) + 1;
      if (fact.sequence !== expected) {
        throw new Error(`execution fact sequence gap for ${fact.sessionId}: expected ${expected}, got ${fact.sequence}`);
      }
      this.facts.push(fact);
      this.sequenceBySession.set(fact.sessionId, fact.sequence);
    }
  }
}

function parseCursor(cursor: string | null): number {
  if (cursor == null) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`invalid execution fact cursor: ${cursor}`);
  return offset;
}
