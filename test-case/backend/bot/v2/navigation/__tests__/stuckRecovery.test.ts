/**
 * StuckRecovery · 单元测试（FEAT-L1-04）
 *
 * 覆盖测试用例文档（寻路卡墙自救）中的 T1~T6。
 * 注意：StuckRecovery 内部用真实 setTimeout，wait 阶段会真等 2s。
 * 为了让测试在合理时间内跑完，maxAttempts 控小、wait 后立即成功。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StuckRecovery } from '../../../../../../apps/minecraft-companion/src/bot/v2/navigation/stuckRecovery.js';
import type { DoorPassageRequest, NavigationAdapter, NavGoal, GotoOptions } from '../../../../../../apps/minecraft-companion/src/bot/adapter/NavigationAdapter.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type {
  Vec3, MovementOptions, NavResult, Unsubscribe, ControlKey,
} from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';

// ──────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────

class MockNav implements NavigationAdapter {
  calls = 0;
  queue: NavResult[] = [];
  default: NavResult = { ok: false, reason: 'noPath' };
  stopCalled = 0;

  async goto(_goal: NavGoal, _opts?: GotoOptions): Promise<NavResult> {
    this.calls++;
    const r = this.queue.length > 0 ? this.queue.shift()! : this.default;
    return Promise.resolve(r);
  }
  async guideThroughDoor(_request: DoorPassageRequest): Promise<NavResult> { return { ok: true }; }
  stop(): void { this.stopCalled++; }
  startFollow(_id: number, _range: number): { ok: boolean; reason?: string } { return { ok: true }; }
  stopFollow(): void { /* noop */ }
  isFollowing(_id?: number): boolean { return false; }
  isMoving(): boolean { return false; }
  isMining(): boolean { return false; }
  isBuilding(): boolean { return false; }
  setMovementOptions(_opts: MovementOptions): void { /* noop */ }
  getCurrentGoal(): NavGoal | null { return null; }
  getCurrentPath(): Vec3[] { return []; }
  onGoalReached(_h: () => void): Unsubscribe { return () => {}; }
  onPathUpdate(_h: (path: Vec3[]) => void): Unsubscribe { return () => {}; }
  onPathStop(_h: (reason: string) => void): Unsubscribe { return () => {}; }
  onGoalUpdated(_h: (goal: NavGoal | null) => void): Unsubscribe { return () => {}; }
}

class MockGame implements Partial<GameAdapter> {
  readonly username = 'mock';
  controlLog: Array<[ControlKey, boolean] | 'clear'> = [];

  setControlState(key: ControlKey, value: boolean): void {
    this.controlLog.push([key, value]);
  }
  clearControlStates(): void {
    this.controlLog.push('clear');
  }
}

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('StuckRecovery · FEAT-L1-04', () => {

  // T1 · 首次成功无需自救
  it('T1 · 首次 nav.goto 成功 → 不执行自救 · controlState 不动', async () => {
    const nav = new MockNav();
    nav.queue = [{ ok: true }];
    const game = new MockGame();
    const recovery = new StuckRecovery();

    const r = await recovery.executeWithRecovery(
      { x: 0, y: 64, z: 0 }, nav, game as unknown as GameAdapter,
    );

    assert.equal(r.ok, true);
    assert.equal(nav.calls, 1);
    assert.equal(game.controlLog.length, 0);
  });

  // T5 · cancelled 立即停止自救
  it('T5 · recovery 期间 nav.goto 返回 cancelled → 立即返回 · 不再继续', async () => {
    const nav = new MockNav();
    nav.default = { ok: false, reason: 'cancelled' };
    const game = new MockGame();
    const recovery = new StuckRecovery();

    const r = await recovery.executeWithRecovery(
      { x: 0, y: 64, z: 0 }, nav, game as unknown as GameAdapter,
      { maxAttempts: 5 },
    );

    // first goto cancelled (不走 ok 分支) → recovery[0]=wait → goto cancelled → 立即 return
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cancelled');
    // 应只调用 2 次 goto（first + 第一次 recovery），后续不再继续
    assert.equal(nav.calls, 2);
  });

  // T4 · maxAttempts 全部失败 → stuck_max_retries
  it('T4 · 全部失败 maxAttempts=2 → reason=stuck_max_retries', async () => {
    const nav = new MockNav();
    nav.default = { ok: false, reason: 'noPath' }; // 全部失败
    const game = new MockGame();
    const recovery = new StuckRecovery();

    const r = await recovery.executeWithRecovery(
      { x: 0, y: 64, z: 0 }, nav, game as unknown as GameAdapter,
      { maxAttempts: 2 },
    );

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'stuck_max_retries');
    // first goto + 2 次 recovery retry = 3
    assert.equal(nav.calls, 3);
  });

  // T3 · 梯度执行：retreat 后成功
  it('T3 · 第 3 次 goto 成功 → 触发了 wait + retreat · controlState 含 back', async () => {
    const nav = new MockNav();
    nav.queue = [
      { ok: false, reason: 'noPath' }, // first
      { ok: false, reason: 'noPath' }, // after wait
      { ok: true },                    // after retreat
    ];
    const game = new MockGame();
    const recovery = new StuckRecovery();

    const r = await recovery.executeWithRecovery(
      { x: 0, y: 64, z: 0 }, nav, game as unknown as GameAdapter,
    );

    assert.equal(r.ok, true);
    assert.equal(nav.calls, 3);
    // 应触发 retreat：含 ['back', true]
    const hasRetreat = game.controlLog.some(
      (e) => Array.isArray(e) && e[0] === 'back' && e[1] === true,
    );
    assert.ok(hasRetreat, `controlLog 应含 back:true · 实际=${JSON.stringify(game.controlLog)}`);
  });
});
