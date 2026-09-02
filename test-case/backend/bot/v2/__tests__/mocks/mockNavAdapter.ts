import type { DoorPassageRequest, NavigationAdapter, GotoOptions, NavGoal } from '../../../../../../apps/minecraft-companion/src/bot/adapter/NavigationAdapter.js';
import type { Vec3, NavResult, MovementOptions, Unsubscribe } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import type { BoundNavigation, NavigationBindingInput } from '../../../../../../apps/minecraft-companion/src/bot/adapter/NavigationExecution.js';

export class MockNavigationAdapter implements NavigationAdapter {
  bind(input: NavigationBindingInput): BoundNavigation {
    let closed=false;
    const pending = new Set<Promise<unknown>>();
    const run = async (work:()=>Promise<NavResult>) => {
      input.scope.assertCurrent('mock-navigation');
      if (closed) throw new Error('mock_navigation_closed');
      const promise=work(); pending.add(promise);
      try { const result=await promise; input.scope.assertCurrent('mock-navigation-result'); return result; }
      finally { pending.delete(promise); }
    };
    return {actions:{
      goto:(goal,options)=>run(()=>this.goto(goal,options)),
      follow:(id,range)=>run(async()=>{
        this.startFollow(id,range);
        while(!closed && this.isFollowing(id)) await input.scope.wait(this.gotoDelay);
        return {ok:false,reason:'cancelled'};
      }),
      guideThroughDoor:request=>run(()=>this.guideThroughDoor(request)),
      stop:async()=>{ this.stop(); await Promise.allSettled([...pending]); },
      replan:()=>{},setMovementOptions:options=>this.setMovementOptions(options),
      isFollowing:id=>this.isFollowing(id),isMoving:()=>this.isMoving(),isMining:()=>this.isMining(),isBuilding:()=>this.isBuilding(),
      getCurrentGoal:()=>this.getCurrentGoal(),getCurrentPath:()=>this.getCurrentPath(),
    },stop:async()=>{closed=true;this.stop();await Promise.allSettled([...pending]);}};
  }
  private _isMoving = false;
  private _currentGoal: NavGoal | null = null;

  // Control test behavior
  gotoDelay = 100; // ms to simulate movement
  gotoResult: NavResult = { ok: true };
  shouldFail = false;

  // BUG-L5-01 · 持续跟随（动态目标）模拟态
  private _followingEntityId: number | null = null;

  // Track calls
  readonly calls: { goto: NavGoal[]; stop: number; startFollow: number[]; stopFollow: number } =
    { goto: [], stop: 0, startFollow: [], stopFollow: 0 };

  async goto(goal: NavGoal, _opts?: GotoOptions): Promise<NavResult> {
    this.calls.goto.push(goal);
    this._currentGoal = goal;
    this._isMoving = true;
    try {
      await new Promise(r => setTimeout(r, this.gotoDelay));
      if (this.shouldFail) return { ok: false, reason: 'simulated_failure' };
      return this.gotoResult;
    } finally {
      this._isMoving = false;
      this._currentGoal = null;
    }
  }

  async guideThroughDoor(_request: DoorPassageRequest): Promise<NavResult> {
    return { ok: true };
  }

  stop(): void {
    this.calls.stop++;
    this._isMoving = false;
    this._currentGoal = null;
    this._followingEntityId = null;
  }

  startFollow(entityId: number, range: number): { ok: boolean; reason?: string } {
    this.calls.startFollow.push(entityId);
    this._followingEntityId = entityId;
    this._isMoving = true;
    this._currentGoal = { type: 'follow_entity', entityId, range };
    return { ok: true };
  }

  stopFollow(): void {
    this.calls.stopFollow++;
    this._followingEntityId = null;
    if (this._currentGoal?.type === 'follow_entity') this._currentGoal = null;
  }

  isFollowing(entityId?: number): boolean {
    if (this._followingEntityId == null) return false;
    return entityId == null || entityId === this._followingEntityId;
  }

  isMoving(): boolean {
    return this._isMoving;
  }

  isMining(): boolean {
    return false;
  }

  isBuilding(): boolean {
    return false;
  }

  setMovementOptions(_opts: MovementOptions): void {}

  getCurrentGoal(): NavGoal | null {
    return this._currentGoal;
  }

  getCurrentPath(): Vec3[] {
    return [];
  }

  onGoalReached(_h: () => void): Unsubscribe {
    return () => {};
  }

  onPathUpdate(_h: (path: Vec3[]) => void): Unsubscribe {
    return () => {};
  }

  onPathStop(_h: (reason: string) => void): Unsubscribe {
    return () => {};
  }

  onGoalUpdated(_h: (goal: NavGoal | null) => void): Unsubscribe {
    return () => {};
  }
}
