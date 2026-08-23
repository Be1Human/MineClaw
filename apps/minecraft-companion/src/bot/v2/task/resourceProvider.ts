/**
 * L6 · ResourceResolver 用的 IResourceProvider 接口（v2）
 *
 * 设计原则（OCP）：每个"获取资源的途径"是一个独立 provider 实现 IResourceProvider，
 * 加新途径不改老代码。Resolver 遍历所有 provider，按 cost 排序，汇总候选。
 *
 * 关键：Provider 不"决策"，只列候选。"选哪个"是 DecisionPolicy / LLM / 主人的事。
 */

import type { WorldStateView } from '../types.js';
import type { MemoryV2 } from '../infra/memory.js';

/** 资源需求 · 任务的 preflight 失败时由 Resolver 用此发起查询 */
export interface ResourceRequirement {
  /** 资源类型 · 当前 v2 起步支持：item（含可破坏工具） */
  kind: 'item';
  /** 物品名（不带 minecraft: 前缀） */
  name: string;
  /** 期望最低数量 / 耐久 */
  minCount?: number;
  /** 工具耐久最低（针对 hoe / pickaxe 等可破坏物） */
  minDurability?: number;
}

/** 候选方案 · Resolver 拿到所有 candidate 后按 cost 排序 */
export interface ResourceCandidate {
  /** 这是谁出的候选（debug + 后续 LLM 解释用） */
  providerId: string;
  /** 人类可读描述 · 给 MainBrain LLM 看的 · 也给 say 给主人看 */
  summary: string;
  /** 估算开销 · 秒 · 越低越好 */
  estimatedCostSec: number;
  /** 把候选落地的子任务建议（由 SubtaskInjector 用） */
  subtaskSuggestion: SubtaskSuggestion | null;
  /** 候选的"满足程度"：'full' = 完全满足；'partial' = 只能部分满足（如只能种 1/3 亩） */
  satisfaction: 'full' | 'partial' | 'none';
  /** partial 时的实际可达量 · 用于 LLM 解释给主人 */
  partialAmount?: number;
}

export interface SubtaskSuggestion {
  kind: string; // 'craft_hoe' / 'fetch_from_chest' / 'mine_wood' ...
  params: Record<string, unknown>;
}

export interface IResourceProvider {
  readonly id: string;
  /** 看本 provider 能不能解 req · 返回 0..N 个候选（多种实现方式） */
  provide(req: ResourceRequirement, world: WorldStateView): ResourceCandidate[];
}

// ──────────────────────────────────────────────────────────────────
// 内置 provider · 起步只覆盖 hoe 场景
// ──────────────────────────────────────────────────────────────────

/** 已有库存 provider · 检查 inventory 里现有的工具耐久 */
export class InventoryProvider implements IResourceProvider {
  readonly id = 'inventory';

  provide(req: ResourceRequirement, world: WorldStateView): ResourceCandidate[] {
    if (req.kind !== 'item') return [];
    const hit = world.inventory.items.find(it => it.name === req.name);
    if (!hit) return [];
    const dur = hit.durability ?? Infinity;
    const minDur = req.minDurability ?? 0;
    if (dur >= minDur) {
      return [
        {
          providerId: this.id,
          summary: `背包里现有 ${hit.name}（耐久 ${dur}/${hit.maxDurability ?? '∞'}），完全够`,
          estimatedCostSec: 0,
          subtaskSuggestion: null,
          satisfaction: 'full',
        },
      ];
    }
    // 部分满足：耐久不够，但能用一点
    // 假设每次 use_tool 消耗 1 耐久，能完成 dur 个动作
    return [
      {
        providerId: this.id,
        summary: `背包里有 ${hit.name}，但耐久只剩 ${dur}（需要 ${minDur}），只能部分完成`,
        estimatedCostSec: 0,
        subtaskSuggestion: null,
        satisfaction: 'partial',
        partialAmount: dur,
      },
    ];
  }
}

/** 合成 provider · 看是否能用现有材料合成 */
export class CraftProvider implements IResourceProvider {
  readonly id = 'craft';

  provide(req: ResourceRequirement, world: WorldStateView): ResourceCandidate[] {
    if (req.kind !== 'item') return [];
    // 当前只内置 wooden_hoe 配方：2 stick + 2 planks
    if (!req.name.endsWith('_hoe')) return [];
    const sticks = countItem(world, 'stick');
    const planks =
      countItem(world, 'oak_planks') ||
      countItem(world, 'spruce_planks') ||
      countItem(world, 'birch_planks');
    if (sticks >= 2 && planks >= 2) {
      return [
        {
          providerId: this.id,
          summary: `合成 ${req.name}（有 ${sticks} 棍 + ${planks} 木板）`,
          estimatedCostSec: 8,
          subtaskSuggestion: { kind: 'craft_item', params: { item: req.name } },
          satisfaction: 'full',
        },
      ];
    }
    if (sticks < 2 || planks < 2) {
      // 材料不全 → 提示但不算候选
      return [
        {
          providerId: this.id,
          summary: `合成 ${req.name} 需要 2 棍 + 2 木板，目前缺（${sticks} 棍 / ${planks} 木板）→ 需先采集`,
          estimatedCostSec: 30,
          subtaskSuggestion: { kind: 'mine_then_craft', params: { item: req.name } },
          satisfaction: 'full',
        },
      ];
    }
    return [];
  }
}

/** 箱子记忆 provider · 查 Spatial Memory 看有没有已知箱子存了目标物 */
export class ChestMemoryProvider implements IResourceProvider {
  readonly id = 'chest_memory';

  constructor(private readonly memory: MemoryV2) {}

  provide(req: ResourceRequirement, world: WorldStateView): ResourceCandidate[] {
    if (req.kind !== 'item') return [];

    // 查 spatial 里 kind='chest' 的条目
    const chests = this.memory.query('spatial', { kind: 'chest' });
    const results: ResourceCandidate[] = [];

    for (const chest of chests) {
      const items = chest.meta?.items as string[] | undefined;
      if (!items || !items.includes(req.name)) continue;

      const selfPos = world.self?.position;
      let dist = 10; // 默认距离估算
      if (selfPos) {
        const dx = chest.position.x - selfPos.x;
        const dy = chest.position.y - selfPos.y;
        const dz = chest.position.z - selfPos.z;
        dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      }

      const estimatedCostSec = dist / 4.3;
      const chestPos = { x: chest.position.x, y: chest.position.y, z: chest.position.z };

      results.push({
        providerId: this.id,
        summary: `箱子记忆中有 ${req.name}（位置 ${chestPos.x},${chestPos.y},${chestPos.z}，距离 ${dist.toFixed(1)} 格，约 ${estimatedCostSec.toFixed(1)}s）`,
        estimatedCostSec,
        subtaskSuggestion: {
          kind: 'fetch_from_chest',
          params: { chestPos, item: req.name },
        },
        satisfaction: 'full',
      });
    }

    return results;
  }
}

function countItem(world: WorldStateView, name: string): number {
  let total = 0;
  for (const it of world.inventory.items) if (it.name === name) total += it.count;
  return total;
}
