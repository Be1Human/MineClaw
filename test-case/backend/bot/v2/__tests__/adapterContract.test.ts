/**
 * adapterContract.test.ts
 *
 * Verifies the L1 Adapter CONTRACT using MockGameAdapter + MockNavigationAdapter.
 * These tests do NOT test mineflayer — they test the interface specification.
 *
 * TC-L1-01 ~ TC-L1-08
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMockBot, MockNavigationAdapter } from './mocks/index.js';

describe('L1 Adapter Contract', () => {
  // TC-L1-01: getInventoryItems() returns RawItem[]
  test('TC-L1-01: GameAdapter.getInventoryItems() returns correct shape', () => {
    const { world, game } = createMockBot();
    world.addItem({ name: 'iron_pickaxe', count: 1, slot: 0, durability: 200, maxDurability: 250 });

    const items = game.getInventoryItems();

    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'iron_pickaxe');
    assert.equal(items[0].count, 1);
    assert.equal(items[0].slot, 0);
  });

  // TC-L1-02: World snapshot structure
  test('TC-L1-02: GameAdapter.getWorldSnapshot returns expected shape (position/health/food)', () => {
    const { world, game } = createMockBot();
    world.setPosition({ x: 10, y: 64, z: 20 });
    world.setHealth(18);
    world.self.food = 16;

    const pos = game.getPosition();
    const health = game.getHealth();
    const food = game.getFood();

    assert.deepEqual(pos, { x: 10, y: 64, z: 20 });
    assert.equal(health, 18);
    assert.equal(food, 16);
  });

  // TC-L1-03: NavigationAdapter.goto() returns {ok: boolean}
  test('TC-L1-03: NavigationAdapter.goto() returns NavResult with ok boolean', async () => {
    const { nav } = createMockBot();
    nav.gotoDelay = 10; // fast for test

    const result = await nav.goto({ type: 'block', position: { x: 5, y: 64, z: 5 } });

    assert.equal(typeof result.ok, 'boolean');
    assert.equal(result.ok, true);
  });

  // TC-L1-04: GameAdapter.sendChat() is called with correct string
  test('TC-L1-04: GameAdapter.sendChat() is called with correct string', () => {
    const { game } = createMockBot();

    game.chat('hello world');

    assert.equal(game.calls.chat.length, 1);
    assert.equal(game.calls.chat[0][0], 'hello world');
  });

  // TC-L1-05: NavigationAdapter.stopNavigation() cancels goto
  test('TC-L1-05: NavigationAdapter.stopNavigation() cancels goto', async () => {
    const nav = new MockNavigationAdapter();
    nav.gotoDelay = 300; // enough to still be "in progress" when stop is called

    const gotoPromise = nav.goto({ type: 'block', position: { x: 100, y: 64, z: 100 } });

    // Stop after a short delay (before goto finishes naturally)
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    nav.stop();

    // Goto should resolve (not hang)
    await gotoPromise;

    assert.ok(nav.calls.stop >= 1, 'stop() should have been called at least once');
    assert.equal(nav.isMoving(), false, 'isMoving() should be false after stop');
  });

  // TC-L1-06: RawItem.durability correctly propagated
  test('TC-L1-06: RawItem.durability correctly propagated from MockWorld', () => {
    const { world, game } = createMockBot();
    world.addItem({ name: 'iron_sword', count: 1, slot: 0, durability: 150, maxDurability: 250 });

    const items = game.getInventoryItems();
    const sword = items.find(i => i.name === 'iron_sword');

    assert.ok(sword !== undefined, 'sword should be in inventory');
    assert.equal(sword!.durability, 150);
    assert.equal(sword!.maxDurability, 250);
  });

  // TC-L1-07: GameAdapter event subscription and unsubscribe
  test('TC-L1-07: GameAdapter onChat subscription and unsubscribe work correctly', () => {
    const { game } = createMockBot();
    let count = 0;

    const unsub = game.onChat(() => { count++; });
    game.emitChat('Alice', 'hello');
    assert.equal(count, 1, 'handler should fire once before unsubscribe');

    unsub();
    game.emitChat('Alice', 'hello again');
    assert.equal(count, 1, 'handler should NOT fire after unsubscribe');
  });

  // TC-L1-08: NavigationAdapter.goto() returns ok:false on failure
  test('TC-L1-08: NavigationAdapter.goto() returns ok:false when shouldFail=true', async () => {
    const nav = new MockNavigationAdapter();
    nav.gotoDelay = 10;
    nav.shouldFail = true;

    const result = await nav.goto({ type: 'block', position: { x: 0, y: 64, z: 0 } });

    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
    assert.ok((result.reason ?? '').length > 0, 'reason should be a non-empty string');
  });

  // Bonus: items without durability return undefined (not 0)
  test('TC-L1-BONUS: items without durability have undefined (not 0) durability', () => {
    const { world, game } = createMockBot();
    world.addItem({ name: 'wheat_seeds', count: 16, slot: 1 }); // no durability fields

    const items = game.getInventoryItems();
    const seeds = items.find(i => i.name === 'wheat_seeds');

    assert.ok(seeds !== undefined, 'seeds should be in inventory');
    assert.equal(seeds!.durability, undefined, 'non-tool item durability should be undefined');
    assert.equal(seeds!.maxDurability, undefined);
  });
});
