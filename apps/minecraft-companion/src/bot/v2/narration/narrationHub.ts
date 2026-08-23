/**
 * FEAT-NARR-01 · NarrationHub · 统一语言中枢
 *
 * 唯一的"嘴"：所有子系统调 narrate(intent) 上报意图，每 tick flushTick() 一次：
 *   退避（主人活跃压制低优）→ 去重（同 key 合一 + 时间窗）→ 仲裁（取最高 urgency）
 *   → 渲染为内部事实摘要 → 投递给 MainBrain。
 *
 * 设计原则：NarrationHub 没有发言权，只能向大脑报告。
 */

import type { SpeechIntent, NarrationRenderer, NarrationConfig } from './types.js';
import { NoticeLog } from './noticeLog.js';

export interface NarrationHubDeps {
  submitNotice: (notice: {
    source: string;
    topic: string;
    label: string;
    detail: string;
    urgency: number;
    wake: boolean;
    dedupeKey: string;
  }) => void;
  /** 渲染器 · MVP=TemplateRenderer */
  renderer: NarrationRenderer;
  /** 主人近 N 秒是否在对话/在场 · 用于退避判定 */
  isOwnerActive: () => boolean;
  /** 时间源 · 默认 Date.now（单测可注入）*/
  now?: () => number;
  cfg?: NarrationConfig;
}

export class NarrationHub {
  private buf: SpeechIntent[] = [];
  private readonly lastSaidAt = new Map<string, number>();
  /** FEAT-NARR-01 · 已发通知日志 · 注入 LLM 上下文用 */
  private readonly notices = new NoticeLog();
  private readonly submitNotice: NarrationHubDeps['submitNotice'];
  private readonly renderer: NarrationRenderer;
  private readonly isOwnerActive: () => boolean;
  private readonly now: () => number;
  private readonly dedupeWindowMs: number;
  private readonly suppressBelow: number;
  private readonly log: (m: string) => void;

  constructor(deps: NarrationHubDeps, log?: (m: string) => void) {
    this.submitNotice = deps.submitNotice;
    this.renderer = deps.renderer;
    this.isOwnerActive = deps.isOwnerActive;
    this.now = deps.now ?? (() => Date.now());
    this.dedupeWindowMs = deps.cfg?.dedupeWindowMs ?? 8000;
    this.suppressBelow = deps.cfg?.ownerActiveSuppressBelow ?? 60;
    this.log = log ?? (() => {});
  }

  /** 各子系统唯一入口：上报一个说话意图（不保证一定说出，要过去重/退避/仲裁） */
  narrate(intent: SpeechIntent): void {
    this.buf.push(intent);
  }

  /** Heartbeat 每 tick 调一次：把缓冲的意图处理成至多一句话 */
  flushTick(): void {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    const now = this.now();
    const ownerActive = this.isOwnerActive();

    // 1. 退避：主人活跃时压制低优意图（llm 来源与高优不压）
    const kept = batch.filter(
      (i) => !(ownerActive && i.urgency < this.suppressBelow && i.source !== 'llm'),
    );

    // 2. 同 key 合一：取最高 urgency
    const byKey = new Map<string, SpeechIntent>();
    for (const i of kept) {
      const key = i.dedupeKey ?? i.topic;
      const cur = byKey.get(key);
      if (!cur || i.urgency > cur.urgency) byKey.set(key, i);
    }

    // 3. 时间窗去重：距上次同 key 太近 → 跳过
    const fresh = [...byKey.entries()].filter(([key]) => {
      const last = this.lastSaidAt.get(key);
      return last === undefined || now - last >= this.dedupeWindowMs;
    });
    if (fresh.length === 0) return;

    // 4. 仲裁：本 tick 只让最高 urgency 的一条说话（一张嘴）
    fresh.sort((a, b) => b[1].urgency - a[1].urgency);
    const [key, winner] = fresh[0];
    const text = this.renderer.render(winner).trim();
    if (!text) return; // 未知 topic / 空渲染 → 不发话
    this.submitNotice({
      source: winner.source,
      topic: winner.topic,
      label: winner.topic,
      detail: text,
      urgency: winner.urgency,
      wake: winner.urgency >= 60,
      dedupeKey: key,
    });
    this.lastSaidAt.set(key, now);
    this.notices.record({ ts: now, source: winner.source, topic: winner.topic, text });
    this.log(`[narration] ${winner.source}/${winner.topic} → brain.notice`);
  }

  /**
   * 近期通知块 · 注入 LLM 上下文用（让大模型知道刚发生了什么）。
   * 返回 '' 表示无近期通知。
   */
  recentNotices(): string {
    const items = this.notices.recent({ limit: 8, now: this.now(), windowMs: 10 * 60 * 1000 });
    if (items.length === 0) return '';
    return items.map((e) => `- ${e.text}`).join('\n');
  }
}
