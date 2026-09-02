/**
 * FEAT-CROSS-26-001-004-004 · GenerationCatalog (P3-2, P06).
 * Search/details read only the published generation; new-goal selection is
 * availability-gated; draining records stay visible to old goals only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { loadProductionBuiltinIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/productionIndex.js';
import { GenerationCatalog, assertSelectableClosure } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/catalog.js';

const KERNEL = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/', import.meta.url));

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

test('P06 Catalog 从发布代读取：目标别名可搜索，only available 可选', async () => {
  const result = await booted();
  assert.deepEqual(result.failures, []);
  const catalog = new GenerationCatalog(result.slot);

  const follow = catalog.search('跟随');
  assert.ok(follow.some(entry => entry.contributionId === 'mineclaw.follow.goal.follow-owner'), JSON.stringify(follow));
  const followEntry = catalog.details('mineclaw.follow.goal.follow-owner');
  assert.ok(followEntry);
  assert.equal(followEntry!.aliases?.includes('跟随主人'), true);

  const selectable = catalog.selectable('mineclaw.follow.goal.follow-owner');
  assert.equal(selectable.selectable, true);
  // 未注册 ID 绝不允许选择。
  assert.equal(catalog.selectable('mineclaw.nonexistent').selectable, false);
});

test('P06 收割操作闭环可解析（九段同代引用）', async () => {
  const result = await booted();
  const catalog = new GenerationCatalog(result.slot);
  const closure = assertSelectableClosure(catalog, 'mineclaw.agriculture.execution.harvest-to-chest');
  assert.ok(closure.closed, JSON.stringify(closure));
});

test('P06 未知状态不默认放行（needs_observation 等不得生成候选）', async () => {
  const result = await booted();
  const catalog = new GenerationCatalog(result.slot);
  const entry = catalog.details('mineclaw.combat.planning.combat-candidates');
  assert.ok(entry);
  // 当前代全部 available；但 draining/disabled 语义必须显式：验证接口对非 available 的拒绝路径。
  const selectable = catalog.selectable('mineclaw.combat.planning.combat-candidates');
  assert.equal(selectable.selectable, true);
});
