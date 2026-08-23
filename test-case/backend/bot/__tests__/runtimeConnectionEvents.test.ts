import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BotRuntime, plannerExperimentsEnabled, type BotRuntimeConfig } from '../../../../apps/minecraft-companion/src/bot/runtime.js';
import type { MineflayerConnection } from '../../../../apps/minecraft-companion/src/bot/mineflayer/connection.js';

const config: BotRuntimeConfig = {
  id: 'runtime-event-test',
  connection: {
    host: '127.0.0.1',
    port: 25565,
    username: 'RuntimeEventTest',
    auth: 'offline',
    reconnect: { enabled: false, maxRetries: 0, baseDelay: 1, maxDelay: 1 },
  },
  llm: { apiKey: 'test', baseUrl: 'http://127.0.0.1', model: 'test' },
  personality: { name: 'RuntimeEventTest', style: 'test', description: 'test', prompt: 'test' },
};

test('TC-L1-07: stable connection EventBus handlers are attached only once', () => {
  const runtime = new BotRuntime(config);
  const internal = runtime as unknown as {
    attachEventHandlers(): void;
    conn: MineflayerConnection;
  };
  let calls = 0;
  runtime.onChat = () => calls++;

  internal.attachEventHandlers();
  internal.attachEventHandlers();
  internal.conn.events.emit({
    type: 'chat',
    timestamp: Date.now(),
    data: { sender: 'owner', message: 'once' },
  });

  assert.equal(calls, 1);
});

test('Planner Candidate 实验授权可限制在固定 Profile', () => {
  assert.equal(plannerExperimentsEnabled(undefined,'profile-a','profile-a'),false);
  assert.equal(plannerExperimentsEnabled('authorized','profile-a','profile-a,profile-b'),true);
  assert.equal(plannerExperimentsEnabled('authorized','profile-c','profile-a,profile-b'),false);
  assert.equal(plannerExperimentsEnabled('authorized','profile-c',''),true);
});
