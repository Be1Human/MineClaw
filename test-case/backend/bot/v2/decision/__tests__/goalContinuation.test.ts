import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MainBrain, goalContinuationDedupeKey, type MainBrainDeps } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/mainBrain.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { ResourceResolver } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceResolver.js';
import { InventoryProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceProvider.js';
import { DecisionPolicy } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/decisionPolicy.js';
import type { LLMClient } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { PerceptionPipeline } from '../../../../../../apps/minecraft-companion/src/bot/v2/perception/pipeline.js';
import type { GoalContinuationV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/contracts.js';

function continuation(state: GoalContinuationV2['session']['state']): GoalContinuationV2 {
  return {
    session: {
      sessionId: 'session-1', origin:'player', originalText: '给我一把稿子', desiredOutcome: '给我一把稿子',
      state, replyObligation: 'must_reply',
    },
    triggeringReport: {
      meta: {
        schemaVersion: 2, sessionId: 'session-1', messageId: 'report-1', correlationId: 'corr-1',
        causationId: 'request-1', conversationId: 'turn-1', sequence: 2,
        emittedAt: new Date().toISOString(), idempotencyKey: 'corr-1:report:2',
      },
      requestId: 'request-1',
      status: state === 'awaiting_player' ? 'need_clarification' : state === 'ready_for_decision' ? 'answered' : 'completed',
      summary: state === 'awaiting_player' ? '你想要木镐还是石镐？' : '背包里有木镐和石镐',
      evidence: [],
    },
    allowedDecisions: state === 'awaiting_player' ? ['clarify'] : state === 'ready_for_decision' ? ['respond', 'submit_followup'] : ['respond'],
  };
}

function build(llm: LLMClient) {
  const bus = new EventBusV2();
  const world = {
    tick: 1, timestamp: Date.now(),
    self: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, maxHealth: 20, food: 20, isOnGround: true },
    owner: null, environment: { dimension: 'overworld', timeOfDay: 0, isDay: true, isRaining: false },
    entities: [], inventory: { items: [], held: null, freeSlots: 36 }, taskContext: null,
  };
  const perception = { getWorldState: () => world, perceive: () => world } as unknown as PerceptionPipeline;
  const memory = {
    record: () => {}, query: () => [], scheduleCommit: () => {}, commitTick: () => 0,
    setRuntime: () => {}, getRuntime: () => undefined, clearRuntime: () => {}, snapshot: () => ({}), inspect: () => ({}), close: () => {},
  } as unknown as MainBrainDeps['memory'];
  const tasks = new TaskRuntime(memory!, bus);
  const resolver = new ResourceResolver(); resolver.register(new InventoryProvider());
  const game = {
    username: 'MineFriend', getPosition: () => ({ x: 0, y: 64, z: 0 }), getDimension: () => 'overworld',
    findBlocks: () => [], chat: () => {}, getInventoryItems: () => [],
  } as unknown as GameAdapter;
  const lifecycle: string[] = [];
  const deps: MainBrainDeps = {
    bus, game, ownerName: 'Owner', llm, memory,
    goalAgentPort: {
      request: () => { throw new Error('not expected'); },
      beginContinuation: (_turnId, sessionId) => lifecycle.push(`begin:${sessionId}`),
      endPlayerTurn: () => lifecycle.push('end'),
      markReplied: sessionId => lifecycle.push(`replied:${sessionId}`),
    },
  };
  return { brain: new MainBrain(deps, { ownerName: 'Owner', idleEnabled: false }), bus, lifecycle };
}

describe('BUG-CROSS-51 · GoalContinuationV2 turn', () => {
  it('awaiting_player 直接转达协议澄清，不允许 LLM 猜答案或改成进度承诺', async () => {
    let llmCalls = 0;
    const llm = {
      callWithTools: async () => { llmCalls += 1; return null; },
    } as unknown as LLMClient;
    const { brain, lifecycle, bus } = build(llm);
    const spoken: string[] = [];
    bus.on('speech.committed', event => spoken.push(String((event.payload as { text?: string }).text ?? '')));
    const run = brain as unknown as { runTurn: (m: string, k: string, s: undefined, c: GoalContinuationV2) => Promise<unknown> };
    await run.runTurn.call(brain, 'continue', 'goal_continuation', undefined, continuation('awaiting_player'));
    assert.equal(llmCalls, 0);
    assert.deepEqual(spoken, ['你想要木镐还是石镐？']);
    assert.deepEqual(lifecycle, ['begin:session-1', 'replied:session-1', 'end']);
    brain.shutdown('test_done');
  });

  it('ready_for_decision 允许一次 follow-up 委托', async () => {
    const seen: string[][] = [];
    const llm = {
      callWithTools: async (args: { tools: Array<{ function: { name: string } }> }) => {
        seen.push(args.tools.map(tool => tool.function.name).sort());
        return { toolCalls: [{ id: 'say', name: 'say', arguments: { text: '我有两把镐，你想要哪把？' } }], content: '' };
      },
    } as unknown as LLMClient;
    const { brain } = build(llm);
    const run = brain as unknown as { runTurn: (m: string, k: string, s: undefined, c: GoalContinuationV2) => Promise<unknown> };
    await run.runTurn.call(brain, 'continue', 'goal_continuation', undefined, continuation('ready_for_decision'));
    assert.deepEqual(seen[0], ['ask_master', 'say', 'submit_goal_request']);
    brain.shutdown('test_done');
  });

  it('must_reply 在 LLM 无决定时使用 GoalAgent 报告兜底，不会静默', async () => {
    const llm = { callWithTools: async () => null } as unknown as LLMClient;
    const { brain, bus } = build(llm);
    const spoken: string[] = [];
    bus.on('speech.committed', event => spoken.push(String((event.payload as { text?: string }).text ?? '')));
    const run = brain as unknown as { runTurn: (m: string, k: string, s: undefined, c: GoalContinuationV2) => Promise<unknown> };
    await run.runTurn.call(brain, 'continue', 'goal_continuation', undefined, continuation('completed'));
    assert.deepEqual(spoken, ['背包里有木镐和石镐']);
    brain.shutdown('test_done');
  });

  it('FEAT-CROSS-18 · running 续接只能表达，不能再次委托 GoalAgent', async () => {
    const seen: string[][] = [];
    const llm = {
      callWithTools: async (args: { tools: Array<{ function: { name: string } }> }) => {
        seen.push(args.tools.map(tool => tool.function.name).sort());
        return { toolCalls: [{ id: 'say', name: 'say', arguments: { text: '附近没找到木材，我换条路线继续找。' } }], content: '' };
      },
    } as unknown as LLMClient;
    const { brain } = build(llm);
    const running = continuation('executing');
    running.triggeringReport.status = 'running';
    running.triggeringReport.update = {
      kind: 'decision', importance: 'high', episodeKey: 'wood', dedupeKey: 'replan:wood:1', ownerActionable: false,
    };
    running.allowedDecisions = ['respond', 'wait'];
    const run = brain as unknown as { runTurn: (m: string, k: string, s: undefined, c: GoalContinuationV2) => Promise<unknown> };
    await run.runTurn.call(brain, 'continue', 'goal_continuation', undefined, running);
    assert.deepEqual(seen[0], ['say']);
    brain.shutdown('test_done');
  });

  it('FEAT-CROSS-18 · 同请求的不同 running update 使用不同 continuation key', () => {
    const first = continuation('executing');
    first.triggeringReport.status = 'running';
    first.triggeringReport.update = {
      kind: 'obstacle', importance: 'high', episodeKey: 'wood', dedupeKey: 'obstacle:wood', ownerActionable: false,
    };
    const second = structuredClone(first);
    second.triggeringReport.update!.dedupeKey = 'decision:replan';
    assert.notEqual(goalContinuationDedupeKey(first), goalContinuationDedupeKey(second));
  });
});
