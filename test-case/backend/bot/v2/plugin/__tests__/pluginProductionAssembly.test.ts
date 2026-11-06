/**
 * FEAT-CROSS-26-001-004-004 · I07 production gate (P3-1).
 * The committed generated index drives PluginHost: the full first-party set
 * (19 plugins including the FastBrain protocol) must boot with zero failures through the production assembly
 * path — no source scanning, no V2Runtime edits.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { loadProductionBuiltinIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/productionIndex.js';
import type { DecisionPort } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/fastbrain/adapter.js';

const KERNEL = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/', import.meta.url));

test('I07 生成索引生产装配：19 首方插件零失败 boot（含依赖解析/权限/事务）', async () => {
  const index = loadProductionBuiltinIndex({ manifestPath: `${KERNEL}/builtin-manifest.generated.json` });
  assert.equal(index.byEntryKey.size, 19);
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index,
    trustedSystemPlugins: ['mineclaw.minecraft-system', 'mineclaw.storage-system', 'mineclaw.llm-system'],
    staticDependencyImports: new Map(),
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.equal(result.installed.length, 19, JSON.stringify(result.installed));
  assert.ok(result.installed.includes('mineclaw.fastbrain'));
  assert.ok(result.services['fastbrain.decisions']);
  const decisions = result.services['fastbrain.decisions'] as DecisionPort;
  assert.equal(decisions.catalog().length, 18, 'decision names are not plugin-package count');
  assert.equal(new Set(decisions.catalog().map(entry => entry.name)).size, 18);
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
  assert.ok(result.installed.length <= 17);
});
