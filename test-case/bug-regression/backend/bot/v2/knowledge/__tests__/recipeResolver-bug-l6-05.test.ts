/**
 * BUG-L6-05 单测 · 配方选材按可得性选 log
 *
 * BUG-L6-05 回归：配方选材应优先使用当前可获得的原木。
 *
 * 关键场景：
 *   §1 背包空 + isMaterialNearby 全部 false → 选 oak_planks 链（rarity 兜底）
 *   §2 背包空 + 仅 oak_log nearby=true       → 选 oak_planks
 *   §3 背包空 + 仅 cherry_log nearby=true    → 选 cherry_planks（就地取材压倒常识）
 *   §4 背包有 oak_log + cherry_log nearby=true → 选 oak_planks（derivable 压倒 nearby）
 *
 * Framework: node:test + node:assert/strict
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RecipeResolver } from '../../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/recipeResolver.js';
import type { RecipeDataSource } from '../../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/recipeResolver.js';
import type { RecipeInfo, ItemSource } from '../../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import type { InventoryView, InventoryItemView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ───────── helpers ─────────

const LOG_KINDS = [
  'oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak',
  'cherry', 'mangrove', 'pale_oak',
] as const;

/** 模拟 minecraft-data：把 LOG_KINDS 字典序排列后作为 *_planks 的可选配方 */
function plankRecipes(): RecipeInfo[] {
  // 注意：故意按字典序排列且让 cherry 排在 oak 之前 —— 这正是 bug 触发的"原始"顺序
  const ordered = [
    'acacia', 'cherry', 'dark_oak', 'jungle', 'mangrove',
    'pale_oak', 'oak', 'spruce', 'birch',
  ];
  return ordered.map(k => ({
    result: { name: `${k}_planks`, count: 4 },
    ingredients: [{ name: `${k}_log`, count: 1 }],
    requiresTable: false,
  }));
}

function inv(items: InventoryItemView[] = []): InventoryView {
  return { items, held: null, freeSlots: 36 };
}

function makeData(nearby: Record<string, boolean> = {}): RecipeDataSource {
  return {
    getCraftRecipes(itemName, _withTable): RecipeInfo[] {
      // crafting_table 4 木板 → 1 工作台（任意 planks 均可）
      if (itemName === 'crafting_table') {
        return [
          {
            result: { name: 'crafting_table', count: 1 },
            ingredients: [
              { name: 'oak_planks', count: 4 },  // 多套配方的同一槽位会被简化：这里只测下层 planks 选择
            ],
            requiresTable: false,
          },
        ];
      }
      // *_planks 多套配方（关键 bug 触发点）
      if (itemName.endsWith('_planks')) {
        return plankRecipes();
      }
      // *_log → 没有合成配方（原料）
      if (itemName.endsWith('_log')) return [];
      return [];
    },
    getItemSource(itemName): ItemSource | null {
      if (itemName.endsWith('_log')) {
        return { block: itemName, requiredTool: null };
      }
      return null;
    },
    isMaterialNearby(material: string): boolean {
      return nearby[material] === true;
    },
  };
}

// ───────── §1 背包空 + 全 false nearby → 选 oak ─────────

describe('BUG-L6-05 · 配方选材按可得性选 log', () => {
  it('§1 背包空 + isMaterialNearby 全 false → 选 oak_log（rarity 常识兜底）', () => {
    const resolver = new RecipeResolver(makeData(/* 全空 */));
    // 用 *_planks 任一作为入口都行，关键是 chooseRecipe 在多套 plank 配方间挑
    // 这里直接让 resolver 反推合成任一 planks（target 是 oak_planks 但 ingredient 走 chooseRecipe）
    // 注意：本测的 chooseRecipe 是在解析"oak_planks"时枚举所有候选 plank 配方。
    // 为了测试 chooseRecipe 的选材逻辑（在多 plank 候选间挑），target 不能直接是 oak_planks
    // （这样不会触发 chooseRecipe 比较），改测一个虚拟上层物品 "any_planks"
    // 但 minecraft-data 没这种入口；实际触发是 resolver 在反推 crafting_table 时遇到 ingredient "oak_planks"，
    // 递归 resolve('oak_planks') → chooseRecipe 在我们的 plankRecipes() 列表里挑。
    // 简化做法：直接验证 chooseRecipe 的产物 —— 通过断言 nextStep 反推到的 gather material。
    const step = resolver.nextStep('oak_planks', 4, inv());

    // 期望：chooseRecipe 在 9 套 plank 配方里挑了 oak_planks 配方（rarity=0），
    // 故下一步去采 oak_log
    assert.equal(step.kind, 'gather', `expected gather, got ${step.kind}`);
    if (step.kind === 'gather') {
      assert.equal(step.material, 'oak_log',
        `bug 复现：选了非 oak 的木头 → ${step.material}（应为 oak_log）`);
    }
  });

  it('§2 背包空 + 仅 oak_log nearby=true → 选 oak_log', () => {
    const resolver = new RecipeResolver(makeData({ oak_log: true }));
    const step = resolver.nextStep('oak_planks', 4, inv());
    assert.equal(step.kind, 'gather');
    if (step.kind === 'gather') {
      assert.equal(step.material, 'oak_log');
    }
  });

  it('§3 背包空 + 仅 cherry_log nearby=true → 选 cherry_log（就地取材压倒常识）', () => {
    const resolver = new RecipeResolver(makeData({ cherry_log: true }));
    const step = resolver.nextStep('oak_planks', 4, inv());
    assert.equal(step.kind, 'gather');
    if (step.kind === 'gather') {
      assert.equal(step.material, 'cherry_log',
        '当周围只有樱花树时，nearbyRaw 信号必须压倒 rarity 兜底');
    }
  });

  it('§4 背包有 oak_log + cherry_log nearby=true → 用手头 oak（derivable 压倒 nearby）', () => {
    const resolver = new RecipeResolver(makeData({ cherry_log: true }));
    const step = resolver.nextStep(
      'oak_planks', 4,
      inv([{ name: 'oak_log', count: 4, slot: 0 }]),
    );
    // 手里 oak_log 足够 → resolver 直接 craft oak_planks
    assert.equal(step.kind, 'craft', `expected craft, got ${step.kind}`);
    if (step.kind === 'craft') {
      assert.equal(step.item, 'oak_planks');
    }
  });

  it('§5 stripped_oak_log rarity=0；stripped_cherry_log rarity 高于 stripped_oak_log', () => {
    // 间接验证：在两个都 nearby=false 时，stripped_oak 应被偏好
    // 这里通过两个 plank-like 自定义配方测试 chooseRecipe 的 -rarity 项
    const data: RecipeDataSource = {
      getCraftRecipes(itemName) {
        if (itemName === 'mystery_item') {
          return [
            {
              result: { name: 'mystery_item', count: 1 },
              ingredients: [{ name: 'stripped_cherry_log', count: 1 }],
              requiresTable: false,
            },
            {
              result: { name: 'mystery_item', count: 1 },
              ingredients: [{ name: 'stripped_oak_log', count: 1 }],
              requiresTable: false,
            },
          ];
        }
        if (itemName.endsWith('_log')) return [];
        return [];
      },
      getItemSource(itemName) {
        if (itemName.endsWith('_log')) return { block: itemName, requiredTool: null };
        return null;
      },
      isMaterialNearby() { return false; },
    };
    const resolver = new RecipeResolver(data);
    const step = resolver.nextStep('mystery_item', 1, inv());
    assert.equal(step.kind, 'gather');
    if (step.kind === 'gather') {
      assert.equal(step.material, 'stripped_oak_log',
        'stripped_oak_log 应在 stripped_cherry_log 之上（rarity 兜底）');
    }
  });
});
