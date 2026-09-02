/**
 * FEAT-CROSS-26-001-004-002/-004 · mineclaw.minecraft-system plugin (P2-2).
 * The first-party system plugin boots through PluginHost with injected adapter
 * ports, registers its atomic catalog + game integration contribution, is
 * exempt from the domain static gate, and executes primitives through the
 * injected ports.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { createMineclawMinecraftSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';

const pluginDir = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system', import.meta.url));

function systemIndex(): BuiltinPluginIndex {
  const manifest = parse(readFileSync(join(pluginDir, 'plugin.yaml'), 'utf8')) as Record<string, unknown>;
  return {
    byEntryKey: new Map([
      ['plugins/builtin/mineclaw.minecraft-system', { entryKey: 'plugins/builtin/mineclaw.minecraft-system', manifest, factory: createMineclawMinecraftSystemPlugin() }],
    ]),
  };
}

test('P2-2 系统插件经 PluginHost 注册：atomic catalog 与 integration 贡献就位，closure 豁免', async () => {
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: systemIndex(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
    systemPorts: {},
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.ok(result.installed.includes('mineclaw.minecraft-system'));
  const active = result.slot.read().active;
  const execution = active.registry.byId.get('mineclaw.minecraft-system.execution.atomics');
  assert.ok(execution);
  assert.equal(execution!.contribution.kind, 'execution');
  const catalog = (execution!.contribution as { atomicCatalog?: unknown[] }).atomicCatalog;
  assert.ok(Array.isArray(catalog) && catalog!.length >= 10, `catalog size ${catalog?.length}`);
  const integration = active.registry.byId.get('mineclaw.minecraft-system.integration.game');
  assert.ok(integration);
  assert.equal(integration!.contribution.kind, 'integration');
});

test('P2-2 系统插件豁免静态依赖门（可引用 adapter 端口），域插件仍被拒', async () => {
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: systemIndex(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
    staticDependencyImports: new Map([
      ['plugins/builtin/mineclaw.minecraft-system', ['../../../../adapter/GameAdapter.js']],
    ]),
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  // domain plugin with the same import would be rejected by checkStaticDependencyPolicy.
  const { checkStaticDependencyPolicy, FIRST_PARTY_STATIC_POLICY } = await import('../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/permission.js');
  assert.throws(() => checkStaticDependencyPolicy('mineclaw.x', 'e/x', ['../../../../adapter/GameAdapter.js'], FIRST_PARTY_STATIC_POLICY));
});

test('P2-2 端口注入：executor 经注入的 game/nav 端口执行原语', async () => {
  const calls: string[] = [];
  const ports = {
    game: {
      getPosition: () => ({ x: 0, y: 64, z: 0 }),
      getEntities: () => [],
      getBlocks: () => ({}),
      getContainer: () => null,
      setControlState: () => undefined,
      clearControlStates: () => undefined,
      lookAt: () => undefined,
      useItem: () => undefined,
      selectSlot: () => undefined,
      equip: () => undefined,
      chat: () => undefined,
    },
    nav: { goto: async (target: unknown) => { calls.push(`goto:${String((target as { position?: unknown }).position)}`); return { ok: true }; }, stop: async () => undefined },
    bus: { publish: () => undefined },
    getWorld: () => ({ environment: { dimension: 'overworld' }, owner: null, blockAt: () => undefined }),
  };
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: systemIndex(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
    systemPorts: ports,
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, []);
  const execution = result.slot.read().active.registry.byId.get('mineclaw.minecraft-system.execution.atomics')!;
  const executor = (execution.contribution as { atomicCatalog: Array<{ atomicId: string; executor: { execute: (cmd: { request: Record<string, unknown>; source: string }, ctx: { assertCurrent(r: string): void; wait(ms: number): Promise<void>; deadlineAt: number }) => Promise<Record<string, unknown>> } }> }).atomicCatalog.find(entry => entry.atomicId === 'move_to')!;
  const outcome = await executor.executor.execute(
    { request: { target: { position: { x: 1, y: 64, z: 1 } } }, source: 'test' },
    { assertCurrent: () => undefined, wait: async () => undefined, deadlineAt: Date.now() + 5000 },
  );
  assert.ok(calls.length >= 1, JSON.stringify(calls));
  assert.equal(outcome.ok, true);
});
