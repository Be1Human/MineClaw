/**
 * Unit tests for MainBrain · pendingHistory behaviour
 *
 * Covers:
 *   ① First turn: LLM returns ask_master → pendingHistory saved, pendingAskMaster=true
 *   ② Second chat: pendingHistory taken + cleared → resumes turn with prior history
 *   ③ Busy guard: two chats racing → second is dropped (no double-process)
 *
 * Test runner: node:test + node:assert/strict
 * Run: npm run test:v2 (from apps/minecraft-companion/)
 */

import { describe, it, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MainBrain, type MainBrainConfig } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/mainBrain.js';
import type { MainBrainDeps } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/mainBrain.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { TaskRuntime } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/taskRuntime.js';
import { ResourceResolver } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceResolver.js';
import { InventoryProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/resourceProvider.js';
import { DecisionPolicy } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/decisionPolicy.js';
import type { PerceptionPipeline } from '../../../../../../apps/minecraft-companion/src/bot/v2/perception/pipeline.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';
import type { LLMClient } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/LLMClient.js';
import type { LLMToolCallResult } from '../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/types.js';
import { TickRate } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tickRegistry.js';
import { CompanionCore } from '../../../../../../apps/minecraft-companion/src/bot/v2/companion/companionCore.js';
import type { GamePresenceState } from '../../../../../../apps/minecraft-companion/src/bot/v2/gamePresenceContext.js';

/**
 * Parse the legacy JSON-string response (used by the old prompt-completion mock)
 * into a function-calling LLMToolCallResult.
 * Legacy format: { thought, action: { tool, input } }
 */
function parseLegacyAsToolCall(raw: string | null): LLMToolCallResult | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as {
      thought?: string;
      action?: { tool: string; input?: Record<string, unknown> };
    };
    if (parsed.action) {
      return {
        toolCalls: [{
          id: `call_${parsed.action.tool}_${Math.random().toString(36).slice(2, 8)}`,
          name: parsed.action.tool,
          arguments: parsed.action.input ?? {},
        }],
        content: parsed.thought ?? '',
      };
    }
  } catch {
    /* fall through */
  }
  return { toolCalls: [], content: raw };
}
import { MemoryV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/memory.js';

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

/** Flush all pending microtasks (settles void-async handlers) */
async function flushMicrotasks(): Promise<void> {
  // Multiple rounds to handle chained promises
  for (let i = 0; i < 10; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function makeWorld(inventoryItems: WorldStateView['inventory']['items'] = []): WorldStateView {
  return {
    tick: 1,
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
    owner: {
      username: 'TestOwner',
      position: { x: 5, y: 64, z: 5 },
      distance: 8,
      entityId: 1,
      isVisible: true,
    },
    environment: {
      dimension: 'overworld',
      timeOfDay: 6000,
      isDay: true,
      isRaining: false,
    },
    entities: [], // no nearby players → detectAddress returns 'addressed'
    inventory: {
      items: inventoryItems,
      held: null,
      freeSlots: 36,
    },
    taskContext: null,
  };
}

/** Stub MemoryV2 – avoids SQLite I/O in unit tests */
function makeStubMemory(): MemoryV2 {
  return {
    scheduleCommit: () => {},
    commitTick: () => 0,
    record: () => {},
    query: () => [],
    setRuntime: () => {},
    getRuntime: () => undefined,
    clearRuntime: () => {},
    snapshot: () => ({
      tasks: [],
      spatialCount: 0,
      objectCount: 0,
      eventCount: 0,
      userCount: 0,
      runtimeKeys: [],
      pendingCount: 0,
      dbConnected: false,
      eventArchivedCount: 0,
    }),
    inspect: () => ({
      taskCount: 0,
      spatialCount: 0,
      objectCount: 0,
      eventCount: 0,
      userCount: 0,
      pendingCount: 0,
      dbConnected: false,
      eventArchivedCount: 0,
    }),
    close: () => {},
  } as unknown as MemoryV2;
}

/** Stub GameAdapter – only chat() needs to work */
function makeStubGame(): GameAdapter {
  return {
    username: 'MineFriend',
    getPosition: () => ({ x: 0, y: 64, z: 0 }),
    getOrientation: () => ({ yaw: 0, pitch: 0 }),
    getVelocity: () => ({ x: 0, y: 0, z: 0 }),
    isOnGround: () => true,
    getHealth: () => 20,
    getFood: () => 20,
    getSaturation: () => 20,
    getExperienceLevel: () => 0,
    getSelectedSlot: () => 0,
    getGameMode: () => 'survival',
    getDimension: () => 'overworld',
    getTimeOfDay: () => 6000,
    isRaining: () => false,
    isThundering: () => false,
    getBlockAt: () => null,
    findBlocks: () => [],
    getEntities: () => [],
    getEntityById: () => null,
    getPlayers: () => ({}),
    getPlayer: () => null,
    getInventoryItems: () => [],
    getHeldItem: () => null,
    getFreeSlotCount: () => 36,
    setControlState: () => {},
    clearControlStates: () => {},
    lookAt: async () => {},
    look: async () => {},
    chat: () => {},
    attack: () => {},
    dig: async () => {},
    equip: async () => {},
    activateItem: () => {},
    deactivateItem: () => {},
    interactBlock: async () => {},
    placeBlock: async () => {},
    onChat: () => () => {},
    onWhisper: () => () => {},
    onHealthChange: () => () => {},
    onDeath: () => () => {},
    onSpawn: () => () => {},
  } as unknown as GameAdapter;
}

/** Stub PerceptionPipeline – returns a fixed world state */
function makeStubPerception(world: WorldStateView): PerceptionPipeline {
  return {
    getWorldState: () => world,
    perceive: () => world,
  } as unknown as PerceptionPipeline;
}

/**
 * Create a mock LLMClient whose call() returns responses from the provided queue.
 * Each call pops the next response string. If the queue is empty, returns null.
 */
function makeMockLLM(responses: string[]): LLMClient {
  const queue = [...responses];
  return {
    call: async (_prompt: string, _system?: string): Promise<string | null> => {
      return queue.shift() ?? null;
    },
    callWithTools: async (): Promise<LLMToolCallResult | null> => {
      return parseLegacyAsToolCall(queue.shift() ?? null);
    },
  } as unknown as LLMClient;
}

/**
 * JSON string that makes LLMToolLoop dispatch "ask_master"
 * (causes the loop to return { pendingAskMaster: true, ... })
 */
function askMasterResponse(): string {
  return JSON.stringify({
    thought: '需要问主人',
    action: {
      tool: 'ask_master',
      input: { text: '要 A 还是 B？' },
    },
  });
}

/**
 * JSON string that makes LLMToolLoop dispatch "say" (ends the turn normally)
 */
function sayResponse(): string {
  return JSON.stringify({
    thought: '回复主人',
    action: {
      tool: 'say',
      input: { text: '好的！' },
    },
  });
}

/** Build a MainBrain + its deps, returning both the instance and the bus */
function buildMainBrain(
  llm: LLMClient | null,
  world: WorldStateView,
  opts?: {
    idleEnabled?: boolean;
    isBenchActive?: () => boolean;
    onOwnerCancellation?: (message: string) => number;
    companion?: CompanionCore;
    isEmbodied?: () => boolean;
    getGamePresence?: () => GamePresenceState;
    memory?: MemoryV2;
  },
): { brain: MainBrain; bus: EventBusV2 } {
  const bus = new EventBusV2();
  const memory = opts?.memory ?? makeStubMemory();
  const game = makeStubGame();
  const perception = makeStubPerception(world);
  const tasks = new TaskRuntime(memory, bus);
  const resolver = new ResourceResolver();
  resolver.register(new InventoryProvider());
  const policy = new DecisionPolicy();

  const cfg: MainBrainConfig = {
    ownerName: 'TestOwner',
    botName: 'MineFriend',
    idleEnabled: opts?.idleEnabled ?? false,
  };

  const deps: MainBrainDeps = {
    bus,
    game,
    ownerName: 'TestOwner',
    llm,
    isBenchActive: opts?.isBenchActive,
    onOwnerCancellation: opts?.onOwnerCancellation,
    companion: opts?.companion,
    isEmbodied: opts?.isEmbodied,
    getGamePresence: opts?.getGamePresence,
    memory,
  };

  const brain = new MainBrain(deps, cfg);
  return { brain, bus };
}

/** Publish a chat.from_owner event and wait for async handlers to settle */
async function sendChat(bus: EventBusV2, message: string): Promise<void> {
  bus.publish('chat.from_owner', 'suggestion', {
    sender: 'TestOwner',
    message,
  });
  await flushMicrotasks();
}

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('MainBrain · pendingHistory', () => {

  /**
   * Case ①: First turn with LLM returning ask_master
   *   → pendingHistory saved (non-null after turn)
   *   → l7.turn_finished published with no error
   */
  it('① first turn: ask_master → pendingHistory saved', async () => {
    const world = makeWorld();
    const llm = makeMockLLM([askMasterResponse()]);
    const { brain, bus } = buildMainBrain(llm, world);

    const publishedEvents: string[] = [];
    bus.onAny(ev => publishedEvents.push(ev.type));

    // Send a chat that triggers a turn
    await sendChat(bus, 'MineFriend 帮我想想怎么种田');

    // l7.turn_finished must have been published (turn completed)
    assert.ok(
      publishedEvents.includes('l7.turn_finished'),
      `Expected l7.turn_finished, got: ${publishedEvents.join(', ')}`,
    );

    // pendingHistory must be saved (ask_master was reached)
    const pendingHistory = (brain as unknown as Record<string, unknown>)['pendingHistory'];
    assert.ok(
      pendingHistory !== null,
      'pendingHistory should be saved after ask_master turn',
    );
    assert.ok(
      Array.isArray(pendingHistory),
      'pendingHistory should be an array of HistoryEntry',
    );
    // The history should contain the ask_master call
    const history = pendingHistory as Array<{ call: { tool: string } }>;
    assert.ok(
      history.some(h => h.call.tool === 'ask_master'),
      'history should contain the ask_master call',
    );
  });

  /**
   * Case ②: Second chat after ask_master
   *   → pendingHistory taken and cleared after the resume turn
   *   → LLM receives the prior history (verified via call count)
   */
  it('② second chat: pendingHistory taken + cleared → resume turn', async () => {
    const world = makeWorld();

    // Track how many times LLM was called and whether history was passed
    let llmCallCount = 0;
    let secondCallPromptContainedHistory = false;

    const handleCall = (prompt: string): string | null => {
      llmCallCount++;
      if (llmCallCount === 1) {
        return askMasterResponse();
      }
      // Second call: verify prompt includes resume hint (FEAT-L7-07 把"恢复"提示放进了 system 段)
      if (prompt.includes('你已经做了') || prompt.includes('恢复') || prompt.includes('ask_master 后')) {
        secondCallPromptContainedHistory = true;
      }
      return sayResponse();
    };
    const mockLLM: LLMClient = {
      call: async (prompt: string, _system?: string): Promise<string | null> => handleCall(prompt),
      callWithTools: async (args: { messages: Array<{ role: string; content: string }> }): Promise<LLMToolCallResult | null> => {
        const promptText = args.messages.map(m => m.content).join('\n');
        return parseLegacyAsToolCall(handleCall(promptText));
      },
    } as unknown as LLMClient;

    const { brain, bus } = buildMainBrain(mockLLM, world);

    // First chat → triggers ask_master, pendingHistory saved
    await sendChat(bus, 'MineFriend 帮我想想怎么种田');

    const pendingAfterFirst = (brain as unknown as Record<string, unknown>)['pendingHistory'];
    assert.ok(pendingAfterFirst !== null, 'pendingHistory should be set after first ask_master turn');

    // Second chat → resumes the turn using pendingHistory
    await sendChat(bus, 'MineFriend 选 A 吧');

    // After the resume turn completes, pendingHistory should be cleared
    const pendingAfterSecond = (brain as unknown as Record<string, unknown>)['pendingHistory'];
    assert.equal(
      pendingAfterSecond,
      null,
      'pendingHistory should be cleared after a successful resume turn (no new ask_master)',
    );

    // LLM was called twice (once per turn)
    assert.ok(llmCallCount >= 2, `Expected at least 2 LLM calls, got ${llmCallCount}`);

    // Second call should have seen the prior history in the prompt
    assert.ok(
      secondCallPromptContainedHistory,
      'Second LLM call should include prior history in prompt (isResume=true)',
    );
  });

  /**
   * Case ③: Two chats racing → busy guard prevents double-processing
   *   The second chat arrives while the first turn is still running.
   *   busy=true should cause the second chat to be dropped.
   */
  it('③ busy guard: second chat while turn in progress → queued then processed', async () => {
    const world = makeWorld();

    let llmCallCount = 0;
    // Use a manual resolve to hold the first LLM call in-flight
    let resolveFirstCall!: (value: string) => void;
    const firstCallPromise = new Promise<string>(resolve => {
      resolveFirstCall = resolve;
    });

    const sharedHandler = async (): Promise<string | null> => {
      llmCallCount++;
      if (llmCallCount === 1) {
        return firstCallPromise;
      }
      return sayResponse();
    };
    const mockLLM: LLMClient = {
      call: async (_prompt: string, _system?: string): Promise<string | null> => sharedHandler(),
      callWithTools: async (): Promise<LLMToolCallResult | null> => {
        const raw = await sharedHandler();
        return parseLegacyAsToolCall(raw);
      },
    } as unknown as LLMClient;

    const { brain, bus } = buildMainBrain(mockLLM, world);

    const publishedEvents: { type: string; payload: unknown }[] = [];
    bus.onAny(ev => publishedEvents.push({ type: ev.type, payload: ev.payload }));

    // Fire first chat – the LLM call will block
    bus.publish('chat.from_owner', 'suggestion', {
      sender: 'TestOwner',
      message: 'MineFriend 帮我想想怎么种田',
    });
    // Yield enough for the handler to start and set busy=true
    await new Promise<void>(resolve => setImmediate(resolve));

    // busy should now be true; verify via internal state (busyBy !== null)
    const busyBeforeSecond = (brain as unknown as Record<string, unknown>)['busyBy'] as string | null;
    assert.equal(busyBeforeSecond !== null, true, 'brain should be busy after first chat starts');

    // Fire second chat while first is still in-flight
    bus.publish('chat.from_owner', 'suggestion', {
      sender: 'TestOwner',
      message: 'MineFriend 等等',
    });
    await new Promise<void>(resolve => setImmediate(resolve));

    // Only ONE LLM call should have been started (second chat dropped by busy guard)
    assert.equal(llmCallCount, 1, `Expected 1 LLM call (second chat dropped), got ${llmCallCount}`);

    // Now release the first call so it completes cleanly
    resolveFirstCall(sayResponse());
    await flushMicrotasks();

    // After the first turn finishes, busy resets to null (idle)
    const busyAfter = (brain as unknown as Record<string, unknown>)['busyBy'] as string | null;
    assert.equal(busyAfter, null, 'brain should not be busy after turn finishes');

    // LLM was called twice (second message was queued and processed after first finished)
    // New behavior: owner messages are never dropped, they queue up
    assert.equal(llmCallCount, 2, 'LLM should have been called twice (second chat queued then processed)');
  });

  it('④ owner FIFO：连续 10 条消息按到达顺序处理，不覆盖中间消息', async () => {
    const world = makeWorld();
    let calls = 0;
    let releaseFirst!: (value: string) => void;
    const first = new Promise<string>(resolve => { releaseFirst = resolve; });
    const llm: LLMClient = {
      call: async () => calls++ === 0 ? first : sayResponse(),
      callWithTools: async () => parseLegacyAsToolCall(calls++ === 0 ? await first : sayResponse()),
    } as unknown as LLMClient;
    const { bus } = buildMainBrain(llm, world);
    const started: string[] = [];
    bus.on('l7.turn_started', event => started.push(String((event.payload as { message: string }).message)));

    for (let i = 0; i < 10; i++) {
      bus.publish('chat.from_owner', 'suggestion', { sender: 'TestOwner', message: `MineFriend 消息-${i}` });
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseFirst(sayResponse());
    await flushMicrotasks();

    assert.deepEqual(started, Array.from({ length: 10 }, (_, i) => `MineFriend 消息-${i}`));
  });

  it('FEAT-CROSS-22 · SQLite restart restores pending replay then closes the pending lifecycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mainbrain-responses-pending-'));
    const filename = join(root, 'memory.sqlite');
    const replayUsage = {
      inputTokens: 20, outputTokens: 5, totalTokens: 25,
      cacheStatus: 'reported' as const, source: 'openai-responses',
    };
    let memory = new MemoryV2(filename);
    let firstBrain: MainBrain | undefined;
    let secondBrain: MainBrain | undefined;
    try {
      const firstLLM = {
        callWithTools: async (): Promise<LLMToolCallResult> => ({
          content: '',
          toolCalls: [{ id: 'pending-call', name: 'ask_master', arguments: { text: '要 A 还是 B？' } }],
          usage: replayUsage,
          canonical: {
            content: [
              { kind: 'reasoning', text: '' },
              { kind: 'tool-call', id: 'pending-call', name: 'ask_master', arguments: { text: '要 A 还是 B？' } },
            ],
            usage: replayUsage,
            replay: {
              kind: 'openai-native', version: 1, api: 'openai-responses',
              providerRoute: 'route-responses', model: 'gpt-test',
              blocks: [
                { type: 'reasoning', encrypted_content: 'opaque-pending', summary: [] },
                { type: 'function_call', call_id: 'pending-call' },
              ],
            },
          },
        }),
      } as unknown as LLMClient;
      const first = buildMainBrain(firstLLM, makeWorld(), { memory });
      firstBrain = first.brain;
      await sendChat(first.bus, 'MineFriend 帮我选方案');
      const pending = memory.query('conversation', { isPending: true });
      assert.equal(pending.length, 1);
      assert.match(pending[0]?.meta?.llmContinuation ?? '', /opaque-pending/);

      firstBrain.shutdown('restart-test');
      memory.close();
      memory = new MemoryV2(filename);
      let restoredMessages: Array<{ role: string; content: string; canonical?: unknown }> = [];
      const secondLLM = {
        callWithTools: async (args: { messages: typeof restoredMessages }): Promise<LLMToolCallResult> => {
          restoredMessages = structuredClone(args.messages);
          return {
            content: '',
            toolCalls: [{ id: 'say-after-restart', name: 'say', arguments: { text: '选 A 就好' } }],
          };
        },
      } as unknown as LLMClient;
      const second = buildMainBrain(secondLLM, makeWorld(), { memory });
      secondBrain = second.brain;
      await sendChat(second.bus, 'MineFriend 选 A');

      const restoredAssistant = restoredMessages.find(message => message.role === 'assistant') as {
        canonical?: { source?: { replay?: { blocks?: Array<Record<string, unknown> | null> } } };
      } | undefined;
      assert.equal(restoredAssistant?.canonical?.source?.replay?.blocks?.[0]?.encrypted_content, 'opaque-pending');
      assert.equal(memory.query('conversation', { isPending: true }).length, 0);
    } finally {
      firstBrain?.shutdown('test-cleanup');
      secondBrain?.shutdown('test-cleanup');
      memory.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

});

test('FEAT-CROSS-04：TestBench 运行期间，IDLE 节拍不会发起额外 LLM turn', async () => {
  let calls = 0;
  const llm = {
    call: async () => null,
    callWithTools: async () => { calls++; return null; },
  } as unknown as LLMClient;
  const { bus } = buildMainBrain(llm, makeWorld(), { idleEnabled: true, isBenchActive: () => true });
  const events: string[] = [];
  bus.onAny(event => events.push(event.type));

  bus.publish('heartbeat.rate_tick', 'info', { rate: TickRate.IDLE, tick: 150 });
  await flushMicrotasks();

  assert.equal(calls, 0);
  assert.ok(!events.includes('l7.idle_turn_started'));
});

test('BUG-CROSS-65：游戏身体在线时普通 IDLE 仍受 Companion 主动性关闭门约束', async () => {
  let calls = 0;
  const llm = {
    call: async () => null,
    callWithTools: async () => { calls++; return null; },
  } as unknown as LLMClient;
  const companion = new CompanionCore({
    profileId: 'profile-idle-gate',
    corePersona: { id: 'core-idle-gate', version: 1, traits: [], boundaries: [] },
  });
  const { bus } = buildMainBrain(llm, makeWorld(), {
    idleEnabled: true,
    companion,
    isEmbodied: () => true,
  });
  const decisions: Array<{ allowed: boolean; reason: string }> = [];
  bus.on('companion.initiative_decision', event => decisions.push(event.payload as typeof decisions[number]));

  bus.publish('heartbeat.rate_tick', 'info', { rate: TickRate.IDLE, tick: 150 });
  await flushMicrotasks();

  assert.equal(calls, 0);
  assert.deepEqual(decisions, [{ allowed: false, reason: 'disabled' }]);
});

test('BUG-CROSS-48: an IDLE tick must not repeat a fresh owner reply', async () => {
  let calls = 0;
  const llm = {
    call: async () => sayResponse(),
    callWithTools: async () => {
      calls++;
      return parseLegacyAsToolCall(sayResponse());
    },
  } as unknown as LLMClient;
  const { bus } = buildMainBrain(llm, makeWorld(), { idleEnabled: true });
  const events: string[] = [];
  bus.onAny(event => events.push(event.type));

  await sendChat(bus, 'MineFriend play tonight?');
  bus.publish('heartbeat.rate_tick', 'info', { rate: TickRate.IDLE, tick: 150 });
  await flushMicrotasks();

  assert.equal(calls, 1, 'only the owner-triggered brain turn may run');
  assert.ok(!events.includes('l7.idle_turn_started'));
});

test('BUG-CROSS-73-005: 纯取消先执行硬栅栏，仍保留 MainBrain 协议回合', async () => {
  let llmCalls = 0;
  const cancelledMessages: string[] = [];
  const llm = {
    call: async () => null,
    callWithTools: async () => { llmCalls++; return null; },
  } as unknown as LLMClient;
  const { bus } = buildMainBrain(llm, makeWorld(), {
    onOwnerCancellation: message => {
      cancelledMessages.push(message);
      return 1;
    },
  });

  await sendChat(bus, '别跟了');

  assert.deepEqual(cancelledMessages, ['别跟了']);
  assert.equal(llmCalls, 1, '硬取消后仍应进入 MainBrain 协议回合，不能直接 return');
});

test('BUG-CROSS-82: MainBrain 每轮现读身体态，且 owner 未观察不等于玩家离线', async () => {
  const systems: string[] = [];
  let presence: GamePresenceState = { embodied: false, ownerObservation: 'unknown' };
  const llm = {
    callWithTools: async (args: { messages: Array<{ role: string; content: string }> }) => {
      // FEAT-CROSS-28: 运行态在受控 context 消息（messages[1]），system 保持静态。
      systems.push(`${args.messages[0]?.content ?? ''}\n${args.messages[1]?.content ?? ''}`);
      return parseLegacyAsToolCall(sayResponse());
    },
  } as unknown as LLMClient;
  const { brain, bus } = buildMainBrain(llm, makeWorld(), {
    getGamePresence: () => presence,
  });

  await sendChat(bus, '你现在在哪？');
  presence = { embodied: true, ownerObservation: 'not_observed' };
  await sendChat(bus, '你看到我了吗？');

  assert.match(systems[0], /MinecraftBodyState=unembodied/);
  assert.match(systems[0], /does not prove the configured player is offline/);
  assert.doesNotMatch(systems[0], /^You are an embodied AI player/);
  assert.match(systems[1], /You are an embodied AI player operating inside a live Minecraft game world/);
  assert.match(systems[1], /owner=null does not prove the player is offline/);
  brain.shutdown('test_done');
});
