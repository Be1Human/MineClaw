import type { Unsubscribe } from '../adapter/types.js';

export interface BotEventSource {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  removeListener(event: string, handler: (...args: unknown[]) => void): unknown;
}

interface Subscription<TBot extends BotEventSource> {
  event: string;
  handler: (...args: unknown[]) => void;
  boundBot: TBot | null;
}

/** Keeps adapter subscriptions alive while Mineflayer replaces the concrete Bot. */
export class BotSubscriptionRegistry<TBot extends BotEventSource> {
  private readonly subscriptions = new Set<Subscription<TBot>>();
  private currentBot: TBot | null = null;

  subscribe(initialBot: TBot | null, event: string, handler: (...args: unknown[]) => void): Unsubscribe {
    const subscription: Subscription<TBot> = { event, handler, boundBot: null };
    this.subscriptions.add(subscription);
    this.bind(subscription, initialBot);
    return () => {
      this.unbind(subscription);
      this.subscriptions.delete(subscription);
    };
  }

  rebind(nextBot: TBot | null): void {
    this.currentBot = nextBot;
    for (const subscription of this.subscriptions) {
      if (subscription.boundBot === nextBot) continue;
      this.unbind(subscription);
      this.bind(subscription, nextBot);
    }
  }

  private bind(subscription: Subscription<TBot>, bot: TBot | null): void {
    const target = bot ?? this.currentBot;
    if (!target) return;
    target.on(subscription.event, subscription.handler);
    subscription.boundBot = target;
  }

  private unbind(subscription: Subscription<TBot>): void {
    if (!subscription.boundBot) return;
    try { subscription.boundBot.removeListener(subscription.event, subscription.handler); }
    catch { /* a dying Bot must not block migration of the remaining subscriptions */ }
    subscription.boundBot = null;
  }
}
