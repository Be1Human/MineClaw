/**
 * FEAT-CROSS-26-001-004-004 · storage-system executor reality (P3-4).
 * deposit/withdraw execute real GameActions chest operations through injected
 * ports; missing ports fail explicitly; open_container/transfer_chest are not
 * primitives (no device op exists under those names) — no fake delegated ok.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createMineclawStorageSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/storage-system/index.js';

const pluginDir = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/storage-system', import.meta.url));

type Executor = { execute(cmd: { request: Record<string, unknown>; source: string }, ctx: { assertCurrent(r: string): void; wait(ms: number): Promise<void>; deadlineAt: number }): Promise<Record<string, unknown>> };

function contributions(systemPorts: Record<string, unknown>) {
  const manifest = parse(readFileSync(join(pluginDir, 'plugin.yaml'), 'utf8')) as Record<string, unknown>;
  const contributions = createMineclawStorageSystemPlugin().create({
    host: { version: '2.0.0', buildId: 'build-1' },
    plugin: { pluginId: String(manifest.id), pluginVersion: String(manifest.version) },
    systemPorts,
  } as never);
  const execution = contributions.find(value => value.kind === 'execution');
  const catalog = (execution as { atomicCatalog?: Array<{ atomicId: string; executor: Executor }> }).atomicCatalog ?? [];
  return { catalog, manifest };
}

test('storage-system：deposit/withdraw 经 GameActions 真执行，无 delegated 假成功', async () => {
  const ops: string[] = [];
  const { catalog, manifest } = contributions({
    game: { getPosition: () => ({ x: 0, y: 64, z: 0 }) },
    actions: {
      depositToChest: async (pos: unknown, item: string, count: number) => { ops.push(`deposit:${item}:${count}`); void pos; return { ok: true, moved: count }; },
      withdrawFromChest: async (pos: unknown, item: string, count: number) => { ops.push(`withdraw:${item}:${count}`); void pos; return { ok: true, moved: count }; },
    },
    bus: { publish: () => undefined },
    getWorld: () => ({ environment: { dimension: 'overworld' } }),
  });
  const ids = catalog.map(entry => entry.atomicId);
  assert.deepEqual([...ids].sort(), ['deposit', 'withdraw']);
  assert.ok(!ids.includes('open_container'));
  assert.ok(!ids.includes('transfer_chest'));

  const depositExecutor = catalog.find(entry => entry.atomicId === 'deposit')!.executor;
  const out = await depositExecutor.execute(
    { request: { target: { position: { x: 1, y: 64, z: 1 }, itemName: 'wheat', count: 12 } }, source: 'test' },
    { assertCurrent: () => undefined, wait: async () => undefined, deadlineAt: Date.now() + 5000 },
  );
  assert.equal(out.ok, true);
  assert.deepEqual(ops, ['deposit:wheat:12']);

  // manifest atomicIds 与实现目录一致
  const executionDecl = (manifest.contributions as Array<{ kind: string; id: string; atomicIds?: string[] }>).find(value => value.kind === 'execution' && value.id === 'mineclaw.storage-system.execution.container');
  assert.deepEqual(executionDecl?.atomicIds?.sort(), ['deposit', 'withdraw']);
});

test('storage-system：缺 actions 端口显式抛 storage_device_unavailable（不伪造成功）', async () => {
  const { catalog } = contributions({});
  const executor = catalog.find(entry => entry.atomicId === 'withdraw')!.executor;
  await assert.rejects(
    executor.execute(
      { request: { target: { position: { x: 1, y: 64, z: 1 }, itemName: 'wheat' } }, source: 'test' },
      { assertCurrent: () => undefined, wait: async () => undefined, deadlineAt: Date.now() + 5000 },
    ),
    /storage_device_unavailable/,
  );
});
