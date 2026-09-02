/**
 * FEAT-CROSS-26-001-004-003/-004 · generation-pinned driver resolver ports (P3-3).
 * Behavior/atomic resolution goes through the pinned snapshot only; in_doubt
 * never falls back to the live registry.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PluginHost } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { loadProductionBuiltinIndex } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/productionIndex.js';
import { GenerationResolvers } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/lifecycle.js';
import { createBehaviorResolver, createAtomicResolver, createAtomicEntryResolver, createContractResolver, atomicExecutionContextAdapter } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/generationResolversPorts.js';
import type { ContributionRef } from '../../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/identity.js';

const KERNEL = fileURLToPath(new URL('../../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/', import.meta.url));

async function booted() {
  const index = loadProductionBuiltinIndex({ manifestPath: `${KERNEL}/builtin-manifest.generated.json` });
  const result = await new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index,
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system', 'mineclaw.llm-system'],
  }).boot();
  return result;
}

test('P3-3 行为解析经固定 snapshot：agriculture 行为工厂同代解析；不存在贡献 in_doubt', async () => {
  const result = await booted();
  assert.deepEqual(result.failures, []);
  const active = result.slot.read().active;
  const snapshot = { generationId: active.generationId, buildId: active.buildId, graphHash: active.graphHash };
  const resolvers = new GenerationResolvers(result.slot);
  const behaviorResolver = createBehaviorResolver(resolvers);
  const ref: ContributionRef = {
    pluginId: 'mineclaw.agriculture', pluginVersion: '1.0.0',
    contributionId: 'mineclaw.agriculture.execution.harvest-to-chest', contributionVersion: '1.0.0',
  };
  const resolved = behaviorResolver.resolve(snapshot, ref);
  assert.equal(resolved.status, 'resolved');
  if (resolved.status === 'resolved') {
    assert.equal(typeof resolved.value.create, 'function');
  }
  const missing = behaviorResolver.resolve(snapshot, { ...ref, contributionId: 'mineclaw.agriculture.execution.none' });
  assert.equal(missing.status, 'in_doubt');
});

test('P3-3 原子解析同代精确 SemVer；晚代查询 in_doubt', async () => {
  const result = await booted();
  const active = result.slot.read().active;
  const snapshot = { generationId: active.generationId, buildId: active.buildId, graphHash: active.graphHash };
  const atomicResolver = createAtomicResolver(new GenerationResolvers(result.slot));
  const resolved = atomicResolver.resolve(snapshot, 'move_to');
  assert.equal(resolved.status, 'resolved');
  if (resolved.status === 'resolved') {
    assert.equal(resolved.value.id, 'mineclaw.minecraft-system.atomic.move_to');
  }
  const wrongSnapshot = atomicResolver.resolve({ ...snapshot, generationId: 'gen-bootstrap' }, 'move_to');
  assert.equal(wrongSnapshot.status, 'in_doubt');
});

test('P3-3 受控上下文适配器：assertCurrent/wait/deadline 原样转发', async () => {
  let asserts = 0;
  let waited = 0;
  const adapter = atomicExecutionContextAdapter({
    deadlineAt: 999,
    assertCurrent: (reason: string) => { asserts += 1; void reason; },
    wait: async (ms: number) => { waited += ms; },
  } as unknown as Parameters<typeof atomicExecutionContextAdapter>[0]);
  adapter.assertCurrent('x');
  await adapter.wait(50);
  assert.equal(asserts, 1);
  assert.equal(waited, 50);
  assert.equal(adapter.deadlineAt, 999);
});

test('P3-4 F12 contract 承载：entry 解析返回 executor+contract；contract 解析返回元数据；无 contract 原子 in_doubt', async () => {
  const result = await booted();
  const active = result.slot.read().active;
  const snapshot = { generationId: active.generationId, buildId: active.buildId, graphHash: active.graphHash };
  const resolvers = new GenerationResolvers(result.slot);
  const entryResolver = createAtomicEntryResolver(resolvers);
  const contractResolver = createContractResolver(resolvers);

  const entry = entryResolver.resolve(snapshot, 'move_to');
  assert.equal(entry.status, 'resolved');
  if (entry.status === 'resolved') {
    assert.equal(typeof entry.value.executor.execute, 'function');
    assert.ok(entry.value.contract !== null);
    assert.equal(entry.value.contract!.atomicId, 'move_to');
    assert.ok(entry.value.contract!.schema !== undefined);
    // P08 精确贡献引用：原子由系统插件 execution 贡献承载
    assert.equal(entry.value.contribution.pluginId, 'mineclaw.minecraft-system');
    assert.equal(entry.value.contribution.contributionId, 'mineclaw.minecraft-system.execution.atomics');
  }

  // list 返回代内全部 contract（含每条目元数据）
  const all = contractResolver.list(snapshot);
  assert.equal(all.status, 'resolved');
  if (all.status === 'resolved') {
    assert.ok(all.value.length >= 30, `contract list ${all.value.length}`);
    assert.ok(all.value.some(contract => contract.atomicId === 'toss_item'));
  }

  const contract = contractResolver.resolve(snapshot, 'move_to');
  assert.equal(contract.status, 'resolved');
  if (contract.status === 'resolved') {
    // prepare 校验：缺 position/entityId → invalid；正常参数 → prepared
    const invalid = contract.value.prepare?.({ text: 'x' });
    assert.equal(typeof invalid, 'object');
    assert.equal((invalid as { invalid?: unknown }).invalid !== undefined, true);
    const prepared = contract.value.prepare?.({ position: { x: 1, y: 64, z: 2 } });
    assert.equal(typeof prepared, 'object');
    assert.equal(JSON.stringify(prepared ?? {}).includes('position'), true);
  }

  const wrongSnapshot = entryResolver.resolve({ ...snapshot, generationId: 'gen-bootstrap' }, 'move_to');
  assert.equal(wrongSnapshot.status, 'in_doubt');
  const missing = entryResolver.resolve(snapshot, 'no_such_atomic');
  assert.equal(missing.status, 'in_doubt');
});
