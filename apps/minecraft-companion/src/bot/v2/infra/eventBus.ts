/**
 * 📡 基础设施 #1 · EventBus 全局事件总线（v2）
 *
 * 与 v1 区别：
 * - 事件强制带 level（critical / recoverable / suggestion / info）
 * - publish 立刻投递（但 Heartbeat 在 tick 内会 drain）
 * - 提供按 level 订阅的快捷方法
 * - 全部用 BusEvent 标准 schema，不再有 GameEventType 强枚举
 */

import type { BusEvent, EventLevel } from '../types.js';

type Handler = (event: BusEvent) => void;

export class EventBusV2 {
  private byType = new Map<string, Set<Handler>>();
  private byLevel = new Map<EventLevel, Set<Handler>>();
  private global = new Set<Handler>();
  private queue: BusEvent[] = [];
  private seqId = 0;

  // ────────────────────── publish ──────────────────────
  publish<T>(
    type: string,
    level: EventLevel,
    payload: T,
  ): BusEvent<T> {
    const ev: BusEvent<T> = {
      id: `${level}-${Date.now()}-${++this.seqId}`,
      type,
      level,
      timestamp: Date.now(),
      payload,
    };
    this.queue.push(ev);
    this.dispatch(ev);
    return ev;
  }

  /** Heartbeat 在 tick 内调用 · 拿走攒下来的事件用于 ② DrainEvents */
  drain(): BusEvent[] {
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  // ────────────────────── subscribe ──────────────────────
  on(type: string, handler: Handler): () => void {
    if (!this.byType.has(type)) this.byType.set(type, new Set());
    this.byType.get(type)!.add(handler);
    return () => this.byType.get(type)?.delete(handler);
  }

  onLevel(level: EventLevel, handler: Handler): () => void {
    if (!this.byLevel.has(level)) this.byLevel.set(level, new Set());
    this.byLevel.get(level)!.add(handler);
    return () => this.byLevel.get(level)?.delete(handler);
  }

  onAny(handler: Handler): () => void {
    this.global.add(handler);
    return () => this.global.delete(handler);
  }

  // ────────────────────── internal ──────────────────────
  private dispatch(ev: BusEvent): void {
    const typeHandlers = this.byType.get(ev.type);
    if (typeHandlers) {
      for (const h of typeHandlers) this.safe(h, ev);
    }
    const levelHandlers = this.byLevel.get(ev.level);
    if (levelHandlers) {
      for (const h of levelHandlers) this.safe(h, ev);
    }
    for (const h of this.global) this.safe(h, ev);
  }

  private safe(h: Handler, ev: BusEvent): void {
    try {
      h(ev);
    } catch (e) {
      console.error('[eventBus v2] handler error for', ev.type, e);
    }
  }
}
