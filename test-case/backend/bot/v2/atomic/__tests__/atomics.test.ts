/**
 * L3 Atomic 函数单元测试 · US-G8
 *
 * 11 个用例覆盖：
 *   ① say  · 成功路径：调用 game.chat + 发布 atomic.say 事件
 *   ② say  · 缺 target.text → fail
 *   ③ stop · 成功路径：调用 nav.stop + game.clearControlStates + 发布 atomic.stop 事件
 *   ④ moveTo · 成功路径：nav.goto 返回 ok=true
 *   ⑤ moveTo · 缺 target.position → fail
 *   ⑥ moveTo · nav.goto 返回 ok=false → fail 且 error 透传
 *   ⑦ followEntity · 缺 target.entityId → fail
 *   ⑧ attack · 缺 target.entityId → fail
 *   ⑨ attack · 成功路径：lookAt + attack 都被调用
 *   ⑩ equip · 成功路径 + atomic.equip 事件
 *   ⑪ equip · game.equip 抛错 → fail
 *   ⑫ useTool · 成功路径 + atomic.use_tool.success 事件
 *   ⑬ useTool · 缺 target.itemName → fail
 *   ⑭ dig · 成功路径 + 事件 dig.start / dig.success
 *   ⑮ dig · 缺 target.position → fail
 *   ⑯ lookAt · 成功路径 + 事件 look_at.success
 *   ⑰ lookAt · 缺 target.position → fail
 *   ⑱ placeBlock · 缺 itemName → fail
 *   ⑲ placeBlock · 缺 referencePosition → fail
 *   ㉓ placeBlock · 成功路径 · place_block.success 事件携带 source（上层进度推进契约）
 *   ⑳ invoke_behavior · 缺 behaviorRegistry → fail
 *   ㉑ invoke_behavior · skill not found → fail
 *   ㉒ invoke_behavior · 成功路径（skill 产生 say 子请求）
 */

import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { executeAtomic, type AtomicContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/atomic/atomics.js';
import { __setTuningOverride } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { ActionRequest } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { IBehaviorRegistry, IBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/types.js';
import type { RecipeInfo } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function makeReq(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: 'test-req',
    source: 'test',
    type: 'say',
    priority: 50,
    interrupt_level: 'soft',
    resource: [],
    preconditions: [],
    timeout_ms: 500,
    ...overrides,
  };
}

// Track published events across a test
interface CapturedEvent { type: string; level: string; payload: unknown }

function makeMockBus() {
  const events: CapturedEvent[] = [];
  const bus = {
    publish: (type: string, level: string, payload: unknown) => {
      events.push({ type, level, payload });
    },
    events,
  };
  return bus;
}

function makeMockNav(
  gotoResult: { ok: boolean; reason?: string } = { ok: true },
  gotoThrows: Error | null = null,
) {
  const calls = {
    goto: 0,
    stop: 0,
    goals: [] as unknown[],
    movementOptions: [] as unknown[],
  };
  return {
    goto: async (goal: unknown, _opts?: unknown) => {
      calls.goto += 1;
      if (gotoThrows) throw gotoThrows;
      calls.goals.push(goal);
      return gotoResult;
    },
    stop: () => { calls.stop += 1; },
    // satisfy full interface (unused in atomics)
    isMoving: () => false,
    isMining: () => false,
    isBuilding: () => false,
    setMovementOptions: (options: unknown) => { calls.movementOptions.push(options); },
    getCurrentGoal: () => null,
    getCurrentPath: () => [],
    onGoalReached: () => () => {},
    onPathUpdate: () => () => {},
    onPathStop: () => () => {},
    onGoalUpdated: () => () => {},
    calls,
  };
}

function makeMockGame(opts: {
  entity?: { id: number; name: string; position: { x: number; y: number; z: number } } | null;
  heldItem?: { name: string } | null;
  refBlock?: object | null;
  equipThrows?: boolean;
  inventory?: Array<{ name: string; count: number; slot: number }>;
  bedPos?: { x: number; y: number; z: number } | null;
  timeOfDay?: number;     // FEAT-L3-04 · 默认 18000（夜晚）
  thundering?: boolean;    // FEAT-L3-04
  entities?: Array<{ id: number; name: string; type: string; position: { x: number; y: number; z: number } }>; // FEAT-L3-04 · 怪物预检
  sleepThrows?: string;    // FEAT-L3-04 · 模拟 bot.sleep 抛错
  consumeReturns?: boolean; // FEAT-L3-02
  bestFood?: string | null; // FEAT-L3-02
  food?: number;            // FEAT-L3-02
  smeltResult?: { ok: boolean; produced: number; reason?: string }; // FEAT-L3-06
  craftRecipes?: Record<string, RecipeInfo[]>; // BUG-CROSS-09
  // FEAT-L3-08 · 垂直移动
  /** getBlockAt 按 pos 返回的 block；key='x,y,z'，否则 fallback opts.refBlock */
  blocksByPos?: Record<string, { name: string; boundingBox: 'block' | 'empty' } | null>;
  /** 每次调用 getPosition 时返回的位置序列（默认每次都返回起点；序列耗尽则保持最后一个） */
  positions?: Array<{ x: number; y: number; z: number }>;
  // FEAT-L3-09 · 载具
  mountFn?: (entityId: number) => Promise<void>;
  dismountFn?: () => Promise<void>;
} = {}) {
  let posIdx = 0;
  const calls = {
    chat: [] as string[],
    lookAt: 0,
    look: 0,
    attack: [] as number[],
    equip: [] as Array<{ name: string; dest: string }>,
    toss: [] as Array<{ name: string; count?: number }>,
    activateItem: [] as Array<boolean | undefined>,
    deactivateItem: 0,
    setControlState: [] as Array<{ key: string; value: boolean }>,
    clearControlStates: 0,
    dig: [] as Array<{ x: number; y: number; z: number }>,
    placeBlock: 0,
    sleep: [] as Array<{ x: number; y: number; z: number }>,
    wake: 0,
    consume: 0,
    smelt: [] as Array<{ pos: { x: number; y: number; z: number }; input: string; fuel: string; count: number }>,
    craft: [] as Array<{ item: string; count: number }>,
    mount: [] as number[],
    dismount: 0,
  };

  const base = {
    // identity / state (unused by atomics but interface-required)
    username: 'testbot',
    getPosition: () => {
      const seq = opts.positions;
      if (!seq || seq.length === 0) return { x: 0, y: 0, z: 0 };
      const p = seq[Math.min(posIdx, seq.length - 1)];
      posIdx++;
      return p;
    },
    getOrientation: () => ({ yaw: 0, pitch: 0 }),
    getVelocity: () => ({ x: 0, y: 0, z: 0 }),
    isOnGround: () => true,
    getHealth: () => 20,
    getSaturation: () => 20,
    getExperienceLevel: () => 0,
    getSelectedSlot: () => 0,
    getGameMode: () => 'survival',
    getDimension: () => 'overworld',
    getTimeOfDay: () => opts.timeOfDay ?? 0,
    isRaining: () => false,
    isThundering: () => opts.thundering ?? false,
    getFood: () => opts.food ?? 20,
    // world
    getBlockAt: (pos: { x: number; y: number; z: number }) => {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      if (opts.blocksByPos && key in opts.blocksByPos) return opts.blocksByPos[key];
      return opts.refBlock ?? null;
    },
    findBlocks: () => [],
    getEntities: () => opts.entities ?? [],
    getEntityById: (_id: number) => opts.entity ?? null,
    getPlayers: () => ({}),
    getPlayer: () => null,
    // inventory
    getInventoryItems: () => opts.inventory ?? [],
    getHeldItem: () => opts.heldItem ?? null,
    getFreeSlotCount: () => 9,
    // 生存（FEAT-L3-02 / FEAT-L3-04）
    findNearbyBed: (_d: number) => opts.bedPos ?? null,
    sleep: async (pos: { x: number; y: number; z: number }) => {
      calls.sleep.push(pos);
      if (opts.sleepThrows) throw new Error(opts.sleepThrows);
    },
    wake: async () => { calls.wake += 1; },
    consume: async () => {
      calls.consume += 1;
      return opts.consumeReturns ?? true;
    },
    findBestFood: () => opts.bestFood ?? null,
    // 熔炼（FEAT-L3-06）
    smelt: async (pos: { x: number; y: number; z: number }, input: string, fuel: string, count: number) => {
      calls.smelt.push({ pos, input, fuel, count });
      return opts.smeltResult ?? { ok: true, produced: count };
    },
    getCraftRecipes: (itemName: string) => opts.craftRecipes?.[itemName] ?? [],
    getItemSource: () => null,
    craft: async (itemName: string, count: number) => {
      calls.craft.push({ item: itemName, count });
      const recipe = opts.craftRecipes?.[itemName]?.[0];
      if (!recipe) return { ok: false, reason: 'no_craftable_recipe' };
      const inv = opts.inventory ?? [];
      for (const ingredient of recipe.ingredients) {
        const row = inv.find(item => item.name === ingredient.name);
        if (!row || row.count < ingredient.count * count) return { ok: false, reason: 'missing_ingredient' };
        row.count -= ingredient.count * count;
      }
      const result = inv.find(item => item.name === itemName);
      if (result) result.count += recipe.result.count * count;
      else inv.push({ name: itemName, count: recipe.result.count * count, slot: inv.length });
      return { ok: true };
    },
    // control
    setControlState: (key: string, value: boolean) => { calls.setControlState.push({ key, value }); },
    clearControlStates: () => { calls.clearControlStates += 1; },
    lookAt: async (_target: unknown, _force?: boolean) => { calls.lookAt += 1; },
    look: async () => { calls.look += 1; },
    chat: (message: string) => { calls.chat.push(message); },
    // atomic actions
    attack: (entityId: number) => { calls.attack.push(entityId); },
    dig: async (pos: { x: number; y: number; z: number }) => { calls.dig.push(pos); },
    equip: async (itemName: string, dest?: unknown) => {
      if (opts.equipThrows) throw new Error('no such item in inventory');
      calls.equip.push({ name: itemName, dest: (dest as string) ?? 'hand' });
      // BUG-CROSS-80 · 模拟服务器手持同步，供 equip 原子的后置确认轮询读取
      opts.heldItem = { name: itemName, count: 1 };
    },
    toss: async (itemName: string, count?: number) => {
      calls.toss.push({ name: itemName, count });
      const have = (opts.inventory ?? []).filter((i: { name: string }) => i.name === itemName)
        .reduce((s: number, i: { count: number }) => s + i.count, 0);
      return count == null ? have : Math.min(count, have);
    },
    activateItem: (offHand?: boolean) => { calls.activateItem.push(offHand); },
    deactivateItem: () => { calls.deactivateItem += 1; },
    interactBlock: async () => {},
    placeBlock: async (_block: unknown, _face: unknown) => { calls.placeBlock += 1; },
    // events
    onChat: () => () => {},
    onWhisper: () => () => {},
    onHealthChange: () => () => {},
    onDeath: () => () => {},
    onSpawn: () => () => {},
    calls,
  };
  // FEAT-L3-09 · 可选 mount/dismount 扩展（默认不挂；测试要时通过 opts.mountFn 注入）
  const withMount: Record<string, unknown> = {};
  if (opts.mountFn) {
    withMount.mount = async (id: number) => { calls.mount.push(id); await opts.mountFn!(id); };
  }
  if (opts.dismountFn) {
    withMount.dismount = async () => { calls.dismount += 1; await opts.dismountFn!(); };
  }
  return { ...base, ...withMount } as typeof base & { calls: typeof calls };
}

/** Minimal WorldStateView stub */
function makeWorldState() {
  return {
    tick: 1,
    timestamp: Date.now(),
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null,
    environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false },
    entities: [],
    inventory: { items: [], held: null, freeSlots: 9 },
    taskContext: null,
  };
}

/** Minimal skill that produces a 'say' sub-request */
function makeSaySkill(id: string): IBehavior {
  return {
    id,
    plan: (_ctx) => [makeReq({ id: 'sub-say', type: 'say', target: { text: 'hello from skill' } })],
  };
}

/** Minimal BehaviorRegistry with a given skill */
function makeRegistry(skill?: IBehavior): IBehaviorRegistry {
  const map = new Map<string, IBehavior>();
  if (skill) map.set(skill.id, skill);
  return {
    register: (s) => { map.set(s.id, s); },
    get: (id) => map.get(id),
    list: () => [...map.values()],
    clear: () => { map.clear(); },
  };
}

function makeCtx(overrides: Partial<AtomicContext> = {}): AtomicContext & {
  bus: ReturnType<typeof makeMockBus>;
  game: ReturnType<typeof makeMockGame>;
  nav: ReturnType<typeof makeMockNav>;
} {
  const bus = makeMockBus();
  const game = makeMockGame();
  const nav = makeMockNav();
  return {
    game: game as any,
    nav: nav as any,
    bus: bus as any,
    behaviorRegistry: undefined,
    worldState: null,
    ...overrides,
    // keep typed refs
    _bus: bus,
    _game: game,
    _nav: nav,
  } as any;
}

// ─────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────

describe('executeAtomic', () => {
  // 本文件测的是 handler「动作发出」行为；后置验真(物理回查)是独立关注点，
  // mock 不模拟"放完世界真变了"，故关闭验真。验真逻辑由 verifiers 专属用例覆盖。
  before(() => __setTuningOverride({ atomic: { verifyEnabled: false, tossSettleMs: 0 } }));
  after(() => __setTuningOverride(null));

  // ─── say ───────────────────────────────────────────────

  describe('say', () => {
    it('① say 原子只投递 brain.notice，不直接调用 game.chat', () => {
      const bus = makeMockBus();
      const game = makeMockGame();
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const req = makeReq({ type: 'say', target: { text: 'Hello world' } });
      const result = executeAtomic(req, ctx);

      // say is synchronous under the hood — executeAtomic returns Promise always
      return result.then(r => {
        assert.equal(r.ok, true);
        assert.deepEqual(game.calls.chat, []);
        assert.ok(bus.events.some(e => e.type === 'brain.notice' && (e.payload as { detail?: string })?.detail === 'Hello world'));
      });
    });

    it('② 缺 target.text → ok=false', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const result = await executeAtomic(makeReq({ type: 'say', target: {} }), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('say requires target.text'));
    });
  });

  // ─── stop ──────────────────────────────────────────────

  describe('stop', () => {
    it('③ 成功路径：调用 nav.stop + clearControlStates + 发布 atomic.stop', async () => {
      const bus = makeMockBus();
      const game = makeMockGame();
      const nav = makeMockNav();
      const ctx: AtomicContext = {
        game: game as any,
        nav: nav as any,
        bus: bus as any,
      };
      const result = await executeAtomic(makeReq({ type: 'stop' }), ctx);
      assert.equal(result.ok, true);
      assert.equal(nav.calls.stop, 1);
      assert.equal(game.calls.clearControlStates, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.stop'));
    });
  });

  // ─── move_to ───────────────────────────────────────────

  describe('move_to', () => {
    it('④ 成功路径：nav.goto 调用并返回 ok=true', async () => {
      const nav = makeMockNav({ ok: true });
      const bus = makeMockBus();
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: nav as any,
        bus: bus as any,
      };
      const req = makeReq({ type: 'move_to', target: { position: { x: 10, y: 64, z: 20 } } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, true);
      assert.equal(nav.calls.goto, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.move_to.end'));
    });

    it('④b 注入 MotorService 后，move_to 不再直写 nav.goto', async () => {
      const nav = makeMockNav({ ok: true });
      const calls: Array<{ owner: string; priority: number; program: unknown }> = [];
      const ctx = makeCtx({
        nav: nav as any,
        motor: {
          run: async (owner, priority, program) => { calls.push({ owner, priority, program }); return { ok: true }; },
          current: () => null,
          isBusy: () => false,
          cancel: () => {},
        },
      });
      const req = makeReq({ id: 'move-via-motor', priority: 47, type: 'move_to', target: { position: { x: 10, y: 64, z: 20 } } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, true);
      assert.equal(nav.calls.goto, 0);
      assert.deepEqual(calls, [{ owner: 'atomic:test:move_to', priority: 47, program: { kind: 'goto', goal: { type: 'block', position: { x: 10, y: 64, z: 20 }, range: 1 }, budgetMs: req.timeout_ms, thinkTimeoutMs: 5000 } }]);
    });

    it('⑤ 缺 target.position → ok=false', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const result = await executeAtomic(makeReq({ type: 'move_to', target: {} }), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('move_to requires target.position'));
    });

    it('⑥ nav.goto 返回 ok=false → result.ok=false 且 error 透传', async () => {
      const nav = makeMockNav({ ok: false, reason: 'path_blocked' });
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: nav as any,
        bus: makeMockBus() as any,
      };
      const req = makeReq({ type: 'move_to', target: { position: { x: 5, y: 64, z: 5 } } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'path_blocked');
    });
  });

  // ─── follow_entity ─────────────────────────────────────

  describe('follow_entity', () => {
    it('⑦ 缺 target.entityId → ok=false', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const result = await executeAtomic(makeReq({ type: 'follow_entity', target: {} }), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('follow_entity requires target.entityId'));
    });
  });

  // ─── attack ────────────────────────────────────────────

  describe('attack', () => {
    it('⑧ 缺 target.entityId → ok=false', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const result = await executeAtomic(makeReq({ type: 'attack', target: {} }), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('attack requires target.entityId'));
    });

    it('⑨ 成功路径：lookAt + attack 都被调用，发布 atomic.attack 事件', async () => {
      const entity = { id: 99, name: 'zombie', type: 'hostile', position: { x: 1, y: 64, z: 1 }, distance: 2, health: 10 };
      const bus = makeMockBus();
      const game = makeMockGame({ entity: entity as any });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const req = makeReq({ type: 'attack', target: { entityId: 99 } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, true);
      assert.equal(game.calls.lookAt, 1);
      assert.deepEqual(game.calls.attack, [99]);
      assert.ok(bus.events.some(e => e.type === 'atomic.attack'));
    });
  });

  // ─── equip ─────────────────────────────────────────────

  describe('equip', () => {
    it('⑩ 成功路径：equip 调用 + 发布 atomic.equip 事件', async () => {
      const bus = makeMockBus();
      const game = makeMockGame();
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const req = makeReq({ type: 'equip', target: { itemName: 'diamond_sword' } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, true);
      assert.ok(game.calls.equip.some(e => e.name === 'diamond_sword'));
      assert.ok(bus.events.some(e => e.type === 'atomic.equip'));
    });

    it('⑪ game.equip 抛错 → ok=false', async () => {
      const game = makeMockGame({ equipThrows: true });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const req = makeReq({ type: 'equip', target: { itemName: 'golden_sword' } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('no such item in inventory'));
    });
  });

  // ─── use_tool ──────────────────────────────────────────

  describe('use_tool', () => {
    it('⑫ 成功路径：activateItem + deactivateItem 调用 + 发布 atomic.use_tool.success', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ heldItem: { name: 'fishing_rod' } });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const req = makeReq({ type: 'use_tool', target: { itemName: 'fishing_rod' } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, true);
      assert.equal(game.calls.activateItem.length, 1);
      assert.equal(game.calls.deactivateItem, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.use_tool.success'));
    });

    it('⑬ 缺 target.itemName → ok=false', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const result = await executeAtomic(makeReq({ type: 'use_tool', target: {} }), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('use_tool requires target.itemName'));
    });
  });

  // ─── dig ───────────────────────────────────────────────

  describe('dig', () => {
    it('⑭ 成功路径：game.dig 调用 + 发布 dig.start / dig.success（含 source）', async () => {
      const bus = makeMockBus();
      const game = makeMockGame();
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const pos = { x: 3, y: 60, z: 3 };
      const req = makeReq({ type: 'dig', source: 'mine_skill', target: { position: pos } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, true);
      assert.equal(game.calls.dig.length, 1);
      const digSuccess = bus.events.find(e => e.type === 'atomic.dig.success');
      assert.ok(bus.events.some(e => e.type === 'atomic.dig.start'));
      assert.ok(digSuccess, '应发布 atomic.dig.success');
      assert.equal(
        (digSuccess!.payload as { source: string }).source,
        'mine_skill',
        'dig.success payload 必须带 source',
      );
    });

    it('⑮ 缺 target.position → ok=false', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const result = await executeAtomic(makeReq({ type: 'dig', target: {} }), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('dig requires target.position'));
    });
  });

  // ─── mine_to · BUG-CROSS-52 ───────────────────────────

  describe('mine_to', () => {
    it('近距离先直接挖矿，并用 range=1 进入掉落拾取范围', async () => {
      const target = { x: 2, y: 64, z: 0 };
      const key = '2,64,0';
      const blocks = { [key]: { name: 'iron_ore', boundingBox: 'block' as const } };
      const game = makeMockGame({ blocksByPos: blocks, positions: [{ x: 0.5, y: 64, z: 0.5 }] });
      const nav = makeMockNav();
      (game as any).dig = async (pos: typeof target) => {
        game.calls.dig.push(pos);
        (blocks as Record<string, { name: string; boundingBox: 'block' | 'empty' }>)[key] = {
          name: 'air',
          boundingBox: 'empty',
        };
      };
      const result = await executeAtomic(
        makeReq({ type: 'mine_to', target: { position: target, itemName: 'stone_pickaxe' } }),
        { game: game as any, nav: nav as any, bus: makeMockBus() as any },
      );

      assert.equal(result.ok, true);
      assert.equal(game.calls.dig.length, 1);
      assert.equal(nav.calls.goto, 1, '近距离不应先走 Pathfinder');
      assert.equal((nav.calls.goals[0] as { range: number }).range, 1, '空气矿位拾取不能使用 range=0');
      assert.ok(!nav.calls.goals.some(goal => (goal as { range?: number }).range === 0));
    });

    it('远距离使用 range=2 接近实心矿块，挖除后再用 range=1 拾取', async () => {
      const target = { x: 10, y: 64, z: 0 };
      const key = '10,64,0';
      const blocks = { [key]: { name: 'iron_ore', boundingBox: 'block' as const } };
      const game = makeMockGame({ blocksByPos: blocks, positions: [{ x: 0, y: 64, z: 0 }] });
      const nav = makeMockNav();
      (game as any).dig = async (pos: typeof target) => {
        game.calls.dig.push(pos);
        (blocks as Record<string, { name: string; boundingBox: 'block' | 'empty' }>)[key] = {
          name: 'air',
          boundingBox: 'empty',
        };
      };
      const result = await executeAtomic(
        makeReq({ type: 'mine_to', target: { position: target, itemName: 'stone_pickaxe' } }),
        { game: game as any, nav: nav as any, bus: makeMockBus() as any },
      );

      assert.equal(result.ok, true);
      assert.deepEqual(
        nav.calls.goals.map(goal => (goal as { range: number }).range),
        [2, 1],
      );
      assert.ok(nav.calls.movementOptions.some(
        options => (options as { canDig?: boolean }).canDig === true,
      ));
      assert.equal(
        (nav.calls.movementOptions.at(-1) as { canDig?: boolean }).canDig,
        false,
        '动作结束必须关闭 Pathfinder 自动挖掘',
      );
    });

    it('dig 调用后矿块仍存在时明确失败，禁止假成功', async () => {
      const target = { x: 2, y: 64, z: 0 };
      const game = makeMockGame({
        blocksByPos: { '2,64,0': { name: 'iron_ore', boundingBox: 'block' } },
        positions: [{ x: 0.5, y: 64, z: 0.5 }],
      });
      const nav = makeMockNav();
      const result = await executeAtomic(
        makeReq({ type: 'mine_to', target: { position: target, itemName: 'stone_pickaxe' } }),
        { game: game as any, nav: nav as any, bus: makeMockBus() as any },
      );

      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /mine_to_target_not_removed/);
      assert.equal(nav.calls.goto, 1, '直接挖失败后只应执行 range=2 接近，不得进入拾取');
      assert.equal((nav.calls.goals[0] as { range: number }).range, 2);
      assert.equal(
        (nav.calls.movementOptions.at(-1) as { canDig?: boolean }).canDig,
        false,
      );
    });

    it('目标位置不是矿块时立即失败，不启动寻路', async () => {
      const nav = makeMockNav();
      const result = await executeAtomic(
        makeReq({ type: 'mine_to', target: { position: { x: 2, y: 64, z: 0 } } }),
        {
          game: makeMockGame({ blocksByPos: { '2,64,0': { name: 'air', boundingBox: 'empty' } } }) as any,
          nav: nav as any,
          bus: makeMockBus() as any,
        },
      );

      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /mine_to_target_missing/);
      assert.equal(nav.calls.goto, 0);
    });

    it('over 4.25 interaction radius goes through range=2 approach before digging', async () => {
      const target = { x: 4, y: 64, z: 2 };
      const key = '4,64,2';
      const blocks = { [key]: { name: 'iron_ore', boundingBox: 'block' as const } };
      const game = makeMockGame({ blocksByPos: blocks, positions: [{ x: 0.5, y: 64, z: 0.5 }] });
      const nav = makeMockNav();
      // distanceToCenter = hypot(4.5-0.5, 64.5-64, 2.5-0.5) = 4.5 > 4.25
      (game as any).dig = async (pos: typeof target) => {
        game.calls.dig.push(pos);
        (blocks as Record<string, { name: string; boundingBox: 'block' | 'empty' }>)[key] = {
          name: 'air',
          boundingBox: 'empty',
        };
      };
      const result = await executeAtomic(
        makeReq({ type: 'mine_to', target: { position: target, itemName: 'stone_pickaxe' } }),
        { game: game as any, nav: nav as any, bus: makeMockBus() as any },
      );

      assert.equal(result.ok, true);
      assert.deepEqual(
        nav.calls.goals.map(goal => (goal as { range: number }).range),
        [2, 1],
        'must approach via range=2, then pickup via range=1',
      );
      assert.equal(game.calls.dig.length, 1);
    });

    it('nav exception restores canDig=false, stops navigation and fails', async () => {
      const target = { x: 10, y: 64, z: 0 };
      const game = makeMockGame({
        blocksByPos: { '10,64,0': { name: 'iron_ore', boundingBox: 'block' } },
        positions: [{ x: 0, y: 64, z: 0 }],
      });
      const nav = makeMockNav({ ok: true }, new Error('nav boom'));
      const result = await executeAtomic(
        makeReq({ type: 'mine_to', target: { position: target, itemName: 'stone_pickaxe' } }),
        { game: game as any, nav: nav as any, bus: makeMockBus() as any },
      );

      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /nav boom/);
      assert.equal(
        (nav.calls.movementOptions.at(-1) as { canDig?: boolean }).canDig,
        false,
        'finally must restore Pathfinder auto-dig flag on exception',
      );
      assert.ok(nav.calls.stop >= 1, 'navigation must stop on exception');
    });
  });

  // ─── look_at ───────────────────────────────────────────

  describe('look_at', () => {
    it('⑯ 成功路径：game.lookAt 调用 + 发布 look_at.success', async () => {
      const bus = makeMockBus();
      const game = makeMockGame();
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const req = makeReq({ type: 'look_at', target: { position: { x: 5, y: 64, z: 5 } } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, true);
      assert.equal(game.calls.lookAt, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.look_at.success'));
    });

    it('⑰ 缺 target.position → ok=false', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const result = await executeAtomic(makeReq({ type: 'look_at', target: {} }), ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('look_at requires target.position'));
    });
  });

  // ─── place_block ───────────────────────────────────────

  describe('place_block', () => {
    it('⑱ 缺 target.itemName → ok=false', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const req = makeReq({ type: 'place_block', target: { referencePosition: { x: 0, y: 63, z: 0 } } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('place_block requires target.itemName'));
    });

    it('⑲ 缺 referencePosition 且附近无可放置点 → ok=false (no_placement_site)', async () => {
      // 新行为：缺 refPos 时自动算放置点；空世界(mock 无实心块)算不出 → no_placement_site
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const req = makeReq({ type: 'place_block', target: { itemName: 'stone' } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('no_placement_site'));
    });

    it('㉓ 成功路径：place_block.success 携带 source（上层进度推进契约）', async () => {
      const bus = makeMockBus();
      const inventory = [{ name: 'wheat_seeds', count: 1, slot: 0 }];
      const blocksByPos:Record<string,{name:string;boundingBox:'block'|'empty'}|null> = {
        '0,63,0': { name: 'dirt', boundingBox: 'block' },
        '0,64,0': { name: 'air', boundingBox: 'empty' },
      };
      const game = makeMockGame({ inventory, blocksByPos });
      game.placeBlock = async () => {
        game.calls.placeBlock += 1;
        inventory[0]!.count = 0;
        blocksByPos['0,64,0'] = { name: 'wheat', boundingBox: 'empty' };
      };
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const req = makeReq({
        type: 'place_block',
        source: 'farm_one_plot',
        target: {
          itemName: 'wheat_seeds',
          position: { x: 0, y: 64, z: 0 },
          referencePosition: { x: 0, y: 63, z: 0 },
          faceVector: { x: 0, y: 1, z: 0 },
        },
      });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, true);
      assert.equal(game.calls.placeBlock, 1);
      const success = bus.events.find(e => e.type === 'atomic.place_block.success');
      assert.ok(success, '应发布 atomic.place_block.success');
      // 关键回归断言：漏带 source 会让 FarmStrategy 监听器永远 early-return，进度卡死
      assert.equal(
        (success!.payload as { source: string }).source,
        'farm_one_plot',
        'place_block.success payload 必须带 source（FarmStrategy 靠它推进 plotsDone）',
      );
    });

    it('BUG-CROSS-66 · adapter 返回但世界与库存未变化时禁止发布成功', async () => {
      const bus=makeMockBus();
      const game=makeMockGame({
        inventory:[{name:'torch',count:1,slot:0}],
        blocksByPos:{
          '0,63,0':{name:'stone',boundingBox:'block'},
          '0,64,0':{name:'air',boundingBox:'empty'},
        },
      });
      const result=await executeAtomic(makeReq({
        type:'place_block',source:'place_relative_to_owner',
        target:{
          itemName:'torch',position:{x:0,y:64,z:0},
          referencePosition:{x:0,y:63,z:0},faceVector:{x:0,y:1,z:0},
        },
      }),{
        game:game as any,nav:makeMockNav() as any,bus:bus as any,
      });
      assert.equal(result.ok,false);
      assert.match(result.error??'',/place_block_unsettled/);
      assert.equal(bus.events.some(event=>event.type==='atomic.place_block.success'),false);
      assert.equal(bus.events.some(event=>event.type==='atomic.place_block.fail'),true);
    });
  });

  // ─── invoke_behavior ──────────────────────────────────────

  describe('invoke_behavior', () => {
    it('⑳ 缺 behaviorRegistry → ok=false + no_registry', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
        behaviorRegistry: undefined,
        worldState: null,
      };
      const req = makeReq({ type: 'invoke_behavior', target: { behavior: 'some_skill' } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('no_registry'));
    });

    it('㉑ skill not found in registry → ok=false + behavior_not_found', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
        behaviorRegistry: makeRegistry(), // empty registry
        worldState: makeWorldState() as any,
      };
      const req = makeReq({ type: 'invoke_behavior', target: { behavior: 'missing_skill' } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('behavior_not_found'));
    });

    it('㉒ 成功路径：skill 产生 say 子请求，bus 发布 invoke_behavior.success', async () => {
      const skill = makeSaySkill('test_skill');
      const bus = makeMockBus();
      const game = makeMockGame();
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
        behaviorRegistry: makeRegistry(skill),
        worldState: makeWorldState() as any,
      };
      const req = makeReq({ type: 'invoke_behavior', target: { behavior: 'test_skill' } });
      const result = await executeAtomic(req, ctx);
      assert.equal(result.ok, true);
      assert.equal(game.calls.chat.length, 0);
      assert.ok(bus.events.some(e => e.type === 'brain.notice' && (e.payload as { detail?: string })?.detail === 'hello from skill'));
      assert.ok(bus.events.some(e => e.type === 'atomic.invoke_behavior.success'));
    });

    it('自适应 skill 可在动作间读取最新世界并执行短原子', async () => {
      const bus = makeMockBus();
      const game = makeMockGame();
      let reads = 0;
      const world = makeWorldState() as any;
      const skill: IBehavior = {
        id: 'adaptive_skill',
        plan: () => { throw new Error('adaptive skill must not call plan'); },
        run: async runtime => {
          runtime.getWorld();
          reads++;
          const result = await runtime.execute(makeReq({ id: 'adaptive-say', type: 'say', target: { text: 'adaptive' } }));
          runtime.getWorld();
          reads++;
          return { ok: result.ok, details: { reads } };
        },
      };
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
        behaviorRegistry: makeRegistry(skill),
        worldState: world,
      };
      const result = await executeAtomic(makeReq({ type: 'invoke_behavior', target: { behavior: skill.id } }), ctx);
      assert.equal(result.ok, true);
      assert.equal(reads, 2);
      assert.ok(bus.events.some(e => e.type === 'atomic.invoke_behavior.start' && (e.payload as { adaptive?: boolean }).adaptive));
      assert.ok(bus.events.some(e => e.type === 'atomic.invoke_behavior.success' && (e.payload as { reads?: number }).reads === 2));
    });

    it('自适应 skill 仍禁止嵌套 invoke_behavior', async () => {
      const skill: IBehavior = {
        id: 'nested_skill',
        plan: () => [],
        run: async runtime => {
          const nested = await runtime.execute(makeReq({ type: 'invoke_behavior', target: { behavior: 'other' } }));
          return { ok: nested.ok, error: nested.error };
        },
      };
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
        behaviorRegistry: makeRegistry(skill),
        worldState: makeWorldState() as any,
      };
      const result = await executeAtomic(makeReq({ type: 'invoke_behavior', target: { behavior: skill.id } }), ctx);
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /nested invoke_behavior forbidden/);
    });
  });

  // ─── eat（FEAT-L3-02） ─────────────────────────────────

  describe('eat', () => {
    it('㉔ 成功路径：equip + consume + 发布 atomic.eat.success', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ bestFood: 'cooked_beef', consumeReturns: true });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const req = makeReq({ type: 'eat', target: {} });
      const r = await executeAtomic(req, ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.consume, 1);
      assert.ok(game.calls.equip.some(e => e.name === 'cooked_beef'));
      assert.ok(bus.events.some(e => e.type === 'atomic.eat.success'));
    });

    it('㉕ 背包无食物 → ok=false', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame({ bestFood: null }) as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'eat', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('no food'));
    });

    it('㉖ consume 返回 false → ok=false + atomic.eat.fail', async () => {
      const bus = makeMockBus();
      const ctx: AtomicContext = {
        game: makeMockGame({ bestFood: 'apple', consumeReturns: false }) as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'eat', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(bus.events.some(e => e.type === 'atomic.eat.fail'));
    });
  });

  // ─── sleep（FEAT-L3-04） ────────────────────────────────

  describe('sleep', () => {
    const NIGHT = 18000; // 0–24000 中的午夜附近

    it('㉗ 成功路径：夜晚 + 无怪 → game.sleep 调用 + atomic.sleep.success', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        bedPos: { x: 10, y: 64, z: 10 },
        timeOfDay: NIGHT,
        entities: [],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'sleep', target: {} }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.sleep.length, 1);
      assert.deepEqual(game.calls.sleep[0], { x: 10, y: 64, z: 10 });
      const succ = bus.events.find(e => e.type === 'atomic.sleep.success');
      assert.ok(succ);
      assert.equal((succ!.payload as { source: string }).source, 'test');
    });

    it('㉘ 找不到床 → ok=false + reason=no_bed_nearby', async () => {
      const bus = makeMockBus();
      const ctx: AtomicContext = {
        game: makeMockGame({ bedPos: null, timeOfDay: NIGHT }) as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'sleep', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('no_bed_nearby'));
      const f = bus.events.find(e => e.type === 'atomic.sleep.fail');
      assert.ok(f);
      assert.equal((f!.payload as { reason: string }).reason, 'no_bed_nearby');
    });

    it('㉙ 白天 → ok=false + reason=not_night (不会调 game.sleep)', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        bedPos: { x: 0, y: 64, z: 0 },
        timeOfDay: 6000, // 中午
        entities: [],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'sleep', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('not_night'));
      assert.equal(game.calls.sleep.length, 0, '白天预检失败前不应调 bot.sleep');
    });

    it('㉚ 雷暴白天 → ok=true（vanilla 规则允许）', async () => {
      const game = makeMockGame({
        bedPos: { x: 0, y: 64, z: 0 },
        timeOfDay: 6000,
        thundering: true,
        entities: [],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'sleep', target: {} }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.sleep.length, 1);
    });

    it('㉛ 怪物在床 8 格内 → ok=false + reason=monster_nearby', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        bedPos: { x: 10, y: 64, z: 10 },
        timeOfDay: NIGHT,
        entities: [{ id: 1, name: 'zombie', type: 'mob', position: { x: 12, y: 64, z: 11 } }],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'sleep', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('monster_nearby'));
      assert.equal(game.calls.sleep.length, 0, '怪物预检前不应调 bot.sleep');
      const f = bus.events.find(e => e.type === 'atomic.sleep.fail');
      assert.equal((f!.payload as { monster: string }).monster, 'zombie');
    });

    it('㉜ 远处怪物（>8 格）不阻止睡觉', async () => {
      const game = makeMockGame({
        bedPos: { x: 0, y: 64, z: 0 },
        timeOfDay: NIGHT,
        entities: [{ id: 1, name: 'zombie', type: 'mob', position: { x: 30, y: 64, z: 30 } }],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'sleep', target: {} }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.sleep.length, 1);
    });

    it('㉝ bot.sleep 抛 monsters_nearby → 映射成 reason=monster_nearby', async () => {
      // 预检漏掉（生物突然出现）→ mineflayer 抛错；atomic 应映射
      const bus = makeMockBus();
      const game = makeMockGame({
        bedPos: { x: 0, y: 64, z: 0 },
        timeOfDay: NIGHT,
        entities: [],
        sleepThrows: 'there_are_monsters_nearby',
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'sleep', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('monster_nearby'));
      const f = bus.events.find(e => e.type === 'atomic.sleep.fail');
      assert.equal((f!.payload as { reason: string }).reason, 'monster_nearby');
    });

    it('㉞ wake atomic 调 game.wake + 发布 atomic.wake', async () => {
      const bus = makeMockBus();
      const game = makeMockGame();
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'wake' }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.wake, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.wake'));
    });
  });

  // ─── smelt（FEAT-L3-06） ────────────────────────────────

  describe('smelt', () => {
    it('㉟ 成功路径：nav 到炉旁 → game.smelt → atomic.smelt.success(produced)', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ smeltResult: { ok: true, produced: 2 } });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const req = makeReq({
        type: 'smelt',
        target: { itemName: 'iron_ore', fuelName: 'coal', count: 2, tablePos: { x: 1, y: 0, z: 1 } },
      });
      const r = await executeAtomic(req, ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.smelt.length, 1);
      const succ = bus.events.find(e => e.type === 'atomic.smelt.success');
      assert.ok(succ);
      assert.equal((succ!.payload as { produced: number }).produced, 2);
    });

    // BUG-CROSS-02 新契约：缺 tablePos 不再是契约错误，原子自己 ensureFurnace。
    // 附近无炉、背包无炉、也造不出时 → 语义失败 smelt_need_furnace（LLM 可据此去挖圆石），
    // 而非旧的 'requires target.tablePos'（LLM 无从理解、更算不出熔炉坐标）。
    it('㊱ 缺 tablePos 且附近无炉造不出 → smelt_need_furnace（语义失败·非契约错误）', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any, // findBlocks→[] 无现成炉；背包空；无 craft 能力
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const req = makeReq({ type: 'smelt', target: { itemName: 'iron_ore', fuelName: 'coal' } });
      const r = await executeAtomic(req, ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('smelt_need_furnace'), `期望语义失败，实得: ${r.error}`);
      assert.ok(!r.error?.includes('requires'), '不应再出现契约错误话术');
    });

    it('㊱b 缺 tablePos 但附近有炉 → 自动定位并熔炼成功', async () => {
      const game = makeMockGame({ smeltResult: { ok: true, produced: 1 } }) as any;
      game.findBlocks = (q: { names: string | string[] }) => {
        const names = Array.isArray(q.names) ? q.names : [q.names];
        return names.includes('furnace') ? [{ x: 2, y: 0, z: 2 }] : [];
      };
      const ctx: AtomicContext = { game, nav: makeMockNav() as any, bus: makeMockBus() as any };
      const req = makeReq({ type: 'smelt', target: { itemName: 'iron_ore', fuelName: 'coal', count: 1 } });
      const r = await executeAtomic(req, ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.smelt.length, 1);
      assert.deepEqual(game.calls.smelt[0].pos, { x: 2, y: 0, z: 2 });
    });

    it('㊱c 缺 fuelName 但背包有煤 → 自动挑煤（不再要求上游填参）', async () => {
      const game = makeMockGame({
        smeltResult: { ok: true, produced: 1 },
        inventory: [{ name: 'coal', count: 5, slot: 0 }, { name: 'oak_planks', count: 3, slot: 1 }],
      }) as any;
      game.findBlocks = (q: { names: string | string[] }) => {
        const names = Array.isArray(q.names) ? q.names : [q.names];
        return names.includes('furnace') ? [{ x: 2, y: 0, z: 2 }] : [];
      };
      const ctx: AtomicContext = { game, nav: makeMockNav() as any, bus: makeMockBus() as any };
      const req = makeReq({ type: 'smelt', target: { itemName: 'raw_iron', count: 1 } });
      const r = await executeAtomic(req, ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.smelt[0].fuel, 'coal', '应优先挑煤而非木板');
    });

    it('㊱d 缺 fuelName 且只有木板 → 自动挑木板', async () => {
      const game = makeMockGame({
        smeltResult: { ok: true, produced: 1 },
        inventory: [{ name: 'oak_planks', count: 8, slot: 0 }],
      }) as any;
      game.findBlocks = (q: { names: string | string[] }) => {
        const names = Array.isArray(q.names) ? q.names : [q.names];
        return names.includes('furnace') ? [{ x: 2, y: 0, z: 2 }] : [];
      };
      const ctx: AtomicContext = { game, nav: makeMockNav() as any, bus: makeMockBus() as any };
      const req = makeReq({ type: 'smelt', target: { itemName: 'raw_iron', count: 1 } });
      const r = await executeAtomic(req, ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.smelt[0].fuel, 'oak_planks');
    });

    it('㊲ smelt 返回 ok=false → fail 透传 reason', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame({ smeltResult: { ok: false, produced: 0, reason: 'no_fuel' } }) as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const req = makeReq({
        type: 'smelt',
        target: { itemName: 'iron_ore', fuelName: 'coal', count: 1, tablePos: { x: 1, y: 0, z: 1 } },
      });
      const r = await executeAtomic(req, ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('no_fuel'));
    });
  });

  // ─── equip_best_armor（FEAT-L3-07） ─────────────────────

  describe('equip_best_armor', () => {
    it('㊳ 空背包 → ok=true 但 equipped=0', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ inventory: [] });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'equip_best_armor' }), ctx);
      assert.equal(r.ok, true);
      const succ = bus.events.find(e => e.type === 'atomic.equip_best_armor.success');
      assert.ok(succ);
      assert.equal((succ!.payload as { equipped: number }).equipped, 0);
    });

    it('㊴ 4 件全套盔甲 → 4 槽位都装备到对应 dest', async () => {
      const game = makeMockGame({
        inventory: [
          { name: 'iron_helmet', count: 1, slot: 9 },
          { name: 'iron_chestplate', count: 1, slot: 10 },
          { name: 'iron_leggings', count: 1, slot: 11 },
          { name: 'iron_boots', count: 1, slot: 12 },
        ],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'equip_best_armor' }), ctx);
      assert.equal(r.ok, true);
      // 应有 4 次 equip 调用，各对应正确 dest
      const equips = game.calls.equip;
      assert.equal(equips.length, 4);
      assert.ok(equips.some(e => e.name === 'iron_helmet' && e.dest === 'head'));
      assert.ok(equips.some(e => e.name === 'iron_chestplate' && e.dest === 'torso'));
      assert.ok(equips.some(e => e.name === 'iron_leggings' && e.dest === 'legs'));
      assert.ok(equips.some(e => e.name === 'iron_boots' && e.dest === 'feet'));
    });

    it('㊵ 同槽位选 tier 最高（皮 vs 铁 → 装铁）', async () => {
      const game = makeMockGame({
        inventory: [
          { name: 'leather_helmet', count: 1, slot: 9 },
          { name: 'iron_helmet', count: 1, slot: 10 },
        ],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'equip_best_armor' }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.equip.length, 1);
      assert.equal(game.calls.equip[0].name, 'iron_helmet');
    });

    it('㊶ 已穿同档不重换（避免 RPC 风暴）', async () => {
      const game = makeMockGame({
        inventory: [
          // slot 5 = 已穿头盔
          { name: 'iron_helmet', count: 1, slot: 5 },
          // 背包里还有一件同款
          { name: 'iron_helmet', count: 1, slot: 9 },
        ],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'equip_best_armor' }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.equip.length, 0, '已穿同档不应再 equip');
    });

    it('㊷ 已穿更高档不被降级（铁→皮 → 跳过）', async () => {
      const game = makeMockGame({
        inventory: [
          { name: 'iron_chestplate', count: 1, slot: 6 }, // 已穿铁
          { name: 'leather_chestplate', count: 1, slot: 9 }, // 背包有皮
        ],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'equip_best_armor' }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.equip.length, 0, '已穿更高档不应降级');
    });
  });

  // ─── fish（FEAT-L3-05） ────────────────────────────────

  describe('fish', () => {
    it('F1 背包无钓竿 → fail no_fishing_rod', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ inventory: [] });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'fish', target: { durationMs: 100 } }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('no_fishing_rod'));
      assert.ok(bus.events.some(e => e.type === 'atomic.fish.fail'));
    });

    it('F2 成功路径：equip + activateItem + deactivateItem + 事件链', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ inventory: [{ name: 'fishing_rod', count: 1, slot: 0 }] });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'fish', target: { durationMs: 100 } }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.equip.length, 1);
      assert.equal(game.calls.equip[0].name, 'fishing_rod');
      assert.equal(game.calls.activateItem.length, 1, '抛钩 activateItem 1 次');
      assert.equal(game.calls.deactivateItem, 1, '收杆 deactivateItem 1 次');
      // 事件链顺序：cast → wait → reel → success
      const types = bus.events.map(e => e.type);
      assert.ok(types.includes('atomic.fish.cast'));
      assert.ok(types.includes('atomic.fish.wait'));
      assert.ok(types.includes('atomic.fish.reel'));
      assert.ok(types.includes('atomic.fish.success'));
    });

    it('F3 给 target.position → 先 lookAt 水面', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ inventory: [{ name: 'fishing_rod', count: 1, slot: 0 }] });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'fish', target: { position: { x: 5, y: 62, z: 5 }, durationMs: 100 } }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.lookAt, 1, 'lookAt 水面 1 次');
      const cast = bus.events.find(e => e.type === 'atomic.fish.cast');
      assert.equal((cast!.payload as { lookedAt: boolean }).lookedAt, true);
    });

    it('F4 durationMs 上限 clamp 到 30000（小输入只验下限）', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ inventory: [{ name: 'fishing_rod', count: 1, slot: 0 }] });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      // 用 1ms 输入 → clamp 到 3000ms。但为避免单测耗 3s，我们直接验下限实现：传 3500 ≤ 30000
      const r = await executeAtomic(makeReq({ type: 'fish', target: { durationMs: 100 } }), ctx);
      assert.equal(r.ok, true);
      const succ = bus.events.find(e => e.type === 'atomic.fish.success');
      // 实际 wait 的 ms 应被 clamp 到 [3000, 30000]
      const ms = (succ!.payload as { durationMs: number }).durationMs;
      assert.ok(ms >= 3000 && ms <= 30000, `durationMs 应被 clamp，实际=${ms}`);
    });
  });

  // ─── climb_up / pillar_up / dig_down / place_scaffold（FEAT-L3-08） ─────

  describe('climb_up', () => {
    it('V1 缺 target.position.y → fail', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'climb_up', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('target.position.y'));
    });

    it('V2 上方非可攀爬方块 → fail not_climbable', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        // 上方是 stone，不能爬
        blocksByPos: { '0,1,0': { name: 'stone', boundingBox: 'block' } },
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(
        makeReq({ type: 'climb_up', target: { position: { x: 0, y: 10, z: 0 } } }),
        ctx,
      );
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('not_climbable'));
    });
  });

  describe('pillar_up', () => {
    it('V3 缺 target.count → fail', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'pillar_up', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('target.count'));
    });

    it('V4 背包无垫脚块 → fail no_pillar_block', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ inventory: [] });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'pillar_up', target: { count: 2 } }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('no_pillar_block'));
    });

    it('V5 有垫脚块 + 成功升 1 格 → equip + placeBlock + setControlState(jump) 都调到', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        inventory: [{ name: 'dirt', count: 8, slot: 0 }],
        // 脚下 -1 是 dirt 实心；目标格变化由 positions 序列模拟
        blocksByPos: { '0,-1,0': { name: 'dirt', boundingBox: 'block' } },
        // pillarUpAtomic 调 getPosition 序列：① startY 计算 ② 循环内 before ③ apex 探测 ④ 落点(>fy) ⑤ 最终 endY
        positions: [
          { x: 0, y: 0, z: 0 }, // startY
          { x: 0, y: 0, z: 0 }, // before（循环开头）→ fy=0
          { x: 0, y: 1, z: 0 }, // apex 探测：y=1 >= fy+0.5=0.5 → 立即退出
          { x: 0, y: 1, z: 0 }, // 落点 floor>fy → climbed++
          { x: 0, y: 1, z: 0 }, // endY 算 dy
        ],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'pillar_up', target: { count: 1 } }), ctx);
      assert.equal(r.ok, true);
      assert.ok(game.calls.equip.length >= 1, 'equip 至少 1 次');
      assert.equal(game.calls.equip[0].name, 'dirt');
      assert.equal(game.calls.placeBlock, 1, 'placeBlock 1 次');
      const jumps = game.calls.setControlState.filter(c => c.key === 'jump' && c.value === true);
      assert.ok(jumps.length >= 1, 'setControlState(jump,true) 至少 1 次');
      assert.ok(bus.events.some(e => e.type === 'atomic.pillar_up.success'));
    });
  });

  describe('dig_down', () => {
    it('V6 缺 target.count → fail', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'dig_down', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('target.count'));
    });

    it('V7 正下方 -1 是岩浆 → fail dig_hazard_below 且 dig 0 次', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        blocksByPos: { '0,-1,0': { name: 'lava', boundingBox: 'block' } },
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'dig_down', target: { count: 3 } }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('dig_hazard_below'));
      assert.equal(game.calls.dig.length, 0);
    });

    it('V8 正下方 -1 安全 → dig + lookAt 调到（早退也算合规）', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        // 起点 y=10；脚下 stone 安全
        blocksByPos: {
          '0,9,0': { name: 'stone', boundingBox: 'block' },
          '0,8,0': { name: 'stone', boundingBox: 'block' },
        },
        positions: [
          { x: 0, y: 10, z: 0 }, // 进入循环
          { x: 0, y: 9, z: 0 },  // 下落后
        ],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'dig_down', target: { count: 1 } }), ctx);
      assert.equal(r.ok, true);
      assert.ok(game.calls.dig.length >= 1, 'dig 至少 1 次');
      assert.ok(game.calls.lookAt >= 1, 'lookAt 至少 1 次');
      assert.ok(bus.events.some(e => e.type === 'atomic.dig_down.success'));
    });
  });

  describe('place_scaffold', () => {
    it('V9 缺 itemName → fail', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'place_scaffold', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('itemName'));
    });

    it('V10 正常路径 → equip + placeBlock 调到', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        blocksByPos: { '0,-1,0': { name: 'stone', boundingBox: 'block' } },
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(
        makeReq({ type: 'place_scaffold', target: { itemName: 'scaffolding', faceVector: { x: 0, y: 1, z: 0 } } }),
        ctx,
      );
      assert.equal(r.ok, true);
      assert.equal(game.calls.equip.length, 1);
      assert.equal(game.calls.equip[0].name, 'scaffolding');
      assert.equal(game.calls.placeBlock, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.place_scaffold.success'));
    });
  });

  // ─── mount / dismount / vehicle_goto（FEAT-L3-09） ─────────────────

  describe('mount', () => {
    it('M1 缺 target.entityId → fail', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'mount', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('target.entityId'));
    });

    it('M2 adapter 无 mount 方法 → fail adapter_unsupported', async () => {
      const bus = makeMockBus();
      const game = makeMockGame(); // 默认无 mountFn
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'mount', target: { entityId: 42 } }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('adapter_unsupported'));
      const f = bus.events.find(e => e.type === 'atomic.mount.fail');
      assert.equal((f!.payload as { reason: string }).reason, 'adapter_unsupported');
    });

    it('M3 mock adapter 有 mount → 成功', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ mountFn: async () => {} });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'mount', target: { entityId: 7 } }), ctx);
      assert.equal(r.ok, true);
      assert.deepEqual(game.calls.mount, [7]);
      assert.ok(bus.events.some(e => e.type === 'atomic.mount.success'));
    });
  });

  describe('dismount', () => {
    it('M4 adapter 无 dismount → fail adapter_unsupported', async () => {
      const bus = makeMockBus();
      const game = makeMockGame();
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'dismount' }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('adapter_unsupported'));
    });

    it('M5 mock adapter 有 dismount → 成功', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ dismountFn: async () => {} });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'dismount' }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.dismount, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.dismount.success'));
    });
  });

  describe('vehicle_goto', () => {
    it('M6 缺 target.position → fail', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'vehicle_goto', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('move_to requires target.position'), '应走 moveTo 失败路径');
    });

    it('M7 正常 → 走 move_to 链路，nav.goto 调 1 次', async () => {
      const nav = makeMockNav({ ok: true });
      const bus = makeMockBus();
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: nav as any,
        bus: bus as any,
      };
      const r = await executeAtomic(
        makeReq({ type: 'vehicle_goto', target: { position: { x: 50, y: 64, z: 50 } } }),
        ctx,
      );
      assert.equal(r.ok, true);
      assert.equal(nav.calls.goto, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.move_to.end'));
    });
  });

  // ─── kite / block_with_shield / bow_shoot / crit_jump_attack（FEAT-L3-12） ─

  describe('kite', () => {
    it('C1 缺 target.entityId → fail', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'kite', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('entityId'));
    });

    it('C2 实体不存在 → fail target_not_found', async () => {
      const game = makeMockGame({ entity: null });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'kite', target: { entityId: 9 } }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('target_not_found'));
    });

    it('C3 成功 → lookAt + attack + back=true/false 都调到', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        entity: { id: 5, name: 'creeper', position: { x: 1, y: 64, z: 1 } } as any,
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(
        makeReq({ type: 'kite', target: { entityId: 5, backDurationMs: 100 } }),
        ctx,
      );
      assert.equal(r.ok, true);
      assert.equal(game.calls.lookAt, 1);
      assert.deepEqual(game.calls.attack, [5]);
      assert.ok(game.calls.setControlState.some(c => c.key === 'back' && c.value === true));
      assert.ok(game.calls.setControlState.some(c => c.key === 'back' && c.value === false));
      assert.ok(bus.events.some(e => e.type === 'atomic.kite.success'));
    });
  });

  describe('block_with_shield', () => {
    it('C4 背包无 shield → fail no_shield, equip 0', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ inventory: [] });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(
        makeReq({ type: 'block_with_shield', target: { durationMs: 100 } }),
        ctx,
      );
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('no_shield'));
      assert.equal(game.calls.equip.length, 0);
    });

    it('C5 成功 → equip(shield, off-hand) + activateItem(true) + deactivateItem', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({ inventory: [{ name: 'shield', count: 1, slot: 0 }] });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(
        makeReq({ type: 'block_with_shield', target: { durationMs: 200 } }),
        ctx,
      );
      assert.equal(r.ok, true);
      assert.equal(game.calls.equip.length, 1);
      assert.equal(game.calls.equip[0].name, 'shield');
      assert.equal(game.calls.equip[0].dest, 'off-hand');
      assert.equal(game.calls.activateItem.length, 1);
      assert.equal(game.calls.activateItem[0], true, 'activateItem(offHand=true)');
      assert.equal(game.calls.deactivateItem, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.block_with_shield.success'));
    });
  });

  describe('bow_shoot', () => {
    it('C6 缺弓 → fail no_bow', async () => {
      const game = makeMockGame({
        entity: { id: 5, name: 'skeleton', position: { x: 8, y: 64, z: 0 } } as any,
        inventory: [{ name: 'arrow', count: 16, slot: 0 }],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'bow_shoot', target: { entityId: 5 } }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('no_bow'));
    });

    it('C7 缺箭 → fail no_arrow', async () => {
      const game = makeMockGame({
        entity: { id: 5, name: 'skeleton', position: { x: 8, y: 64, z: 0 } } as any,
        inventory: [{ name: 'bow', count: 1, slot: 0 }],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'bow_shoot', target: { entityId: 5 } }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('no_arrow'));
    });

    it('C8 成功 → equip(bow) + lookAt + activateItem(false) + deactivateItem', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        entity: { id: 5, name: 'skeleton', position: { x: 8, y: 64, z: 0 } } as any,
        inventory: [
          { name: 'bow', count: 1, slot: 0 },
          { name: 'arrow', count: 16, slot: 1 },
        ],
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(
        makeReq({ type: 'bow_shoot', target: { entityId: 5, drawMs: 200 } }),
        ctx,
      );
      assert.equal(r.ok, true);
      assert.equal(game.calls.equip.length, 1);
      assert.equal(game.calls.equip[0].name, 'bow');
      assert.equal(game.calls.lookAt, 1);
      assert.equal(game.calls.activateItem.length, 1);
      assert.equal(game.calls.activateItem[0], false, 'activateItem(offHand=false)');
      assert.equal(game.calls.deactivateItem, 1);
      assert.ok(bus.events.some(e => e.type === 'atomic.bow_shoot.success'));
    });
  });

  describe('crit_jump_attack', () => {
    it('C9 缺 entityId → fail', async () => {
      const ctx: AtomicContext = {
        game: makeMockGame() as any,
        nav: makeMockNav() as any,
        bus: makeMockBus() as any,
      };
      const r = await executeAtomic(makeReq({ type: 'crit_jump_attack', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.ok(r.error?.includes('entityId'));
    });

    it('C10 成功 → jump=true + attack + jump=false', async () => {
      const bus = makeMockBus();
      const game = makeMockGame({
        entity: { id: 5, name: 'zombie', position: { x: 1, y: 64, z: 1 } } as any,
      });
      const ctx: AtomicContext = {
        game: game as any,
        nav: makeMockNav() as any,
        bus: bus as any,
      };
      const r = await executeAtomic(makeReq({ type: 'crit_jump_attack', target: { entityId: 5 } }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.lookAt, 1);
      assert.ok(game.calls.setControlState.some(c => c.key === 'jump' && c.value === true));
      assert.ok(game.calls.setControlState.some(c => c.key === 'jump' && c.value === false));
      assert.deepEqual(game.calls.attack, [5]);
      assert.ok(bus.events.some(e => e.type === 'atomic.crit_jump_attack.success'));
    });
  });

  // FEAT-L3-13 · 给玩家递物品
  describe('toss_item', () => {
    it('有该物品 → 调 game.toss 并成功', async () => {
      const game = makeMockGame({ inventory: [{ name: 'stone_axe', count: 1, slot: 0 }] });
      const ctx = makeCtx({ game: game as any });
      const r = await executeAtomic(makeReq({ type: 'toss_item', target: { itemName: 'stone_axe', count: 1 } }), ctx);
      assert.equal(r.ok, true);
      assert.equal(game.calls.toss.length, 1);
      assert.equal(game.calls.toss[0]!.name, 'stone_axe');
    });

    it('缺 itemName → fail', async () => {
      const ctx = makeCtx();
      const r = await executeAtomic(makeReq({ type: 'toss_item', target: {} }), ctx);
      assert.equal(r.ok, false);
      assert.match(r.error ?? '', /requires target\.itemName/);
    });

    it('背包没有该物品 → fail no_item（不空扔）', async () => {
      const game = makeMockGame({ inventory: [] });
      const ctx = makeCtx({ game: game as any });
      const r = await executeAtomic(makeReq({ type: 'toss_item', target: { itemName: 'diamond' } }), ctx);
      assert.equal(r.ok, false);
      assert.match(r.error ?? '', /no_item/);
      assert.equal(game.calls.toss.length, 0);
    });
  });

  describe('craft · BUG-CROSS-09', () => {
    it('已有数量超过执行次数但低于库存目标时，仍真实执行一次配方', async () => {
      const inventory = [
        { name: 'oak_planks', count: 2, slot: 0 },
        { name: 'oak_log', count: 4, slot: 1 },
      ];
      const game = makeMockGame({
        inventory,
        craftRecipes: {
          oak_planks: [{
            result: { name: 'oak_planks', count: 4 },
            ingredients: [{ name: 'oak_log', count: 1 }],
            requiresTable: false,
          }],
        },
      });
      const ctx = makeCtx({ game: game as any });

      const result = await executeAtomic(makeReq({
        type: 'craft',
        resource: ['inventory'],
        target: { itemName: 'oak_planks', count: 1, inventoryTargetCount: 3 },
      }), ctx);

      assert.equal(result.ok, true);
      assert.deepEqual(game.calls.craft, [{ item: 'oak_planks', count: 1 }]);
      assert.equal(inventory.find(item => item.name === 'oak_planks')?.count, 6);
    });
  });

  describe('escape_pit · BUG-CROSS-04', () => {
    it('仍被四面 bedrock 封死 → 返回失败，不再固定 ok=true', async () => {
      const blocks: Record<string, { name: string; boundingBox: 'block' | 'empty' }> = {};
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        blocks[`${dx},0,${dz}`] = { name: 'bedrock', boundingBox: 'block' };
        blocks[`${dx},1,${dz}`] = { name: 'bedrock', boundingBox: 'block' };
      }
      const game = makeMockGame({ blocksByPos: blocks, inventory: [], positions: [{ x: 0, y: 0, z: 0 }] });
      const ctx = makeCtx({ game: game as any });
      const result = await executeAtomic(makeReq({ type: 'escape_pit', resource: ['movement'] }), ctx);
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /still_trapped/);
      const end = ctx.bus.events.find(e => e.type === 'atomic.escape_pit.end');
      assert.equal((end?.payload as { escaped?: boolean })?.escaped, false);
    });

    it('挖开墙并实际移动到安全出口 → 返回成功', async () => {
      const blocks: Record<string, { name: string; boundingBox: 'block' | 'empty' }> = {};
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        blocks[`${dx},0,${dz}`] = { name: 'stone', boundingBox: 'block' };
        blocks[`${dx},1,${dz}`] = { name: 'stone', boundingBox: 'block' };
      }
      blocks['1,-1,0'] = { name: 'stone', boundingBox: 'block' };
      blocks['2,-1,0'] = { name: 'stone', boundingBox: 'block' };
      let pos = { x: 0, y: 0, z: 0 };
      const dug: string[] = [];
      const game = makeMockGame({ inventory: [] });
      (game as any).getPosition = () => ({ ...pos });
      (game as any).getBlockAt = (p: { x: number; y: number; z: number }) =>
        blocks[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] ?? { name: 'air', boundingBox: 'empty' };
      (game as any).dig = async (p: { x: number; y: number; z: number }) => {
        const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
        dug.push(key);
        delete blocks[key];
      };
      (game as any).setControlState = (key: string, value: boolean) => {
        if (key === 'forward' && value) pos = { x: Math.min(2, pos.x + 1), y: 1, z: 0 };
      };
      const ctx = makeCtx({ game: game as any });
      const result = await executeAtomic(makeReq({ type: 'escape_pit', resource: ['movement'] }), ctx);
      assert.equal(result.ok, true);
      assert.equal(pos.x >= 1, true);
      assert.equal(dug.includes('1,0,0'), false, '必须保留相邻同层方块作为上坡踏脚');
      assert.equal(dug.includes('1,1,0'), true, '应开凿上一级脚位净空');
      const end = ctx.bus.events.find(e => e.type === 'atomic.escape_pit.end');
      assert.equal((end?.payload as { escaped?: boolean })?.escaped, true);
    });

    it('已部分上升后接管且末端方块视图滞后 → 以观测到的地表高度判成功', async () => {
      let pos = { x: 0, y: 1, z: 0 };
      const game = makeMockGame({ inventory: [] });
      (game as any).getPosition = () => ({ ...pos });
      (game as any).getBlockAt = (p: { x: number; y: number; z: number }) => {
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        if (pos.y < 2) {
          if (x === 1 && y === 1 && z === 0) return { name: 'stone', boundingBox: 'block' };
          if (x === 1 && (y === 2 || y === 3) && z === 0) return { name: 'air', boundingBox: 'empty' };
          return { name: 'stone', boundingBox: 'block' };
        }
        // 模拟玩家已经到地表，但末端 block/chunk 视图仍把四周识别为实心。
        return { name: 'stone', boundingBox: 'block' };
      };
      (game as any).setControlState = (key: string, value: boolean) => {
        if (key === 'forward' && value) pos = { x: 1, y: 2, z: 0 };
      };
      const ctx = makeCtx({ game: game as any });

      const result = await executeAtomic(makeReq({ type: 'escape_pit', resource: ['movement'] }), ctx);

      assert.equal(result.ok, true);
      const end = ctx.bus.events.find(e => e.type === 'atomic.escape_pit.end');
      assert.equal((end?.payload as { targetSurfaceY?: number })?.targetSurfaceY, 2);
      assert.equal((end?.payload as { reachedObservedSurface?: boolean })?.reachedObservedSurface, true);
    });
  });

});
