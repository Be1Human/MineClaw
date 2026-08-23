/**
 * FEAT-WEBUI-07 · chunkGrid 纯函数单测
 * 运行：node --test apps/minecraft-companion/web/src/lib/__tests__/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkKeyOf, blockKey, takeDirtyChunks, selectEvictions } from '../../../../apps/minecraft-companion/web/src/lib/chunkGrid.js';

test('chunkKeyOf · 正坐标按 16 分组', () => {
  assert.equal(chunkKeyOf(0, 0), '0,0');
  assert.equal(chunkKeyOf(15, 15), '0,0');
  assert.equal(chunkKeyOf(16, 0), '1,0');
  assert.equal(chunkKeyOf(0, 16), '0,1');
  assert.equal(chunkKeyOf(31, 47), '1,2');
});

test('chunkKeyOf · 负坐标 floor 分组（-1 属于 chunk -1，-16 也属于 -1，-17 属于 -2）', () => {
  assert.equal(chunkKeyOf(-1, -1), '-1,-1');
  assert.equal(chunkKeyOf(-16, -16), '-1,-1');
  assert.equal(chunkKeyOf(-17, 0), '-2,0');
  assert.equal(chunkKeyOf(-32, -33), '-2,-3');
});

test('chunkKeyOf · 自定义 chunk 尺寸', () => {
  assert.equal(chunkKeyOf(7, 9, 8), '0,1');
  assert.equal(chunkKeyOf(8, 7, 8), '1,0');
});

test('blockKey · 四舍五入取整拼 key', () => {
  assert.equal(blockKey(1, 2, 3), '1,2,3');
  assert.equal(blockKey(1.4, 2.6, -3.5), '1,3,-3');
});

test('takeDirtyChunks · 限量出队且从集合移除', () => {
  const dirty = new Set(['a', 'b', 'c', 'd', 'e']);
  const batch = takeDirtyChunks(dirty, 2);
  assert.equal(batch.length, 2);
  assert.equal(dirty.size, 3);
  for (const k of batch) assert.ok(!dirty.has(k));
});

test('takeDirtyChunks · 集合小于上限时全部取出', () => {
  const dirty = new Set(['x']);
  const batch = takeDirtyChunks(dirty, 4);
  assert.deepEqual(batch, ['x']);
  assert.equal(dirty.size, 0);
});

test('takeDirtyChunks · 空集合返回空数组', () => {
  const dirty = new Set();
  assert.deepEqual(takeDirtyChunks(dirty, 4), []);
});

test('脏块标记语义 · 同 chunk 多方块只触发一次重建（Set 去重）', () => {
  const dirty = new Set();
  // 同一 chunk 内 3 个方块变化
  dirty.add(chunkKeyOf(1, 1));
  dirty.add(chunkKeyOf(5, 9));
  dirty.add(chunkKeyOf(15, 15));
  assert.equal(dirty.size, 1);
  // 跨 chunk 边界的方块各自标脏
  dirty.add(chunkKeyOf(16, 0));
  assert.equal(dirty.size, 2);
});

// ── BUG-WEBUI-04 · selectEvictions 防无限累积 ──
const bot0 = { x: 0, y: 0, z: 0 };
const bigCfg = { radiusXZ: 56, radiusY: 40, maxBlocks: 8000 };

test('selectEvictions · 半径内全保留', () => {
  const blocks = [
    { key: 'a', x: 10, y: 5, z: 10 },
    { key: 'b', x: -50, y: -30, z: 50 },
    { key: 'c', x: 56, y: 40, z: -56 }, // 恰在边界（不超过=保留）
  ];
  assert.deepEqual(selectEvictions(blocks, bot0, bigCfg), []);
});

test('selectEvictions · 超 XZ/Y 半径的远块被淘汰', () => {
  const blocks = [
    { key: 'near', x: 10, y: 0, z: 10 },
    { key: 'farX', x: 100, y: 0, z: 0 },   // 超 XZ
    { key: 'farZ', x: 0, y: 0, z: -90 },   // 超 XZ
    { key: 'farY', x: 0, y: 60, z: 0 },    // 超 Y
  ];
  const ev = selectEvictions(blocks, bot0, bigCfg).sort();
  assert.deepEqual(ev, ['farX', 'farY', 'farZ']);
});

test('selectEvictions · 半径内仍超 maxBlocks 时按最远补砍到上限', () => {
  // 5 个块全在半径内，maxBlocks=3 → 砍掉最远 2 个
  const blocks = [
    { key: 'd1', x: 1, y: 0, z: 0 },
    { key: 'd2', x: 2, y: 0, z: 0 },
    { key: 'd3', x: 3, y: 0, z: 0 },
    { key: 'd40', x: 40, y: 0, z: 0 },  // 远
    { key: 'd50', x: 50, y: 0, z: 0 },  // 最远
  ];
  const ev = selectEvictions(blocks, bot0, { radiusXZ: 56, radiusY: 40, maxBlocks: 3 }).sort();
  assert.deepEqual(ev, ['d40', 'd50']);
});

test('selectEvictions · 半径淘汰 + 总量兜底叠加', () => {
  const blocks = [
    { key: 'in1', x: 1, y: 0, z: 0 },
    { key: 'in2', x: 2, y: 0, z: 0 },
    { key: 'in3', x: 3, y: 0, z: 0 },
    { key: 'out', x: 200, y: 0, z: 0 }, // 半径外先淘汰
  ];
  // 半径外淘汰 out；剩 3 个超 maxBlocks=2 → 再砍最远 in3
  const ev = selectEvictions(blocks, bot0, { radiusXZ: 56, radiusY: 40, maxBlocks: 2 }).sort();
  assert.deepEqual(ev, ['in3', 'out']);
});

test('selectEvictions · 空输入返回空', () => {
  assert.deepEqual(selectEvictions([], bot0, bigCfg), []);
});
