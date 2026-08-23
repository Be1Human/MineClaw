/**
 * 💬 NavFailureFeedback — 寻路失败感知反馈
 *
 * FEAT-L5-01
 *
 * 订阅 bus 的 atomic.move_to.end / atomic.follow.end 事件，
 * 当 ok=false 时形成事实通知交给 MainBrain，不直接告知用户。
 * 每类原因有 30s 冷却，避免刷屏。
 */

import type { EventBusV2 } from '../infra/eventBus.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { BusEvent } from '../types.js';
import type { SpeechIntent } from '../narration/types.js';

const DEFAULT_COOLDOWN_MS = 30_000;

type ReasonCategory = 'door' | 'noPath' | 'timeout' | 'stuck' | 'cancelled';

function categorize(reason: string | undefined): ReasonCategory {
  if (!reason) return 'stuck';
  const r = reason.toLowerCase();
  if (r.includes('door') || r.includes('openable')) return 'door';
  if (
    r === 'cancelled'
    || r === 'preempted'
    || r === 'motor_busy'
    || r.includes('goalchanged')
    || r.includes('pathstopped')
  ) return 'cancelled';
  if (r.includes('timeout') || r.includes('time')) return 'timeout';
  if (r.includes('nopath') || r.includes('no path') || r.includes('no_path') || r.includes('unreachable')) return 'noPath';
  return 'stuck';
}

const MESSAGES: Record<ReasonCategory, string> = {
  door:      '那扇门开不了，你能帮我开一下吗？',
  noPath:    '那边好像过不去，要不你换个位置？',
  timeout:   '这次寻路超时了，我先停下来重新判断。',
  stuck:     '我被卡住了，等我缓一下……',
  cancelled: '',  // 静默
};

/** FEAT-NARR-01 · category → 中枢 topic（中性通知）*/
const CATEGORY_TOPIC: Record<ReasonCategory, string | null> = {
  door: 'nav_door',
  noPath: 'nav_blocked',
  timeout: 'nav_timeout',
  stuck: 'nav_blocked',
  cancelled: null,
};

export class NavFailureFeedback {
  private readonly cooldownMs: number;
  private readonly lastSaidAt = new Map<ReasonCategory, number>();
  private unsub1: (() => void) | null = null;
  private unsub2: (() => void) | null = null;

  constructor(
    private readonly bus: EventBusV2,
    _game: GameAdapter,
    config?: { cooldownMs?: number },
    /** 传入则经统一通知中枢报告；不传也只写 brain.notice。 */
    private readonly narrate?: (intent: SpeechIntent) => void,
  ) {
    this.cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  start(): void {
    const handler = (ev: BusEvent) => this.onNavEnd(ev);
    this.unsub1 = this.bus.on('atomic.move_to.end', handler);
    this.unsub2 = this.bus.on('atomic.follow.end', handler);
  }

  stop(): void {
    this.unsub1?.();
    this.unsub2?.();
    this.unsub1 = null;
    this.unsub2 = null;
  }

  private onNavEnd(ev: BusEvent): void {
    const payload = ev.payload as { ok?: boolean; reason?: string } | undefined;
    if (!payload || payload.ok !== false) return;

    const category = categorize(payload.reason);
    if (category === 'cancelled') return; // 静默

    const now = Date.now();
    const last = this.lastSaidAt.get(category) ?? 0;
    if (now - last < this.cooldownMs) return; // 冷却中

    this.lastSaidAt.set(category, now);

    // 优先走统一通知中枢；没有中枢时也只能投递给大脑。
    const topic = CATEGORY_TOPIC[category];
    if (this.narrate && topic) {
      this.narrate({ source: 'nav', topic, urgency: 45, dedupeKey: `nav_${category}` });
      return;
    }
    const msg = MESSAGES[category];
    if (!msg) return;
    this.bus.publish('brain.notice', 'suggestion', {
      source: 'nav',
      topic: topic ?? 'nav_failed',
      label: '寻路失败',
      detail: msg,
      status: 'fail',
      wake: false,
      dedupeKey: `nav_${category}`,
    });
  }
}
