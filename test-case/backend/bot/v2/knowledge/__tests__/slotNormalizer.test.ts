/**
 * FEAT-L7-13 · slotNormalizer 单元测试
 * 框架：node:test + node:assert/strict
 *
 * 覆盖设计文档 §6 风险点的 4 个历史 bug 场景：
 *   BUG-L7-02   · 同类去重合并（mergeKeys 白名单）
 *   BUG-CROSS-01 · 坐标对话兜底 + ownerPosition 别名归一
 *   gather 别名  · {"target":"dirt"} → material
 *   craft 别名   · {"name":"wooden_pickaxe"} → item
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskParams, mergePatchForReuse } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/slotNormalizer.js';
import type { NormalizableTaskDef, NormalizeContext } from '../../../../../../apps/minecraft-companion/src/bot/v2/knowledge/slotNormalizer.js';

const ctx = (ownerText = '', ownerName = 'CloudBoy'): NormalizeContext => ({
  recentOwnerText: () => ownerText,
  ownerName,
});

const GATHER_DEF: NormalizableTaskDef = {
  slots: {
    required: [{
      name: 'material',
      type: 'item',
      aliases: ['target', 'name', 'block', 'item', 'resource', 'blockName'],
      defaultFrom: ['dialogue'],
    }],
    optional: [{ name: 'count', type: 'number', defaultFrom: ['dialogue'] }],
  },
  mergeKeys: ['material', 'count', 'maxDistance'],
};

const CRAFT_DEF: NormalizableTaskDef = {
  slots: {
    required: [{
      name: 'item',
      type: 'item',
      aliases: ['target', 'name', 'itemName', 'material', 'recipe'],
      defaultFrom: ['dialogue'],
    }],
  },
  mergeKeys: ['item', 'count'],
};

const FOLLOW_DEF: NormalizableTaskDef = {
  slots: {
    required: [{ name: 'ownerName', type: 'entity', defaultFrom: ['dialogue', 'owner'] }],
    optional: [{
      name: 'targetPosition',
      type: 'location',
      aliases: ['ownerPosition'],
      defaultFrom: ['dialogue'],
    }],
  },
  mergeKeys: ['targetPosition', 'ownerPosition'],
};

describe('normalizeTaskParams · 别名归一', () => {
  it('gather 别名：{"target":"dirt"} → material=dirt（真服历史 bug）', () => {
    const { params, missingSlots } = normalizeTaskParams(GATHER_DEF, { target: 'dirt' }, ctx());
    assert.equal(params.material, 'dirt');
    assert.deepEqual(missingSlots, []);
  });

  it('craft 别名：{"name":"wooden_pickaxe"} → item=wooden_pickaxe', () => {
    const { params, missingSlots } = normalizeTaskParams(CRAFT_DEF, { name: 'wooden_pickaxe' }, ctx());
    assert.equal(params.item, 'wooden_pickaxe');
    assert.deepEqual(missingSlots, []);
  });

  it('正名优先于别名：material 已有值时不被 target 覆盖', () => {
    const { params } = normalizeTaskParams(GATHER_DEF, { material: 'oak_log', target: 'dirt' }, ctx());
    assert.equal(params.material, 'oak_log');
  });

  it('ownerPosition 坐标别名 → targetPosition', () => {
    const pos = { x: 1, y: 64, z: 2 };
    const { params } = normalizeTaskParams(FOLLOW_DEF, { ownerPosition: pos }, ctx());
    assert.deepEqual(params.targetPosition, pos);
  });
});

describe('normalizeTaskParams · defaultFrom 取值器', () => {
  it('dialogue/item：主人说"采点木头" → material=oak_log', () => {
    const { params, missingSlots } = normalizeTaskParams(GATHER_DEF, {}, ctx('去东边采点木头'));
    assert.equal(params.material, 'oak_log');
    assert.deepEqual(missingSlots, []);
  });

  it('dialogue/location：主人说"我在 520 -60 520" → targetPosition（BUG-CROSS-01 坐标兜底）', () => {
    const { params } = normalizeTaskParams(FOLLOW_DEF, {}, ctx('你过来，我在 520 -60 520'));
    assert.deepEqual(params.targetPosition, { x: 520, y: -60, z: 520 });
  });

  it('dialogue 命中时触发 onDialogueFill 回调（task.params_from_dialogue 事件源）', () => {
    const fills: Array<[string, unknown]> = [];
    const c = { ...ctx('我在 8 -60 0'), onDialogueFill: (s: string, v: unknown) => fills.push([s, v]) };
    normalizeTaskParams(FOLLOW_DEF, {}, c);
    assert.ok(fills.some(([s]) => s === 'targetPosition'));
  });

  it('owner：follow_owner 缺 ownerName → 注入配置主人名（原补名硬编码）', () => {
    const { params, missingSlots } = normalizeTaskParams(FOLLOW_DEF, {}, ctx('', 'CloudBoy'));
    assert.equal(params.ownerName, 'CloudBoy');
    assert.deepEqual(missingSlots, []);
  });

  it('dialogue 提取不到 → missingSlots 列出缺槽（clarify 槽门）', () => {
    const { missingSlots } = normalizeTaskParams(GATHER_DEF, {}, ctx('帮我个忙'));
    assert.deepEqual(missingSlots, ['material']);
  });

  it('无 def（未注册任务）→ 原样透传 · 零缺槽', () => {
    const { params, missingSlots } = normalizeTaskParams(undefined, { foo: 1 }, ctx());
    assert.deepEqual(params, { foo: 1 });
    assert.deepEqual(missingSlots, []);
  });
});

describe('mergePatchForReuse · 复用合并（BUG-L7-02 / BUG-CROSS-01 修①）', () => {
  it('白名单 = def.mergeKeys · 仅非空键入 patch', () => {
    const patch = mergePatchForReuse(GATHER_DEF, { material: 'dirt', count: null, junk: 'x' });
    assert.deepEqual(patch, { material: 'dirt' });
  });

  it('无 def → 通用兜底清单（与旧 MERGE_KEYS 一致）', () => {
    const patch = mergePatchForReuse(undefined, { targetPosition: { x: 1, y: 2, z: 3 }, plots: 2, junk: 'x' });
    assert.deepEqual(patch, { targetPosition: { x: 1, y: 2, z: 3 }, plots: 2 });
  });

  it('patch 内 ownerPosition → targetPosition 归一', () => {
    const pos = { x: 5, y: 64, z: 5 };
    const patch = mergePatchForReuse(FOLLOW_DEF, { ownerPosition: pos });
    assert.deepEqual(patch.targetPosition, pos);
  });
});
