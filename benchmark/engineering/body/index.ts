/**
 * 评测场景总注册表（FEAT-CROSS-03）
 *
 * 7 类目：NAV / REC / GATHER / CRAFT / FOLLOW / SURVIVAL / COMBAT。
 * 每类目由模板展开：pinned 实例（full/quick，原 13 钉名 + SURV/COMB）+ matrix 实例（按需）。
 */

import type { ScenarioFactory, Suite } from '../core/types.js';
import { navScenarios } from './nav.js';
import { recoverScenarios } from './recover.js';
import { gatherScenarios } from './gather.js';
import { craftScenarios } from './craft.js';
import { followScenarios } from './follow.js';
import { survivalScenarios } from './survival.js';
import { combatScenarios } from './combat.js';

/** 全部场景工厂（顺序即报告顺序） */
export const allScenarios: ScenarioFactory[] = [
  ...navScenarios,
  ...recoverScenarios,
  ...gatherScenarios,
  ...craftScenarios,
  ...followScenarios,
  ...survivalScenarios,
  ...combatScenarios,
];

/**
 * 按套件 + 可选单场景 ID 过滤：
 *   quick  → 仅 quick 实例（冒烟）
 *   full   → 全部 pinned（quick + full · 13 钉名 + SURV/COMB）
 *   matrix → 仅 matrix 实例（模板矩阵全量）
 */
export function selectScenarios(opts: { suite: Suite; only?: string }): ScenarioFactory[] {
  let list = allScenarios;
  if (opts.only) {
    return list.filter(f => f().id === opts.only);
  }
  if (opts.suite === 'quick') {
    list = list.filter(f => f().suite === 'quick');
  } else if (opts.suite === 'matrix') {
    list = list.filter(f => f().suite === 'matrix');
  } else {
    // full：全部钉名实例（quick + full），不含 matrix
    list = list.filter(f => f().suite === 'quick' || f().suite === 'full');
  }
  return list;
}
