import {
  EXECUTION_FACT_SCHEMA_V1,
  type ExecutionFactEnvelopeV1,
} from '../executionFactsV1.js';

export const EXECUTION_FACT_V1_GOLDEN: ExecutionFactEnvelopeV1 = Object.freeze({
  schema: EXECUTION_FACT_SCHEMA_V1,
  eventId: 'event-golden-1',
  eventType: 'execution.session.terminal',
  sessionId: 'leaf-golden-1',
  runId: 'plan-golden-1',
  planRunId: 'plan-golden-1',
  planRevision: 1,
  nodeId: 'node-golden-1',
  sequence: 9,
  occurredAt: '2026-08-02T12:00:00.000Z',
  codeRevision: 'golden',
  configRevision: 'golden',
  correlationId: 'goal-golden-1',
  payload: {
    outcome: 'succeeded',
    handoff: 'none',
    verdict: { ok: true, detail: 'inventory iron_pickaxe 1/1' },
  },
});
