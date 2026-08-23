/**
 * NavigationRouter · 退避式寻路单元测试（FEAT-L1-07）
 *
 * 退避阶梯：
 *   L0 直冲（pathfinder）成功 → mode=direct
 *   L0 失败 + 已贴近目标      → mode=direct（不绕）
 *   L0 失败 + 离目标仍远      → L1 DetourPlanner 记忆地图绕路
 *        ├ 记忆有路 → 绕过 → mode=detour 成功
 *        └ 记忆无路 → mode=detour 失败 reason=no_path
 *   cancel()                  → mode=cancelled
 *
 * 全部用 MockNav + MockWorldMapStore，零外部依赖。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NavigationRouterImpl } from '../../../../../../apps/minecraft-companion/src/bot/v2/navigation/navigationRouter.js';
import type { DoorPassageRequest, NavigationAdapter, NavGoal, GotoOptions } from '../../../../../../apps/minecraft-companion/src/bot/adapter/NavigationAdapter.js';
import type { Vec3, MovementOptions, NavResult, Unsubscribe } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import type { StoredBlock, WorldMapStore, WorldMapStats } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/worldMapStore.js';

interface GotoCall { goal: NavGoal; opts?: GotoOptions; }

class MockNav implements NavigationAdapter {
  calls: GotoCall[] = [];
  /** 队列：每次 goto 弹一个结果 · 队空用 default */
  queue: NavResult[] = [];
  default: NavResult = { ok: true };
  stopCalled = 0;

  async goto(goal: NavGoal, opts?: GotoOptions): Promise<NavResult> {
    this.calls.push({ goal, opts });
    return Promise.resolve(this.queue.length > 0 ? this.queue.shift()! : this.default);
  }
  async guideThroughDoor(_request: DoorPassageRequest): Promise<NavResult> { return { ok: true }; }
  stop(): void { this.stopCalled++; }
  startFollow(): { ok: boolean; reason?: string } { return { ok: true }; }
  stopFollow(): void {}
  isFollowing(): boolean { return false; }
  isMoving(): boolean { return false; }
  isMining(): boolean { return false; }
  isBuilding(): boolean { return false; }
  setMovementOptions(_o: MovementOptions): void {}
  getCurrentGoal(): NavGoal | null { return null; }
  getCurrentPath(): Vec3[] { return []; }
  onGoalReached(): Unsubscribe { return () => {}; }
  onPathUpdate(): Unsubscribe { return () => {}; }
  onPathStop(): Unsubscribe { return () => {}; }
  onGoalUpdated(): Unsubscribe { return () => {}; }
}

class MockWorldMapStore implements WorldMapStore {
  private blocks = new Map<string, StoredBlock>();
  private chunks = new Set<string>();

  setBlock(x: number, y: number, z: number, blockName: string, boundingBox: 'block' | 'empty'): void {
    this.blocks.set(`${x}:${y}:${z}`, { x, y, z, blockName, boundingBox, updatedAt: Date.now() });
    this.chunks.add(`${Math.floor(x / 16)}:${Math.floor(z / 16)}`);
  }
  /** 铺一条 x 走廊（脚下 stone + 2 格 air）让体素 A* 能找到路 */
  fillCorridorX(xMin: number, xMax: number, y: number, z: number): void {
    for (let x = xMin; x <= xMax; x++) {
      this.setBlock(x, y - 1, z, 'stone', 'block');
      this.setBlock(x, y, z, 'air', 'empty');
      this.setBlock(x, y + 1, z, 'air', 'empty');
    }
  }
  getBlock(x: number, y: number, z: number): StoredBlock | null { return this.blocks.get(`${x}:${y}:${z}`) ?? null; }
  upsertBatch(): void {}
  getRegion(): StoredBlock[] { return []; }
  chunkHasData(cx: number, cz: number): boolean { return this.chunks.has(`${cx}:${cz}`); }
  getStats(): WorldMapStats { return { totalBlocks: this.blocks.size, chunksWithData: this.chunks.size }; }
  close(): void {}
  decayConfidence(): number | null { return null; }
  forgetBlock(): void {}
  updateBlock(): void {}
}

const at0 = (): Vec3 => ({ x: 0, y: 64, z: 0 });

describe('NavigationRouter · 退避式寻路 · FEAT-L1-07', () => {

  it('L0 · pathfinder 直冲成功 → mode=direct · 单次 goto', async () => {
    const nav = new MockNav();
    const router = new NavigationRouterImpl(nav, new MockWorldMapStore(), at0);

    const r = await router.navigateTo({ x: 50, y: 64, z: 0 });

    assert.equal(r.success, true);
    assert.equal(r.mode, 'direct');
    assert.equal(nav.calls.length, 1); // 只 L0 一次，不进绕路
  });

  it('L0 失败 + 已贴近目标（≤stuckArriveDist）→ mode=direct 失败 · 不绕路', async () => {
    const nav = new MockNav();
    nav.default = { ok: false, reason: 'noPath' };
    const router = new NavigationRouterImpl(nav, new MockWorldMapStore(), at0);

    // 目标距 3 格 < stuckArriveDist(4) → 哨兵判定已尽力，不升级
    const r = await router.navigateTo({ x: 3, y: 64, z: 0 });

    assert.equal(r.success, false);
    assert.equal(r.mode, 'direct');
    assert.equal(nav.calls.length, 1); // 没进绕路
  });

  it('L0 失败 + 离目标远 + 记忆无路 → 升级绕路后仍失败 mode=detour', async () => {
    const nav = new MockNav();
    nav.default = { ok: false, reason: 'noPath' };
    const router = new NavigationRouterImpl(nav, new MockWorldMapStore(), at0);

    // 远(50) + 空记忆 → 哨兵升级 L1；记忆无真路 → frontier 摸黑步进也失败 → L2 失败
    const r = await router.navigateTo({ x: 50, y: 64, z: 0 });

    assert.equal(r.success, false);
    assert.equal(r.mode, 'detour');
    assert.ok(/no_path|detour_failed/.test(r.reason ?? ''), `reason=${r.reason}`);
  });

  it('L1 · L0 失败 + 记忆有路 → DetourPlanner 绕路 → mode=detour 成功', async () => {
    const nav = new MockNav();
    // 第一次 goto(L0) 失败，其余（绕路 waypoint + 末段）成功
    nav.queue = [{ ok: false, reason: 'noPath' }];
    nav.default = { ok: true };

    const worldMap = new MockWorldMapStore();
    worldMap.fillCorridorX(-1, 51, 64, 0); // 记忆里有一条到 goal 的走廊

    const router = new NavigationRouterImpl(nav, worldMap, at0);
    const r = await router.navigateTo({ x: 50, y: 64, z: 0 });

    assert.equal(r.success, true);
    assert.equal(r.mode, 'detour');
    assert.ok(nav.calls.length >= 2, `应 L0 + 绕路段，实际 ${nav.calls.length}`);
    // 末次调用是 goal 本体
    const last = nav.calls[nav.calls.length - 1].goal as { position?: Vec3 };
    assert.equal(last.position?.x, 50);
  });

  it('cancel() → nav.stop 被调用 · mode=cancelled', async () => {
    const nav = new MockNav();
    nav.default = { ok: false, reason: 'cancelled' };
    const router = new NavigationRouterImpl(nav, new MockWorldMapStore(), at0);

    const p = router.navigateTo({ x: 200, y: 64, z: 0 });
    router.cancel();
    const r = await p;

    assert.ok(nav.stopCalled >= 1, 'nav.stop 应被调用');
    assert.equal(r.mode, 'cancelled');
    assert.equal(r.success, false);
  });
});
