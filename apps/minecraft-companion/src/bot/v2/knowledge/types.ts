/**
 * L7 · Task Knowledge 类型定义
 */

export interface SlotDefinition {
  name: string;
  type: 'item' | 'location' | 'number' | 'entity' | 'string';
  description: string;
  defaultFrom: string[];
  fallback?: unknown;
  askable: boolean;
  /** FEAT-L7-13 · 入参别名键（LLM 常把 material 写成 target/name 等）· slotNormalizer 声明式归一 */
  aliases?: string[];
}

export interface CookbookEntry {
  steps: string[];
  failures: { condition: string; strategies: string[] }[];
  completion: string;
  estimatedDuration: { minSec: number; maxSec: number | null };
}

/**
 * FEAT-L6-03 阶段二 · 声明式后置断言。
 * 一个值可以是字面量，或 { fromSlot: 槽名, default?: 兜底 }（运行时从 task.params 取）。
 */
export type PostValue = number | string | { fromSlot: string; default?: number | string };

export interface PostconditionSpec {
  /** 断言类型 · 目前支持 inventory_gte（库存计数 ≥ 阈值） */
  type: 'inventory_gte';
  /** 物品名（item 类断言）· 木头类自动按"全原木求和"口径 */
  item: PostValue;
  /** 阈值 */
  count: PostValue;
}

export interface TaskDefinition {
  kind: string;
  aliases: string[];
  summary: string;
  priority: { default: number; tier: string };
  persistent: boolean;
  slots: { required: SlotDefinition[]; optional: SlotDefinition[] };
  preconditions: string[];
  strategy: string;
  cookbook?: CookbookEntry;
  examples: string[];
  /** FEAT-L6-03 阶段二 · 后置验证断言（complete() 验证门用 · 写 yaml 即得验证，OCP） */
  postconditions?: PostconditionSpec[];
  /** FEAT-L7-13 · 同类任务复用时允许合并的参数键白名单（缺省 = 通用兜底清单） */
  mergeKeys?: string[];
}
