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
import type { GameView } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import { GenerationRuntimeProjection } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/runtimeProjection.js';
import { GenerationDomainKnowledgePort, GenerationSkillKnowledgePort } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/generationResources.js';
import type { GoalAgentStateV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/task/goalAgent/goalAgentState.js';

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
  test('I07 全链：生成索引 + 注入 world 端口 → 17 插件零失败 + slot/catalog/resolvers 就绪', async () => {
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
    assert.ok(result.installed.length >= 17);
    // 系统插件在列
    assert.ok(result.installed.includes('mineclaw.minecraft-system'));
    assert.ok(result.installed.includes('mineclaw.storage-system'));
    assert.ok(result.installed.includes('mineclaw.llm-system'));
    assert.ok(result.installed.includes('mineclaw.agent-guidance'));
  });

  test('P2-6 Skill/Knowledge 内容由发布代提供，不依赖运行时目录扫描', async () => {
    const result = await buildRuntimePluginKernel({ buildId: 'resource-test' });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.ok(result.slot);
    const projection = new GenerationRuntimeProjection(result.slot, '2.0.0');
    const snapshot = projection.activeSnapshot();
    const skills = new GenerationSkillKnowledgePort(() => result.slot, () => snapshot);
    const agriculture = skills.search({ query: '种田', objective: 'plan', limit: 4 })[0];
    assert.equal(agriculture?.name, '农活种植');
    assert.match(agriculture?.evidenceRef ?? '', /mineclaw\.agent-guidance@1\.0\.0/);
    const skill = skills.get({ ref: agriculture!.ref, expectedVersion: agriculture!.version });
    assert.equal(skill.ok, true);
    if (skill.ok) assert.match(skill.skill.body, /不能编造玩家视线/);

    const knowledge = new GenerationDomainKnowledgePort(() => result.slot, () => snapshot);
    const found = knowledge.search({ query: '农田周围放火把', limit: 4 })[0];
    assert.equal(found?.id, 'agriculture-basics');
    const document = knowledge.get({ ref: found!.ref, expectedVersion: found!.version });
    assert.equal(document.ok, true);
    if (document.ok) assert.match(document.document.body, /组合“农业观察”与“放置火把”能力/);
  });

  test('P3-3 固定 Generation 可从“火把”目标发现合成候选并保持精确贡献身份', async () => {
    const world = sampleWorld();
    const observation = createRuntimeObservationPorts(() => world);
    const result = await buildRuntimePluginKernel({
      systemPorts: {
        blockObservation: observation.block,
        inventoryObservation: observation.inventory,
        ownerContextObservation: observation.owner,
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.ok(result.slot);
    const projection = new GenerationRuntimeProjection(result.slot, '2.0.0');
    const snapshot = projection.activeSnapshot();
    const torch = projection.goalTargets(snapshot).find(target => target.registryId === 'minecraft:torch');
    assert.ok(torch);
    assert.ok(torch.aliases.includes('火把'));

    const provider = projection.actionProviders(snapshot)
      .find(candidate => candidate.id === 'mineclaw.crafting.planning.craft-candidates');
    assert.ok(provider);
    const state = {
      sessionId: 'projection-test', requestId: 'request-1', epoch: 1,
      request: { requestText: '帮我做一个火把' },
      plan: { revision: 1 }, budget: { maxActions: 4, actions: 0 },
    } as unknown as GoalAgentStateV1;
    const candidates = await provider.list({
      state,
      criteria: [{ type: 'inventory', item: 'torch', count: 1 }],
      goalText: '帮我做一个火把',
      world,
      signal: new AbortController().signal,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.action, 'invoke_behavior');
    assert.equal(candidates[0]?.operationRef?.pluginId, 'mineclaw.crafting');
    assert.equal(candidates[0]?.operationRef?.contributionId, 'mineclaw.crafting.execution.craft-item');
    assert.deepEqual(candidates[0]?.fixedArgs?.behaviorParams, { item: 'torch' });
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

describe('createRuntimeObservationPorts · block', () => {
  test('经 GameView 读取真实方块属性，并按 owner 锚点、上限和范围形成证据', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const game = {
      getDimension: () => 'overworld',
      findBlocks: (input: Record<string, unknown>) => {
        calls.push(input);
        return [{ x: 12, y: 64, z: -3 }, { x: 13, y: 64, z: -3 }];
      },
      getBlockAt: (position: { x: number; y: number; z: number }) => ({ name: 'wheat', position }),
      getBlockProperties: () => ({ age: '7' }),
    } as unknown as GameView;
    const { block } = createRuntimeObservationPorts(() => sampleWorld(), game);
    const out = await block.observe({
      dimension: 'minecraft:overworld',
      bounds: { radius: 8, anchor: { kind: 'owner' } },
      blockFilter: ['wheat'],
      maxBlocks: 1,
      deadlineAt: Date.now() + 1000,
      signal: new AbortController().signal,
    });
    assert.deepEqual(calls[0]?.origin, { x: 11, y: 64, z: -4 });
    assert.equal(calls[0]?.count, 2);
    assert.equal(out.blocks.length, 1);
    assert.deepEqual(out.blocks[0]?.properties, { age: '7' });
    assert.equal(out.truncated, true);
    assert.equal(out.complete, false);
    assert.ok(out.evidenceRefs.includes('world:tick:42'));
  });

  test('缺少真实 GameView 时显式 unavailable，不再伪造完整空扫描', async () => {
    const { block } = createRuntimeObservationPorts(() => sampleWorld());
    await assert.rejects(block.observe({
      dimension: 'overworld', bounds: { radius: 8 }, blockFilter: ['wheat'], maxBlocks: 4,
      deadlineAt: Date.now() + 1000, signal: new AbortController().signal,
    }), /block_observation_unavailable/);
  });
});
