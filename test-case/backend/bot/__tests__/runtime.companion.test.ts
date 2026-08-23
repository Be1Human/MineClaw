import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BotRuntime } from '../../../../apps/minecraft-companion/src/bot/runtime.js';
import { NullGameAdapter, NullNavAdapter } from '../../../../apps/minecraft-companion/src/bot/adapter/index.js';

describe('FEAT-CROSS-08/09 · BotRuntime 陪伴连续性', () => {
  it('TC-COMP-07：进出游戏不重建 V2Runtime 或 CompanionCore', async () => {
    const runtime = new BotRuntime({
      id: 'companion-runtime-test',
      connection: {
        host: 'localhost', port: 25565, username: 'CompanionTest', auth: 'offline',
        reconnect: { enabled: false, maxRetries: 0, baseDelay: 1, maxDelay: 1 },
      },
      llm: { apiKey: '', baseUrl: '', model: '' },
      personality: { name: 'CompanionTest', style: '温和', description: '温和且诚实', prompt: '温和且诚实' },
    });

    let connected = false;
    const realGame = new NullGameAdapter('CompanionTest');
    const realNav = new NullNavAdapter();
    (runtime as unknown as { conn: unknown }).conn = {
      isConnected: () => connected,
      getStatus: () => connected ? 'connected' : 'disconnected',
      setNavLogger: () => {},
      connect: async () => { connected = true; },
      disconnect: async () => { connected = false; },
      gameAdapter: realGame,
      navAdapter: realNav,
      events: { on: () => () => {} },
      getBot: () => ({ chat: () => {} }),
    };
    let worldUiPushes = 0;
    runtime.onV2WorldUiView = () => { worldUiPushes++; };

    await runtime.start();
    const runtimeView = runtime as unknown as {
      v2: {
        companion: unknown;
        tasks: {
          createTask(kind: string, params: Record<string, unknown>): { id: string };
          start(id: string, world: unknown): void;
          list(): Array<{ state: string; kind: string }>;
        };
        perception: { perceive(): unknown };
      };
    };
    const before = runtimeView.v2;
    const companion = runtimeView.v2.companion;
    assert.ok(before);
    assert.equal(
      (runtime as unknown as { v2PushInterval: unknown }).v2PushInterval,
      null,
      '无身体陪伴态不得启动游戏世界状态推送',
    );

    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(
      runtimeView.v2.tasks.list().some(task => ['pending', 'running', 'paused'].includes(task.state)),
      false,
      '陪聊态运行多个 tick 不得从 NullGame 创建身体任务',
    );

    const joined = await runtime.joinGame();
    assert.equal(joined.ok, true);
    assert.equal((runtime as unknown as { v2: unknown }).v2, before);
    assert.equal((runtime as unknown as { v2: { companion: unknown } }).v2.companion, companion);
    const firstPushInterval = (runtime as unknown as { v2PushInterval: unknown }).v2PushInterval;
    assert.ok(firstPushInterval, '热挂载游戏身体后必须启动世界状态推送');
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.ok(worldUiPushes >= 1, '热挂载后 1 秒内应产生 WorldUiView 回调');

    const joinedAgain = await runtime.joinGame();
    assert.equal(joinedAgain.ok, true);
    assert.equal(
      (runtime as unknown as { v2PushInterval: unknown }).v2PushInterval,
      firstPushInterval,
      '重复进服不得创建第二个世界状态推送定时器',
    );
    assert.deepEqual(realNav.getMovementOptionsForDebug(), {
      canDig: false,
      canPlace: true,
      canOpenDoors: false,
      allowParkour: true,
      allowSprinting: true,
      scafoldingBlocks: ['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack'],
    }, 'Companion→Game 热挂载必须在首次导航前安装安全 Movements');

    const bodyTask = runtimeView.v2.tasks.createTask('goto_position', {
      targetPosition: { x: 10, y: 64, z: 0 },
    });
    runtimeView.v2.tasks.start(bodyTask.id, runtimeView.v2.perception.perceive());
    assert.equal(runtimeView.v2.tasks.list().some(task => task.state === 'running'), true);

    await runtime.leaveGame();
    assert.equal((runtime as unknown as { v2: unknown }).v2, before);
    assert.equal((runtime as unknown as { v2: { companion: unknown } }).v2.companion, companion);
    assert.equal(
      (runtime as unknown as { v2PushInterval: unknown }).v2PushInterval,
      null,
      '离开游戏必须停止世界状态推送',
    );
    const pushesAfterLeave = worldUiPushes;
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal(worldUiPushes, pushesAfterLeave, '离开游戏后不得继续推送旧世界状态');
    assert.equal(
      runtimeView.v2.tasks.list().some(task => ['pending', 'running', 'paused'].includes(task.state)),
      false,
      '离开游戏必须取消全部非终态身体任务',
    );

    const rejoined = await runtime.joinGame();
    assert.equal(rejoined.ok, true);
    assert.ok(
      (runtime as unknown as { v2PushInterval: unknown }).v2PushInterval,
      '重新进服必须恢复世界状态推送',
    );
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.ok(worldUiPushes > pushesAfterLeave, '重新进服后 WorldUiView 回调必须恢复');

    await runtime.stop();
    assert.equal(
      (runtime as unknown as { v2PushInterval: unknown }).v2PushInterval,
      null,
      '完全停止后不得残留世界状态推送定时器',
    );
  });
});
