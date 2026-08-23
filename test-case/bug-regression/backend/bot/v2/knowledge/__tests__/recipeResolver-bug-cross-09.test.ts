import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RecipeResolver, type RecipeDataSource } from '../../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/recipeResolver.js';
import type { RecipeInfo } from '../../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import type { InventoryView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

const recipes: Record<string, RecipeInfo[]> = {
  wooden_pickaxe: [{
    result: { name: 'wooden_pickaxe', count: 1 },
    ingredients: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
    requiresTable: true,
  }],
  oak_planks: [{
    result: { name: 'oak_planks', count: 4 },
    ingredients: [{ name: 'oak_log', count: 1 }],
    requiresTable: false,
  }],
};

function inventory(items: Record<string, number>): InventoryView {
  return {
    items: Object.entries(items).map(([name, count], slot) => ({ name, count, slot })),
    held: null,
    freeSlots: 36,
  };
}

describe('BUG-CROSS-09 · 配方执行次数与库存目标分离', () => {
  it('已有 2 木板但父配方需要 3 时，返回执行 1 次且库存目标为 3', () => {
    const resolver = new RecipeResolver({
      getCraftRecipes: name => recipes[name] ?? [],
      getItemSource: () => null,
    });

    const step = resolver.nextStep('wooden_pickaxe', 1, inventory({
      oak_planks: 2,
      stick: 2,
      oak_log: 1,
    }));

    assert.equal(step.kind, 'craft');
    if (step.kind === 'craft') {
      assert.equal(step.item, 'oak_planks');
      assert.equal(step.count, 1);
      assert.equal(step.inventoryTargetCount, 3);
    }
  });

  it('静态配方表跨连续求解复用', () => {
    const calls = new Map<string, number>();
    const data: RecipeDataSource = {
      getCraftRecipes(name) {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return recipes[name] ?? [];
      },
      getItemSource: () => null,
    };
    const resolver = new RecipeResolver(data);
    const inv = inventory({ oak_planks: 3, stick: 2 });

    resolver.nextStep('wooden_pickaxe', 1, inv);
    resolver.nextStep('wooden_pickaxe', 1, inv);

    assert.equal(calls.get('wooden_pickaxe'), 1);
  });
});
