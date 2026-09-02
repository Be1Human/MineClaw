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
import { createBehaviorResolver, createAtomicResolver, atomicExecutionContextAdapter } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/execution/generationResolversPorts.js';
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
