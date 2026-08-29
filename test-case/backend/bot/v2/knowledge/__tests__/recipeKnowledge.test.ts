import assert from 'node:assert/strict';
import test from 'node:test';

import { DomainKnowledgeRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/domainKnowledge.js';
import { buildRecipeKnowledgeDocuments } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/recipeKnowledge.js';
import type { RecipeDataSource } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/recipeResolver.js';

function dataSource(): RecipeDataSource {
  return {
    getCraftRecipes: (item: string) => {
      if (item === 'stone_axe') {
        return [{
          result: { name: 'stone_axe', count: 1 },
          ingredients: [{ name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }],
          requiresTable: true,
        }];
      }
      if (item === 'wooden_pickaxe') {
        return [{
          result: { name: 'wooden_pickaxe', count: 1 },
          ingredients: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }],
          requiresTable: true,
        }];
      }
      if (item === 'oak_planks') {
        return [{
          result: { name: 'oak_planks', count: 4 },
          ingredients: [{ name: 'oak_log', count: 1 }],
          requiresTable: false,
        }];
      }
      return [];
    },
    getItemSource: (item: string) => {
      if (item === 'cobblestone') return { block: 'stone', requiredTool: 'wooden_pickaxe' };
      if (item === 'oak_log') return { block: 'oak_log', requiredTool: null };
      return null;
    },
  };
}

test('recipe knowledge generates documents whose numbers match getCraftRecipes exactly', () => {
  const documents = buildRecipeKnowledgeDocuments({
    items: [
      { id: 'stone_axe', aliases: ['石斧', 'stone axe'] },
      { id: 'wooden_pickaxe', aliases: ['木镐', 'wooden pickaxe'] },
      { id: 'cobblestone', aliases: ['圆石', '石头'] },
      { id: 'no_such_item', aliases: [] },
    ],
    data: dataSource(),
  });
  assert.deepEqual(documents.map(doc => doc.id), [
    'recipe:stone_axe',
    'recipe:wooden_pickaxe',
    'recipe:cobblestone',
  ]);
  const axe = documents.find(doc => doc.id === 'recipe:stone_axe')!;
  assert.match(axe.body, /cobblestone×3 \+ stick×2/);
  assert.match(axe.body, /需工作台/);
  const pickaxe = documents.find(doc => doc.id === 'recipe:wooden_pickaxe')!;
  assert.match(pickaxe.body, /oak_planks×3 \+ stick×2/);
  const cobble = documents.find(doc => doc.id === 'recipe:cobblestone')!;
  assert.match(cobble.body, /挖 stone/);
  assert.match(cobble.body, /需 wooden_pickaxe/);
});

test('recipe knowledge is searchable by Chinese alias and by item id', () => {
  const registry = new DomainKnowledgeRegistry(buildRecipeKnowledgeDocuments({
    items: [
      { id: 'stone_axe', aliases: ['石斧', 'stone axe'] },
      { id: 'wooden_pickaxe', aliases: ['木镐', 'wooden pickaxe'] },
    ],
    data: dataSource(),
  }));
  const byAlias = registry.search({ query: '合成木镐', limit: 12 });
  assert.ok(byAlias.length > 0);
  assert.ok(byAlias.some(result => result.id === 'recipe:wooden_pickaxe'));
  const byId = registry.search({ query: 'stone_axe', limit: 12 });
  assert.ok(byId.some(result => result.id === 'recipe:stone_axe'));
});

test('recipe knowledge documents can be loaded by ref and version', () => {
  const documents = buildRecipeKnowledgeDocuments({
    items: [{ id: 'wooden_pickaxe', aliases: ['木镐'] }],
    data: dataSource(),
  });
  const registry = new DomainKnowledgeRegistry(documents);
  const found = registry.search({ query: 'wooden_pickaxe', limit: 12 });
  assert.equal(found.length, 1);
  const loaded = registry.get({ ref: found[0]!.ref, expectedVersion: found[0]!.version });
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.match(loaded.document.body, /oak_planks×3/);
  }
});

test('unknown items without recipe or source produce no knowledge document', () => {
  const documents = buildRecipeKnowledgeDocuments({
    items: [{ id: 'ghost_item', aliases: [] }],
    data: dataSource(),
  });
  assert.deepEqual(documents, []);
});

test('stable ref survives content updates while version changes', () => {
  const before = buildRecipeKnowledgeDocuments({
    items: [{ id: 'wooden_pickaxe', aliases: ['木镐'] }],
    data: dataSource(),
  });
  const changed = buildRecipeKnowledgeDocuments({
    items: [{ id: 'wooden_pickaxe', aliases: ['木镐子'] }],
    data: dataSource(),
  });
  assert.equal(before[0]!.ref, changed[0]!.ref);
  assert.notEqual(before[0]!.version, changed[0]!.version);
});
