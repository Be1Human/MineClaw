/**
 * US-D4 · E2E 场景验证 · 工具损坏自动补救
 *
 * 等价于手动测试"种 3 亩中途锄头坏自动补救"，通过 ScenarioRunner 自动执行。
 *
 * 场景步骤：
 *   1. 建立 farm 任务（hoeName='wooden_hoe', plots=3）并 pushToStack
 *   2. 等待任务进入 running 状态
 *   3. 手动向 bus 发布 tool_broken 事件
 *   4. Supervisor 接收 → planRecovery → inject craft_item 子任务 → farm 任务 paused
 *   5. 验证：
 *      a. farm 任务有 task.started 事件
 *      b. supervisor.recovery_started 事件发出（走 subtask 路径）
 *         OR craft_item 子任务的 task.started 事件
 *      c. farm 任务进入 paused 状态（task.paused 事件 + state='paused'）
 */

import { afterEach, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMockBot } from '../mocks/index.js';
import { V2Runtime } from '../../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';
import type { BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

let runtime: V2Runtime | null = null;

// 断言失败时也必须回收定时器，否则 Node 测试进程会持续运行而掩盖失败结果。
afterEach(() => {
  runtime?.stop();
  runtime = null;
});

describe('US-D4 · E2E: farm → tool_broken → auto recovery', () => {
  test('tool_broken event triggers recovery chain: farm paused + craft_item injected', async () => {
    const bot = createMockBot();

    // Set up inventory: wooden_hoe with very low durability, wheat_seeds
    bot.world.addItem({ name: 'wooden_hoe', count: 1, slot: 0, durability: 1, maxDurability: 59 });
    bot.world.addItem({ name: 'wheat_seeds', count: 10, slot: 1 });
    bot.world.addItem({ name: 'wooden_planks', count: 2, slot: 2 });
    bot.world.addItem({ name: 'stick', count: 2, slot: 3 });

    const collectedEvents: BusEvent[] = [];

    const rt = runtime = new V2Runtime({
      game: bot.game,
      nav: bot.nav,
      ownerName: 'testOwner',
      dbPath: ':memory:',
      worldMapDbPath: ':memory:',
      chatMemoryDbPath: ':memory:',
      tickMs: 50,
      blockingExecute: true,
      onEvent: (ev: BusEvent) => { collectedEvents.push(ev); },
    });

    rt.start();

    // Allow runtime to warm up
    await new Promise(r => setTimeout(r, 150));

    // Create a farm task with hoeName so recoveryPlanner can identify it
    const farmTask = rt.tasks.createFarmTask({
      seedName: 'wheat_seeds',
      plots: 3,
      hoeName: 'wooden_hoe',
      durabilityPerPlot: 1,
    });

    // Push directly to stack (bypasses preflight — mirrors what Supervisor does)
    rt.tasks.pushToStack(farmTask.id);

    // Confirm farm task is running
    await new Promise(r => setTimeout(r, 100));
    const farmTaskAfterStart = rt.tasks.getById(farmTask.id);
    assert.ok(farmTaskAfterStart, 'farm task should exist in TaskRuntime');
    assert.equal(farmTaskAfterStart.state, 'running', 'farm task should be running before tool_broken');

    // Assertion 1: task.started event was emitted for farm kind
    const farmStarted = collectedEvents.find(
      e => e.type === 'task.started' && (e.payload as { kind?: string }).kind === 'farm',
    );
    assert.ok(farmStarted, 'task.started event with kind=farm must be emitted');

    // Manually publish tool_broken event — simulating hardware breakage mid-task
    rt.bus.publish('tool_broken', 'recoverable', {
      tool: 'wooden_hoe',
      taskId: farmTask.id,
    });

    // Give Supervisor time to react (it handles events synchronously via dispatch,
    // but injector side-effects happen inside commit())
    await new Promise(r => setTimeout(r, 200));

    // Assertion 2a: supervisor.recovery_started published (subtask path)
    const recoveryStarted = collectedEvents.find(e => e.type === 'supervisor.recovery_started');

    // Assertion 2b: craft_item subtask was started
    const craftItemStarted = collectedEvents.find(
      e => e.type === 'task.started' && (e.payload as { kind?: string }).kind === 'craft_item',
    );

    // Assertion 2c: subtask_injected event
    const subtaskInjected = collectedEvents.find(e => e.type === 'task.subtask_injected');

    // At least one of these must have fired (recovery happened)
    const recoveryFired = recoveryStarted != null || craftItemStarted != null || subtaskInjected != null;
    assert.ok(
      recoveryFired,
      [
        'Expected supervisor.recovery_started or task.started(craft_item) or task.subtask_injected,',
        'but none were emitted.',
        `All events: [${collectedEvents.map(e => e.type).join(', ')}]`,
      ].join(' '),
    );

    // Assertion 3: 注入时必须暂停父任务。子任务可能已在等待窗口内完成，
    // 此时 TaskRuntime 会自动恢复父任务，因此不能把最终状态固定为 paused。
    const farmTaskAfterBroken = rt.tasks.getById(farmTask.id);
    assert.ok(farmTaskAfterBroken, 'farm task should still exist after tool_broken');
    assert.ok(
      farmTaskAfterBroken.state === 'paused' || farmTaskAfterBroken.state === 'running',
      `farm task should be paused during recovery or resumed after successful subtask. Got: ${farmTaskAfterBroken.state}`,
    );

    // Assertion 4: task.paused event was emitted for the farm task
    const farmPaused = collectedEvents.find(
      e => e.type === 'task.paused' && (e.payload as { taskId?: string }).taskId === farmTask.id,
    );
    assert.ok(farmPaused, 'task.paused event should have been emitted for the farm task');

    const subtaskDone = collectedEvents.find(e => e.type === 'task.subtask_done');
    assert.ok(
      farmTaskAfterBroken.state === 'paused' || subtaskDone,
      '父任务若已恢复，必须有 task.subtask_done 证明恢复子任务已结束',
    );

    rt.stop();
  });

  test('tool_broken with no running task → no recovery actions taken', async () => {
    const bot = createMockBot();
    const collectedEvents: BusEvent[] = [];

    const rt = runtime = new V2Runtime({
      game: bot.game,
      nav: bot.nav,
      ownerName: 'testOwner',
      dbPath: ':memory:',
      worldMapDbPath: ':memory:',
      chatMemoryDbPath: ':memory:',
      tickMs: 50,
      blockingExecute: true,
      onEvent: (ev: BusEvent) => { collectedEvents.push(ev); },
    });

    rt.start();
    await new Promise(r => setTimeout(r, 100));

    // Publish tool_broken with no running tasks
    rt.bus.publish('tool_broken', 'recoverable', { tool: 'wooden_hoe', taskId: 'nonexistent' });

    await new Promise(r => setTimeout(r, 150));

    // Neither recovery_started nor subtask injection should happen
    const recoveryStarted = collectedEvents.find(e => e.type === 'supervisor.recovery_started');
    const subtaskInjected = collectedEvents.find(e => e.type === 'task.subtask_injected');

    assert.equal(recoveryStarted, undefined, 'No recovery should start when no task is running');
    assert.equal(subtaskInjected, undefined, 'No subtask should be injected when no task is running');

    rt.stop();
  });

  test('tool_broken for unrelated tool → farm task continues running', async () => {
    const bot = createMockBot();
    bot.world.addItem({ name: 'wheat_seeds', count: 10, slot: 0 });
    bot.world.addItem({ name: 'wooden_hoe', count: 1, slot: 1, durability: 59, maxDurability: 59 });

    const collectedEvents: BusEvent[] = [];

    const rt = runtime = new V2Runtime({
      game: bot.game,
      nav: bot.nav,
      ownerName: 'testOwner',
      dbPath: ':memory:',
      worldMapDbPath: ':memory:',
      chatMemoryDbPath: ':memory:',
      tickMs: 50,
      blockingExecute: true,
      onEvent: (ev: BusEvent) => { collectedEvents.push(ev); },
    });

    rt.start();
    await new Promise(r => setTimeout(r, 100));

    const farmTask = rt.tasks.createFarmTask({
      seedName: 'wheat_seeds',
      plots: 3,
      hoeName: 'wooden_hoe',
      durabilityPerPlot: 1,
    });
    rt.tasks.pushToStack(farmTask.id);

    await new Promise(r => setTimeout(r, 100));

    // Publish tool_broken for a DIFFERENT tool (iron_sword — not the hoe the farm uses)
    rt.bus.publish('tool_broken', 'recoverable', { tool: 'iron_sword' });

    await new Promise(r => setTimeout(r, 150));

    // Farm task should remain running (tool mismatch guard in decideToolBroken)
    const farmTaskAfter = rt.tasks.getById(farmTask.id);
    assert.ok(farmTaskAfter, 'farm task should exist');
    assert.equal(
      farmTaskAfter.state,
      'running',
      'farm task should remain running when unrelated tool breaks',
    );

    const subtaskInjected = collectedEvents.find(e => e.type === 'task.subtask_injected');
    assert.equal(subtaskInjected, undefined, 'No subtask injected for unrelated tool');

    rt.stop();
  });
});
