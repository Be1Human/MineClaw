/**
 * US-H5 · 场景 e2e · 种田 1 亩端到端
 *
 * 覆盖：
 *   1. 直接注入 farm 任务 → FarmStrategy 激活 → invoke_behavior → 原子链执行
 *      → atomic.use_tool.success + atomic.place_block.success
 *   2. chat "种1亩地" → ruleLoop 解析 intent=farm_request → 创建并启动 farm 任务
 *      → task.started(kind=farm) 事件
 *
 * 注：MockGameAdapter.getBlockAt 默认返回 null，place_block atomic 会因
 *    "reference block not found" 失败。测试通过 monkey-patch getBlockAt 让其
 *    返回一个 dummy dirt block，从而使完整 FarmBehavior 子请求链全部成功。
 *
 * 注 2：FarmStrategy 监听 atomic.place_block.success 的 payload.source 推进
 *    plotsDone。atomics.ts 的 place_block 事件已带 source（与 use_tool 一致），
 *    撒种成功 → plotsDone 递增 → Critic 判 success → 任务完成。
 *    因此端到端断言验证「farm.progress / task.completed」而非任务卡死状态。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, expectEventEmitted } from './runner.js';
import { createMockBot } from '../mocks/index.js';
import type { BusEvent } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { RawBlock } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';
import { V2Runtime } from '../../../../../../apps/minecraft-companion/src/bot/v2/v2Runtime.js';

// ──────────────────────────────────────────────────────────────────
// 辅助：给 MockGameAdapter 打补丁让 getBlockAt 返回 dummy 方块
// ──────────────────────────────────────────────────────────────────

function patchGetBlockAt(game: object): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter=game as any;
  const originalInventory=adapter.getInventoryItems.bind(adapter);
  let placedPosition:{x:number;y:number;z:number}|null=null;
  adapter.getBlockAt=(pos:{x:number;y:number;z:number}):RawBlock=>({
    name:placedPosition
      && placedPosition.x===pos.x&&placedPosition.y===pos.y&&placedPosition.z===pos.z
      ?'wheat':'dirt',
    position:{...pos},
    boundingBox:placedPosition
      && placedPosition.x===pos.x&&placedPosition.y===pos.y&&placedPosition.z===pos.z
      ?'empty':'block',
  });
  adapter.getInventoryItems=()=>originalInventory().map((item:{name:string;count:number})=>
    item.name==='wheat_seeds'&&placedPosition?{...item,count:Math.max(0,item.count-1)}:item,
  );
  adapter.placeBlock=async(block:RawBlock,face:{x:number;y:number;z:number})=>{
    adapter.calls.placeBlock.push([block,face]);
    placedPosition={
      x:block.position.x+face.x,
      y:block.position.y+face.y,
      z:block.position.z+face.z,
    };
  };
}

// ──────────────────────────────────────────────────────────────────
// Suite A: 直接注入任务 · 测试 FarmStrategy → atomic 链
// ──────────────────────────────────────────────────────────────────

describe('US-H5 · 种田 e2e · 直接注入 farm 任务', () => {

  test('farm task starts → FarmStrategy emits invoke_behavior → atomic chain executes', async () => {
    const events: BusEvent[] = [];

    const bot = createMockBot();

    // 背包：小麦种子 + 木锄（无耐久字段 → durability ?? Infinity 可通过 preflight）
    bot.world.addItem({ name: 'wheat_seeds', count: 64, slot: 1 });
    bot.world.addItem({ name: 'wooden_hoe', count: 1, slot: 2 });

    // 修复 getBlockAt → place_block atomic 能找到目标方块
    patchGetBlockAt(bot.game);

    const rt = new V2Runtime({
      game: bot.game,
      nav: bot.nav,
      ownerName: 'testOwner',
      tickMs: 50,
      blockingExecute: true,
      dbPath: ':memory:',
      worldMapDbPath: ':memory:',
      chatMemoryDbPath: ':memory:',
      onEvent: (ev) => { events.push(ev); },
    });

    rt.start();

    // 等 perception 预热
    await new Promise(r => setTimeout(r, 100));

    // 直接创建并启动 farm 任务（绕过 preflight · 模拟 ruleLoop 成功路径）
    const farmTask = rt.tasks.createFarmTask({
      seedName: 'wheat_seeds',
      hoeName: 'wooden_hoe',
      plots: 1,
      durabilityPerPlot: 1,
    });
    rt.tasks.pushToStack(farmTask.id);

    // 运行足够长时间让 FarmStrategy → invoke_behavior → FarmBehavior 子原子链全部执行完
    await new Promise(r => setTimeout(r, 7000));

    rt.stop();

    // ── 断言 1：task.started 含 kind=farm ──
    const taskStarted = events.find(e => e.type === 'task.started');
    assert.ok(taskStarted, '应有 task.started 事件');
    assert.ok(
      (taskStarted.payload as { kind: string }).kind === 'farm',
      `task.started 的 kind 应为 'farm'，实际：${(taskStarted.payload as { kind: string }).kind}`,
    );

    // ── 断言 2：invoke_behavior 被启动（FarmStrategy → Arbitrator → executeAtomic） ──
    const invokeSkillStart = events.find(e => e.type === 'atomic.invoke_behavior.start');
    assert.ok(invokeSkillStart, '应有 atomic.invoke_behavior.start 事件（FarmStrategy 触发了 invoke_behavior）');

    // ── 断言 3：equip 被调用（FarmBehavior 第 1 步：装备锄头） ──
    assert.ok(
      bot.game.calls.equip.length >= 1,
      `MockGameAdapter.equip 应至少被调 1 次，实际：${bot.game.calls.equip.length}`,
    );

    // ── 断言 4：atomic.use_tool.success（FarmBehavior 第 3 步：右键耕地） ──
    const useToolSuccess = events.find(e => e.type === 'atomic.use_tool.success');
    assert.ok(useToolSuccess, '应有 atomic.use_tool.success 事件（耕地动作成功）');

    // ── 断言 5：atomic.place_block.success（FarmBehavior 第 5 步：撒种） ──
    const placeBlockSuccess = events.find(e => e.type === 'atomic.place_block.success');
    assert.ok(
      placeBlockSuccess,
      `应有 atomic.place_block.success 事件（撒种成功）。place 事件：${JSON.stringify(events.filter(event=>event.type.includes('place_block')))}`,
    );

    // ── 断言 6：MockGameAdapter.placeBlock 被调用 ──
    assert.ok(
      bot.game.calls.placeBlock.length >= 1,
      `MockGameAdapter.placeBlock 应至少被调 1 次，实际：${bot.game.calls.placeBlock.length}`,
    );

    // ── 断言 7：撒种推进 plotsDone（place_block.success 带 source） ──
    const farmProgress = events.find(
      e => e.type === 'farm.progress' && (e.payload as { plotsDone: number }).plotsDone >= 1,
    );
    assert.ok(
      farmProgress,
      `应有 farm.progress 事件且 plotsDone>=1（撒种成功推进进度）。已收到：[${events.map(e => e.type).join(', ')}]`,
    );

    // ── 断言 8：farm 任务被 Critic 判定 success 并完成 ──
    const farmCompleted = events.find(
      e => e.type === 'task.completed' && (e.payload as { kind: string }).kind === 'farm',
    );
    assert.ok(farmCompleted, '应有 task.completed(kind=farm) 事件（1 亩种完 → Critic success）');

    // ── 断言 9：FarmStrategy.inspect() 字段合理（任务完成后归 idle） ──
    const inspect = rt.farm.inspect();
    assert.equal(inspect.kind, 'fsm', 'FarmStrategy.inspect().kind 应为 fsm');
  });

});

// ──────────────────────────────────────────────────────────────────
// Suite B: Chat 注入路径 · 测 ruleLoop 解析 "种1亩地" → farm intent
// ──────────────────────────────────────────────────────────────────

describe.skip('US-H5 · 旧 RuleLoop chat→farm 链（BUG-CROSS-51 已删除）', () => {

  test('chat "种1亩地" → ruleLoop 识别 farm_request → task.started(kind=farm)', async () => {
    const result = await runScenario({
      setup: (bot) => {
        // 主人在视野内
        bot.world.setOwner('testOwner', 1, { x: 3, y: 64, z: 3 });
        // 背包：种子 + 锄头（durability undefined → Infinity ≥ 1 通过 preflight）
        bot.world.addItem({ name: 'wheat_seeds', count: 32, slot: 1 });
        bot.world.addItem({ name: 'wooden_hoe', count: 1, slot: 2 });
        // 修复 getBlockAt 让 place_block 能找到方块
        patchGetBlockAt(bot.game);
      },
      timeline: [
        {
          atMs: 200,
          action: (bot) => {
            // "种1亩地" contains '种' and '地' → parseIntent returns 'farm_request'
            // parsePlots("种1亩地") → match /(\d+)\s*(?:亩|块|格|个)/ → plots=1
            bot.game.emitChat('testOwner', '种1亩地');
          },
        },
      ],
      durationMs: 8000,
    });

    // ── 断言 1：chat.from_owner 收到 ──
    expectEventEmitted(result.events, 'chat.from_owner');

    // ── 断言 2：task.started 且 kind=farm ──
    const taskStartedEvent = result.events.find(
      e => e.type === 'task.started' && (e.payload as { kind: string }).kind === 'farm',
    );
    assert.ok(
      taskStartedEvent != null,
      `应有 task.started(kind=farm)。已收到事件类型：[${result.events.map(e => e.type).join(', ')}]`,
    );

    // ── 断言 3：bot 说了开始种地的话（ruleLoop dispatcher say → game.chat 直接调用）
    // 注：dispatcher 的 say 工具直接调 game.chat()，不经 executeAtomic，
    // 因此不产生 atomic.say 事件，需检查 bot.game.calls.chat 调用记录
    const chatCalls = result.bot.game.calls.chat as unknown[][];
    assert.ok(
      chatCalls.length >= 1,
      `bot 应通过 game.chat 说过话（ruleLoop say），实际调用次数：${chatCalls.length}`,
    );

    // ── 断言 4：invoke_behavior 被触发（FarmStrategy → Heartbeat → atomic） ──
    const invokeSkill = result.events.find(e => e.type === 'atomic.invoke_behavior.start');
    assert.ok(invokeSkill, '应有 atomic.invoke_behavior.start 事件');

    // ── 断言 5：equip 被调用（FarmBehavior 装备锄头） ──
    assert.ok(
      result.bot.game.calls.equip.length >= 1,
      `MockGameAdapter.equip 应至少被调 1 次，实际：${result.bot.game.calls.equip.length}`,
    );

    // ── 断言 6：use_tool.success（耕地） ──
    expectEventEmitted(result.events, 'atomic.use_tool.success');

    // ── 断言 7：撒种成功推进 plotsDone（place_block.success 带 source） ──
    const farmProgress = result.events.find(
      e => e.type === 'farm.progress' && (e.payload as { plotsDone: number }).plotsDone >= 1,
    );
    assert.ok(
      farmProgress,
      `应有 farm.progress 事件且 plotsDone>=1。已收到：[${result.events.map(e => e.type).join(', ')}]`,
    );

    // ── 断言 8：farm 任务端到端完成（Critic 判 success） ──
    const farmCompleted = result.events.find(
      e => e.type === 'task.completed' && (e.payload as { kind: string }).kind === 'farm',
    );
    assert.ok(farmCompleted, '应有 task.completed(kind=farm) 事件（种 1 亩端到端成功）');
  });

  test('ruleLoop 正确解析 "种1亩地" → intent=farm_request, plots=1', async () => {
    // 验证 ruleLoop 内部解析逻辑：种+地 → farm_request，1亩 → plots=1
    // 通过观察 task.created 事件里的 params 来确认
    const result = await runScenario({
      setup: (bot) => {
        bot.world.setOwner('testOwner', 2, { x: 0, y: 64, z: 5 });
        bot.world.addItem({ name: 'wheat_seeds', count: 10, slot: 1 });
        bot.world.addItem({ name: 'wooden_hoe', count: 1, slot: 2 });
        patchGetBlockAt(bot.game);
      },
      timeline: [
        {
          atMs: 150,
          action: (bot) => {
            bot.game.emitChat('testOwner', '种3亩地');
          },
        },
      ],
      durationMs: 1500,
    });

    // task.created 应该有 farm 任务
    const taskCreated = result.events.find(
      e => e.type === 'task.created' && (e.payload as { kind: string }).kind === 'farm',
    );
    assert.ok(taskCreated, '应有 farm task.created 事件');

    // 验证 farm 任务在 TaskRuntime 里
    const tasks = result.runtime.tasks.list();
    const farmTask = tasks.find(t => t.kind === 'farm');
    assert.ok(farmTask, 'TaskRuntime 里应有 farm 任务');
    assert.equal(
      (farmTask!.params as { plots: number }).plots,
      3,
      '解析 "种3亩地" → plots 应为 3',
    );
  });

});
