/**
 * FEAT-NARR-01 · TemplateRenderer（MVP 渲染器 · 中性功能通知）
 *
 * 设计修订 v2：自驱系统产出的是【功能性事件通知】，中性、无情绪、不污染对话。
 * 这里的措辞统一为 `[类别] 事实` 形态，不带角色情绪（情绪只属于 LLM 的 say）。
 *
 * 未知 topic → 返回 ''（NarrationHub 视为不发话），不抛异常。
 */

import type { SpeechIntent, NarrationRenderer } from './types.js';

type TemplateFn = (d: Record<string, unknown>) => string;

/** 中性通知模板库 · topic → `[类别] 事实` */
export const TEMPLATES: Record<string, TemplateFn> = {
  // 生存 / 危险
  danger_flee: (d) => `[警戒] 发现${d.mob ?? '敌人'}，规避中`,
  danger_fight: () => `[警戒] 无法脱离，转为反击`,
  danger_cleared: () => `[警戒] 威胁解除`,
  low_health: (d) => `[状态] 生命值偏低（${d.health ?? '?'}）`,
  night_shelter: () => `[状态] 入夜，构筑掩体中`,
  // 采集
  gather_progress: (d) => `[采集] ${d.material ?? '材料'} 进行中（${d.have ?? ''}）`,
  gather_done: (d) => `[采集] ${d.material ?? '材料'} 完成 ×${d.have ?? ''}`,
  gather_blocked: (d) => `[采集] ${d.material ?? '材料'} 受阻，暂停`,
  gather_no_resource: (d) => `[采集] 附近无 ${d.material ?? '材料'}，转移搜索`,
  gather_no_tool: (d) => `[采集] 缺${d.tool ?? '工具'}，无法采集${d.material ?? ''}`,
  // 合成
  craft_done: (d) => `[合成] ${d.item ?? '物品'} 完成`,
  craft_blocked: (d) => `[合成] ${d.item ?? '物品'} 受阻，暂停`,
  // 导航 / 脱困
  nav_door: () => `[移动] 前方门无法通过，需协助`,
  nav_blocked: () => `[移动] 路径受阻`,
  nav_timeout: () => `[移动] 寻路超时，已停止本次尝试`,
  nav_far: () => `[移动] 目标过远，寻路失败`,
  pit_help: () => `[求助] 被困坑中，无法自行脱出`,
  // IDLE / 跟随
  idle_eat: () => `[状态] 生命值偏低，进食中`,
  idle_night: () => `[状态] 入夜，寻找掩体`,
  follow_lost: () => `[跟随] 视野内未见主人`,
  // BUG-L5-01：follow_blocked 已删——stuck-detector 砍除后无人发此通知（动态跟随不会假"卡住"）
};

export class TemplateRenderer implements NarrationRenderer {
  render(intent: SpeechIntent): string {
    const fn = TEMPLATES[intent.topic];
    if (!fn) return ''; // 未知 topic → 不发话（兜底不抛）
    return fn(intent.data ?? {});
  }
}
