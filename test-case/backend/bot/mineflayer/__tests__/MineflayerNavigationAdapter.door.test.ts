import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'mineflayer';

import { MineflayerNavigationAdapter } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerNavigationAdapter.js';
import type { DoorPassageRequest } from '../../../../../apps/minecraft-companion/src/bot/adapter/NavigationAdapter.js';

interface Deferred {
  reject: (error: Error) => void;
}

function fixture() {
  let gotoCount = 0;
  let pending: Deferred | null = null;
  let forward = false;
  let clearCount = 0;
  let lookTarget = { x: 10.65, y: 65, z: 19.4 };
  const onceHandlers = new Map<string, () => void>();
  const position = { x: 10.5, y: 64, z: 19.4 };

  const pathfinder = {
    goto: () => {
      gotoCount++;
      if (gotoCount >= 2) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => { pending = { reject }; });
    },
    stop: () => {
      pending?.reject(new Error('PathStopped'));
      pending = null;
      const handler = onceHandlers.get('path_stop');
      onceHandlers.delete('path_stop');
      handler?.();
    },
    setGoal: () => {},
    isMoving: () => true,
  };

  const bot = {
    pathfinder,
    entity: { position },
    entities: {},
    players: {},
    on: () => {},
    once: (event: string, handler: () => void) => { onceHandlers.set(event, handler); },
    removeListener: (event: string, handler: () => void) => {
      if (onceHandlers.get(event) === handler) onceHandlers.delete(event);
    },
    lookAt: async (target: { x: number; y: number; z: number }) => { lookTarget = target; },
    setControlState: (key: string, value: boolean) => {
      if (key === 'forward') {
        forward = value;
        if (value) {
          position.x = lookTarget.x;
          position.z = lookTarget.z;
        }
      }
    },
    clearControlStates: () => { forward = false; clearCount++; },
  } as unknown as Bot;

  return {
    bot,
    get gotoCount() { return gotoCount; },
    get forward() { return forward; },
    get clearCount() { return clearCount; },
  };
}

const door: DoorPassageRequest = {
  position: { x: 10, y: 64, z: 20 },
  blockName: 'oak_door',
  properties: { facing: 'north', hinge: 'left', half: 'lower', open: 'true' },
};

describe('BUG-CROSS-08 · MineflayerNavigationAdapter 门事务', () => {
  it('BUG-CROSS-74 · idle stop is a no-op and cannot poison the next goto', async () => {
    let stopCount = 0;
    let gotoCount = 0;
    const pathfinder = {
      goto: () => { gotoCount += 1; return Promise.resolve(); },
      stop: () => { stopCount += 1; },
      setGoal: () => {},
      isMoving: () => false,
    };
    const bot = {
      pathfinder,
      entity: { position: { x: 0, y: 64, z: 0 } },
      entities: {}, players: {}, on: () => {}, clearControlStates: () => {},
    } as unknown as Bot;
    const nav = new MineflayerNavigationAdapter(() => bot);

    nav.stop();
    assert.equal(stopCount, 0);
    assert.deepEqual(
      await nav.goto({ type: 'block', position: { x: 2, y: 64, z: 0 } }),
      { ok: true },
    );
    assert.equal(gotoCount, 1);
  });

  it('内部 PathStopped 被消费，穿门后恢复同一 goto', async () => {
    const f = fixture();
    const nav = new MineflayerNavigationAdapter(() => f.bot, undefined, 1);
    const moving = nav.goto({ type: 'block', position: { x: 10, y: 64, z: 24 } }, { totalTimeout: 1_000 });
    await Promise.resolve();
    const passage = await nav.guideThroughDoor(door);
    assert.equal(passage.ok, true);
    assert.equal((await moving).ok, true);
    assert.equal(f.gotoCount, 2, '穿门后必须恢复原 goto');
    assert.equal(f.forward, false);
  });

  it('外部 stop 取消门事务并禁止恢复旧目标', async () => {
    const f = fixture();
    const nav = new MineflayerNavigationAdapter(() => f.bot, undefined, 10);
    const moving = nav.goto({ type: 'block', position: { x: 10, y: 64, z: 24 } }, { totalTimeout: 1_000 });
    await Promise.resolve();
    const passage = nav.guideThroughDoor(door);
    nav.stop();
    assert.deepEqual(await passage, { ok: false, reason: 'cancelled' });
    assert.deepEqual(await moving, { ok: false, reason: 'cancelled' });
    assert.equal(f.gotoCount, 1, '取消后不得恢复旧 goto');
    assert.equal(f.forward, false);
    assert.ok(f.clearCount >= 1);
  });
});
