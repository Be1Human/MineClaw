/**
 * FEAT-NARR-01 · 统一语言中枢 · 类型定义
 *
 * 核心思想：子系统只上报"发生了什么"（结构化 SpeechIntent，不含成品中文），
 * 由唯一的 NarrationHub 去重 / 仲裁 / 人格渲染 / 唯一出口发话。
 */

/** 一次"想说话"的结构化意图 · 不携带最终中文 */
export interface SpeechIntent {
  /** 来源系统 · 'supervisor' | 'survival' | 'idle' | 'gather' | 'llm' ... */
  source: string;
  /** 语义主题 · 决定用哪个模板 · 'danger_flee' | 'gather_done' | 'nav_door' ... */
  topic: string;
  /** 紧急度 · 沿用 ActionArbitrator priority 量纲（如 danger=90, 进度=40） */
  urgency: number;
  /** 渲染所需上下文（mob 名、数量、坐标…）· 不含成品中文 */
  data?: Record<string, unknown>;
  /** 去重键 · 同键短窗内只说一次 · 缺省用 topic */
  dedupeKey?: string;
  /** 打断级别 · 预留（hard 可在后续接管动作仲裁）*/
  interruptLevel?: 'soft' | 'hard';
}

/** 渲染器：把结构化意图变成最终中文（MVP=模板，后批=LLM+记忆） */
export interface NarrationRenderer {
  /** 返回最终中文；返回 '' 表示该意图不发话（如未知 topic） */
  render(intent: SpeechIntent): string;
}

export interface NarrationConfig {
  /** 同 dedupeKey 短窗内只说一次（ms）· 默认 8000 */
  dedupeWindowMs?: number;
  /** 主人活跃时，压制 urgency 低于此值的意图 · 默认 60 */
  ownerActiveSuppressBelow?: number;
}
