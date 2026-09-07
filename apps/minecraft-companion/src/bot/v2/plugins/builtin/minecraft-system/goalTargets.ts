import type { GoalContribution, PluginGoalTargetDeclaration } from '../../../plugin-sdk/contributions.js';

type TargetSeed = {
  readonly registryId: string;
  readonly goalKind: PluginGoalTargetDeclaration['goalKind'];
  readonly aliases: readonly string[];
  readonly taskFamilies: readonly string[];
  readonly successCriteria?: readonly Readonly<Record<string, unknown>>[];
};

const ITEMS: readonly [string, readonly string[], readonly string[]][] = [
  ['crafting_table', ['工作台', 'crafting table'], ['crafting']],
  ['wooden_pickaxe', ['木镐', 'wooden pickaxe'], ['crafting', 'mining']],
  ['stone_pickaxe', ['石镐', 'stone pickaxe'], ['crafting', 'mining']],
  ['iron_pickaxe', ['铁镐', 'iron pickaxe'], ['crafting', 'mining']],
  ['diamond_pickaxe', ['钻石镐', 'diamond pickaxe'], ['crafting', 'mining']],
  ['wooden_axe', ['木斧', '木头斧', 'wooden axe'], ['crafting', 'gathering']],
  ['stone_axe', ['石斧', 'stone axe'], ['crafting', 'gathering']],
  ['iron_axe', ['铁斧', 'iron axe'], ['crafting', 'gathering']],
  ['diamond_axe', ['钻石斧', 'diamond axe'], ['crafting', 'gathering']],
  ['oak_log', ['橡木原木', '橡木', '原木', '木头', '木材', '砍树', '树', 'oak log', 'oak_log', 'logs', 'log', 'wood'], ['gathering']],
  ['birch_log', ['白桦原木', '白桦', 'birch log', 'birch_log', 'birch'], ['gathering']],
  ['spruce_log', ['云杉原木', '云杉', 'spruce log', 'spruce_log', 'spruce'], ['gathering']],
  ['rail', ['铁轨', 'rail', 'rails'], ['crafting']],
  ['iron_ingot', ['铁锭', 'iron ingot'], ['crafting', 'smelting']],
  ['furnace', ['熔炉', '炉子', 'furnace'], ['crafting', 'smelting']],
  ['torch', ['普通火把', '火把', 'torch', 'torches'], ['crafting', 'building']],
  ['redstone_torch', ['红石火把', 'redstone torch'], ['crafting', 'building']],
  ['soul_torch', ['灵魂火把', '灵魂火炬', 'soul torch'], ['crafting', 'building']],
  ['bread', ['面包', 'bread'], ['crafting', 'survival']],
  ['red_bed', ['红床', '红色床', 'red bed'], ['crafting', 'building', 'survival']],
  ['oak_planks', ['橡木木板', '橡木板', '木板', 'oak planks'], ['crafting', 'building']],
  ['cobblestone', ['圆石', '石头', '石块', '石材', 'cobblestone', 'cobble', 'stone', 'rock'], ['gathering', 'crafting', 'building']],
  ['chest', ['箱子', '储物箱', '宝箱', 'chest'], ['crafting', 'storage']],
  ['iron_shovel', ['铁锹', '铁铲', 'iron shovel'], ['crafting', 'digging']],
  ['dirt', ['泥土', '泥巴', '土块', '泥', '土', 'dirt', 'soil'], ['gathering', 'building']],
  ['sand', ['沙子', '沙', 'sand'], ['gathering', 'building']],
  ['gravel', ['沙砾', '砂砾', 'gravel'], ['gathering', 'building']],
  ['coal', ['煤炭', '煤', 'coal'], ['gathering', 'smelting']],
  ['iron_ore', ['铁矿石', '铁矿', '铁', 'iron ore', 'iron_ore', 'iron'], ['gathering', 'smelting']],
  ['gold_ore', ['金矿石', '金矿', '黄金', 'gold ore', 'gold_ore', 'gold'], ['gathering', 'smelting']],
  ['diamond_ore', ['钻石矿石', '钻石矿', '钻石', 'diamond ore', 'diamond_ore', 'diamond'], ['gathering']],
  ['copper_ore', ['铜矿石', '铜矿', '铜', 'copper ore', 'copper_ore', 'copper'], ['gathering', 'smelting']],
  ['clay', ['黏土', '粘土', 'clay'], ['gathering', 'building']],
];

const TARGETS: readonly TargetSeed[] = [
  {
    registryId: 'mineclaw:owner_position', goalKind: 'location',
    aliases: ['我身边', '主人身边', '玩家身边', '我旁边', '主人旁边', '玩家旁边', '我附近', '主人附近', '玩家附近', '主人位置', '玩家位置', 'owner position', 'player position', '身边', 'come to me'],
    taskFamilies: ['movement'], successCriteria: [{ type: 'reached', relativeTo: 'owner', radius: 2 }],
  },
  {
    registryId: 'minecraft:zombie', goalKind: 'entity', aliases: ['僵尸', '普通僵尸', 'zombie', 'zombies'],
    taskFamilies: ['combat'], successCriteria: [{ type: 'entity_dead', entityName: 'zombie' }],
  },
  ...ITEMS.map(([id, aliases, taskFamilies]) => ({
    registryId: `minecraft:${id}`, goalKind: 'item' as const, aliases,
    taskFamilies: [...new Set([...taskFamilies, 'delivery', 'storage', 'placement'])],
    successCriteria: [{ type: 'inventory', item: id, count: '$quantity' }],
  })),
  {
    registryId: 'mineclaw:craft_axe_and_gather_logs', goalKind: 'composite',
    aliases: ['造一把斧头并砍树', '制作一把斧头然后砍树', '做把斧头去砍树', '造斧头砍树', '用斧头砍树'],
    taskFamilies: ['crafting', 'gathering'],
    successCriteria: [
      { type: 'inventory', item: 'wooden_axe', count: 1 },
      { type: 'inventory', item: 'oak_log', count: '$quantity' },
    ],
  },
];

export function minecraftGoalContributions(): readonly GoalContribution[] {
  return TARGETS.map((seed, index) => ({
    kind: 'goal',
    id: `mineclaw.minecraft-system.goal.catalog-${String(index + 1).padStart(2, '0')}`,
    version: '1.0.0',
    target: {
      registryId: seed.registryId,
      goalKind: seed.goalKind,
      aliases: seed.aliases,
      successCriteria: seed.successCriteria ?? [],
      taskFamilies: seed.taskFamilies,
    } as PluginGoalTargetDeclaration,
  }));
}
