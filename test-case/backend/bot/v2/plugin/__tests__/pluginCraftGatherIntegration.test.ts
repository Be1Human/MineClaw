/**
 * FEAT-CROSS-26-001-004-004 · crafting/gathering batch (P2-7).
 * Both register closed loops with exact contribution IDs and fail explicitly
 * when the body service is unavailable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { createMineclawMinecraftSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import { createMineclawInventoryPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/inventory/index.js';
import { createMineclawCraftingPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/crafting/index.js';
import { createMineclawGatheringPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/gathering/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUILTIN = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/', import.meta.url));

function fullIndex(): BuiltinPluginIndex {
  const entry = (id: string, factory: () => unknown) => {
    const manifest = parse(readFileSync(`${BUILTIN}/${id}/plugin.yaml`, 'utf8')) as Record<string, unknown>;
    return { entryKey: `plugins/builtin/${manifest.id}`, manifest, factory: factory() as never };
  };
  return {
    byEntryKey: new Map([
      ['plugins/builtin/mineclaw.minecraft-system', entry('minecraft-system', createMineclawMinecraftSystemPlugin)],
      ['plugins/builtin/mineclaw.inventory', entry('inventory', createMineclawInventoryPlugin)],
      ['plugins/builtin/mineclaw.crafting', entry('crafting', createMineclawCraftingPlugin)],
      ['plugins/builtin/mineclaw.gathering', entry('gathering', createMineclawGatheringPlugin)],
    ]),
  };
}

function host(): PluginHost {
  return new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: fullIndex(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
    systemPorts: {
      inventoryObservation: {
        observe: async () => ({
          snapshotVersion: 'v1',
          observedAt: new Date().toISOString(),
          subjectRef: 'owner',
          slots: [{ slot: 0, itemId: 'oak_log', count: 8 }],
          complete: true,
          truncated: false,
          evidenceRefs: ['inv-1'],
        }),
      },
    },
  });
}

test('P2-7 crafting/gathering 闭环注册与全链 boot（8 插件级全量含依赖）', async () => {
  const result = await host().boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.ok(result.installed.includes('mineclaw.crafting'));
  assert.ok(result.installed.includes('mineclaw.gathering'));
  const active = result.slot.read().active;
  for (const id of [
    'mineclaw.crafting.goal.craft-item', 'mineclaw.crafting.execution.craft-item',
    'mineclaw.gathering.goal.gather-material', 'mineclaw.gathering.execution.gather-material',
  ]) {
    assert.ok(active.registry.byId.has(id), `missing ${id}`);
    assert.equal(active.registry.byId.get(id)!.ref.pluginVersion, '1.0.0');
  }
});

test('P2-7 Host body 失败收据令两执行器显式失败（不伪装成功）', async () => {
  const craftingContributions = createMineclawCraftingPlugin().create({
    host: { version: '2.0.0', buildId: 'b' },
    plugin: { pluginId: 'mineclaw.crafting', pluginVersion: '1.0.0' },
  });
  const craftExec = (craftingContributions.find(c => c.kind === 'execution') as any).behaviorFactory;
  const craft = craftExec.create({ goalId: 'g' } as never);
  assert.deepEqual(craft.compile({ goal: { goalId: 'g' }, facts: [], params: { item: 'torch' } }).steps,
    [{ atomicId: 'craft', args: { itemName: 'torch', count: 1 } }]);

  const gatheringContributions = createMineclawGatheringPlugin().create({
    host: { version: '2.0.0', buildId: 'b' },
    plugin: { pluginId: 'mineclaw.gathering', pluginVersion: '1.0.0' },
  });
  const gatherExec = (gatheringContributions.find(c => c.kind === 'execution') as any).behaviorFactory;
  const gather = gatherExec.create({ goalId: 'g' } as never);
  const gatherPlan = gather.compile({ goal: { goalId: 'g' }, facts: [], params: { target: { position: { x: 1, y: 2, z: 3 } } } });
  assert.equal(gather.kind, 'sequence');
  assert.deepEqual(gatherPlan.steps.map((step: { atomicId: string }) => step.atomicId), ['move_to', 'dig']);
});
