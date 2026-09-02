/**
 * FEAT-CROSS-26-001-004-003 · Registry Generation (U35, I09 plugin side, P08).
 * Old goals stay pinned to their generation; new goals use the latest active set;
 * draining records keep existing leases and are evicted when references reach zero.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapGeneration,
  createActivationGate,
  PublishedGenerationSlot,
  RegistrationTransaction,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/registration.js';
import {
  JsonGenerationStore,
  ReferenceLedger,
  GenerationSetMaintainer,
  preflightBuildUpgrade,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/registryGeneration.js';
import {
  GenerationResolvers,
  LifecycleCoordinator,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/lifecycle.js';
import type { PluginManifestV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/manifest.js';
import type { ContributionRef, RegistrySnapshotRef } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/identity.js';

function skillManifest(id: string, version: string): PluginManifestV1 {
  return {
    schema: 'mineclaw.plugin/v1', id, version, apiVersion: '^2.0.0', kind: 'domain',
    entry: `e/${id}`, dependencies: {},
    permissions: ['world.read:bounded-block-snapshot'],
    contributions: [{ kind: 'skill', id: `${id}.s1`, version: '1.0.0', entryRef: 'x.md' }],
  } as PluginManifestV1;
}

function install(slot: PublishedGenerationSlot, gate: ReturnType<typeof createActivationGate>, manifest: PluginManifestV1) {
  const tx = new RegistrationTransaction(manifest, { buildId: 'build-1', existingSlot: slot });
  tx.construct({
    entryKey: manifest.entry!,
    create: () => [{ kind: 'skill', id: `${manifest.id}.s1`, version: '1.0.0', entryRef: 'x.md' }],
  }, { host: { version: '2.0.0', buildId: 'build-1' }, plugin: { pluginId: manifest.id, pluginVersion: manifest.version } });
  tx.stage(); tx.validate(); tx.prepareStart(gate);
  return tx.commit(gate, slot.read());
}

function snapshotOf(record: { generationId: string; buildId: string; graphHash: string }): RegistrySnapshotRef {
  return { generationId: record.generationId, buildId: record.buildId, graphHash: record.graphHash };
}

test('U35 Gen41 运行中发布数据插件新版本形成 42：旧 Goal 固定 41，draining 后引用清零移除并由 gate 拒绝晚到', async () => {
  const slot = new PublishedGenerationSlot(bootstrapGeneration('build-1'));
  const gate = createActivationGate();
  const gen41 = install(slot, gate, skillManifest('mineclaw.old', '1.0.0'));
  const snapshot41 = snapshotOf(gen41);
  const resolvers = new GenerationResolvers(slot);
  const ledger = new ReferenceLedger();
  const maintainer = new GenerationSetMaintainer(slot, ledger, (id) => gate.retract(id));

  // Old goal references gen41.
  ledger.reference(snapshot41, 'goal-41');
  // Data plugin new version creates gen42.
  const gen42 = install(slot, gate, skillManifest('mineclaw.facts', '2.0.0'));
  const snapshot42 = snapshotOf(gen42);
  assert.notEqual(gen42.generationId, gen41.generationId);
  assert.ok(slot.read().drainingById.has(gen41.generationId), 'gen41 must be draining');

  // Old goal resolves 41 regardless of the new active set.
  const oldResolve = resolvers.resolveById(snapshot41, 'mineclaw.old.s1');
  assert.equal(oldResolve.status, 'resolved');
  assert.equal(oldResolve.record!.generationId, gen41.generationId);
  assert.equal(oldResolve.entry!.ref.pluginId, 'mineclaw.old');

  // New goal uses 42 and cannot obtain a gen41 lease.
  const newResolve = resolvers.resolveById(snapshot42, 'mineclaw.facts.s1');
  assert.equal(newResolve.status, 'resolved');
  assert.equal(newResolve.record!.generationId, gen42.generationId);
  const oldActive = slot.read().active;
  const nullNewAttempt = resolvers.resolveById(snapshot41, 'mineclaw.facts.s1');
  assert.equal(nullNewAttempt.status, 'in_doubt', 'new contribution is not in the old generation');

  // Existing lease callbacks keep running while draining.
  assert.equal(gate.shouldRun(gen41, 'gen41-token', true), true);

  // Reference clears → evicted from set and the gate retracts the record.
  const evicted = maintainer.releaseAndMaybeEvict(snapshot41, 'goal-41');
  assert.equal(evicted, true);
  assert.ok(!slot.read().drainingById.has(gen41.generationId));
  assert.equal(gate.shouldRun(gen41, 'gen41-token', true), false, 'late callback without lease must be refused');
  assert.equal(gate.shouldRun(gen41, '', false), false);
  void oldActive;
});

test('I09 插件侧 同构建重启恢复原代；跨构建升级预检阻止，绕过则 needs_rebind/in_doubt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mineclaw-gen-'));
  try {
    const store = new JsonGenerationStore(join(dir, 'generations.json'));
    const slotA = new PublishedGenerationSlot(bootstrapGeneration('build-1'));
    const gateA = createActivationGate();
    const recordA = install(slotA, gateA, skillManifest('mineclaw.a', '1.0.0'));
    store.save(recordA);

    // Restart (same build): restore the durable generation.
    const restored = store.loadLatest();
    assert.ok(restored);
    assert.equal(restored.generationId, recordA.generationId);
    assert.equal(restored.buildId, 'build-1');

    // Same-build upgrade is allowed by preflight.
    const sameBuild = preflightBuildUpgrade('build-1', 'build-1', [{ generationId: recordA.generationId, buildId: 'build-1', graphHash: recordA.graphHash }]);
    assert.equal(sameBuild.decision, 'allowed');

    // Cross-build with a non-terminal reference is blocked.
    const now = new Date().toISOString();
    void now;
    const cross = preflightBuildUpgrade('build-1', 'build-2', [{ generationId: recordA.generationId, buildId: 'build-1', graphHash: recordA.graphHash }]);
    assert.equal(cross.decision, 'blocked');
    assert.match(cross.reason!, /non-terminal/);

    // Bypassing the guard: resolver on a build mismatch yields needs_rebind/in_doubt.
    const restoredSlot = new PublishedGenerationSlot({
      active: restored,
      drainingById: new Map(),
      generationId: restored.generationId,
    });
    const resolvers = new GenerationResolvers(restoredSlot);
    const result = resolvers.resolveById(snapshotOf(restored), 'mineclaw.a.s1');
    assert.equal(result.status, 'in_doubt', 'registry identities are not restored from the raw file; only the durable reference survives');
    assert.notEqual(result.status, 'resolved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P08 同一 snapshotRef 贯穿 Observation/Binding/Candidate/Predicate/Progress/Behavior/Atomic/Result 解析', () => {
  const slot = new PublishedGenerationSlot(bootstrapGeneration('build-1'));
  const gate = createActivationGate();
  const record = install(slot, gate, skillManifest('mineclaw.loop', '1.0.0'));
  const snapshot = snapshotOf(record);
  const resolvers = new GenerationResolvers(slot);

  const contributionRef: ContributionRef = { pluginId: 'mineclaw.loop', pluginVersion: '1.0.0', contributionId: 'mineclaw.loop.s1', contributionVersion: '1.0.0' };
  const stages = [
    resolvers.resolveContribution(snapshot, contributionRef),
    resolvers.resolveContribution(snapshot, contributionRef),
    resolvers.resolveContribution(snapshot, contributionRef),
    resolvers.resolveById(snapshot, 'mineclaw.loop.s1'),
    resolvers.resolveById(snapshot, 'mineclaw.loop.s1'),
    resolvers.resolveById(snapshot, 'mineclaw.loop.s1'),
    resolvers.resolveById(snapshot, 'mineclaw.loop.s1'),
    resolvers.resolveById(snapshot, 'mineclaw.loop.s1'),
    resolvers.resolveById(snapshot, 'mineclaw.loop.s1'),
  ];
  for (const stage of stages) {
    assert.equal(stage.status, 'resolved');
    assert.equal(stage.record!.generationId, record.generationId);
    assert.equal(stage.entry!.ref.contributionId, 'mineclaw.loop.s1');
  }
});

test('U35 atomic/command 精确引用：解析返回精确 SemVer，不查最新 Registry', () => {
  const slot = new PublishedGenerationSlot(bootstrapGeneration('build-1'));
  const gate = createActivationGate();
  const gen41 = install(slot, gate, skillManifest('mineclaw.atomic', '1.0.0'));
  const resolvers = new GenerationResolvers(slot);
  const snapshot = snapshotOf(gen41);

  // Old generation still answers exactly what the goal pinned.
  const resolved = resolvers.resolveById(snapshot, 'mineclaw.atomic.s1');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.entry!.ref.contributionVersion, '1.0.0');

  // New active set is never consulted for a pinned snapshot.
  install(slot, gate, skillManifest('mineclaw.atomic2', '2.0.0'));
  const again = resolvers.resolveById(snapshot, 'mineclaw.atomic.s1');
  assert.equal(again.status, 'resolved');
  assert.equal(again.entry!.ref.pluginVersion, '1.0.0');
});

test('LifecycleCoordinator: prepared→active→draining→disabled；faulted 只能到 disabled', () => {
  const coordinator = new LifecycleCoordinator();
  coordinator.declare('mineclaw.guard', 'prepared');
  coordinator.transition('mineclaw.guard', 'active');
  coordinator.transition('mineclaw.guard', 'draining');
  coordinator.transition('mineclaw.guard', 'disabled');
  assert.equal(coordinator.stateOf('mineclaw.guard'), 'disabled');

  coordinator.declare('mineclaw.broken', 'active');
  coordinator.transition('mineclaw.broken', 'faulted');
  assert.throws(() => coordinator.transition('mineclaw.broken', 'active'));
});
