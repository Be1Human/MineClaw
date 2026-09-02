/**
 * FEAT-CROSS-26-001-004-004 · placement/combat batch (P2-9).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { createMineclawMinecraftSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import { createMineclawPlacementPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/placement/index.js';
import { createMineclawCombatPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/combat/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUILTIN = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/', import.meta.url));

function index(): BuiltinPluginIndex {
  const entry = (id: string, factory: () => unknown) => {
    const manifest = parse(readFileSync(`${BUILTIN}/${id}/plugin.yaml`, 'utf8')) as Record<string, unknown>;
    return { entryKey: `plugins/builtin/${manifest.id}`, manifest, factory: factory() as never };
  };
  return {
    byEntryKey: new Map([
      ['plugins/builtin/mineclaw.minecraft-system', entry('minecraft-system', createMineclawMinecraftSystemPlugin)],
      ['plugins/builtin/mineclaw.placement', entry('placement', createMineclawPlacementPlugin)],
      ['plugins/builtin/mineclaw.combat', entry('combat', createMineclawCombatPlugin)],
    ]),
  };
}

test('P2-9 placement/combat 注册；combat 无实体观察时候选显式 unavailable；无 body 服务显式失败', async () => {
  const result = await new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
  }).boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  const active = result.slot.read().active;
  assert.ok(active.registry.byId.has('mineclaw.placement.execution.place-relative'));
  assert.ok(active.registry.byId.has('mineclaw.combat.execution.combat-target'));

  // combat 候选：无实体事实 → unavailable（绝不猜测）。
  const combatCandidates = (active.registry.byId.get('mineclaw.combat.planning.combat-candidates')!.contribution as { candidateProvider: { list: (i: unknown) => Promise<{ status: string; reason?: string }> } }).candidateProvider;
  const listed = await combatCandidates.list({ goal: {}, snapshot: {}, facts: [], params: {}, signal: new AbortController().signal, budget: {} } as never);
  assert.equal(listed.status, 'unavailable');
  assert.match(listed.reason ?? '', /entity_observation_unavailable/);

  // 无 body 服务：placement 执行器显式失败。
  const placementContributions = createMineclawPlacementPlugin().create({ host: { version: '2.0.0', buildId: 'b' }, plugin: { pluginId: 'mineclaw.placement', pluginVersion: '1.0.0' } });
  const placementExec = (placementContributions.find(c => c.kind === 'execution') as { behaviorFactory: { create: (l: Record<string, unknown>) => { run: (ctx: { signal: AbortSignal; facts: Record<string, unknown>[] }) => Promise<{ ok: boolean; error?: string }> } } }).behaviorFactory;
  const outcome = await placementExec.create({ goalId: 'g' } as never).run({ signal: new AbortController().signal, facts: [] } as never);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /body_submit_service_missing/);
});
