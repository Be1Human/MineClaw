/**
 * L4 BehaviorRegistry 单元测试 · US-DOC-L4
 *
 * 8 个用例覆盖：
 *   ① register + get skill
 *   ② get unknown skill returns undefined
 *   ③ list returns all registered skills
 *   ④ register overwrites skill with same id
 *   ⑤ clear removes all skills
 *   ⑥ FollowBehavior: id='follow_owner', plan() 返回 ActionRequest[]
 *   ⑦ FarmBehavior: id='farm_one_plot', plan() 返回 5 步序列
 *   ⑧ CombatBehavior: id='combat', plan() 含 targetEntityId 时返回 4 步序列
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorRegistry } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/behaviorRegistry.js';
import type { IBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/types.js';
import { FollowBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/followBehavior.js';
import { FarmBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/farmBehavior.js';
import { CombatBehavior } from '../../../../../../apps/minecraft-companion/src/bot/v2/behavior/combatBehavior.js';
import type { WorldStateView } from '../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function makeMockSkill(id: string): IBehavior {
  return {
    id,
    kind: 'sequence', compile: (_ctx) => [],
  };
}

function makeWorldState(overrides: Partial<WorldStateView> = {}): WorldStateView {
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
    owner: null,
    environment: {
      dimension: 'overworld',
      timeOfDay: 0,
      isDay: true,
      isRaining: false,
    },
    entities: [],
    inventory: {
      items: [],
      held: null,
      freeSlots: 9,
    },
    taskContext: null,
    ...overrides,
  } as WorldStateView;
}

// ─────────────────────────────────────────────────────────
// BehaviorRegistry 基础行为
// ─────────────────────────────────────────────────────────

describe('BehaviorRegistry', () => {
  test('① register + get skill', () => {
    const reg = new BehaviorRegistry();
    const skill = makeMockSkill('test_skill');
    reg.register(skill);
    assert.equal(reg.get('test_skill'), skill);
  });

  test('② get unknown skill returns undefined', () => {
    const reg = new BehaviorRegistry();
    assert.equal(reg.get('nonexistent'), undefined);
  });

  test('③ list returns all registered skills', () => {
    const reg = new BehaviorRegistry();
    reg.register(makeMockSkill('skill_a'));
    reg.register(makeMockSkill('skill_b'));
    const list = reg.list();
    assert.equal(list.length, 2);
    assert.ok(list.some(s => s.id === 'skill_a'));
    assert.ok(list.some(s => s.id === 'skill_b'));
  });

  test('④ register overwrites skill with same id', () => {
    const reg = new BehaviorRegistry();
    const s1 = makeMockSkill('dup');
    const s2: IBehavior = { id: 'dup', kind: 'sequence', compile: () => [] };
    reg.register(s1);
    reg.register(s2);
    assert.equal(reg.get('dup'), s2);
  });

  test('⑤ clear removes all skills', () => {
    const reg = new BehaviorRegistry();
    reg.register(makeMockSkill('a'));
    reg.register(makeMockSkill('b'));
    reg.clear();
    assert.equal(reg.list().length, 0);
  });
});

// ─────────────────────────────────────────────────────────
// 具体技能验证
// ─────────────────────────────────────────────────────────

describe('FollowBehavior', () => {
  test('⑥ id=follow_owner, plan() 按距离返回 ActionRequest[]', () => {
    const skill = new FollowBehavior();
    assert.equal(skill.id, 'follow_owner');

    // owner 距离 2 → 已到位 → 空数组
    const world1 = makeWorldState({
      owner: {
        username: 'owner',
        position: { x: 1, y: 64, z: 0 },
        distance: 2,
        entityId: 100,
      },
    } as any);
    const result1 = skill.compile({ world: world1 });
    assert.ok(Array.isArray(result1));
    assert.equal(result1.length, 0);

    // owner 距离 10 → follow_entity
    const world2 = makeWorldState({
      owner: {
        username: 'owner',
        position: { x: 10, y: 64, z: 0 },
        distance: 10,
        entityId: 100,
      },
    } as any);
    const result2 = skill.compile({ world: world2 });
    assert.ok(Array.isArray(result2));
    assert.equal(result2.length, 1);
    assert.equal(result2[0]!.type, 'follow_entity');
  });
});

describe('FarmBehavior', () => {
  test('⑦ id=farm_one_plot, plan() 返回 5 步序列（equip→look→till→look→seed）', () => {
    const skill = new FarmBehavior();
    assert.equal(skill.id, 'farm_one_plot');

    const world = makeWorldState();
    const result = skill.compile({
      world,
      taskParams: { seedName: 'wheat_seeds', hoeName: 'wooden_hoe' },
    });

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 5);
    assert.equal(result[0]!.type, 'equip');
    assert.equal(result[1]!.type, 'look_at');
    assert.equal(result[2]!.type, 'use_tool');
    assert.equal(result[3]!.type, 'look_at');
    assert.equal(result[4]!.type, 'place_block');
  });
});

describe('CombatBehavior', () => {
  test('combat has exactly one adaptive execution entry', () => {
    const behavior = new CombatBehavior();
    assert.equal(behavior.id,'combat');
    assert.equal(behavior.kind,'adaptive');
    assert.equal(typeof behavior.run,'function');
    assert.equal('compile' in behavior,false);
    assert.equal('plan' in behavior,false);
  });
  test('registry rejects mixed adaptive/sequence definitions', () => {
    const registry=new BehaviorRegistry();
    assert.throws(()=>registry.register({id:'invalid',kind:'adaptive',compile:()=>[],run:async()=>({ok:true})} as never),/invalid_behavior/);
  });
});
