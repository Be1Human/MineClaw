import type { ParentGoalTargetKind } from '../task/planner/plannerContracts.js';
import { jsonSnapshot } from '../infra/jsonSnapshot.js';

export type GoalTargetCriterionTemplate =
  | { type: 'inventory'; item: string; count: number | '$quantity' }
  | { type: 'entity_dead'; entityName: string }
  | { type: 'reached'; relativeTo: 'owner'; radius: number }
  | { type: 'predicate'; predicate: string; predicateVersion?: string; args?: Readonly<Record<string, unknown>> };

export interface GoalTargetDefinition {
  kind: ParentGoalTargetKind;
  registryId: string;
  aliases: readonly string[];
  taskFamilies: readonly string[];
  /** Package-owned machine criteria replace the generic item outcome criterion. */
  successCriteriaPolicy?: 'fallback' | 'authoritative';
  successCriteria?: readonly GoalTargetCriterionTemplate[];
}

export interface GoalTargetCandidate extends GoalTargetDefinition {
  matchedAlias?: string;
  evidenceRef: string;
}

export interface GoalKnowledgePort {
  list(): GoalTargetDefinition[];
  getTarget(registryId: string): GoalTargetDefinition | null;
  searchTargets(input: { query: string; kind?: ParentGoalTargetKind; limit?: number }): GoalTargetCandidate[];
}

/**
 * The one human-language target catalog used by GoalAgent goal creation.
 * Minecraft ids remain the canonical identity;
 * aliases are only lookup knowledge and never authorize an unknown id.
 */
export const DEFAULT_GOAL_TARGETS: readonly GoalTargetDefinition[] = [
  {
    kind: 'location', registryId: 'mineclaw:owner_position',
    aliases: [
      '我身边', '主人身边', '玩家身边', '我旁边', '主人旁边', '玩家旁边',
      '我附近', '主人附近', '玩家附近', '主人位置', '玩家位置', 'owner position',
      'player position', '身边', 'come to me',
    ],
    taskFamilies: ['movement'], successCriteria: [{ type: 'reached', relativeTo: 'owner', radius: 2 }],
  },
  {
    kind: 'entity', registryId: 'minecraft:zombie', aliases: ['僵尸', '普通僵尸', 'zombie', 'zombies'],
    taskFamilies: ['combat'], successCriteria: [{ type: 'entity_dead', entityName: 'zombie' }],
  },
  { kind: 'item', registryId: 'minecraft:crafting_table', aliases: ['工作台', 'crafting table'], taskFamilies: ['crafting'] },
  { kind: 'item', registryId: 'minecraft:wooden_pickaxe', aliases: ['木镐', 'wooden pickaxe'], taskFamilies: ['crafting', 'mining'] },
  { kind: 'item', registryId: 'minecraft:stone_pickaxe', aliases: ['石镐', 'stone pickaxe'], taskFamilies: ['crafting', 'mining'] },
  { kind: 'item', registryId: 'minecraft:iron_pickaxe', aliases: ['铁镐', 'iron pickaxe'], taskFamilies: ['crafting', 'mining'] },
  { kind: 'item', registryId: 'minecraft:diamond_pickaxe', aliases: ['钻石镐', 'diamond pickaxe'], taskFamilies: ['crafting', 'mining'] },
  { kind: 'item', registryId: 'minecraft:wooden_axe', aliases: ['木斧', '木头斧', 'wooden axe'], taskFamilies: ['crafting', 'gathering'] },
  { kind: 'item', registryId: 'minecraft:stone_axe', aliases: ['石斧', 'stone axe'], taskFamilies: ['crafting', 'gathering'] },
  { kind: 'item', registryId: 'minecraft:iron_axe', aliases: ['铁斧', 'iron axe'], taskFamilies: ['crafting', 'gathering'] },
  { kind: 'item', registryId: 'minecraft:diamond_axe', aliases: ['钻石斧', 'diamond axe'], taskFamilies: ['crafting', 'gathering'] },
  { kind: 'item', registryId: 'minecraft:oak_log', aliases: ['橡木原木', '橡木', '原木', '木头', '木材', '砍树', '树', 'oak log', 'oak_log', 'logs', 'log', 'wood'], taskFamilies: ['gathering'] },
  { kind: 'item', registryId: 'minecraft:birch_log', aliases: ['白桦原木', '白桦', 'birch log', 'birch_log', 'birch'], taskFamilies: ['gathering'] },
  { kind: 'item', registryId: 'minecraft:spruce_log', aliases: ['云杉原木', '云杉', 'spruce log', 'spruce_log', 'spruce'], taskFamilies: ['gathering'] },
  {
    kind: 'item', registryId: 'mineclaw:craft_axe_and_gather_logs',
    aliases: ['造一把斧头并砍树', '制作一把斧头然后砍树', '做把斧头去砍树', '造斧头砍树', '用斧头砍树'],
    taskFamilies: ['crafting', 'gathering'],
    successCriteria: [
      { type: 'inventory', item: 'wooden_axe', count: 1 },
      { type: 'inventory', item: 'oak_log', count: '$quantity' },
    ],
  },
  { kind: 'item', registryId: 'minecraft:rail', aliases: ['铁轨', 'rail', 'rails'], taskFamilies: ['crafting'] },
  { kind: 'item', registryId: 'minecraft:iron_ingot', aliases: ['铁锭', 'iron ingot'], taskFamilies: ['crafting', 'smelting'] },
  { kind: 'item', registryId: 'minecraft:furnace', aliases: ['熔炉', '炉子', 'furnace'], taskFamilies: ['crafting', 'smelting'] },
  { kind: 'item', registryId: 'minecraft:torch', aliases: ['普通火把', '火把', 'torch', 'torches'], taskFamilies: ['crafting', 'building'] },
  { kind: 'item', registryId: 'minecraft:redstone_torch', aliases: ['红石火把', 'redstone torch'], taskFamilies: ['crafting', 'building'] },
  { kind: 'item', registryId: 'minecraft:soul_torch', aliases: ['灵魂火把', '灵魂火炬', 'soul torch'], taskFamilies: ['crafting', 'building'] },
  { kind: 'item', registryId: 'minecraft:bread', aliases: ['面包', 'bread'], taskFamilies: ['crafting', 'survival'] },
  { kind: 'item', registryId: 'minecraft:red_bed', aliases: ['红床', '红色床', 'red bed'], taskFamilies: ['crafting', 'building', 'survival'] },
  { kind: 'item', registryId: 'minecraft:oak_planks', aliases: ['橡木木板', '橡木板', '木板', 'oak planks'], taskFamilies: ['crafting', 'building'] },
  { kind: 'item', registryId: 'minecraft:cobblestone', aliases: ['圆石', '石头', '石块', '石材', 'cobblestone', 'cobble', 'stone', 'rock'], taskFamilies: ['gathering', 'crafting', 'building'] },
  { kind: 'item', registryId: 'minecraft:chest', aliases: ['箱子', '储物箱', '宝箱', 'chest'], taskFamilies: ['crafting', 'storage'] },
  { kind: 'item', registryId: 'minecraft:iron_shovel', aliases: ['铁锹', '铁铲', 'iron shovel'], taskFamilies: ['crafting', 'digging'] },
  { kind: 'item', registryId: 'minecraft:dirt', aliases: ['泥土', '泥巴', '土块', '泥', '土', 'dirt', 'soil'], taskFamilies: ['gathering', 'building'] },
  { kind: 'item', registryId: 'minecraft:sand', aliases: ['沙子', '沙', 'sand'], taskFamilies: ['gathering', 'building'] },
  { kind: 'item', registryId: 'minecraft:gravel', aliases: ['沙砾', '砂砾', 'gravel'], taskFamilies: ['gathering', 'building'] },
  { kind: 'item', registryId: 'minecraft:coal', aliases: ['煤炭', '煤', 'coal'], taskFamilies: ['gathering', 'smelting'] },
  { kind: 'item', registryId: 'minecraft:iron_ore', aliases: ['铁矿石', '铁矿', '铁', 'iron ore', 'iron_ore', 'iron'], taskFamilies: ['gathering', 'smelting'] },
  { kind: 'item', registryId: 'minecraft:gold_ore', aliases: ['金矿石', '金矿', '黄金', 'gold ore', 'gold_ore', 'gold'], taskFamilies: ['gathering', 'smelting'] },
  { kind: 'item', registryId: 'minecraft:diamond_ore', aliases: ['钻石矿石', '钻石矿', '钻石', 'diamond ore', 'diamond_ore', 'diamond'], taskFamilies: ['gathering'] },
  { kind: 'item', registryId: 'minecraft:copper_ore', aliases: ['铜矿石', '铜矿', '铜', 'copper ore', 'copper_ore', 'copper'], taskFamilies: ['gathering', 'smelting'] },
  { kind: 'item', registryId: 'minecraft:clay', aliases: ['黏土', '粘土', 'clay'], taskFamilies: ['gathering', 'building'] },
];

export class InMemoryGoalKnowledgePort implements GoalKnowledgePort {
  private readonly definitions = new Map<string, GoalTargetDefinition>();

  constructor(definitions: readonly GoalTargetDefinition[] = DEFAULT_GOAL_TARGETS) {
    for (const definition of definitions) {
      const registryId = normalizeRegistryId(definition.registryId);
      if (!registryId || definition.aliases.length === 0) throw new Error('invalid goal target definition');
      this.definitions.set(registryId, Object.freeze({
        ...definition,
        registryId,
        aliases: Object.freeze([...new Set(definition.aliases.map(normalizeSurface).filter(Boolean))]),
        taskFamilies: Object.freeze([...new Set(definition.taskFamilies)]),
        ...(definition.successCriteria ? {
          successCriteria: jsonSnapshot([...definition.successCriteria]),
        } : {}),
      }));
    }
  }

  list(): GoalTargetDefinition[] {
    return [...this.definitions.values()].map(cloneDefinition);
  }

  getTarget(registryId: string): GoalTargetDefinition | null {
    const definition = this.definitions.get(normalizeRegistryId(registryId));
    return definition ? cloneDefinition(definition) : null;
  }

  searchTargets(input: { query: string; kind?: ParentGoalTargetKind; limit?: number }): GoalTargetCandidate[] {
    const query = normalizeSurface(input.query);
    if (!query) return [];
    const limit = Math.max(1, Math.min(50, input.limit ?? 8));
    return [...this.definitions.values()]
      .filter(definition => !input.kind || definition.kind === input.kind)
      .flatMap(definition => {
        const idSurface = normalizeSurface(definition.registryId.replace(/^[^:]+:/, ''));
        const matchedAlias = definition.aliases
          .filter(alias => query.includes(alias) || alias.includes(query))
          .sort((left, right) => right.length - left.length)[0];
        if (!matchedAlias && query !== idSurface && !query.includes(idSurface)) return [];
        return [{
          ...cloneDefinition(definition),
          ...(matchedAlias ? { matchedAlias } : {}),
          evidenceRef: `goal-target:${definition.registryId}`,
        } satisfies GoalTargetCandidate];
      })
      .sort((left, right) => scoreCandidate(right, query) - scoreCandidate(left, query))
      .slice(0, limit);
  }
}

export const defaultGoalKnowledge: GoalKnowledgePort = new InMemoryGoalKnowledgePort();

export function normalizeGoalRegistryId(value: string): string {
  return normalizeRegistryId(value);
}

export function normalizeGoalSurface(value: string): string {
  return normalizeSurface(value);
}

function scoreCandidate(candidate: GoalTargetCandidate, query: string): number {
  const idSurface = normalizeSurface(candidate.registryId.replace(/^[^:]+:/, ''));
  if (query === idSurface) return 10_000 + idSurface.length;
  if (candidate.matchedAlias === query) return 8_000 + query.length;
  return 1_000 + (candidate.matchedAlias?.length ?? idSurface.length);
}

function cloneDefinition(definition: GoalTargetDefinition): GoalTargetDefinition {
  return {
    ...definition,
    aliases: [...definition.aliases],
    taskFamilies: [...definition.taskFamilies],
    ...(definition.successCriteria ? { successCriteria: structuredClone(definition.successCriteria) } : {}),
  };
}

function normalizeSurface(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’]+/g, '');
}

function normalizeRegistryId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  return normalized.includes(':') ? normalized : `minecraft:${normalized}`;
}
