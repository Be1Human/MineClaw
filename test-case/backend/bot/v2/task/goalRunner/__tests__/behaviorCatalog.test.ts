import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorRegistry } from '../../../../../../../apps/minecraft-companion/src/bot/v2/behavior/behaviorRegistry.js';
import type { IBehavior } from '../../../../../../../apps/minecraft-companion/src/bot/v2/behavior/types.js';
import {
  behaviorCatalogText,
  buildInvokeBehaviorToolSchema,
  listBehaviorIds,
  resolvePlannerBehaviorId,
  shouldRetryRegisteredBehavior,
  validateBehaviorId,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/goalRunner/behaviorCatalog.js';

const behavior = (id: string): IBehavior => ({ id, kind: 'sequence', compile: () => [] });

describe('BUG-CROSS-40 · 注册表驱动的 Behavior 目录', () => {
  it('目录去重、过滤空 ID 并稳定排序', () => {
    const registry = new BehaviorRegistry();
    registry.register(behavior('farm_one_plot'));
    registry.register(behavior('combat'));
    registry.register(behavior('gather_block'));
    registry.register(behavior('farm_one_plot'));
    assert.throws(()=>registry.register(behavior('   ')),/invalid_behavior/);

    assert.deepEqual(listBehaviorIds(registry), ['combat', 'farm_one_plot', 'gather_block']);
    assert.equal(behaviorCatalogText(registry), 'combat, farm_one_plot, gather_block');
  });

  it('schema enum 精确投影当前注册表，热注册后自动更新', () => {
    const registry = new BehaviorRegistry();
    registry.register(behavior('combat'));
    const before = buildInvokeBehaviorToolSchema(registry)!;
    const beforeBehavior = before.function.parameters.properties.behavior as { enum: string[] };
    assert.deepEqual(beforeBehavior.enum, ['combat']);

    registry.register(behavior('farm_one_plot'));
    const after = buildInvokeBehaviorToolSchema(registry)!;
    const afterBehavior = after.function.parameters.properties.behavior as { enum: string[] };
    assert.deepEqual(afterBehavior.enum, ['combat', 'farm_one_plot']);
    assert.match(after.function.description, /farm_one_plot/);
    assert.doesNotMatch(after.function.description, /combat\/gather\/farm/);
  });

  it('空注册表不暴露 invoke_behavior', () => {
    const registry = new BehaviorRegistry();
    assert.equal(buildInvokeBehaviorToolSchema(registry), null);
  });

  it('非法别名同步返回可用 ID，精确 ID 通过', () => {
    const registry = new BehaviorRegistry();
    registry.register(behavior('farm_one_plot'));

    const bad = validateBehaviorId(registry, 'farm');
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.error, 'behavior_not_found: farm');
      assert.deepEqual(bad.available, ['farm_one_plot']);
    }
    assert.deepEqual(validateBehaviorId(registry, 'farm_one_plot'), { ok: true });
  });

  it('FEAT-CROSS-15-001-006 · 当前 PlanNode taskFamily 精确命中同名 Behavior', () => {
    const registry = new BehaviorRegistry();
    registry.register(behavior('combat'));
    registry.register(behavior('gather_block'));
    const plannerContext = {
      nodeId: 'fight',
      planGraph: {
        nodes: [
          { id: 'prepare', goal: { taskFamily: 'crafting' } },
          { id: 'fight', goal: { taskFamily: 'combat' } },
        ],
      },
    };

    assert.equal(resolvePlannerBehaviorId(registry, plannerContext), 'combat');
    assert.equal(resolvePlannerBehaviorId(registry, {
      ...plannerContext,
      nodeId: 'prepare',
    }), null);
    assert.equal(resolvePlannerBehaviorId(registry), null);
  });

  it('FEAT-CROSS-15-001-006 · 可重试的 Behavior 失败保持同一行为路由', () => {
    assert.equal(shouldRetryRegisteredBehavior('recovery', 'retry'), true);
    assert.equal(shouldRetryRegisteredBehavior('continued'), true);
    assert.equal(shouldRetryRegisteredBehavior('recovery', 'satisfy_prerequisite'), false);
    assert.equal(shouldRetryRegisteredBehavior('recovery', 'correct_proposal'), false);
    assert.equal(shouldRetryRegisteredBehavior('terminal'), false);
  });
});
