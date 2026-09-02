import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { runControlledAtomic as executeAtomic, type AtomicFixture as AtomicContext } from '../../__tests__/mocks/controlledAtomic.js';
import { __setTuningOverride } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';
import type { ActionRequest } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

describe('BUG-CROSS-60 · toss_item stable delivery receipt', () => {
  before(() => __setTuningOverride({ atomic: { verifyEnabled: false, tossSettleMs: 20 } }));
  after(() => __setTuningOverride(null));

  it('publishes success only when the tossed item remains outside Bot inventory', async () => {
    const inventory = [{ name: 'iron_pickaxe', count: 1, slot: 0 }];
    const events: string[] = [];
    const ctx = context(inventory, events, async () => { inventory.splice(0); return 1; });

    const result = await executeAtomic(request(), ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(events.filter(type => type === 'atomic.toss_item.success'), ['atomic.toss_item.success']);
  });

  it('fails without a success receipt when Bot picks the item back up during settlement', async () => {
    const inventory = [{ name: 'iron_pickaxe', count: 1, slot: 0 }];
    const events: string[] = [];
    const ctx = context(inventory, events, async () => {
      inventory.splice(0);
      setTimeout(() => inventory.push({ name: 'iron_pickaxe', count: 1, slot: 0 }), 5);
      return 1;
    });

    const result = await executeAtomic(request(), ctx);

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /toss_reacquired_or_unsettled/);
    assert.equal(events.includes('atomic.toss_item.success'), false);
  });

  it('fails without a delivery receipt when the tossed item remains on the ground', async () => {
    const inventory = [{ name: 'iron_pickaxe', count: 1, slot: 0 }];
    const events: string[] = [];
    const ground: Array<{
      id: number; name: string; type: string; position: { x: number; y: number; z: number };
      droppedItem: { name: string; count: number };
    }> = [];
    const ctx = context(inventory, events, async () => {
      inventory.splice(0);
      ground.push({
      id: 77, name: 'item', type: 'object', position: { x: -3, y: 64, z: 0 },
      droppedItem: { name: 'iron_pickaxe', count: 1 },
      });
      return 1;
    }, () => ground);

    const result = await executeAtomic(request(), ctx);

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /delivery_unverified/);
    assert.equal(events.includes('atomic.toss_item.success'), false);
  });

  it('keeps untargeted discard semantics without requiring a delivery settlement', async () => {
    const inventory = [{ name: 'iron_pickaxe', count: 1, slot: 0 }];
    const events: string[] = [];
    const ground = [{
      id: 78, name: 'item', type: 'object', position: { x: 0, y: 64, z: 0 },
      droppedItem: { name: 'iron_pickaxe', count: 1 },
    }];
    const ctx = context(inventory, events, async () => { inventory.splice(0); return 1; }, () => ground);
    const untargeted = request();
    untargeted.target = { itemName: 'iron_pickaxe', count: 1 };

    const result = await executeAtomic(untargeted, ctx);

    assert.equal(result.ok, true);
    assert.equal(events.includes('atomic.toss_item.success'), true);
  });

  it('accepts a grounded handoff inside the recipient pickup radius', async () => {
    const inventory = [{ name: 'iron_pickaxe', count: 1, slot: 0 }];
    const events: string[] = [];
    const ground: Array<{
      id: number; name: string; type: string; position: { x: number; y: number; z: number };
      droppedItem: { name: string; count: number };
    }> = [];
    const ctx = context(inventory, events, async () => {
      inventory.splice(0);
      ground.push({
        id: 79, name: 'item', type: 'object', position: { x: 1.4, y: 65, z: 0 },
        droppedItem: { name: 'iron_pickaxe', count: 1 },
      });
      return 1;
    }, () => ground);

    const result = await executeAtomic(request(), ctx);

    assert.equal(result.ok, true);
    assert.equal(events.includes('atomic.toss_item.success'), true);
  });
});

function request(): ActionRequest {
  return {
    id: 'deliver-1', source: 'deliver_to_owner', type: 'toss_item', priority: 30,
    interrupt_level: 'soft', resource: ['inventory'], preconditions: [], timeout_ms: 1_000,
    target: { itemName: 'iron_pickaxe', count: 1, position: { x: 1, y: 65, z: 0 } },
  };
}

function context(
  inventory: Array<{ name: string; count: number; slot: number }>,
  events: string[],
  toss: () => Promise<number>,
  getEntities: () => Array<{
    id: number; name: string; type: string; position: { x: number; y: number; z: number };
    droppedItem: { name: string; count: number };
  }> = () => [],
): AtomicContext {
  return {
    game: {
      getInventoryItems: () => inventory,
      getEntities,
      getEntityById: () => null,
      lookAt: async () => {},
      toss,
    } as never,
    nav: {} as never,
    bus: { publish: (type: string) => events.push(type) } as never,
  };
}
