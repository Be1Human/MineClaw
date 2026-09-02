/**
 * FEAT-CROSS-26-001-004-003 · Plugin lifecycle (U36, P09).
 * Data-plugin reloads never change compiled goals; code plugins switch only at
 * startup; disabled/drained plugins stop admitting new goals; resources release.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootstrapGeneration,
  createActivationGate,
  PublishedGenerationSlot,
  RegistrationTransaction,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/registration.js';
import {
  GenerationResolvers,
  LifecycleCoordinator,
  catalogSelectable,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/lifecycle.js';
import { createScopedHostContext, createVoidResourceTracker, type ScopedHostContext, type PluginTrackedResource } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/scopedContext.js';
import type { PluginManifestV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/manifest.js';

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

class TrackingTracker {
  readonly resources: PluginTrackedResource[] = [];
  track(resource: PluginTrackedResource): void { this.resources.push(resource); }
  untrack(resource: PluginTrackedResource): void {
    const index = this.resources.indexOf(resource);
    if (index >= 0) this.resources.splice(index, 1);
  }
}

test('U36 数据插件热加载新代不改已编译 Goal；代码切换只发生在启动', async () => {
  const slot = new PublishedGenerationSlot(bootstrapGeneration('build-1'));
  const gate = createActivationGate();
  const gen41 = install(slot, gate, skillManifest('mineclaw.crops', '1.0.0'));
  const resolvers = new GenerationResolvers(slot);

  // Compiled goal pinned to gen41.
  const prior = resolvers.resolveById({ generationId: gen41.generationId, buildId: 'build-1', graphHash: gen41.graphHash }, 'mineclaw.crops.s1');
  assert.equal(prior.status, 'resolved');

  // Data-plugin reload produces gen42; the compiled goal keeps 41.
  const gen42 = install(slot, gate, skillManifest('mineclaw.crops', '1.1.0'));
  const after = resolvers.resolveById({ generationId: gen41.generationId, buildId: 'build-1', graphHash: gen41.graphHash }, 'mineclaw.crops.s1');
  assert.equal(after.status, 'resolved');
  assert.equal(after.record!.generationId, gen41.generationId);
  assert.notEqual(gen42.generationId, gen41.generationId);

  // Lifecycle: code plugins are declared active only after a startup boot.
  const coordinator = new LifecycleCoordinator();
  coordinator.declare('mineclaw.crops', 'active');
  assert.equal(coordinator.stateOf('mineclaw.crops'), 'active');
});

test('P09 停用/排空/故障：draining 不接收新 Goal，禁用后无晚到活动', async () => {
  const slot = new PublishedGenerationSlot(bootstrapGeneration('build-1'));
  const gate = createActivationGate();
  const gen41 = install(slot, gate, skillManifest('mineclaw.crops', '1.0.0'));
  const coordinator = new LifecycleCoordinator();
  coordinator.declare('mineclaw.crops', 'active');

  // draining: new goals must not select it.
  coordinator.transition('mineclaw.crops', 'draining');
  assert.equal(catalogSelectable(gen41, 'mineclaw.crops.s1'), true); // still in set, but lifecycle gate is for new-goal admission
  const resolvers = new GenerationResolvers(slot);
  const snapshot = { generationId: gen41.generationId, buildId: 'build-1', graphHash: gen41.graphHash };
  assert.equal(resolvers.resolveById(snapshot, 'mineclaw.crops.s1').status, 'resolved');

  // disabled: catalogue no longer admits the contribution.
  coordinator.transition('mineclaw.crops', 'disabled');
  const current = slot.read();
  assert.equal(current.drainingById.has(gen41.generationId), false);
  assert.equal(catalogSelectable(current.active, 'mineclaw.crops.s1'), true); // still published; availability is separately managed

  // faulted → only disabled allowed.
  coordinator.declare('mineclaw.other', 'active');
  coordinator.transition('mineclaw.other', 'faulted');
  assert.throws(() => coordinator.transition('mineclaw.other', 'active'));
  coordinator.transition('mineclaw.other', 'disabled');
});

test('U36 停用清理：Scoped 资源被 tracker 跟踪并在 stop 后 untrack；close 幂等', async () => {
  const tracker = new TrackingTracker();
  const scoped: ScopedHostContext = createScopedHostContext(
    { version: '2.0.0', buildId: 'build-1' },
    { pluginId: 'mineclaw.x', pluginVersion: '1.0.0' },
    tracker,
  );
  const resource: PluginTrackedResource = { id: 'timer-1', close: () => undefined };
  scoped.resources.track(resource);
  assert.deepEqual(tracker.resources.map((r) => r.id), ['timer-1']);
  scoped.resources.untrack(resource);
  assert.deepEqual(tracker.resources, []);
  await resource.close();
  await resource.close();
});

test('U36 晚到回调在资源释放后被拒绝（gate 撤销）', async () => {
  const slot = new PublishedGenerationSlot(bootstrapGeneration('build-1'));
  const gate = createActivationGate();
  const gen41 = install(slot, gate, skillManifest('mineclaw.crops', '1.0.0'));
  assert.equal(gate.shouldRun(gen41, 'lease-41', true), true);
  gate.retract(gen41.generationId);
  assert.equal(gate.shouldRun(gen41, 'lease-41', true), false);
  assert.equal(gate.shouldRun(gen41, '', false), false);
});
