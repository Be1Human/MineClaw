/**
 * DoorMonitor · 单元测试（BUG-L1-02 v2 方案 · L5 策略层）
 *
 * 覆盖：
 *   T1 · 不在导航中 → tick 直接返回 · 不检测
 *   T2 · 路径节点上有关闭的 oak_door → publish door.detected 并单次开门
 *   T3 · 路径节点上有 open=true 的 oak_door → 不重复触发
 *   T4 · 铁门 → 跳过 · publish door.blocked
 *   T5 · 同一坐标 5 秒内不重复触发（冷却）
 *   T6 · 新契约：废除暴力穿门 · 卡门不接管移动/不发 force_walk/不 nav.stop
 *   T7 · 路径前方关闭门 → 单次交互 · 不接管移动
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalDoorPosition, DoorMonitor } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/doorMonitor.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { DoorPassageRequest, NavigationAdapter, NavGoal, GotoOptions } from '../../../../../../apps/minecraft-companion/src/bot/adapter/NavigationAdapter.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type {
  Vec3, MovementOptions, NavResult, Unsubscribe, ControlKey, RawBlock,
} from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';

// ──────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────

class MockNav implements NavigationAdapter {
  moving = true;
  path: Vec3[] = [];
  stopCalls = 0;
  passageCalls: DoorPassageRequest[] = [];

  async goto(_g: NavGoal, _o?: GotoOptions): Promise<NavResult> { return { ok: true }; }
  async guideThroughDoor(request: DoorPassageRequest): Promise<NavResult> {
    this.passageCalls.push(request);
    return { ok: true };
  }
  stop(): void { this.stopCalls++; }
  startFollow(_id: number, _range: number): { ok: boolean; reason?: string } { return { ok: true }; }
  stopFollow(): void { /* noop */ }
  isFollowing(_id?: number): boolean { return false; }
  isMoving(): boolean { return this.moving; }
  isMining(): boolean { return false; }
  isBuilding(): boolean { return false; }
  setMovementOptions(_o: MovementOptions): void { /* noop */ }
  getCurrentGoal(): NavGoal | null { return null; }
  getCurrentPath(): Vec3[] { return this.path; }
  onGoalReached(_h: () => void): Unsubscribe { return () => {}; }
  onPathUpdate(_h: (path: Vec3[]) => void): Unsubscribe { return () => {}; }
  onPathStop(_h: (reason: string) => void): Unsubscribe { return () => {}; }
  onGoalUpdated(_h: (goal: NavGoal | null) => void): Unsubscribe { return () => {}; }
}

interface MockGameOpts {
  blocks?: Map<string, RawBlock>;
  /** 静态 props（按坐标 key） */
  props?: Map<string, Record<string, string>>;
  positions?: Vec3[]; // 每次 getPosition 返回的位置序列
}

class MockGame {
  blocks = new Map<string, RawBlock>();
  props = new Map<string, Record<string, string>>();
  posQueue: Vec3[] = [];
  lastPos: Vec3 = { x: 0, y: 64, z: 0 };
  controlLog: Array<[ControlKey, boolean] | 'clear' | 'lookAt'> = [];
  interactPositions: Vec3[] = [];
  username = 'mock';

  constructor(opts?: MockGameOpts) {
    if (opts?.blocks) this.blocks = opts.blocks;
    if (opts?.props) this.props = opts.props;
    if (opts?.positions) this.posQueue = [...opts.positions];
  }

  getPosition(): Vec3 {
    if (this.posQueue.length > 0) this.lastPos = this.posQueue.shift()!;
    return { ...this.lastPos };
  }
  getBlockAt(pos: Vec3): RawBlock | null {
    return this.blocks.get(`${pos.x}:${pos.y}:${pos.z}`) ?? null;
  }
  getBlockProperties(pos: Vec3): Record<string, string> | null {
    return this.props.get(`${pos.x}:${pos.y}:${pos.z}`) ?? null;
  }
  setControlState(key: ControlKey, value: boolean): void {
    this.controlLog.push([key, value]);
  }
  clearControlStates(): void { this.controlLog.push('clear'); }
  async lookAt(_target: Vec3, _force?: boolean): Promise<void> {
    this.controlLog.push('lookAt');
  }
  async interactBlock(pos: Vec3): Promise<void> {
    this.interactPositions.push({ ...pos });
    const props = this.props.get(`${pos.x}:${pos.y}:${pos.z}`);
    if (props) props.open = 'true';
  }
}

// helpers
function doorBlock(name: string, x: number, y: number, z: number): RawBlock {
  return { name, position: { x, y, z } };
}

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('DoorMonitor · BUG-L1-02 v2', () => {

  it('BUG-CROSS-08 · 仅普通双格门 upper 归一化到 lower', () => {
    assert.deepEqual(
      canonicalDoorPosition({ x: 1, y: 65, z: 2 }, 'oak_door', { half: 'upper' }),
      { x: 1, y: 64, z: 2 },
    );
    assert.deepEqual(
      canonicalDoorPosition({ x: 1, y: 64, z: 2 }, 'oak_door', { half: 'lower' }),
      { x: 1, y: 64, z: 2 },
    );
    assert.deepEqual(
      canonicalDoorPosition({ x: 1, y: 65, z: 2 }, 'oak_trapdoor', { half: 'upper' }),
      { x: 1, y: 65, z: 2 },
    );
  });

  it('BUG-CROSS-08 · 路径命中 upper 时事件和交互都使用 lower 坐标', () => {
    const nav = new MockNav();
    nav.path = [{ x: 1, y: 65, z: 0 }];
    const game = new MockGame();
    game.blocks.set('1:65:0', doorBlock('oak_door', 1, 65, 0));
    game.blocks.set('1:64:0', doorBlock('oak_door', 1, 64, 0));
    game.props.set('1:65:0', { open: 'false', half: 'upper' });
    game.props.set('1:64:0', { open: 'false', half: 'lower' });
    const bus = new EventBusV2();
    let detectedPos: Vec3 | null = null;
    bus.on('door.detected', ev => { detectedPos = (ev.payload as { pos: Vec3 }).pos; });
    const dm = new DoorMonitor(nav, game as unknown as GameAdapter, bus, {} as never);

    dm.tick();

    assert.deepEqual(detectedPos, { x: 1, y: 64, z: 0 });
    assert.deepEqual(game.interactPositions, [{ x: 1, y: 64, z: 0 }]);
  });

  // T1 · 不在导航中 → tick 直接返回
  it('T1 · isMoving=false · tick 不消费事件 · 不发 bus 事件', () => {
    const nav = new MockNav();
    nav.moving = false;
    const game = new MockGame();
    const bus = new EventBusV2();
    const events: string[] = [];
    bus.onAny(e => events.push(e.type));

    const dm = new DoorMonitor(nav, game as unknown as GameAdapter, bus, { createTask: () => ({ id: "d" }), startEmergency: () => ({ ok: true }), complete: () => {} } as never);
    dm.tick();
    assert.equal(events.length, 0);
  });

  // T2 · 路径前方有关闭 oak_door → 检测到 + door.detected 事件
  it('T2 · 前方关闭 oak_door → publish door.detected 并单次开门', () => {
    const nav = new MockNav();
    nav.path = [
      { x: 0, y: 64, z: 0 },
      { x: 1, y: 64, z: 0 },
      { x: 2, y: 64, z: 0 },
    ];
    const game = new MockGame();
    game.blocks.set('1:64:0', doorBlock('oak_door', 1, 64, 0));
    game.props.set('1:64:0', { open: 'false', facing: 'east' });

    const bus = new EventBusV2();
    const events: string[] = [];
    bus.onAny(e => events.push(e.type));

    const dm = new DoorMonitor(nav, game as unknown as GameAdapter, bus, { createTask: () => ({ id: "d" }), startEmergency: () => ({ ok: true }), complete: () => {} } as never);
    dm.tick();

    assert.ok(events.includes('door.detected'), `events=${events.join(',')}`);
    assert.equal(game.interactPositions.length, 1, '物理开门必须只归 DoorMonitor 且只执行一次');
  });

  // T3 · 路径前方 open=true 的门 → 不发事件
  it('T3 · 前方 oak_door 已 open=true → 不 publish door.detected', () => {
    const nav = new MockNav();
    nav.path = [{ x: 1, y: 64, z: 0 }];
    const game = new MockGame();
    game.blocks.set('1:64:0', doorBlock('oak_door', 1, 64, 0));
    game.props.set('1:64:0', { open: 'true', facing: 'east' });

    const bus = new EventBusV2();
    const events: string[] = [];
    bus.onAny(e => events.push(e.type));

    const dm = new DoorMonitor(nav, game as unknown as GameAdapter, bus, { createTask: () => ({ id: "d" }), startEmergency: () => ({ ok: true }), complete: () => {} } as never);
    dm.tick();

    assert.ok(!events.includes('door.detected'), `events=${events.join(',')}`);
  });

  // T4 · 铁门 → door.blocked 事件
  it('T4 · 前方 iron_door → publish door.blocked', () => {
    const nav = new MockNav();
    nav.path = [{ x: 1, y: 64, z: 0 }];
    const game = new MockGame();
    game.blocks.set('1:64:0', doorBlock('iron_door', 1, 64, 0));
    game.props.set('1:64:0', { open: 'false', facing: 'east' });

    const bus = new EventBusV2();
    const events: string[] = [];
    bus.onAny(e => events.push(e.type));

    const dm = new DoorMonitor(nav, game as unknown as GameAdapter, bus, { createTask: () => ({ id: "d" }), startEmergency: () => ({ ok: true }), complete: () => {} } as never);
    dm.tick();

    assert.ok(events.includes('door.blocked'), `events=${events.join(',')}`);
    assert.ok(!events.includes('door.detected'));
  });

  // T5 · 5s 冷却内不重复触发
  it('T5 · 连续 3 次 tick 同一关闭门 · door.detected 只发 1 次（冷却）', () => {
    const nav = new MockNav();
    nav.path = [{ x: 1, y: 64, z: 0 }];
    const game = new MockGame();
    game.blocks.set('1:64:0', doorBlock('oak_door', 1, 64, 0));
    game.props.set('1:64:0', { open: 'false', facing: 'east' });

    const bus = new EventBusV2();
    let detectedCount = 0;
    bus.on('door.detected', () => detectedCount++);

    const dm = new DoorMonitor(nav, game as unknown as GameAdapter, bus, { createTask: () => ({ id: "d" }), startEmergency: () => ({ ok: true }), complete: () => {} } as never);
    dm.tick();
    dm.tick();
    dm.tick();

    assert.equal(detectedCount, 1);
  });

  // T6 · 新契约：废除暴力穿门 —— 卡在门旁也绝不接管移动、不发 force_walk、不 nav.stop
  it('T6 · 连续不动 + 附近有门(无路径) → 不发 force_walk · 不抢 forward · 不 nav.stop', () => {
    const nav = new MockNav();
    nav.moving = true;
    nav.path = []; // 无路径 → 穿门交给 A*，DoorMonitor 不应做任何事
    const game = new MockGame();
    game.blocks.set('1:64:0', doorBlock('oak_door', 1, 64, 0));
    game.props.set('1:64:0', { open: 'false', facing: 'east' });
    for (let i = 0; i < 20; i++) game.posQueue.push({ x: 0, y: 64, z: 0 });

    const bus = new EventBusV2();
    const events: string[] = [];
    bus.onAny(e => events.push(e.type));

    const dm = new DoorMonitor(nav, game as unknown as GameAdapter, bus, { createTask: () => ({ id: "d" }), startEmergency: () => ({ ok: true }), complete: () => {} } as never);
    for (let i = 0; i < 20; i++) dm.tick();

    assert.ok(!events.some(e => e.startsWith('door.force_walk')), `不应发 force_walk，实际 events=${events.join(',')}`);
    const fwd = game.controlLog.filter(e => Array.isArray(e) && e[0] === 'forward');
    assert.equal(fwd.length, 0, 'DoorMonitor 不应接管 forward 控制');
    assert.equal(nav.stopCalls, 0, 'DoorMonitor 不应 nav.stop（不掐死正规寻路）');
  });

  // T7 · 路径前方关闭门 → 单次开门，全程不接管移动
  it('T7 · 前方关闭门 → 单次开门 · 不接管 forward · 不 nav.stop', () => {
    const nav = new MockNav();
    nav.moving = true;
    nav.path = [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }];
    const game = new MockGame();
    game.blocks.set('1:64:0', doorBlock('oak_door', 1, 64, 0));
    game.props.set('1:64:0', { open: 'false', facing: 'east' });
    for (let i = 0; i < 10; i++) game.posQueue.push({ x: 0, y: 64, z: 0 });

    const bus = new EventBusV2();
    const events: string[] = [];
    bus.onAny(e => events.push(e.type));

    const dm = new DoorMonitor(nav, game as unknown as GameAdapter, bus, { createTask: () => ({ id: "d" }), startEmergency: () => ({ ok: true }), complete: () => {} } as never);
    for (let i = 0; i < 10; i++) dm.tick();

    assert.ok(events.includes('door.detected'), `应检测到门，events=${events.join(',')}`);
    assert.equal(game.interactPositions.length, 1, 'DoorMonitor 只点击一次');
    const fwd = game.controlLog.filter(e => Array.isArray(e) && e[0] === 'forward');
    assert.equal(fwd.length, 0, 'DoorMonitor 不应接管 forward 控制');
    assert.equal(nav.stopCalls, 0, 'DoorMonitor 不应 nav.stop');
  });

  it('BUG-CROSS-08 · 普通门打开后把 facing/hinge 交给导航适配器穿门', async () => {
    const nav = new MockNav();
    nav.path = [{ x: 1, y: 64, z: 0 }];
    const game = new MockGame();
    game.blocks.set('1:64:0', doorBlock('oak_door', 1, 64, 0));
    game.props.set('1:64:0', {
      open: 'false', half: 'lower', facing: 'south', hinge: 'left',
    });
    const bus = new EventBusV2();
    let passed = 0;
    bus.on('door.passed', () => passed++);
    const dm = new DoorMonitor(nav, game as unknown as GameAdapter, bus, {} as never);

    dm.tick();
    await new Promise(resolve => setTimeout(resolve, 450));

    assert.equal(nav.passageCalls.length, 1);
    assert.deepEqual(nav.passageCalls[0], {
      position: { x: 1, y: 64, z: 0 },
      blockName: 'oak_door',
      properties: { open: 'false', half: 'lower', facing: 'south', hinge: 'left' },
    });
    assert.equal(passed, 1);
  });
});
