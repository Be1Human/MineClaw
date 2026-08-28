import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectRadarEntities,
  radarCategoryPresentation,
} from '../../../../apps/minecraft-companion/web/src/lib/radarEntityProjection.js';

function world({ yaw = 0, entities = [], position = { x: 0, y: 64, z: 0 } } = {}) {
  return { self: { position, yaw }, entities };
}

function entity(id, x, z, category = 'other', overrides = {}) {
  return {
    id,
    name: `entity-${id}`,
    category,
    position: { x, y: 64, z },
    distance: Math.hypot(x, z),
    ...overrides,
  };
}

test('yaw=0 时伙伴前后左右分别投影到雷达上/下/左/右', () => {
  const result = projectRadarEntities(world({
    entities: [
      entity(1, 0, 10),
      entity(2, 10, 0),
      entity(3, 0, -10),
      entity(4, -10, 0),
    ],
  }));

  assert.deepEqual(result.markers.map(marker => [marker.xPercent, marker.yPercent]), [
    [50, 6],
    [94, 50],
    [50, 94],
    [6, 50],
  ]);
});

test('伙伴 yaw 旋转后仍以局部前方为雷达上方', () => {
  const result = projectRadarEntities(world({
    yaw: Math.PI / 2,
    entities: [entity(1, -10, 0), entity(2, 0, 10)],
  }));

  assert.deepEqual(result.markers.map(marker => [marker.xPercent, marker.yPercent]), [
    [50, 6],
    [94, 50],
  ]);
});

test('投影范围取当前最远合法实体并把标记约束在圆形边界内', () => {
  const result = projectRadarEntities(world({
    entities: [entity(1, 0, 5), entity(2, 0, 20)],
  }));

  assert.equal(result.range, 20);
  assert.equal(result.rangeLabel, '20');
  assert.equal(result.markers[0].yPercent, 39);
  assert.equal(result.markers[0].edge, false);
  assert.equal(result.markers[1].yPercent, 6);
  assert.equal(result.markers[1].edge, true);
});

test('六类实体具有稳定展示语义，未知分类回退为 other', () => {
  assert.deepEqual(
    ['player', 'hostile', 'passive', 'neutral', 'item', 'other', 'modded'].map(category => radarCategoryPresentation(category)),
    [
      { key: 'player', label: '玩家' },
      { key: 'hostile', label: '敌对生物' },
      { key: 'passive', label: '被动生物' },
      { key: 'neutral', label: '中立生物' },
      { key: 'item', label: '掉落物' },
      { key: 'other', label: '其他实体' },
      { key: 'other', label: '其他实体' },
    ],
  );
});

test('无世界状态和非法实体安全返回空投影', () => {
  assert.deepEqual(projectRadarEntities(null), { range: 0, rangeLabel: '—', total: 0, markers: [] });
  assert.deepEqual(projectRadarEntities(world({
    entities: [
      entity(1, Number.NaN, 1),
      { id: 2, name: 'missing-position', category: 'player' },
      entity(3, 1, Number.POSITIVE_INFINITY),
    ],
  })), { range: 0, rangeLabel: '—', total: 0, markers: [] });
});

test('标记保留真实名称、类别、距离和同点实体节点', () => {
  const result = projectRadarEntities(world({
    entities: [
      entity(7, 0, 0, 'player', { name: 'Alex', distance: 2.25 }),
      entity(8, 0, 0, 'hostile', { name: 'zombie', distance: 2.25 }),
    ],
  }));

  assert.equal(result.total, 2);
  assert.equal(result.markers[0].description, 'Alex · 玩家 · 2.3 格');
  assert.equal(result.markers[1].description, 'zombie · 敌对生物 · 2.3 格');
  assert.notEqual(result.markers[0].id, result.markers[1].id);
  assert.deepEqual(result.markers.map(marker => [marker.xPercent, marker.yPercent]), [[50, 50], [50, 50]]);
});

test('感知上限 32 个实体全部投影且保持在雷达边界内', () => {
  const entities = Array.from({ length: 32 }, (_, index) => {
    const angle = (index / 32) * Math.PI * 2;
    const distance = index + 1;
    return entity(index + 1, Math.sin(angle) * distance, Math.cos(angle) * distance);
  });

  const result = projectRadarEntities(world({ entities }));

  assert.equal(result.total, 32);
  assert.equal(result.markers.length, 32);
  assert.ok(result.markers.every(marker => marker.xPercent >= 6 && marker.xPercent <= 94));
  assert.ok(result.markers.every(marker => marker.yPercent >= 6 && marker.yPercent <= 94));
});
