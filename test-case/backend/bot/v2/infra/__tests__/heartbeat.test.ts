/**
 * Heartbeat 单元测试 · US-G4 + US-DOC-HB
 *
 * US-G4（4 个用例）：
 *   ① 10 步按顺序执行（perceive → drain → watchdog → reflex → sched → commit）
 *   ② submitRequest() 注入 externalRequests → 下一 tick 进入仲裁后输出为 winner
 *   ③ submitSay() 创建 say ActionRequest 经过 Arbitrator
 *   ④ 多 active 策略在同一 tick 都被 tick
 *
 * US-DOC-HB（6 个新用例）：
 *   TC-HB-05 SLOW tick (tick=10) 触发 critic.verifyAll
 *   TC-HB-06 Critic success → tasks.complete 被调用
 *   TC-HB-09 TickRegistry FAST handler 每 tick 都调用
 *   TC-HB-10 TickRegistry STD handler 每 5 tick 触发（tick=4 不调, tick=5 调）
 *   TC-HB-11 TickRegistry SLOW handler 在 tick=10 调用
 *   TC-HB-12 executing=true → non-light 动作设置 executing 锁
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Heartbeat } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/heartbeat.js';
import type { HeartbeatDeps, HeartbeatConfig } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/heartbeat.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { ActionRequest } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { StrategyContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/strategy/types.js';
import { TickRate, TickRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tickRegistry.js';
import type { TickContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tickRegistry.js';
import type { ICriticRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/critic/types.js';
import type { Task } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';

// ──────────────────────────────────────────────────────────────────
// 辅助：构造最小化 WorldStateView
// ──────────────────────────────────────────────────────────────────

function makeWorld(tick = 1): WorldStateView {
  return {
    tick,
    timestamp: Date.now(),
    self: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      maxHealth: 20,
      food: 20,
      isOnGround: true,
    },
    owner: null,
    inventory: { items: [], held: null, freeSlots: 36 },
    environment: {
      dimension: 'overworld',
      timeOfDay: 6000,
      isDay: true,
      isRaining: false,
    },
    entities: [],
    taskContext: null,
  };
}

// ──────────────────────────────────────────────────────────────────
// 辅助：构造 ActionRequest
// ──────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────
// 辅助：构造一套 mock deps，支持 callOrder 追踪
// ──────────────────────────────────────────────────────────────────

/** Optional per-test publish spy; set before making deps. */
type PublishSpy = (type: string, level: string, payload?: unknown) => void;

function makeDeps(
  callOrder: string[],
  overrides: Partial<HeartbeatDeps> = {},
  publishSpy?: PublishSpy,
): HeartbeatDeps {
  const mockPerception = {
    perceive: (): WorldStateView => {
      callOrder.push('perceive');
      return makeWorld();
    },
  };

  // chat log: captured by spy when 'atomic.say' is published
  const mockGame = {
    chat: (_text: string): void => {},
    clearControlStates: (): void => {},
  };

  const mockBus = {
    drain: (): unknown[] => {
      callOrder.push('drain');
      return [];
    },
    publish: (type: string, level: string, payload?: unknown): void => {
      if (publishSpy) publishSpy(type, level, payload);
    },
    on: (_type: string, _handler: unknown) => () => {},
  };

  const mockTasks = {
    active: () => null,
    isRunning: (_taskId: string) => true,
    sched: (_tick: number, _world: WorldStateView): void => {
      callOrder.push('sched');
    },
  };

  const mockSupervisor = {
    watchdog: (_tick: number): void => {
      callOrder.push('watchdog');
    },
  };

  const mockReflex = {
    ingestCritical: (_events: unknown[]): void => {},
    tick: (_ctx: StrategyContext): ActionRequest[] => {
      callOrder.push('reflex');
      return [];
    },
    isActive: (_ctx: StrategyContext): boolean => false,
  };

  const mockMemory = {
    commitTick: (): number => {
      callOrder.push('commit');
      return 0;
    },
    setRuntime: (_key: string, _val: unknown): void => {},
  };

  const mockAtomic = {
    nav: { stop: () => {} },
    game: mockGame as never,
    bus: mockBus as never,
  };

  return {
    bus: mockBus as never,
    memory: mockMemory as never,
    perception: mockPerception as never,
    tasks: mockTasks as never,
    supervisor: mockSupervisor as never,
    reflex: mockReflex as never,
    taskStrategies: [],
    body:bodyStub() as never,isEmbodied:()=>true,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────
// 配置：blockingExecute=true · 最简模式
// ──────────────────────────────────────────────────────────────────

const cfg: HeartbeatConfig = { tickMs: 200, blockingExecute: true };

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('Heartbeat 10 步 tick 顺序', () => {

  it('FEAT-CROSS-15 · 自动防御关闭沿清理并可热切回开启', async () => {
    const calls: string[] = [];
    const modes: Array<{ enabled: boolean; previous: boolean | null }> = [];
    let enabled = false;
    const normal = {
      id: 'normal', kind: 'rule' as const,
      isActive: () => true,
      tick: () => { calls.push('normal'); return []; },
      inspect: () => ({ kind: 'rule' as const, view: {} }),
    };
    const automatic = {
      id: 'automatic', kind: 'reflex' as const,
      isActive: () => true,
      tick: () => { calls.push('automatic'); return []; },
      suspend: () => { calls.push('automatic.suspend'); },
      inspect: () => ({ kind: 'reflex' as const, view: {} }),
    };
    const deps = makeDeps([], {
      isAutomaticDefenseEnabled: () => enabled,
      autoDefenseStrategies: [automatic],
      taskStrategies: [normal],
      reflex: {
        ingestCritical: () => calls.push('reflex.ingest'),
        tick: () => { calls.push('reflex'); return []; },
        suspend: () => calls.push('reflex.suspend'),
        isActive: () => false,
      } as never,
    }, (type, _level, payload: any) => {
      if (type === 'defense.mode_changed') modes.push({ enabled: payload.enabled, previous: payload.previous });
    });
    const hb = new Heartbeat(cfg, deps);

    await (hb as any).runTick();
    assert.deepEqual(calls, ['reflex.suspend', 'automatic.suspend', 'normal']);
    assert.deepEqual(modes, [{ enabled: false, previous: null }]);

    calls.length = 0;
    await (hb as any).runTick();
    assert.deepEqual(calls, ['normal']);

    enabled = true;
    calls.length = 0;
    await (hb as any).runTick();
    assert.deepEqual(calls, ['reflex.ingest', 'reflex', 'automatic', 'normal']);
    assert.deepEqual(modes, [
      { enabled: false, previous: null },
      { enabled: true, previous: false },
    ]);
  });

  // ① 10 步按顺序执行：perceive → drain → watchdog → reflex → sched → commit
  it('① perceive / drain / watchdog / reflex / sched / commit 严格顺序', async () => {
    const callOrder: string[] = [];
    const deps = makeDeps(callOrder);
    const hb = new Heartbeat(cfg, deps);

    await (hb as any).runTick();

    // perceive 必须在 drain 之前
    assert.ok(
      callOrder.indexOf('perceive') < callOrder.indexOf('drain'),
      `perceive(${callOrder.indexOf('perceive')}) 应在 drain(${callOrder.indexOf('drain')}) 之前`,
    );
    // drain 必须在 watchdog 之前
    assert.ok(
      callOrder.indexOf('drain') < callOrder.indexOf('watchdog'),
      `drain(${callOrder.indexOf('drain')}) 应在 watchdog(${callOrder.indexOf('watchdog')}) 之前`,
    );
    // watchdog 必须在 reflex 之前
    assert.ok(
      callOrder.indexOf('watchdog') < callOrder.indexOf('reflex'),
      `watchdog(${callOrder.indexOf('watchdog')}) 应在 reflex(${callOrder.indexOf('reflex')}) 之前`,
    );
    // reflex 必须在 sched 之前
    assert.ok(
      callOrder.indexOf('reflex') < callOrder.indexOf('sched'),
      `reflex(${callOrder.indexOf('reflex')}) 应在 sched(${callOrder.indexOf('sched')}) 之前`,
    );
    // sched 必须在 commit 之前（commit 是最后一步 ⑩）
    assert.ok(
      callOrder.indexOf('sched') < callOrder.indexOf('commit'),
      `sched(${callOrder.indexOf('sched')}) 应在 commit(${callOrder.indexOf('commit')}) 之前`,
    );

    // 所有步骤都至少被调用了一次
    for (const step of ['perceive', 'drain', 'watchdog', 'reflex', 'sched', 'commit']) {
      assert.ok(callOrder.includes(step), `步骤 ${step} 未被调用`);
    }
  });

  // ② submitRequest() 注入 → 下一 tick 仲裁可见（在 arbitrate.result 中胜出）
  //
  // publishArbitration 把 winners 压缩为 {source,type,priority} · 不含 id/target。
  // exec.success 事件也只含 {source,type,durationMs} — 同样只靠 source 识别。
  it('② submitRequest() 注入 externalRequests → 下一 tick 仲裁胜出 (exec.success 验证)', async () => {
    const execSuccessLog: Array<{ source: string; type: string }> = [];

    const spy: PublishSpy = (type, _level, payload: any) => {
      if (type === 'exec.success') {
        execSuccessLog.push({ source: payload?.source, type: payload?.type });
      }
    };

    const callOrder: string[] = [];
    const deps = makeDeps(callOrder, {}, spy);
    const hb = new Heartbeat(cfg, deps);

    // 注入一个 say request（resource=[] 无前置条件 · 必然通过仲裁并被执行）
    hb.submitRequest(makeReq({
      id: 'injected-req',
      source: 'external.test',
      type: 'say',
      priority: 60,
      target: { text: 'hello from external' },
    }));

    // 运行 tick → 仲裁通过 → executeAtomic(say) → exec.success 发布
    await (hb as any).runTick();

    const found = execSuccessLog.find(e => e.source === 'external.test' && e.type === 'say');
    assert.ok(
      found !== undefined,
      `submitRequest 注入的 say 请求应在 exec.success 中出现，实际日志: ${JSON.stringify(execSuccessLog)}`,
    );
  });

  it('BUG-CROSS-04 · 无 running task 背书的 movement 在仲裁前被拒绝', async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const deps = makeDeps([], {
      tasks: {
        active: () => null,
        isRunning: () => false,
        sched: () => {},
      } as never,
    }, (type, _level, payload) => events.push({ type, payload }));
    const hb = new Heartbeat(cfg, deps);

    hb.submitRequest(makeReq({
      id: 'orphan-move',
      source: 'external.orphan',
      type: 'move_to',
      priority: 80,
      resource: ['movement'],
      target: { position: { x: 10, y: 64, z: 10 } },
    }));
    await (hb as any).runTick();

    const rejected = events.find(e => e.type === 'arbiter.orphan_request');
    assert.equal(rejected?.payload?.rejected, true);
    const arbitration = events.find(e => e.type === 'arbitrate.result');
    assert.deepEqual(arbitration?.payload?.winners ?? [], []);
    assert.equal(events.some(e => e.type === 'exec.success' || e.type === 'exec.fail'), false);
  });

  it('BUG-CROSS-04 · running task 背书的 movement 保持可执行', async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const deps = makeDeps([], {
      tasks: {
        active: () => null,
        isRunning: (id: string) => id === 'task-live',
        sched: () => {},
      } as never,
      body:bodyStub() as never,
    }, (type, _level, payload) => events.push({ type, payload }));
    const hb = new Heartbeat({ ...cfg, blockingExecute: true }, deps);

    hb.submitRequest(makeReq({
      id: 'owned-move',
      source: 'external.owned',
      taskId: 'task-live',
      type: 'move_to',
      priority: 80,
      resource: ['movement'],
      target: { position: { x: 1, y: 64, z: 0 } },
    }));
    await (hb as any).runTick();

    assert.equal(events.some(e => e.type === 'arbiter.orphan_request'), false);
    assert.equal(events.some(e => e.type === 'exec.success'), true);
  });

  it('③ submitSay() 只投递 brain.notice，不进入动作仲裁', async () => {
    const notices: string[] = [];
    const arbitrateWinners: Array<{ source: string; type: string; priority: number }> = [];

    const spy: PublishSpy = (type, _level, payload: any) => {
      if (type === 'brain.notice' && payload?.detail) {
        notices.push(payload.detail);
      }
      if (type === 'arbitrate.result' && Array.isArray(payload?.winners)) {
        arbitrateWinners.push(...payload.winners);
      }
    };

    const callOrder: string[] = [];
    const deps = makeDeps(callOrder, {}, spy);
    const hb = new Heartbeat(cfg, deps);

    hb.submitSay('test.source', '你好！', 55);

    await (hb as any).runTick();

    assert.equal(arbitrateWinners.some(w => w.source === 'test.source' && w.type === 'say'), false);
    assert.deepEqual(notices, ['你好！']);
  });

  // ④ 多 active 策略在同一 tick 都被 tick
  it('④ 多 active 策略全部在同一 tick 内被调用', async () => {
    const strategyCallLog: string[] = [];

    function makeActiveStrategy(id: string) {
      return {
        id,
        kind: 'rule' as const,
        isActive: (_ctx: StrategyContext): boolean => true,
        tick: (_ctx: StrategyContext): ActionRequest[] => {
          strategyCallLog.push(id);
          return [];
        },
        inspect: () => ({ kind: 'rule' as const, view: {} }),
      };
    }

    const strategy1 = makeActiveStrategy('strategy-alpha');
    const strategy2 = makeActiveStrategy('strategy-beta');
    const strategy3 = makeActiveStrategy('strategy-gamma');

    const callOrder: string[] = [];
    const deps = makeDeps(callOrder, {
      taskStrategies: [strategy1, strategy2, strategy3],
    });
    const hb = new Heartbeat(cfg, deps);

    await (hb as any).runTick();

    // 三个策略都应该在同一 tick 内被调用
    assert.ok(strategyCallLog.includes('strategy-alpha'), 'strategy-alpha 未被 tick');
    assert.ok(strategyCallLog.includes('strategy-beta'), 'strategy-beta 未被 tick');
    assert.ok(strategyCallLog.includes('strategy-gamma'), 'strategy-gamma 未被 tick');
    // 总共被调用了 3 次（每个策略各一次）
    assert.equal(strategyCallLog.length, 3, `期望 3 次策略调用，实际 ${strategyCallLog.length} 次`);
  });

  it('BUG-CROSS-25 · 陪聊态跳过身体循环，只执行 say 并拒绝身体请求', async () => {
    const calls: string[] = [];
    const events: Array<{ type: string; payload: any }> = [];
    const strategy = {
      id: 'body-only-strategy',
      kind: 'reflex' as const,
      isActive: () => true,
      tick: () => {
        calls.push('strategy');
        return [makeReq({ type: 'escape_pit', resource: ['movement'] })];
      },
      inspect: () => ({ kind: 'reflex' as const, view: {} }),
    };
    const deps = makeDeps(calls, {
      isEmbodied: () => false,
      taskStrategies: [strategy],
    }, (type, _level, payload) => events.push({ type, payload }));
    const hb = new Heartbeat(cfg, deps);

    hb.submitSay('companion.test', '陪聊仍可回复');
    hb.submitRequest(makeReq({
      id: 'queued-body-request',
      source: 'stale.body',
      type: 'escape_pit',
      resource: ['movement'],
      taskId: 'task-live',
    }));
    await (hb as any).runTick();

    assert.equal(calls.includes('watchdog'), false);
    assert.equal(calls.includes('reflex'), false);
    assert.equal(calls.includes('sched'), false);
    assert.equal(calls.includes('strategy'), false);
    assert.equal(events.some(e => e.type === 'brain.notice' && e.payload?.detail === '陪聊仍可回复'), true);
    assert.equal(events.some(e => e.type === 'arbiter.body_unavailable' && e.payload?.type === 'escape_pit'), true);
    assert.equal(events.some(e => e.type === 'exec.success' && e.payload?.type === 'escape_pit'), false);
  });
});

describe('BUG-CROSS-36 · 陪聊最小循环', () => {
  it('无身体 150 tick 不运行游戏链，只在第 150 tick 发布一次 IDLE rate', async () => {
    const callOrder: string[] = [];
    const published: Array<{ type: string; payload: unknown }> = [];
    const deps = makeDeps(callOrder, { isEmbodied: () => false }, (type, _level, payload) => published.push({ type, payload }));
    const hb = new Heartbeat(cfg, deps);

    for (let index = 0; index < TickRate.IDLE; index += 1) await (hb as any).runTick();

    for (const forbidden of ['perceive', 'watchdog', 'reflex', 'sched']) {
      assert.equal(callOrder.includes(forbidden), false, `${forbidden} 不应在陪聊态运行`);
    }
    assert.equal(callOrder.filter(item => item === 'drain').length, TickRate.IDLE);
    assert.equal(callOrder.filter(item => item === 'commit').length, TickRate.IDLE);
    const idle = published.filter(item => item.type === 'heartbeat.rate_tick');
    assert.equal(idle.length, 1);
    assert.deepEqual(idle[0]?.payload, { rate: TickRate.IDLE, tick: TickRate.IDLE });
    assert.equal(published.some(item => item.type === 'heartbeat.tick_done'), false);
  });

  it('身体动态挂载后下一个 tick 恢复完整游戏链', async () => {
    const callOrder: string[] = [];
    let embodied = false;
    const deps = makeDeps(callOrder, { isEmbodied: () => embodied });
    const hb = new Heartbeat(cfg, deps);

    await (hb as any).runTick();
    assert.equal(callOrder.includes('perceive'), false);
    embodied = true;
    await (hb as any).runTick();
    for (const expected of ['perceive', 'watchdog', 'reflex', 'sched']) assert.ok(callOrder.includes(expected), expected);
  });
});

// ──────────────────────────────────────────────────────────────────
// US-DOC-HB · 新增 6 个测试用例
// ──────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────
// 辅助：构造 mock Task (running)
// ──────────────────────────────────────────────────────────────────
function makeRunningTask(id = 't1', kind = 'follow_owner'): Task {
  return {
    id,
    kind,
    state: 'running',
    priority: 10,
    preconditions: [],
    params: {},
    createdAt: Date.now(),
    lastActiveTick: 0,
  };
}

// ──────────────────────────────────────────────────────────────────
// TC-HB-05 / TC-HB-06 · Critic 集成
// ──────────────────────────────────────────────────────────────────

describe('Heartbeat · Critic integration', () => {

  it('TC-HB-05 SLOW tick (tick=10) 触发 critic.verifyAll', async () => {
    let verifyAllCalled = false;
    const task = makeRunningTask();

    const mockCritic: ICriticRegistry = {
      register: () => {},
      get: () => undefined,
      verifyAll: (_tasks: Task[], _before: WorldStateView, _after: WorldStateView) => {
        verifyAllCalled = true;
        return [];
      },
    };

    const callOrder: string[] = [];
    const deps = makeDeps(callOrder, {
      critic: mockCritic,
      tasks: {
        active: () => null,
        sched: () => { callOrder.push('sched'); },
        list: () => [task],
        complete: () => {},
      } as never,
    });

    const hb = new Heartbeat(cfg, deps);
    // 手动把 tick 设为 9，下次 runTick 变为 10（SLOW 节拍触发）
    (hb as any).tick = 9;

    await (hb as any).runTick();

    assert.ok(verifyAllCalled, 'tick=10 时 critic.verifyAll 应被调用');
  });

  it('TC-HB-06 Critic success verdict 调用 tasks.complete', async () => {
    const completedIds: string[] = [];
    const task = makeRunningTask('task-abc');

    const mockCritic: ICriticRegistry = {
      register: () => {},
      get: () => undefined,
      verifyAll: (tasks: Task[], _b: WorldStateView, _a: WorldStateView) =>
        tasks.map(t => ({
          taskId: t.id,
          taskKind: t.kind,
          status: 'success' as const,
          reason: 'test-success',
          evaluatedAt: Date.now(),
        })),
    };

    const callOrder: string[] = [];
    const deps = makeDeps(callOrder, {
      critic: mockCritic,
      tasks: {
        active: () => null,
        sched: () => { callOrder.push('sched'); },
        list: () => [task],
        complete: (id: string) => { completedIds.push(id); },
      } as never,
    });

    const hb = new Heartbeat(cfg, deps);
    (hb as any).tick = 9; // 下次 runTick → tick=10

    await (hb as any).runTick();

    assert.ok(completedIds.includes('task-abc'), `tasks.complete 应以 'task-abc' 调用，实际: ${JSON.stringify(completedIds)}`);
  });
});

// ──────────────────────────────────────────────────────────────────
// TC-HB-09 / TC-HB-10 / TC-HB-11 · TickRegistry 四级节拍
// ──────────────────────────────────────────────────────────────────

describe('Heartbeat · TickRegistry', () => {

  it('TC-HB-09 FAST handler 每 tick 都调用', async () => {
    let callCount = 0;
    const registry = new TickRegistry();
    registry.register({
      id: 'fast-test',
      rate: TickRate.FAST,
      onTick: (_ctx: TickContext) => { callCount++; },
    });

    const callOrder: string[] = [];
    const deps = makeDeps(callOrder, { tickRegistry: registry });
    const hb = new Heartbeat(cfg, deps);

    await (hb as any).runTick(); // tick=1
    await (hb as any).runTick(); // tick=2
    await (hb as any).runTick(); // tick=3

    assert.equal(callCount, 3, `FAST handler 应在 3 个 tick 内被调用 3 次，实际 ${callCount} 次`);
  });

  it('TC-HB-10 STD handler 在 tick=4 不调，在 tick=5 调', async () => {
    let callCount = 0;
    const registry = new TickRegistry();
    registry.register({
      id: 'std-test',
      rate: TickRate.STD,
      onTick: (_ctx: TickContext) => { callCount++; },
    });

    const callOrder: string[] = [];
    const deps = makeDeps(callOrder, { tickRegistry: registry });
    const hb = new Heartbeat(cfg, deps);

    // tick 设为 3 → 下次 runTick 变为 4（不是 5 的倍数，不触发 STD）
    (hb as any).tick = 3;
    await (hb as any).runTick(); // tick=4

    assert.equal(callCount, 0, `STD handler 在 tick=4 不应被调，实际 ${callCount} 次`);

    // 再运行一次 → tick=5（5 的倍数，触发 STD）
    await (hb as any).runTick(); // tick=5

    assert.equal(callCount, 1, `STD handler 在 tick=5 应被调 1 次，实际 ${callCount} 次`);
  });

  it('TC-HB-11 SLOW handler 在 tick=10 被调用', async () => {
    let callCount = 0;
    const registry = new TickRegistry();
    registry.register({
      id: 'slow-test',
      rate: TickRate.SLOW,
      onTick: (_ctx: TickContext) => { callCount++; },
    });

    const callOrder: string[] = [];
    const deps = makeDeps(callOrder, { tickRegistry: registry });
    const hb = new Heartbeat(cfg, deps);

    // tick 设为 9 → 下次 runTick 变为 10（10 的倍数，触发 SLOW）
    (hb as any).tick = 9;
    await (hb as any).runTick(); // tick=10

    assert.equal(callCount, 1, `SLOW handler 在 tick=10 应被调 1 次，实际 ${callCount} 次`);
  });
});

// ──────────────────────────────────────────────────────────────────
// TC-HB-13 · Critic before/after 快照滚动（BUG-HB-01 修复验证）
// ──────────────────────────────────────────────────────────────────

describe('Heartbeat · Critic snapshot rolling (BUG-HB-01)', () => {

  it('TC-HB-13 第二次 SLOW 评测时 before 快照不同于 after（不再 before===after）', async () => {
    // 用 perceiveCount 控制每次 perceive() 返回不同的 world 对象
    let perceiveCount = 0;
    const worlds: WorldStateView[] = [];

    // capturedBeforeAfter：记录每次 verifyAll 收到的 before/after 是否相同对象
    const capturedBeforeAfter: Array<{ sameRef: boolean; beforeTick: number; afterTick: number }> = [];

    const task = makeRunningTask('t-snap');

    const mockCritic: ICriticRegistry = {
      register: () => {},
      get: () => undefined,
      verifyAll: (
        _tasks: Task[],
        before: WorldStateView,
        after: WorldStateView,
      ) => {
        capturedBeforeAfter.push({
          sameRef: before === after,
          beforeTick: before.tick,
          afterTick: after.tick,
        });
        return [];
      },
    };

    const callOrder: string[] = [];
    const deps = makeDeps(callOrder, {
      critic: mockCritic,
      tasks: {
        active: () => null,
        sched: () => { callOrder.push('sched'); },
        list: () => [task],
        complete: () => {},
      } as never,
      // 每次 perceive 返回不同 tick 编号的 world
      perception: {
        perceive: (): WorldStateView => {
          perceiveCount++;
          const w = { ...makeWorld(perceiveCount) };
          worlds.push(w);
          return w;
        },
      } as never,
    });

    const hb = new Heartbeat(cfg, deps);

    // 第一次 SLOW tick（tick=10）
    (hb as any).tick = 9;
    await (hb as any).runTick(); // tick=10，首次评测：criticSnapshot=null → before=after=world_10

    assert.equal(capturedBeforeAfter.length, 1, '第一次 SLOW tick 应触发一次 verifyAll');
    // 首次 fallback：before === after（因为 criticSnapshot 为 null）
    assert.ok(capturedBeforeAfter[0].sameRef, '首次评测 before 应 fallback 为当前 world（before===after）');

    // 第二次 SLOW tick（tick=20）
    (hb as any).tick = 19;
    await (hb as any).runTick(); // tick=20，before=world_10, after=world_20

    assert.equal(capturedBeforeAfter.length, 2, '第二次 SLOW tick 应再次触发 verifyAll');
    // 第二次评测：before 是上一 SLOW 末的快照，after 是本 tick 新快照 → 不同对象
    assert.ok(
      !capturedBeforeAfter[1].sameRef,
      `第二次评测 before 与 after 应是不同快照，beforeTick=${capturedBeforeAfter[1].beforeTick} afterTick=${capturedBeforeAfter[1].afterTick}`,
    );
    assert.ok(
      capturedBeforeAfter[1].beforeTick < capturedBeforeAfter[1].afterTick,
      `before.tick 应早于 after.tick，实际 before=${capturedBeforeAfter[1].beforeTick} after=${capturedBeforeAfter[1].afterTick}`,
    );
  });

});

// ──────────────────────────────────────────────────────────────────
// TC-HB-12 · Execute 锁
// ──────────────────────────────────────────────────────────────────

describe('Heartbeat · unified body ownership', () => {
  it('busy comes from the body runtime while reflex continues',async()=>{
    let busy=true, taskTicks=0,reflexTicks=0;
    const body=bodyStub();body.busy=()=>busy;
    const deps=makeDeps([],{
      body:body as never,
      reflex:{ingestCritical:()=>{},tick:()=>{reflexTicks++;return [];}} as never,
      taskStrategies:[{isActive:()=>true,tick:()=>{taskTicks++;return [];}} as never],
    });
    const heartbeat=new Heartbeat(cfg,deps);
    await (heartbeat as any).runTick();
    assert.equal(taskTicks,0);assert.equal(reflexTicks,1);
    busy=false;
    await (heartbeat as any).runTick();
    assert.equal(taskTicks,1);assert.equal(reflexTicks,2);
  });

  it('cancellation delegates once and cannot clear an unconfirmed body lease',()=>{
    let cancelled=0;const body=bodyStub();body.busy=()=>true;body.cancelAll=()=>{cancelled++;};
    const heartbeat=new Heartbeat(cfg,makeDeps([],{body:body as never}));
    heartbeat.submitRequest(makeReq({type:'say'}));
    heartbeat.submitRequest(makeReq({type:'stop'}));
    heartbeat.submitRequest(makeReq({type:'move_to'}));
    assert.equal(heartbeat.cancelBodyActions(),1);
    assert.equal(cancelled,1);assert.equal(body.busy(),true);
    assert.deepEqual((heartbeat as any).externalRequests.map((r:ActionRequest)=>r.type),['say','stop']);
    assert.equal('executing' in heartbeat,false);
  });

  it('cancellation includes goal-agent work outside heartbeat dispatch',()=>{
    let cancelled=0;const body=bodyStub();body.cancelAll=()=>{cancelled++;};
    const heartbeat=new Heartbeat(cfg,makeDeps([],{body:body as never}));
    heartbeat.cancelBodyActions();assert.equal(cancelled,1);
  });

  it('async dispatch is tracked by the body, never by a heartbeat watchdog lock',async()=>{
    let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
    let busy=false;const body=bodyStub();
    body.busy=()=>busy;
    body.executeTask=async request=>{busy=true;await pending;busy=false;return {ok:true,request,durationMs:1};};
    const heartbeat=new Heartbeat({tickMs:200,blockingExecute:false},makeDeps([],{body:body as never}));
    heartbeat.submitRequest(makeReq({type:'move_to',taskId:'live',target:{position:{x:1,y:64,z:0}}}));
    await (heartbeat as any).runTick();
    assert.equal(body.busy(),true);assert.equal('executing' in heartbeat,false);
    release();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(body.busy(),false);
  });
});

function bodyStub() {
  return {
    busy:()=>false,currentRequest:():ActionRequest|null=>null,cancelAll:()=>{},
    executeTask:async(request:ActionRequest)=>({ok:true,request,durationMs:0}),
    executeSafety:async(request:ActionRequest)=>({ok:true,request,durationMs:0}),
  };
}
