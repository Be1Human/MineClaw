import { GameEvent, GameEventType } from './types.js';

type Handler = (event: GameEvent) => void;

export class EventBus {
  private handlers = new Map<GameEventType, Set<Handler>>();
  private globalHandlers = new Set<Handler>();

  emit(event: GameEvent): void {
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try { handler(event); } catch (e) { console.error('[eventBus] handler error:', e); }
      }
    }
    for (const handler of this.globalHandlers) {
      try { handler(event); } catch (e) { console.error('[eventBus] global handler error:', e); }
    }
  }

  on(type: GameEventType, handler: Handler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  off(type: GameEventType, handler: Handler): void {
    this.handlers.get(type)?.delete(handler);
  }

  onAny(handler: Handler): void {
    this.globalHandlers.add(handler);
  }

  offAny(handler: Handler): void {
    this.globalHandlers.delete(handler);
  }

  once(type: GameEventType, handler: Handler): void {
    const wrapper = (event: GameEvent) => {
      this.off(type, wrapper);
      handler(event);
    };
    this.on(type, wrapper);
  }

  removeAll(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
  }
}
