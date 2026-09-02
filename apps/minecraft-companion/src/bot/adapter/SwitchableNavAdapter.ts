import type { BoundNavigation, NavigationBindingInput } from './NavigationExecution.js';
import type { DoorPassageRequest, GotoOptions, NavGoal, NavigationAdapter } from './NavigationAdapter.js';
import type { MovementOptions, NavResult, Unsubscribe, Vec3 } from './types.js';

/**
 * FEAT-CROSS-08 v2 · 可切换导航适配器代理。
 * 与 SwitchableGameAdapter 同款：方法委托 + 订阅簿记重放，进/退游戏只 setTarget。
 */
export class SwitchableNavAdapter implements NavigationAdapter {
  private target: NavigationAdapter;
  private readonly subs: { rebind: (t: NavigationAdapter) => Unsubscribe; unsub: Unsubscribe }[] = [];

  constructor(initial: NavigationAdapter) {
    this.target = initial;
  }

  setTarget(next: NavigationAdapter): void {
    if (next === this.target) return;
    this.target = next;
    for (const rec of this.subs) {
      try { rec.unsub(); } catch { /* 旧 target 解绑失败不阻断切换 */ }
      rec.unsub = rec.rebind(next);
    }
  }

  bind(input: NavigationBindingInput): BoundNavigation {
    const target = this.target;
    const scope = input.scope;
    const check = (stage?: string) => {
      scope.assertCurrent(stage);
      if (target !== this.target) throw new Error('navigation_generation_changed');
    };
    return target.bind({ ...input, scope: {
      signal: scope.signal, assertCurrent: check,
      effect: run => scope.effect(() => { check('navigation_dispatch'); return run(); }),
      wait: ms => scope.wait(ms),
    } });
  }

  getTarget(): NavigationAdapter { return this.target; }

  private track(rebind: (t: NavigationAdapter) => Unsubscribe): Unsubscribe {
    const rec = { rebind, unsub: rebind(this.target) };
    this.subs.push(rec);
    return () => {
      try { rec.unsub(); } catch { /* ignore */ }
      const i = this.subs.indexOf(rec);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }
  isFollowing(entityId?: number): boolean { return this.target.isFollowing(entityId); }
  isMoving(): boolean { return this.target.isMoving(); }
  isMining(): boolean { return this.target.isMining(); }
  isBuilding(): boolean { return this.target.isBuilding(); }
  setMovementOptions(opts: MovementOptions): void { this.target.setMovementOptions(opts); }
  getCurrentGoal(): NavGoal | null { return this.target.getCurrentGoal(); }
  getCurrentPath(): Vec3[] { return this.target.getCurrentPath(); }

  onGoalReached(handler: () => void): Unsubscribe { return this.track(t => t.onGoalReached(handler)); }
  onPathUpdate(handler: (path: Vec3[]) => void): Unsubscribe { return this.track(t => t.onPathUpdate(handler)); }
  onPathStop(handler: (reason: string) => void): Unsubscribe { return this.track(t => t.onPathStop(handler)); }
  onGoalUpdated(handler: (goal: NavGoal | null) => void): Unsubscribe { return this.track(t => t.onGoalUpdated(handler)); }
}
