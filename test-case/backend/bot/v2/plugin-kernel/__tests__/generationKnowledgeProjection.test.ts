/**
 * FEAT-CROSS-26-001-004-004 · generation→knowledge projection (P3-4).
 * PluginAtomicContract[] maps to legacy ActionContractDefinition shape; prepare
 * honors contract.invalid, normalize maps to failure envelope, missing contract
 * metadata yields the safe pass-through default.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAtomicContractsToKnowledge } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/generationKnowledgeProjection.js';
import type { PluginAtomicContract } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/execution.js';

const contract: PluginAtomicContract = {
  atomicId: 'move_to',
  version: '1.0.0',
  schema: { type: 'object', properties: { position: { type: 'object' } } },
  prepare: request => ('position' in request && request.position !== undefined)
    ? { prepared: { position: request.position }, derivedFields: ['position'] }
    : { invalid: { code: 'contract.invalid_parameter', message: 'bad args' } },
  normalize: result => (result as { ok?: boolean }).ok === false ? { code: 'atomic_failed', message: 'boom' } : null,
};

test('projection: schema/prepare/normalize 映射到 legacy 形状且语义保持', () => {
  const [def] = projectAtomicContractsToKnowledge([contract]);
  assert.equal(def.action, 'move_to');
  assert.ok(def.schema);
  const ready = def.prepare({ action: 'move_to', source: 'test', args: { position: { x: 1, y: 64, z: 1 } } }, { now: 0 });
  assert.equal(ready.kind, 'ready');
  if (ready.kind === 'ready') {
    assert.equal((ready.action.target as { position?: unknown }).position !== undefined, true);
    assert.deepEqual(ready.action.derivedFields, ['position']);
  }
  const invalid = def.prepare({ action: 'move_to', source: 'test', args: {} }, { now: 0 });
  assert.equal(invalid.kind, 'invalid');
  const okNormalize = def.normalize({ ok: true } as never);
  assert.equal(okNormalize, null);
  const failNormalize = def.normalize({ ok: false, error: 'boom' } as never);
  assert.ok(failNormalize);
  assert.match(JSON.stringify(failNormalize), /boom/);
});

test('projection: 无 prepare/normalize 的目录型契约使用安全透传', () => {
  const [def] = projectAtomicContractsToKnowledge([{ atomicId: 'say', version: '1.0.0' }]);
  const ready = def.prepare({ action: 'say', source: 'test', args: { text: 'hi' } }, { now: 0 });
  assert.equal(ready.kind, 'ready');
  if (ready.kind === 'ready') {
    assert.deepEqual(ready.action.target, { text: 'hi' });
    assert.deepEqual(ready.action.derivedFields, []);
  }
  assert.equal(def.normalize({ ok: true } as never), null);
});
