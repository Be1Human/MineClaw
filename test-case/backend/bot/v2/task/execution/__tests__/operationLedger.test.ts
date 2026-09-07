import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openSqliteDatabase } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/sqliteDatabase.js';
import type { OperationIdentity, OperationIntent, StopAcknowledgement } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/bodyOperation.js';
import type { OperationReceipt } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/contracts/operationReceipt.js';
import { BodyExecutionRuntime } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/bodyExecutionRuntime.js';
import { ExecutionAuthority } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/executionAuthority.js';
import { OperationLedger, operationArgsHash } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/operationLedger.js';
import { OperationRecoveryCoordinator } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/operationRecoveryCoordinator.js';

const snapshot = { generationId: 'gen-ledger', buildId: 'build-ledger', graphHash: 'graph-ledger' };
const contribution = {
  pluginId: 'mineclaw.agriculture', pluginVersion: '2.3.0',
  contributionId: 'mineclaw.agriculture.behavior.sow-field', contributionVersion: '1.4.0',
};
function intent(operationId = 'goal:node-1:attempt-1', args: Record<string, unknown> = { fieldId: 'field-7' }): OperationIntent {
  return {
    operationId, owner: { kind: 'goal', taskId: 'task-1', sessionId: 'goal-1', epoch: 2, planRevision: 4 },
    command: { ref: { id: 'behavior:sow-field', contribution }, snapshot, args },
    expectedEffects: [{ type: 'predicate', predicate: 'crop_planted', predicateVersion: '1.0.0', args: { fieldId: 'field-7' } }],
    scope: { dimension: 'overworld', targetRefs: ['field-7'], bindings: [] },
    deadlineAt: Date.now() + 60_000, budget: { maxActions: 12 }, priority: 50, preemption: 'none',
  };
}
function identity(operation: OperationIntent, operationEpoch = 1): OperationIdentity {
  return { operationId: operation.operationId, owner: operation.owner, operationEpoch,
    leaseRef: `process-a:${operationEpoch}`, deadlineAt: operation.deadlineAt };
}
function stop(id: OperationIdentity, at = Date.now()): StopAcknowledgement { return { ...id, state: 'quiesced', at }; }
function receipt(id: OperationIdentity, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): OperationReceipt {
  const stopped = stop(id);
  return {
    ...id, schema: 'mineclaw.operation-receipt/v2', source:{commandId:'behavior:sow-field',contribution,snapshot,
      argsHash:operationArgsHash({fieldId:'field-7'}),grantHash:'grant-1'},status, stop: stopped, noOp: false,
    effects: [{ predicate: { id: 'crop_planted', version: '1.0.0', args: { fieldId: 'field-7' } }, evidenceRefs: ['world:block:7'] }],
    evidenceRefs: ['world:block:7'], startedAt: stopped.at - 10, completedAt: stopped.at,
  };
}

test('U22/P08: ledger persists exact plugin, contribution and Registry Generation source and replays one terminal receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'operation-ledger-'));
  const file = join(root, 'operations.db');
  try {
    const op = intent(); const id = identity(op);
    const first = new OperationLedger(file);
    assert.deepEqual(first.begin({ intent: op, identity: id, grantHash: 'grant-1', startedAt: 100 }), { status: 'new' });
    first.recordEffect(op.operationId, receipt(id).effects[0]!, 110);
    first.acknowledgeStop(op.operationId, stop(id, 120));
    first.complete({ ...receipt(id), startedAt: 100, completedAt: 120, stop: stop(id, 120) });
    const stored = first.get(op.operationId)!;
    assert.deepEqual(stored.source, { ...contribution, ...snapshot });
    first.close();

    const restarted = new OperationLedger(file);
    const replay = restarted.begin({ intent: op, identity: identity(op, 99), grantHash: 'grant-1', startedAt: 500 });
    assert.equal(replay.status, 'completed');
    if (replay.status === 'completed') {
      assert.equal(replay.receipt.operationEpoch, 1);
      assert.equal(replay.receipt.effects.length, 1);
    }
    restarted.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('U22: logical identity rejects changed content while identical parameters under a new operation ID execute independently', () => {
  const ledger = new OperationLedger(':memory:');
  const first = intent('node:attempt:1');
  assert.equal(ledger.begin({ intent: first, identity: identity(first), grantHash: 'grant-a', startedAt: 1 }).status, 'new');
  const changed = intent(first.operationId, { fieldId: 'other' });
  assert.throws(() => ledger.begin({ intent: changed, identity: identity(changed), grantHash: 'grant-b', startedAt: 2 }), /operation_identity_conflict/);
  const next = intent('node:attempt:2');
  assert.equal(ledger.begin({ intent: next, identity: identity(next, 2), grantHash: 'grant-b', startedAt: 3 }).status, 'new');
  ledger.close();
});

test('I04: every non-terminal crash window becomes in_doubt and retains effects, cancel and stop evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'operation-ledger-crash-'));
  try {
    for (const crash of ['after_begin', 'after_effect', 'after_cancel', 'after_stop'] as const) {
      const file = join(root, `${crash}.db`); const op = intent(crash); const id = identity(op);
      const first = new OperationLedger(file);
      first.begin({ intent: op, identity: id, grantHash: 'grant', startedAt: 10 });
      if (crash !== 'after_begin') first.recordEffect(op.operationId, receipt(id).effects[0]!, 11);
      if (crash === 'after_cancel' || crash === 'after_stop') first.requestCancel(op.operationId, 'owner_stop', 12);
      if (crash === 'after_stop') first.acknowledgeStop(op.operationId, stop(id, 13));
      first.close();
      const restarted = new OperationLedger(file);
      const replay = restarted.begin({ intent: op, identity: identity(op, 2), grantHash: 'grant', startedAt: 20 });
      assert.equal(replay.status, 'in_doubt', crash);
      if (replay.status === 'in_doubt') {
        assert.equal(replay.record.effects.length, crash === 'after_begin' ? 0 : 1, crash);
        assert.equal(!!replay.record.stop, crash === 'after_stop', crash);
        assert.match(replay.record.recoveryReason ?? '', /process_restarted_during/, crash);
      }
      restarted.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('I04/I09: BodyRuntime never dispatches an in-doubt operation to a new process or latest implementation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'operation-ledger-runtime-')); const file = join(root, 'operations.db');
  try {
    const op = intent();
    const authorityA = new ExecutionAuthority();
    const authorizedA = { intent: op, grant: authorityA.issue(op, { isCurrent: () => true, allowsChild: () => false }) };
    const first = new OperationLedger(file);
    first.begin({ intent: op, identity: identity(op), grantHash: authorityA.grantHash(authorizedA)!, startedAt: 1 });
    first.close();

    let binds = 0;
    const authorityB = new ExecutionAuthority();
    const restarted = new OperationLedger(file);
    const runtime = new BodyExecutionRuntime({ ledger: restarted, authority: authorityB, driver: {
      resources: () => ['body'], bind: () => { binds++; return { run: async () => ({ ok: true }), stop: async () => undefined }; },
    } });
    const result = await runtime.submit({ intent: op, grant: authorityB.issue(op, { isCurrent: () => true, allowsChild: () => false }) }).result;
    assert.equal(result.status, 'in_doubt');
    assert.equal(result.failure?.code, 'execution.result_unknown');
    assert.equal(result.failure?.retryable, false);
    assert.equal(binds, 0);
    restarted.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('I04: fixed-source readback recovers completed, releases proven-not-started, and preserves unknown operations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'operation-ledger-reconcile-')); const file = join(root, 'operations.db');
  let ledger: OperationLedger | null = null;
  try {
    const first = new OperationLedger(file);
    const intents = new Map<string, OperationIntent>();
    for (const id of ['completed', 'not-started', 'unknown']) {
      const op = intent(id);
      intents.set(id, op);
      first.begin({ intent: op, identity: identity(op), grantHash: `grant-${id}`, startedAt: 10 });
    }
    first.close();
    ledger = new OperationLedger(file);
    const seenGenerations: string[] = [];
    const recovery = new OperationRecoveryCoordinator(ledger, { readback: async record => {
      seenGenerations.push(record.intent!.command.snapshot.generationId);
      if (record.operationId === 'completed') return { status: 'completed', effects: [], evidenceRefs: ['world:completed'], reason: 'postcondition_satisfied', at: 20 };
      if (record.operationId === 'not-started') return { status: 'not_started', evidenceRefs: ['world:no_effect'], reason: 'all_targets_unchanged', at: 20 };
      return { status: 'unknown', evidenceRefs: ['world:truncated'], reason: 'chunks_unloaded', at: 20 };
    } });
    const results = await recovery.recover(new AbortController().signal);
    assert.deepEqual(results.map(result => result.status), ['recovered', 'ready_to_retry', 'in_doubt']);
    assert.deepEqual(seenGenerations, ['gen-ledger', 'gen-ledger', 'gen-ledger']);
    assert.equal(ledger.get('completed')?.receipt?.details?.recoveredByReadback, true);
    const retry = intents.get('not-started')!;
    assert.equal(ledger.begin({ intent: retry, identity: identity(retry, 2), grantHash: 'grant-not-started', startedAt: 30 }).status, 'new');
    assert.equal(ledger.get('unknown')?.status, 'in_doubt');
    ledger.close(); ledger = null;
  } finally { ledger?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('migration: legacy GoalAgent rows become source-unproven read-only in_doubt records', () => {
  const root = mkdtempSync(join(tmpdir(), 'operation-ledger-migrate-')); const file = join(root, 'operations.db');
  try {
    const db = openSqliteDatabase(file);
    db.exec(`CREATE TABLE goal_agent_actions (
      idempotency_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      status TEXT NOT NULL, proposal_json TEXT NOT NULL, result_json TEXT,
      started_at TEXT NOT NULL, completed_at TEXT
    )`);
    db.prepare(`INSERT INTO goal_agent_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-key', 'legacy-session', 1, 'started', JSON.stringify({ action: 'plant' }), null, '2026-09-01T00:00:00.000Z', null);
    db.close();
    const ledger = new OperationLedger(file);
    const migrated = ledger.get('legacy-key')!;
    assert.equal(migrated.status, 'in_doubt');
    assert.equal(migrated.intent, null);
    assert.equal(migrated.identity, null);
    assert.equal(migrated.source.generationId, null);
    assert.equal(migrated.recoveryReason, 'needs_rebind:legacy_source_unproven');
    ledger.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
