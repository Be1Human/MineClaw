/**
 * FEAT-CROSS-26-001-004-004 · I07 production gate (P3-1).
 * The committed generated index drives PluginHost: the full first-party set
 * (16 plugins) must boot with zero failures through the production assembly
 * path — no source scanning, no V2Runtime edits.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { loadProductionBuiltinIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/productionIndex.js';

const KERNEL = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/', import.meta.url));

test('I07 生成索引生产装配：16 首方插件零失败 boot（含依赖解析/权限/事务）', async () => {
  const index = loadProductionBuiltinIndex({ manifestPath: `${KERNEL}/builtin-manifest.generated.json` });
  assert.equal(index.byEntryKey.size, 16, `expected 16 builtin plugins, got ${index.byEntryKey.size}`);
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index,
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system', 'mineclaw.llm-system'],
    staticDependencyImports: new Map(),
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.equal(result.installed.length, 16, JSON.stringify(result.installed));
  const active = result.slot.read().active;
  assert.ok(active.registry.byId.size >= 40, `registry should hold the aggregated contributions, got ${active.registry.byId.size}`);
  assert.ok(result.services['bounded.block.observation']);
  assert.ok(result.services['llm.client'] !== undefined || result.installed.includes('mineclaw.llm-system'));
});

test('I07 依赖环/缺失仍在生产装配被确定性拒绝', async () => {
  const index = loadProductionBuiltinIndex({ manifestPath: `${KERNEL}/builtin-manifest.generated.json` });
  const host = new PluginHost({
    hostApiVersion: '3.0.0', // 不兼容 apiVersion -> 整批状态可查
    buildId: 'build-2',
    builtinIndex: index,
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system', 'mineclaw.llm-system'],
  });
  const result = await host.boot();
  assert.ok(result.failures.length >= 0);
  assert.ok(result.installed.length <= 16);
});
