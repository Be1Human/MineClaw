import assert from 'node:assert/strict';
import test from 'node:test';
import { MainBrain } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/mainBrain.js';
import { EventBusV2 } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/eventBus.js';
import { QueryRunner } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/knowledgeQueryRunner.js';
import { KnowledgeQueryPort } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/knowledgeQueryPort.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { PluginObservationProviderFactory } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/observation.js';

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

test('MainBrain 在自由表达前查询，并把机器验证的作物答案确定性说给玩家', async () => {
  const spoken: string[] = [];
  const game = { chat: (text: string) => spoken.push(text) } as unknown as GameAdapter;
  const bus = new EventBusV2();
  const events: string[] = [];
  bus.onAny(event => events.push(event.type));
  const provider: PluginObservationProviderFactory = {
    id: 'mineclaw.test.observation.crops', version: '1.0.0',
    descriptor: {
      id: 'mineclaw.test.observation.crops', version: '1.0.0', inputSchema: {}, resultSchema: {},
      factKinds: ['nearby_crops'], coverage: { dimension: ['overworld'], role: 'world' }, limits: {},
    },
    create: context => ({
      id: 'mineclaw.test.observation.crops', close: () => undefined,
      observe: async input => ({
        status: 'fulfilled',
        fact: {
          factKind: 'nearby_crops', snapshotVersion: 'world-1', observedAt: new Date().toISOString(),
          requestedBounds: input.scope, observedBounds: input.scope, complete: true, truncated: false,
          unloadedRegions: [], payload: { crops: [{ block: 'wheat', state: 'mature', position: { x: 1, y: 64, z: 1 } }], count: 1 },
          evidenceRefs: [{ ref: 'block:1', source: 'test', at: new Date().toISOString() }], contribution: context.identity,
        },
      }),
    }),
  };
  const port = new KnowledgeQueryPort({
    runner: new QueryRunner({ resolveProvider: kind => kind === 'nearby_crops' ? [provider] : [] }),
    sink: { deliver: async () => ({ accepted: true }) },
  });
  const brain = new MainBrain({
    bus, game, ownerName: 'Owner', knowledgeQueryPort: port,
    getRegistrySnapshot: () => ({ generationId: 'g1', buildId: 'b1', graphHash: 'h1' }),
  }, { ownerName: 'Owner', botName: 'MineFriend', idleEnabled: false });

  brain.handleDirectMessage('你旁边有什么农作物？');
  await settle();

  assert.equal(spoken.length, 1);
  assert.match(spoken[0]!, /wheat/);
  assert.match(spoken[0]!, /成熟 1/);
  assert.ok(events.includes('knowledge.intent.classified'));
  assert.ok(events.includes('knowledge.query.submitted'));
  assert.ok(events.includes('knowledge.answer.received'));
  brain.shutdown();
});
