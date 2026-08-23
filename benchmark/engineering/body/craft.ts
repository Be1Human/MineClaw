/**
 * 评测场景 · 合成类（FEAT-CROSS-03 · 模板化）
 *
 * 给足原木 + 工作台，让 ProvisionStrategy 递归合成木镐（log→planks→sticks + table）。
 */

import { expand, type ScenarioTemplate } from '../core/template.js';
import type { ScenarioFactory } from '../core/types.js';

const craftPickaxeTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'CRAFT-PICK', category: 'craft', axes: {},
  pinned: [{ id: 'CRAFT-01', suite: 'full', params: {} }],
  build: () => ({
    title: '从原木合成木镐', timeoutMs: 60000,
    async setup(d, s) {
      await d.parkFar();
      await d.clearInv(s.username);
      await d.give(s.username, 'oak_log', 5);
      await d.give(s.username, 'crafting_table', 1);
      await d.tp(s.username, 0, 0, 0);
    },
    async inject(s) { s.injectTask('craft_item', { item: 'wooden_pickaxe', count: 1 }); },
    success(s) { return s.invCount('wooden_pickaxe') >= 1; },
  }),
};

export const craftScenarios: ScenarioFactory[] = expand(craftPickaxeTpl);
