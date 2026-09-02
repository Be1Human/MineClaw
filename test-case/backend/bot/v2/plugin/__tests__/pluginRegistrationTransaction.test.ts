/**
 * FEAT-CROSS-26-001-004-002 · Registration transaction (U32, P04, P05).
 * Failure windows: construct/stage/validate/prepareStart/CAS conflict — all must
 * abort to the previous generation with zero visibility and released resources.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootstrapGeneration,
  createActivationGate,
  PublishedGenerationSlot,
  RegistrationTransaction,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/registration.js';
import type { PluginManifestV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/manifest.js';
import { PluginContractError } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/errors.js';

function manifest(id = 'mineclaw.test', overrides: Partial<PluginManifestV1> = {}): PluginManifestV1 {
  return {
    schema: 'mineclaw.plugin/v1',
    id,
    version: '1.0.0',
    apiVersion: '^2.0.0',
    kind: 'domain',
    entry: `plugins/builtin/${id}`,
    dependencies: {},
    permissions: ['world.read:bounded-block-snapshot'],
    contributions: [{ kind: 'skill', id: `${id}.s1`, version: '1.0.0', entryRef: 'x.md' }],
    ...overrides,
  } as PluginManifestV1;
}

function skillImpl(id: string): Record<string, unknown> {
  return { kind: 'skill', id: `${id}.s1`, version: '1.0.0', entryRef: 'x.md' };
}

function slotSetup(): { slot: PublishedGenerationSlot; gate: ReturnType<typeof createActivationGate> } {
  const slot = new PublishedGenerationSlot(bootstrapGeneration('build-1'));
  return { slot, gate: createActivationGate() };
}

test('U32 construct 抛错 → abort 后零可见性、资源已释放', async () => {
  const { slot, gate } = slotSetup();
  const tx = new RegistrationTransaction(manifest(), { buildId: 'build-1', existingSlot: slot });
  assert.throws(() => tx.construct(
    { entryKey: 'x', create: () => { throw new Error('boom'); } },
    { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId: 'mineclaw.test', pluginVersion: '1.0.0' } },
  ));
  await tx.abort();
  assert.equal(slot.read().generationId, 'gen-bootstrap');
  assert.equal(tx.transactionState, 'aborted');
});

test('U32 stage 重复贡献 ID → 结构化拒绝', () => {
  const { slot } = slotSetup();
  const tx = new RegistrationTransaction(manifest(), { buildId: 'build-1', existingSlot: slot });
  tx.construct({
    entryKey: 'x',
    create: () => [
      { kind: 'skill', id: 'mineclaw.test.s1', version: '1.0.0', entryRef: 'a.md' },
      { kind: 'skill', id: 'mineclaw.test.s1', version: '1.0.0', entryRef: 'b.md' },
    ],
  }, { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId: 'mineclaw.test', pluginVersion: '1.0.0' } });
  assert.throws(() => tx.stage(),
    (error: unknown) => error instanceof PluginContractError && error.code === 'id_conflict');
});

test('U32 validate 与 active Generation 的 ID 冲突 → 整包失败', async () => {
  const { slot, gate } = slotSetup();
  // First package installs a skill.
  const first = new RegistrationTransaction(manifest('mineclaw.a'), { buildId: 'build-1', existingSlot: slot });
  first.construct({
    entryKey: 'a',
    create: () => [skillImpl('mineclaw.a')],
  }, { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId: 'mineclaw.a', pluginVersion: '1.0.0' } });
  first.stage();
  first.validate();
  first.prepareStart(gate);
  first.commit(gate, slot.read());

  // Second transaction with the same package id (direct construction, bypassing the resolver) must fail global ID uniqueness.
  const second = new RegistrationTransaction(manifest('mineclaw.a'), { buildId: 'build-1', existingSlot: slot });
  second.construct({
    entryKey: 'a',
    create: () => [skillImpl('mineclaw.a')],
  }, { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId: 'mineclaw.a', pluginVersion: '1.0.0' } });
  second.stage();
  assert.throws(() => second.validate(),
    (error: unknown) => error instanceof PluginContractError && error.code === 'id_conflict');
  await second.abort();
  assert.ok(slot.read().active.registry.byId.has('mineclaw.a.s1'));
  assert.equal(slot.read().active.registry.byId.size, 1);
});

test('U32 CAS 冲突（并发提交同一基代）→ generation_conflict', async () => {
  const { slot, gate } = slotSetup();
  const txA = new RegistrationTransaction(manifest('mineclaw.a'), { buildId: 'build-1', existingSlot: slot });
  txA.construct({
    entryKey: 'a',
    create: () => [skillImpl('mineclaw.a')],
  }, { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId: 'mineclaw.a', pluginVersion: '1.0.0' } });
  txA.stage(); txA.validate(); txA.prepareStart(gate);
  const staleBase = slot.read();
  txA.commit(gate, staleBase);

  // A second transaction still holding the stale base must fail CAS.
  const txB = new RegistrationTransaction(manifest('mineclaw.b'), { buildId: 'build-1', existingSlot: slot });
  txB.construct({
    entryKey: 'b',
    create: () => [skillImpl('mineclaw.b')],
  }, { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId: 'mineclaw.b', pluginVersion: '1.0.0' } });
  txB.stage(); txB.validate(); txB.prepareStart(gate);
  assert.throws(() => txB.commit(gate, staleBase),
    (error: unknown) => error instanceof PluginContractError && error.code === 'generation_conflict');
  await txB.abort();
});

test('U32 prepareStart 资源挡在 gate 后；commit 前回调不运行，commit 后新代放行', async () => {
  const { slot, gate } = slotSetup();
  assert.equal(gate.open, false);
  const tx = new RegistrationTransaction(manifest('mineclaw.a'), { buildId: 'build-1', existingSlot: slot });
  tx.construct({
    entryKey: 'a',
    create: () => [skillImpl('mineclaw.a')],
  }, { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId: 'mineclaw.a', pluginVersion: '1.0.0' } });
  tx.stage(); tx.validate();
  const lease = await tx.prepareStart(gate);
  assert.equal(lease.closed, false);
  const before = slot.read().active;
  assert.equal(gate.shouldRun(before, 'any', false), false);
  const record = tx.commit(gate, slot.read());
  assert.equal(gate.open, true);
  assert.equal(gate.shouldRun(record, lease.token, false), true);
  // Draining old record with an existing lease still runs.
  assert.equal(gate.shouldRun(before, '', true), true);
  // No-lease late callback on old record is rejected.
  assert.equal(gate.shouldRun(before, '', false), false);
});

test('U32 abort 关闭 prepared lease', async () => {
  const { slot, gate } = slotSetup();
  const tx = new RegistrationTransaction(manifest('mineclaw.a'), { buildId: 'build-1', existingSlot: slot });
  tx.construct({ entryKey: 'a', create: () => [skillImpl('mineclaw.a')] }, { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId: 'mineclaw.a', pluginVersion: '1.0.0' } });
  tx.stage(); tx.validate();
  const lease = await tx.prepareStart(gate);
  await tx.abort();
  assert.equal(lease.closed, true);
  assert.equal(tx.transactionState, 'aborted');
  assert.equal(slot.read().generationId, 'gen-bootstrap');
});

test('P05 确定性发布：sequential commits 累积完整 Registry 快照', () => {
  const { slot, gate } = slotSetup();
  for (const pluginId of ['mineclaw.a', 'mineclaw.b']) {
    const tx = new RegistrationTransaction(manifest(pluginId), { buildId: 'build-1', existingSlot: slot });
    tx.construct({
      entryKey: pluginId,
      create: () => [skillImpl(pluginId)],
    }, { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId, pluginVersion: '1.0.0' } });
    tx.stage();
    tx.validate();
    tx.prepareStart(gate);
    tx.commit(gate, slot.read());
  }
  const active = slot.read().active;
  assert.ok(active.registry.byId.has('mineclaw.a.s1'));
  assert.ok(active.registry.byId.has('mineclaw.b.s1'));
  assert.ok(active.registry.byId.size >= 2);
  // 旧代进入 draining。
  assert.ok(slot.read().drainingById.size >= 1);
});
