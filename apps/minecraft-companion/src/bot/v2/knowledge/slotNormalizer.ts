/**
 * 🧩 L7 知识 · create_task 入参声明式归一化器（FEAT-L7-13）
 *
 * 吃掉原 dispatcher.ts create_task 分支里的全部 per-kind 硬编码：
 *   - gather_material/craft_item 别名归一       → slot.aliases（.task.yaml 声明）
 *   - follow_owner/goto_position 坐标对话兜底    → slot.defaultFrom:[dialogue] + type=location
 *   - follow_owner 补 ownerName                 → slot.defaultFrom:[owner]
 *   - MERGE_KEYS 复用合并白名单                  → def.mergeKeys
 *
 * 框架零 `if (kind === ...)`：全部行为由 TaskDefinition 驱动。
 * 新增取值器 = PROVIDERS 里注册一个 provider，不改调用方。
 */

import { extractItemFromDialogue, extractPositionFromDialogue } from './dialogueSlots.js';

/** 归一化所需的槽位声明子集（结构匹配 knowledge/types.SlotDefinition · 也兼容测试 stub） */
export interface NormalizableSlot {
  name: string;
  type: string;
  defaultFrom?: string[];
  aliases?: string[];
}

export interface NormalizableTaskDef {
  slots?: { required?: NormalizableSlot[]; optional?: NormalizableSlot[] };
  mergeKeys?: string[];
}

export interface NormalizeContext {
  /** 最近一条主人对话原文（dialogue 取值器用）· 无 memory 时返回空串 → 安全降级 clarify */
  recentOwnerText(): string;
  ownerName: string;
  /** dialogue 取值器命中时回调（发 task.params_from_dialogue 事件用） */
  onDialogueFill?: (slotName: string, value: unknown) => void;
}

/** 旧 MERGE_KEYS 常量 · 任务定义未声明 mergeKeys 时的通用兜底（行为与重构前一致） */
const LEGACY_MERGE_KEYS = ['targetPosition', 'ownerPosition', 'material', 'count', 'item', 'plots'];

const isEmpty = (v: unknown): boolean => v == null || v === '';

/**
 * defaultFrom 取值器注册表。
 *   dialogue：按槽类型选提取器（item → extractItemFromDialogue · location → extractPositionFromDialogue）
 *   owner   ：注入 ctx.ownerName（原 follow_owner 补名逻辑）
 * 命中不了返回 null/undefined → 试下一个 provider → 都不行进 missingSlots。
 */
const PROVIDERS: Record<string, (slot: NormalizableSlot, current: unknown, ctx: NormalizeContext) => unknown> = {
  dialogue(slot, current, ctx) {
    if (slot.type === 'item') {
      // 先用 LLM 已传的任何别名值（可能是中文），再退到最近一条主人对话
      return extractItemFromDialogue(String(current ?? '')) ?? extractItemFromDialogue(ctx.recentOwnerText());
    }
    if (slot.type === 'location' || slot.type === 'position') {
      return extractPositionFromDialogue(ctx.recentOwnerText());
    }
    return null; // number/entity/string 暂无对话提取器 · 走下一 provider 或 clarify
  },
  owner(_slot, _current, ctx) {
    return ctx.ownerName;
  },
};

/**
 * create_task 入参声明式归一：
 *   ① 别名归一（slot.aliases 顺序取第一个非空）
 *   ② defaultFrom 取值器兜底（dialogue / owner）
 *   ③ required 缺槽清点（调用方据此 clarify，不建脏任务）
 */
export function normalizeTaskParams(
  def: NormalizableTaskDef | undefined,
  raw: Record<string, unknown>,
  ctx: NormalizeContext,
): { params: Record<string, unknown>; missingSlots: string[] } {
  const params: Record<string, unknown> = { ...raw };
  const required = def?.slots?.required ?? [];
  const slots: NormalizableSlot[] = [...required, ...(def?.slots?.optional ?? [])];

  for (const slot of slots) {
    // ① 别名归一（LLM 把 material 写成 target/name、targetPosition 写成 ownerPosition 等）
    if (isEmpty(params[slot.name])) {
      for (const alias of slot.aliases ?? []) {
        if (!isEmpty(params[alias])) {
          params[slot.name] = params[alias];
          break;
        }
      }
    }
    // ② defaultFrom 取值器兜底
    if (isEmpty(params[slot.name])) {
      for (const providerName of slot.defaultFrom ?? []) {
        const v = PROVIDERS[providerName]?.(slot, params[slot.name], ctx);
        if (v != null && v !== '') {
          params[slot.name] = v;
          if (providerName === 'dialogue') ctx.onDialogueFill?.(slot.name, v);
          break;
        }
      }
    }
  }

  // ③ required 缺槽清点
  const missingSlots = required.filter(s => isEmpty(params[s.name])).map(s => s.name);
  return { params, missingSlots };
}

/**
 * 复用已有任务时的参数合并（BUG-L7-02 同类去重 + BUG-CROSS-01 修①）：
 * 白名单 = def.mergeKeys ?? 通用兜底清单；仅非空键覆盖；坐标别名归一到 targetPosition。
 */
export function mergePatchForReuse(
  def: NormalizableTaskDef | undefined,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const keys = def?.mergeKeys ?? LEGACY_MERGE_KEYS;
  const patch: Record<string, unknown> = {};
  for (const k of keys) {
    if (params[k] != null) patch[k] = params[k];
  }
  // 坐标别名归一（与新建路径同口径）
  if (patch.ownerPosition && !patch.targetPosition) patch.targetPosition = patch.ownerPosition;
  return patch;
}
