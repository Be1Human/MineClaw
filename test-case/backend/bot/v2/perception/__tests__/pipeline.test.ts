/**
 * PerceptionPipeline 单元测试 · US-G6
 *
 * 6 个用例覆盖：
 *   ① perceive() 返回含正确 self 字段的 WorldStateView
 *   ② 血量下降 → emit under_attack 事件（prevHealth > currHealth > 0）
 *   ③ owner 发 chat → emit chat.from_owner 事件
 *   ④ 锄耐久从 >0 降至 0 → emit tool_broken 事件
 *   ⑤ 耐久无变化 → 不 emit tool_broken
 *   ⑥ perceive() 返回的 entities 按 distance 升序排列
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PerceptionPipeline } from '../../../../../../apps/minecraft-companion/src/bot/v2/perception/pipeline.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { RawEntity, RawItem, Unsubscribe } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';

// ──────────────────────────────────────────────────────────────────
// Mock GameAdapter factory
// ──────────────────────────────────────────────────────────────────

interface MockGameOverrides {
  health?: number;
  entities?: RawEntity[];
  inventoryItems?: RawItem[];
  heldItem?: RawItem | null;
  freeSlots?: number;
}

/** 最简 mock · 内部维护一个 chatHandlers 列表供测试触发 */
function makeMockGame(
  overrides: MockGameOverrides = {},
  chatHandlers: Array<(sender: string, message: string) => void> = [],
): GameAdapter {
  const {
    health = 20,
    entities = [],
    inventoryItems = [],
    heldItem = null,
    freeSlots = 36,
  } = overrides;

  return {
    username: 'TestBot',

    // self state
    getPosition: () => ({ x: 0, y: 64, z: 0 }),
    getOrientation: () => ({ yaw: 0, pitch: 0 }),
    getVelocity: () => ({ x: 0, y: 0, z: 0 }),
    isOnGround: () => true,
    getHealth: () => health,
    getFood: () => 20,
    getSaturation: () => 5,
    getExperienceLevel: () => 0,
    getSelectedSlot: () => 0,
    getGameMode: () => 'survival',

    // world
    getDimension: () => 'overworld',
    getTimeOfDay: () => 6000,
    isRaining: () => false,
    isThundering: () => false,

    getBlockAt: () => null,
    getBlockProperties: () => null,
    findBlocks: () => [],
    getEntities: () => entities,
    getEntityById: () => null,
    getPlayers: () => ({}),
    getPlayer: () => null,

    // inventory
    getInventoryItems: () => inventoryItems,
    getHeldItem: () => heldItem,
    getFreeSlotCount: () => freeSlots,
    getArmorItems: () => ({ head: null, torso: null, legs: null, feet: null }),
    getOffhandItem: () => null,
    getEffects: () => [],
    getOxygen: () => 20,

    // low-level control (stubs)
    setControlState: () => {},
    clearControlStates: () => {},
    lookAt: async () => {},
    look: async () => {},
    chat: () => {},
    attack: () => {},
    dig: async () => {},
    equip: async () => {},
    toss: async () => 0,
    activateItem: () => {},
    deactivateItem: () => {},
    interactBlock: async () => {},
    placeBlock: async () => {},

    // event subscriptions
    onChat: (handler) => {
      chatHandlers.push(handler);
      return () => {
        const idx = chatHandlers.indexOf(handler);
        if (idx !== -1) chatHandlers.splice(idx, 1);
      };
    },
    onWhisper: () => (() => {}) as Unsubscribe,
    onHealthChange: () => (() => {}) as Unsubscribe,
    onDeath: () => (() => {}) as Unsubscribe,
    onSpawn: () => (() => {}) as Unsubscribe,
    craft: async () => ({ ok: false, reason: 'test' }),
    smelt: async () => ({ ok: false, produced: 0, reason: 'test' }),
    getCraftRecipes: () => [],
    getItemSource: () => null,
    consume: async () => true,
    findBestFood: () => null,
    sleep: async () => {},
    wake: async () => {},
    findNearbyBed: () => null,
    depositToChest: async () => ({ ok: false, moved: 0, reason: 'test' }),
    withdrawFromChest: async () => ({ ok: false, moved: 0, reason: 'test' }),
  } satisfies GameAdapter;
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

const OWNER = 'TestOwner';

describe('PerceptionPipeline', () => {
  // ① perceive() 返回含正确 self 字段的 WorldStateView
  it('① perceive() 返回含正确 self 的 WorldStateView', () => {
    const bus = new EventBusV2();
    const game = makeMockGame({ health: 18 });
    const pipeline = new PerceptionPipeline(game, bus, { ownerName: OWNER });

    const view = pipeline.perceive();

    assert.equal(view.tick, 1);
    assert.equal(view.self.health, 18);
    assert.equal(view.self.maxHealth, 20);
    assert.equal(view.self.food, 20);
    assert.equal(view.self.isOnGround, true);
    assert.deepEqual(view.self.position, { x: 0, y: 64, z: 0 });
    assert.equal(view.self.yaw, 0);
    assert.equal(view.self.pitch, 0);
    assert.equal(view.environment.dimension, 'overworld');
    assert.equal(view.environment.timeOfDay, 6000);
    assert.equal(view.environment.isRaining, false);
  });

  // ② 血量下降 → emit under_attack 事件（prevHealth > currHealth > 0）
  it('② 血量下降 → emit under_attack 事件', () => {
    const bus = new EventBusV2();
    // 第一 tick health=20（初始），第二 tick health=17（被攻击 3 点，delta<6，非 critical）
    let callCount = 0;
    const mockGame: GameAdapter = {
      ...makeMockGame(),
      getHealth: () => (callCount++ === 0 ? 20 : 17),
    };
    const pipeline = new PerceptionPipeline(mockGame, bus, { ownerName: OWNER });

    pipeline.perceive(); // tick 1 — 建立基准 health=20
    bus.drain();         // 清空

    pipeline.perceive(); // tick 2 — health=17，触发检测

    const events = bus.drain();
    const attackEvents = events.filter(e => e.type === 'under_attack');
    assert.equal(attackEvents.length, 1);
    // delta=3, health=17 > 6 → level='recoverable'
    assert.equal(attackEvents[0].level, 'recoverable');
    const payload = attackEvents[0].payload as { prevHealth: number; currHealth: number; damage: number };
    assert.equal(payload.prevHealth, 20);
    assert.equal(payload.currHealth, 17);
    assert.equal(payload.damage, 3);
  });

  // ③ owner 发 chat → emit chat.from_owner 事件
  it('③ owner 发 chat → emit chat.from_owner 事件', () => {
    const bus = new EventBusV2();
    const chatHandlers: Array<(sender: string, message: string) => void> = [];
    const game = makeMockGame({}, chatHandlers);
    const pipeline = new PerceptionPipeline(game, bus, { ownerName: OWNER });

    // 在 perceive 之前触发 chat（会被 pendingChats 收集）
    chatHandlers.forEach(h => h(OWNER, 'hello bot'));

    pipeline.perceive();

    const events = bus.drain();
    const chatEvents = events.filter(e => e.type === 'chat.from_owner');
    assert.equal(chatEvents.length, 1);
    assert.equal(chatEvents[0].level, 'suggestion');
    const payload = chatEvents[0].payload as { sender: string; message: string };
    assert.equal(payload.sender, OWNER);
    assert.equal(payload.message, 'hello bot');
  });

  // ④ 锄耐久从 >0 降至 0 → emit tool_broken 事件
  it('④ 锄耐久 >0 → 0 → emit tool_broken', () => {
    const bus = new EventBusV2();
    let tick = 0;
    const hoeWith1: RawItem = { name: 'wooden_hoe', count: 1, slot: 0, durability: 1, maxDurability: 59 };
    const hoeWith0: RawItem = { name: 'wooden_hoe', count: 1, slot: 0, durability: 0, maxDurability: 59 };

    const mockGame: GameAdapter = {
      ...makeMockGame(),
      getHeldItem: () => {
        tick++;
        return tick <= 1 ? hoeWith1 : hoeWith0;
      },
    };

    const pipeline = new PerceptionPipeline(mockGame, bus, { ownerName: OWNER });

    pipeline.perceive(); // tick 1 — 建立基准 durability=1
    bus.drain();

    pipeline.perceive(); // tick 2 — durability=0，触发 tool_broken

    const events = bus.drain();
    const brokenEvents = events.filter(e => e.type === 'tool_broken');
    assert.equal(brokenEvents.length, 1);
    assert.equal(brokenEvents[0].level, 'recoverable');
    const payload = brokenEvents[0].payload as { name: string | null };
    assert.equal(payload.name, 'wooden_hoe');
  });

  // ⑤ 耐久无变化 → 不 emit tool_broken
  it('⑤ 耐久无变化 → 不 emit tool_broken', () => {
    const bus = new EventBusV2();
    const hoe: RawItem = { name: 'wooden_hoe', count: 1, slot: 0, durability: 10, maxDurability: 59 };

    const game = makeMockGame({ heldItem: hoe });
    const pipeline = new PerceptionPipeline(game, bus, { ownerName: OWNER });

    pipeline.perceive(); // tick 1
    bus.drain();
    pipeline.perceive(); // tick 2 — 耐久不变

    const events = bus.drain();
    const brokenEvents = events.filter(e => e.type === 'tool_broken');
    assert.equal(brokenEvents.length, 0);
  });

  // ⑥ perceive() 返回的 entities 按优先级排序（hostile > passive），同优先级内按距离
  it('⑥ entities 按优先级+距离排序（hostile 优先于 passive）', () => {
    const bus = new EventBusV2();
    // self 位置 (0,64,0) — 距离是简单欧几里得
    const entities: RawEntity[] = [
      { id: 1, name: 'zombie', type: 'mob', position: { x: 10, y: 64, z: 0 } },  // dist=10, hostile
      { id: 2, name: 'cow',    type: 'mob', position: { x: 3,  y: 64, z: 0 } },  // dist=3,  passive
      { id: 3, name: 'pig',    type: 'mob', position: { x: 7,  y: 64, z: 0 } },  // dist=7,  passive
    ];

    const game = makeMockGame({ entities });
    const pipeline = new PerceptionPipeline(game, bus, { ownerName: OWNER });

    const view = pipeline.perceive();

    assert.equal(view.entities.length, 3);
    // hostile（zombie）排在最前面（优先级高于 passive）
    assert.equal(view.entities[0].name, 'zombie');
    assert.equal(view.entities[0].category, 'hostile');
    // passive 内按距离升序：cow(3) < pig(7)
    assert.equal(view.entities[1].name, 'cow');
    assert.equal(view.entities[2].name, 'pig');
  });

  it('BUG-CROSS-69 · 地面物品身份进入 WorldStateView', () => {
    const game = makeMockGame({
      entities: [{
        id: 41,
        name: 'item',
        type: 'object',
        position: { x: 5, y: 64, z: 0 },
        droppedItem: { name: 'iron_pickaxe', count: 1 },
      }],
    });
    const view = new PerceptionPipeline(game, new EventBusV2(), { ownerName: OWNER }).perceive();

    assert.equal(view.entities[0].category, 'item');
    assert.deepEqual(view.entities[0].droppedItem, { name: 'iron_pickaxe', count: 1 });
    assert.equal(view.entities[0].distance, 5);
  });

  it('WEBUI-001 · 服务器玩家皮肤进入 WorldStateView', () => {
    const game = makeMockGame({
      entities: [{
        id: 52,
        name: 'player',
        username: 'cloudboyboy',
        type: 'player',
        position: { x: 2, y: 64, z: 3 },
        yaw: 0.75,
        skinUrl: 'https://textures.minecraft.net/texture/server-player',
        skinModel: 'slim',
      }],
    });
    const view = new PerceptionPipeline(game, new EventBusV2(), { ownerName: OWNER }).perceive();

    assert.equal(view.entities[0].name, 'cloudboyboy');
    assert.equal(view.entities[0].category, 'player');
    assert.equal(view.entities[0].skinUrl, 'https://textures.minecraft.net/texture/server-player');
    assert.equal(view.entities[0].skinModel, 'slim');
    assert.equal(view.entities[0].yaw, 0.75);
  });
});

// ──────────────────────────────────────────────────────────────────
// 额外用例 · US-DOC-PERC（4+ additional cases to reach ≥10 total）
// ──────────────────────────────────────────────────────────────────

describe('PerceptionPipeline · additional cases', () => {
  // TC-PERC-03 · health 相同两帧 → 不 emit under_attack
  it('health same frame → no under_attack', () => {
    const bus = new EventBusV2();
    const game = makeMockGame({ health: 15 });
    const pipeline = new PerceptionPipeline(game, bus, { ownerName: OWNER });

    pipeline.perceive(); // tick 1 — 基准 health=15
    bus.drain();         // 清空

    pipeline.perceive(); // tick 2 — health 仍然是 15，不变

    const events = bus.drain();
    const attackEvents = events.filter(e => e.type === 'under_attack');
    assert.equal(attackEvents.length, 0, 'health unchanged → must not emit under_attack');
  });

  // TC-PERC-10 · 非 owner chat → 不 emit chat.from_owner（改为 chat.from_other）
  it('non-owner chat → no chat.from_owner', () => {
    const bus = new EventBusV2();
    const chatHandlers: Array<(sender: string, message: string) => void> = [];
    const game = makeMockGame({}, chatHandlers);
    const pipeline = new PerceptionPipeline(game, bus, { ownerName: OWNER });

    // 触发陌生人的 chat（sender !== OWNER）
    chatHandlers.forEach(h => h('StrangerPlayer', 'hello everyone'));

    pipeline.perceive();

    const events = bus.drain();
    const ownerChatEvents = events.filter(e => e.type === 'chat.from_owner');
    assert.equal(ownerChatEvents.length, 0, 'non-owner chat must not emit chat.from_owner');

    // 改为 emit chat.from_other
    const otherChatEvents = events.filter(e => e.type === 'chat.from_other');
    assert.equal(otherChatEvents.length, 1);
    const payload = otherChatEvents[0].payload as { sender: string; message: string };
    assert.equal(payload.sender, 'StrangerPlayer');
  });

  // TC-PERC-09 · 多次 perceive() → getWorldState() 返回最新
  it('multiple perceive() → getWorldState returns latest', () => {
    const bus = new EventBusV2();
    let tick = 0;
    const mockGame: GameAdapter = {
      ...makeMockGame(),
      getHealth: () => {
        tick++;
        return tick <= 1 ? 20 : 12;
      },
    };
    const pipeline = new PerceptionPipeline(mockGame, bus, { ownerName: OWNER });

    pipeline.perceive(); // tick 1 — health=20
    pipeline.perceive(); // tick 2 — health=12

    const latest = pipeline.getWorldState();
    assert.ok(latest !== null, 'getWorldState() must not be null after perceive()');
    assert.equal(latest.self.health, 12, 'getWorldState() must return latest snapshot');
    assert.equal(latest.tick, 2, 'tick counter must be 2 after two perceive() calls');
  });

  // TC-PERC-08 · owner 不在实体列表且 getPlayer 返回 null → worldState.owner === null
  it('owner not in entities → worldState.owner null', () => {
    const bus = new EventBusV2();
    // entities 列表里没有 ownerName 对应的 player，getPlayer 也返回 null（默认 mock 行为）
    const game = makeMockGame({ entities: [] });
    const pipeline = new PerceptionPipeline(game, bus, { ownerName: OWNER });

    const view = pipeline.perceive();

    assert.equal(view.owner, null, 'owner must be null when owner not visible and getPlayer returns null');
  });
});
