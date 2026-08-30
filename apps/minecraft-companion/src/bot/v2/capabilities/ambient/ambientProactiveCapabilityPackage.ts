import { tuning } from '../../infra/tuning.js';
import type { ProactiveTickCapabilityImplementation, ProactiveTickManifestEntry } from '../../proactive/contracts.js';
import type { CapabilityPackageDefinition } from '../types.js';

const LOG_NAMES = new Set(['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']);
const FOOD_NAMES = new Set(['bread', 'baked_potato', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'carrot', 'potato']);

export function createAmbientProactiveCapabilityPackage(): CapabilityPackageDefinition {
  const defaults = tuning().proactiveCapabilities;
  const manifests: ProactiveTickManifestEntry[] = [{
    id: 'auto_follow',
    label: '空闲自动跟随',
    description: '没有其他任务且主人在线可见时，自动回到主人身边并持续跟随。',
    goalTarget: 'mineclaw:owner_position',
    defaultEnabled: false,
    rate: 'std',
    priority: 40,
    decisionMode: 'deterministic',
    conflictGroups: ['movement', 'ambient_activity'],
    configSchema: {
      startDistance: { type: 'number', label: '开始距离', default: defaults.autoFollow.startDistance, min: 2, max: 64 },
      stopDistance: { type: 'number', label: '贴近距离', default: defaults.autoFollow.stopDistance, min: 1, max: 16 },
    },
  }, {
    id: 'auto_stockpile',
    label: '空闲自动屯资源',
    description: '主人不在且安全空闲时，有限补充木材和食物；默认关闭。',
    goalTarget: 'minecraft:oak_log',
    defaultEnabled: false,
    rate: 'slow',
    priority: 20,
    decisionMode: 'deterministic',
    conflictGroups: ['movement', 'ambient_activity'],
    configSchema: {
      targetLogs: { type: 'number', label: '木材目标', default: defaults.autoStockpile.targetLogs, min: 0, max: 256 },
      targetFood: { type: 'number', label: '食物目标', default: defaults.autoStockpile.targetFood, min: 0, max: 256 },
      minHealth: { type: 'number', label: '最低生命', default: defaults.autoStockpile.minHealth, min: 1, max: 20 },
      dangerRadius: { type: 'number', label: '危险半径', default: defaults.autoStockpile.dangerRadius, min: 4, max: 64 },
      minFreeSlots: { type: 'number', label: '最少空槽', default: defaults.autoStockpile.minFreeSlots, min: 1, max: 20 },
    },
  }];
  return {
    manifest: {
      schema: 'mineclaw/capability-manifest@1',
      id: 'ambient.proactive_basics',
      version: 1,
      description: '可插拔的基础空闲主动能力，只观察并产出高层意图。',
      goalTargets: [], skills: [], knowledge: [], requires: { atomics: [] }, proactiveTicks: manifests,
    },
    actionProviders: [],
    predicateEvaluators: [],
    proactiveTicks: [autoFollow(), autoStockpile()],
  };
}

function autoFollow(): ProactiveTickCapabilityImplementation {
  return {
    id: 'auto_follow',
    evaluate: ({ world, config, foregroundBusy, activeActivation }) => {
      if (!world) return { kind: 'release', reason: 'world_unavailable' };
      if (!world.owner?.isVisible || !world.owner.position || !Number.isFinite(world.owner.distance)) {
        return { kind: 'release', reason: 'owner_offline_or_not_observed' };
      }
      if (foregroundBusy) return { kind: 'idle', reason: 'foreground_busy' };
      const startDistance = numberConfig(config.startDistance, tuning().proactiveCapabilities.autoFollow.startDistance);
      const stopDistance = numberConfig(config.stopDistance, tuning().proactiveCapabilities.autoFollow.stopDistance);
      if (world.owner.distance <= stopDistance && activeActivation?.capabilityId !== 'auto_follow') {
        return { kind: 'idle', reason: 'owner_close_enough' };
      }
      if (world.owner.distance < startDistance) return { kind: 'idle', reason: 'within_follow_hysteresis' };
      return {
        kind: 'candidate',
        candidate: {
          requestText: `持续跟随主人 ${world.owner.username}`,
          constraints: ['主人必须在线且可见', `跟随距离保持在 ${stopDistance} 格左右`, '玩家任务和安全任务优先'],
          evidenceRefs: [`owner:${world.owner.username}`, `owner-distance:${world.owner.distance.toFixed(1)}`],
          idempotencyKey: `auto_follow:${world.owner.username}`,
        },
      };
    },
  };
}

function autoStockpile(): ProactiveTickCapabilityImplementation {
  return {
    id: 'auto_stockpile',
    evaluate: ({ world, config, foregroundBusy }) => {
      if (!world) return { kind: 'release', reason: 'world_unavailable' };
      if (world.owner) return { kind: 'release', reason: 'owner_present' };
      if (foregroundBusy) return { kind: 'idle', reason: 'foreground_busy' };
      const defaults = tuning().proactiveCapabilities.autoStockpile;
      if (world.self.health < numberConfig(config.minHealth, defaults.minHealth)) return { kind: 'release', reason: 'health_below_safety_floor' };
      if (world.inventory.freeSlots < numberConfig(config.minFreeSlots, defaults.minFreeSlots)) return { kind: 'release', reason: 'inventory_space_low' };
      const dangerRadius = numberConfig(config.dangerRadius, defaults.dangerRadius);
      if (world.entities.some(entity => entity.category === 'hostile' && entity.distance <= dangerRadius)) {
        return { kind: 'release', reason: 'hostile_nearby' };
      }
      const logs = countInventory(world.inventory.items, LOG_NAMES);
      const targetLogs = numberConfig(config.targetLogs, defaults.targetLogs);
      if (logs < targetLogs) {
        const missing = Math.max(1, targetLogs - logs);
        return { kind: 'candidate', candidate: {
          requestText: `安全收集 ${missing} 个自然生长的橡木原木，使背包原木达到 ${targetLogs} 个`,
          constraints: ['只砍有自然树证据的原木，不破坏建筑', '不远游、不挖矿', '玩家或危险事件出现时立即停止'],
          evidenceRefs: [`inventory:logs=${logs}`, 'owner:not_observed'],
          idempotencyKey: 'auto_stockpile:logs',
        } };
      }
      const food = countInventory(world.inventory.items, FOOD_NAMES);
      const targetFood = numberConfig(config.targetFood, defaults.targetFood);
      if (food < targetFood) {
        const missing = Math.max(1, targetFood - food);
        return { kind: 'candidate', candidate: {
          requestText: `安全补充 ${missing} 份可持续食物，使背包食物达到 ${targetFood} 份`,
          constraints: ['只收成熟作物并原位补种', '不猎杀动物，不破坏未成熟作物', '玩家或危险事件出现时立即停止'],
          evidenceRefs: [`inventory:food=${food}`, 'owner:not_observed'],
          idempotencyKey: 'auto_stockpile:food',
        } };
      }
      return { kind: 'release', reason: 'stock_targets_satisfied' };
    },
  };
}

function countInventory(items: readonly { name: string; count: number }[], names: ReadonlySet<string>): number {
  return items.filter(item => names.has(item.name)).reduce((sum, item) => sum + item.count, 0);
}

function numberConfig(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
