/**
 * US-H6 · 场景 e2e · 种田缺锄头 → ask_master → 答复 → 完成
 *
 * MockWorld 初始状态：
 *   - bot 背包: wooden_hoe（耐久=1，仅够 1 亩），wheat_seeds x32
 *   - ResourceResolver 被 monkey-patch 强制只返回 2 个 partial 候选（无 full）
 *     → DecisionPolicy rule 4 → ask_master
 *
 *   注 1：不能只返回 1 个 partial，因为 DecisionPolicy rule 1（唯一候选 → auto）
 *        会优先于 rule 4（所有 partial → ask_master）触发，导致直接 auto 不问主人。
 *        需要 ≥2 个 partial 候选才能触发 ask_master。
 *
 *   注 2：所有场景测试使用 dbPath: ':memory:' 避免并行测试 SQLite 锁争用。
 *        并行跑时共享同一个 'data/v2-memory.db' 会导致 SQLITE_BUSY 错误和 tick 卡顿。
 *
 * Timeline:
 *   t=200ms  owner chat "种3亩田" → ruleLoop intent=farm_request plots=3
 *            → start_task 失败 (hoe_durability:1/3)
 *            → resolve_resource → 2 partial → DecisionPolicy rule 4 → ask_master
 *            → bot 通过 ask_master 工具向主人提问
 *   t=3500ms owner chat "先种1亩" → resumeAnswer → matchAnswerToCandidate → partial(1)
 *            → update_task(plots=1) → start_task → task.started(kind=farm)
 *
 * 断言链：
 *   1. l7.tool_use name=ask_master 出现在事件流中（bot 提问了主人）
 *   2. t=3.5s 答复后，l7.tool_use name=update_task 出现（参数被修正为 plots=1）
 *   3. update_task.input.patch.plots === 1（按主人意图）
 *   4. task.started with kind=farm 在最终事件流中（任务启动）
 *   5. farm task.params.plots === 1（TaskRuntime 里已更新）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './runner.js';
import type { ResourceRequirement } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceProvider.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { ResolutionResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceResolver.js';

// ──────────────────────────────────────────────────────────────────
// 辅助：monkey-patch ResourceResolver.resolve 使其只返回 2 个 partial 候选
//
// 关键：需要 ≥2 个 partial + 0 个 full 候选，才能触发 DecisionPolicy rule 4：
//   rule 1: cs.length===1 → auto（唯一候选）← 1 个 partial 会被 rule 1 直选
//   rule 4: hasPartial && !hasNone → ask_master ← 需 2+ partial 才能跳过 rule 1
// ──────────────────────────────────────────────────────────────────

type ResolverLike = {
  resolve: (req: ResourceRequirement, world: WorldStateView) => ResolutionResult;
};

function patchResolverToPartialOnly(resolver: ResolverLike): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (resolver as any).resolve = (
    req: ResourceRequirement,
    _world: WorldStateView,
  ): ResolutionResult => ({
    requirement: req,
    candidates: [
      {
        // 候选 A: 背包里的锄头，耐久只剩 1，只能种 1 亩
        providerId: 'inventory_patch',
        summary: `背包里有 ${req.name}，但耐久只剩 1（需要 3），只能种 1 亩`,
        estimatedCostSec: 0,
        subtaskSuggestion: null,
        satisfaction: 'partial',
        partialAmount: 1,
      },
      {
        // 候选 B: 先去砍木头合成新锄，也只够再种 2 亩（资源有限）
        providerId: 'crafting_patch',
        summary: `先砍木头合成新 ${req.name}（约 45s），也只能再种 2 亩`,
        estimatedCostSec: 45,
        subtaskSuggestion: null,
        satisfaction: 'partial',
        partialAmount: 2,
      },
    ],
    hasFullSolution: false,
  });
}

// ──────────────────────────────────────────────────────────────────
// Suite A: ask_master 触发验证
// ──────────────────────────────────────────────────────────────────

describe.skip('US-H6 · 旧 RuleLoop 种田澄清链（BUG-CROSS-51 已由 GoalAgentPort 合同测试替代）', () => {

  test('种3亩田（锄头耐久不足）→ ask_master 工具被调用', async () => {
    const result = await runScenario({
      setup: (bot) => {
        // 主人在视野内
        bot.world.setOwner('testOwner', 1, { x: 3, y: 64, z: 3 });
        // 背包：种子充足 + 锄头耐久只有 1（够 1 亩，不够 3 亩）
        bot.world.addItem({ name: 'wheat_seeds', count: 32, slot: 1 });
        bot.world.addItem({ name: 'wooden_hoe', count: 1, slot: 2, durability: 1, maxDurability: 59 });
      },
      // 关键：':memory:' 避免并行测试的 SQLite 锁争用
      runtimeConfig: { dbPath: ':memory:' },
      timeline: [
        {
          atMs: 200,
          // 先 patch resolver，再发 chat — 确保 resolve_resource 走 partial only 路径
          action: (bot, rt) => {
            patchResolverToPartialOnly(rt.resolver);
            bot.game.emitChat('testOwner', '种3亩田');
          },
        },
      ],
      // 给足够时间让 ruleLoop 处理完（perception tick=50ms，chat 在 50ms 内被处理）
      durationMs: 4000,
    });

    const { events, bot } = result;

    // ── 断言 1：chat.from_owner 收到（主人消息被感知层收到）──
    const chatEvt = events.find(e => e.type === 'chat.from_owner');
    assert.ok(
      chatEvt != null,
      `应有 chat.from_owner 事件。已收到：[${events.map(e => e.type).join(', ')}]`,
    );

    // ── 断言 2：l7.turn_started 出现（主脑处理了该 chat）──
    const turnStarted = events.find(e => e.type === 'l7.turn_started');
    assert.ok(
      turnStarted != null,
      '应有 l7.turn_started 事件（MainBrain 开始处理 chat）',
    );

    // ── 断言 3：l7.tool_use name=ask_master 出现 ──
    // ruleLoop：handleFarmRequest(3) → start_task 失败 → resolve_resource
    //   → decide_with_policy → ask_master verdict
    //   → applyVerdict(ask_master) → dispatcher.call({tool:'ask_master'})
    //   → bus.publish('l7.tool_use', 'info', { name:'ask_master', ... })
    const askMasterEvt = events.find(
      e => e.type === 'l7.tool_use' &&
           (e.payload as { name: string }).name === 'ask_master',
    );
    assert.ok(
      askMasterEvt != null,
      `应有 l7.tool_use(name=ask_master) 事件。已有工具调用：[${
        events
          .filter(e => e.type === 'l7.tool_use')
          .map(e => (e.payload as { name: string }).name)
          .join(', ')
      }]`,
    );

    // ── 断言 4：bot 通过 game.chat 向主人提问 ──
    // dispatcher.dispatch('ask_master') → game.chat(question)
    const chatCalls = bot.game.calls.chat as unknown[][];
    assert.ok(
      chatCalls.length >= 1,
      `bot 应通过 game.chat 发出问题，实际调用次数：${chatCalls.length}`,
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // Suite B: ask_master → 答复 → update_task → task.started 完整流程
  // ──────────────────────────────────────────────────────────────────

  test('owner 答复 "先种1亩" → update_task(plots=1) + task.started(kind=farm)', async () => {
    const result = await runScenario({
      setup: (bot) => {
        bot.world.setOwner('testOwner', 1, { x: 3, y: 64, z: 3 });
        bot.world.addItem({ name: 'wheat_seeds', count: 32, slot: 1 });
        // 锄头耐久=1 → 不够种 3 亩 → preflight 失败 hoe_durability:1/3
        bot.world.addItem({ name: 'wooden_hoe', count: 1, slot: 2, durability: 1, maxDurability: 59 });
        // Patch getBlockAt 让 place_block atomic 不会因 null block 报错
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (bot.game as any).getBlockAt = () => ({
          name: 'dirt',
          position: { x: 1, y: 63, z: 1 },
          boundingBox: 'block',
        });
      },
      runtimeConfig: { dbPath: ':memory:' },
      timeline: [
        {
          atMs: 200,
          // Step 1: 种3亩田 → ask_master（先 patch resolver）
          action: (bot, rt) => {
            patchResolverToPartialOnly(rt.resolver);
            bot.game.emitChat('testOwner', '种3亩田');
          },
        },
        {
          atMs: 3500,
          // Step 2: 主人答复 "先种1亩" → resumeAnswer path
          // matchAnswerToCandidate: "先种1亩" → a.includes('先种') → partial candidate
          // → choice.partialAmount = 1 → update_task({plots:1}) → start_task
          action: (bot) => {
            bot.game.emitChat('testOwner', '先种1亩');
          },
        },
      ],
      durationMs: 7000,
    });

    const { events, runtime: rt } = result;

    // 提取所有工具调用名称（按时间顺序）
    const allToolCalls = events
      .filter(e => e.type === 'l7.tool_use')
      .map(e => (e.payload as { name: string }).name);

    // ── 断言 1：ask_master 工具在第一轮 turn 中被调用 ──
    const askMasterEvt = events.find(
      e => e.type === 'l7.tool_use' &&
           (e.payload as { name: string }).name === 'ask_master',
    );
    assert.ok(
      askMasterEvt != null,
      `第一轮应有 l7.tool_use(ask_master)。全部工具调用：[${allToolCalls.join(', ')}]`,
    );

    // ── 断言 2：答复后 update_task 工具被调用 ──
    // resumeAnswer("先种1亩") → matchAnswerToCandidate → partial(partialAmount=1)
    // → dispatcher.call({tool:'update_task', input:{taskId, patch:{plots:1}}})
    const updateTaskEvt = events.find(
      e => e.type === 'l7.tool_use' &&
           (e.payload as { name: string }).name === 'update_task',
    );
    assert.ok(
      updateTaskEvt != null,
      `owner 答复后应有 l7.tool_use(update_task)。全部工具调用：[${allToolCalls.join(', ')}]`,
    );

    // ── 断言 3：update_task 的 input.patch.plots 应为 1 ──
    const updatePayload = updateTaskEvt!.payload as {
      name: string;
      input: { taskId: string; patch: { plots: number } };
    };
    assert.equal(
      updatePayload.input.patch.plots,
      1,
      `update_task 的 patch.plots 应为 1（主人指定先种 1 亩），实际：${updatePayload.input.patch.plots}`,
    );

    // ── 断言 4：task.started with kind=farm 最终出现 ──
    // resumeAnswer → update_task → start_task → task.started(kind=farm)
    const taskStartedEvt = events.find(
      e => e.type === 'task.started' &&
           (e.payload as { kind: string }).kind === 'farm',
    );
    assert.ok(
      taskStartedEvt != null,
      `应有 task.started(kind=farm)。已收到：[${
        events.filter(e => e.type === 'task.started').map(e => JSON.stringify(e.payload)).join(', ')
      }]`,
    );

    // ── 断言 5：TaskRuntime 里 farm task.params.plots === 1 ──
    const farmTask = rt.tasks.list().find(t => t.kind === 'farm');
    assert.ok(farmTask != null, 'TaskRuntime 里应有 farm 任务');
    assert.equal(
      (farmTask!.params as { plots: number }).plots,
      1,
      `farm task.params.plots 应为 1，实际：${(farmTask!.params as { plots: number }).plots}`,
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // Suite C: 单元级验证 — DecisionPolicy ask_master 触发条件
  // ──────────────────────────────────────────────────────────────────

  test('DecisionPolicy: 2 个 partial 候选（无 full）→ 触发 ask_master 路径条件满足', () => {
    // 验证 patchResolverToPartialOnly 构造的候选满足 ask_master 触发条件：
    //   rule 4: hasPartial && !hasNone → ask_master

    const twoPartialResolution: ResolutionResult = {
      requirement: { kind: 'item', name: 'wooden_hoe', minDurability: 3 },
      candidates: [
        {
          providerId: 'inventory_patch',
          summary: '背包里有 wooden_hoe，但耐久只剩 1，只能种 1 亩',
          estimatedCostSec: 0,
          subtaskSuggestion: null,
          satisfaction: 'partial',
          partialAmount: 1,
        },
        {
          providerId: 'crafting_patch',
          summary: '先砍树合成新锄头（约 45s），也只能种 2 亩',
          estimatedCostSec: 45,
          subtaskSuggestion: null,
          satisfaction: 'partial',
          partialAmount: 2,
        },
      ],
      hasFullSolution: false,
    };

    // 验证候选组合满足 ask_master 触发条件
    const { candidates } = twoPartialResolution;
    const hasPartial = candidates.some(c => c.satisfaction === 'partial');
    const hasNone = candidates.some(c => c.satisfaction === 'none');
    const hasFull = candidates.some(c => c.satisfaction === 'full');

    assert.equal(hasPartial, true, '应有 partial 候选');
    assert.equal(hasFull, false, '不应有 full 候选（否则 rule 2/3 优先 → 不会到 ask_master）');
    assert.equal(hasNone, false, '不应有 none 候选（hasPartial && !hasNone → rule 4 ask_master）');

    // 验证候选数量 > 1（排除 rule 1：唯一候选 → auto）
    assert.ok(candidates.length >= 2, '候选数量应 ≥2（单候选会被 rule 1 auto 拦截）');

    // 验证第一个 partial 的 partialAmount（resumeAnswer 返回此值给 update_task）
    const firstPartial = candidates.find(c => c.satisfaction === 'partial');
    assert.equal(firstPartial?.partialAmount, 1, '第一个 partial 的 partialAmount 应为 1');
  });

  // ──────────────────────────────────────────────────────────────────
  // Suite D: 工具调用顺序验证 — ask_master 先于 update_task
  // ──────────────────────────────────────────────────────────────────

  test('工具调用顺序：ask_master 先出现，update_task 在 owner 答复后出现', async () => {
    const result = await runScenario({
      setup: (bot) => {
        bot.world.setOwner('testOwner', 1, { x: 3, y: 64, z: 3 });
        bot.world.addItem({ name: 'wheat_seeds', count: 32, slot: 1 });
        bot.world.addItem({ name: 'wooden_hoe', count: 1, slot: 2, durability: 1, maxDurability: 59 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (bot.game as any).getBlockAt = () => ({
          name: 'dirt',
          position: { x: 1, y: 63, z: 1 },
          boundingBox: 'block',
        });
      },
      runtimeConfig: { dbPath: ':memory:' },
      timeline: [
        {
          atMs: 200,
          action: (bot, rt) => {
            patchResolverToPartialOnly(rt.resolver);
            bot.game.emitChat('testOwner', '种3亩田');
          },
        },
        {
          atMs: 3500,
          action: (bot) => {
            // "先种1亩" 包含 '先种' → matchAnswerToCandidate → partial(partialAmount=1)
            bot.game.emitChat('testOwner', '先种1亩');
          },
        },
      ],
      durationMs: 7000,
    });

    const { events } = result;

    // 提取所有工具调用名称（按时间顺序）
    const toolCalls = events
      .filter(e => e.type === 'l7.tool_use')
      .map(e => (e.payload as { name: string }).name);

    // ask_master 应该存在于工具调用序列中
    assert.ok(
      toolCalls.includes('ask_master'),
      `工具调用序列应含 ask_master，实际：[${toolCalls.join(', ')}]`,
    );

    // 若 update_task 也出现，其 index 必须在 ask_master 之后
    const askIdx = toolCalls.indexOf('ask_master');
    const updateIdx = toolCalls.indexOf('update_task');

    if (updateIdx !== -1) {
      assert.ok(
        askIdx < updateIdx,
        `ask_master(idx=${askIdx}) 应早于 update_task(idx=${updateIdx})，顺序：[${toolCalls.join(', ')}]`,
      );
    }

    // task.started(kind=farm) 应在最终出现
    const taskStarted = events.find(
      e => e.type === 'task.started' &&
           (e.payload as { kind: string }).kind === 'farm',
    );
    assert.ok(
      taskStarted != null,
      `应有 task.started(kind=farm)，task 类型事件：[${
        events.filter(e => e.type.startsWith('task.')).map(e => e.type).join(', ')
      }]`,
    );
  });
});
