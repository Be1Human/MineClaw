/**
 * pluginRuntimeBridge unit/assembly tests · FEAT-CROSS-26-001-004-004 (P3-4 step 1).
 * The composition-root bridge boots the committed generated index with injected
 * world ports; failures are structured, never thrown, and the observation ports
 * report unavailable instead of fabricating state.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRuntimePluginKernel,
  createRuntimeObservationPorts,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/pluginRuntimeBridge.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

function sampleWorld(overrides: Partial<WorldStateView> = {}): WorldStateView {
  return {
    tick: 42,
    timestamp: 1_700_000_000_000,
    self: {
      position: { x: 10, y: 64, z: -5 },
      yaw: 0.5,
      pitch: 0.1,
      health: 20,
      maxHealth: 20,
      food: 20,
      isOnGround: true,
    },
    owner: {
      username: 'cloudboyboy',
      position: { x: 11, y: 64, z: -4 },
      distance: 1.41,
      entityId: 77,
      isVisible: true,
    },
    environment: { dimension: 'minecraft:overworld', timeOfDay: 6000, isDay: true, isRaining: false },
    entities: [],
    inventory: {
      items: [
        { name: 'wheat_seeds', count: 8, slot: 0 },
        { name: 'iron_hoe', count: 1, slot: 1, durability: 100, maxDurability: 250 },
        { name: 'wheat', count: 12, slot: 2 },
      ],
      held: { name: 'iron_hoe', count: 1, slot: 1, durability: 100, maxDurability: 250 },
      freeSlots: 33,
    },
    taskContext: null,
    ...overrides,
  };
}

describe('buildRuntimePluginKernel', () => {
  test('I07 全链：生成索引 + 注入 world 端口 → 16 插件零失败 + slot/catalog/resolvers 就绪', async () => {
    const ports = createRuntimeObservationPorts(() => sampleWorld());
    const result = await buildRuntimePluginKernel({
      systemPorts: {
        // game/nav/bus 由组合根在真实装配时注入；这里省略验证缺端口时构造仍成功。
      },
    });
    // 观察端口不与 boot 阶段耦合；本用例验证 index 加载与 kernel boot 全链。
    void ports;
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.ok(result.slot !== null);
    assert.ok(result.resolvers !== null);
    assert.ok(result.catalog !== null);
    assert.ok(result.installed.length >= 16);
    // 系统插件在列
    assert.ok(result.installed.includes('mineclaw.minecraft-system'));
    assert.ok(result.installed.includes('mineclaw.storage-system'));
    assert.ok(result.installed.includes('mineclaw.llm-system'));
  });
});

describe('createRuntimeObservationPorts · inventory', () => {
  test('把 WorldStateView.inventory 映射为有界 slots，带耐久 metadataHash', async () => {
    const { inventory } = createRuntimeObservationPorts(() => sampleWorld());
    const out = await inventory.observe({
      subjectRef: 'self',
      maxSlots: 32,
      deadlineAt: Date.now() + 1000,
      signal: new AbortController().signal,
    });
    assert.equal(out.subjectRef, 'self');
    assert.equal(out.complete, true);
    assert.equal(out.truncated, false);
    assert.equal(out.slots.length, 3);
    assert.equal(out.slots[0].itemId, 'wheat_seeds');
    assert.equal(out.slots[1].itemId, 'iron_hoe');
    assert.equal(out.slots[1].metadataHash, '100/250');
    assert.equal(out.evidenceRefs.length, 1);
  });

  test('maxSlots 截断时 truncated=true 且 complete=false', async () => {
    const { inventory } = createRuntimeObservationPorts(() => sampleWorld());
    const out = await inventory.observe({
      subjectRef: 'self',
      maxSlots: 1,
      deadlineAt: Date.now() + 1000,
      signal: new AbortController().signal,
    });
    assert.equal(out.slots.length, 1);
    assert.equal(out.truncated, true);
    assert.equal(out.complete, false);
  });

  test('world 不可用时显式抛错（调用方转 unavailable，不伪造空背包）', async () => {
    const { inventory } = createRuntimeObservationPorts(() => null);
    await assert.rejects(
      inventory.observe({ subjectRef: 'self', maxSlots: 32, deadlineAt: 0, signal: new AbortController().signal }),
      /world_unavailable/,
    );
  });
});

describe('createRuntimeObservationPorts · owner', () => {
  test('owner 可见时给出位置与结构化 unavailable pointing（无 pitch/raycast 不得伪造）', async () => {
    const { owner } = createRuntimeObservationPorts(() => sampleWorld());
    const out = await owner.observe({ subjectRef: 'owner', signal: new AbortController().signal });
    assert.equal(out.ownerPosition?.x, 11);
    assert.equal(out.botPosition.x, 10);
    assert.equal(out.pointing.kind, 'unavailable');
    assert.match((out.pointing as { reason: string }).reason, /pitch|raycast/);
  });

  test('owner 不可见时返回 not_visible 分支', async () => {
    const { owner } = createRuntimeObservationPorts(() =>
      sampleWorld({
        owner: { username: 'cloudboyboy', position: null, distance: Infinity, entityId: null, isVisible: false },
      }),
    );
    const out = await owner.observe({ subjectRef: 'owner', signal: new AbortController().signal });
    assert.equal(out.ownerPosition, null);
    assert.equal(out.pointing.kind, 'not_visible');
  });

  test('world 不可用时显式抛错', async () => {
    const { owner } = createRuntimeObservationPorts(() => null);
    await assert.rejects(owner.observe({ subjectRef: 'owner', signal: new AbortController().signal }), /world_unavailable/);
  });
});
