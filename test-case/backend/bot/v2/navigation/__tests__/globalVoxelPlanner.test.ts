/**
 * GlobalVoxelPlanner · 单元测试（FEAT-L1-02 Phase 2）
 *
 * 覆盖测试用例文档（融合寻路Phase2）中的 T1~T5：
 *   T1 · strict 模式 · 已知区域直线路径
 *   T2 · strict 模式 · 未知格阻断
 *   T3 · frontier 模式 · 停在未知格边界
 *   T4 · 迭代上限保护
 *   T5 · 高度差场景
 *
 * 不依赖 SQLite / 真实 WorldMapStore，用内存 MockWorldMapStore。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GlobalVoxelPlannerImpl } from '../../../../../../apps/minecraft-companion/src/bot/v2/navigation/globalVoxelPlanner.js';
import type {
  StoredBlock,
  WorldMapStore,
  WorldMapStats,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/worldMapStore.js';

// ──────────────────────────────────────────────────────────────────
// Mock WorldMapStore
// ──────────────────────────────────────────────────────────────────

class MockWorldMapStore implements WorldMapStore {
  private blocks = new Map<string, StoredBlock>();

  setBlock(x: number, y: number, z: number, blockName: string, boundingBox: 'block' | 'empty'): void {
    this.blocks.set(key(x, y, z), {
      x, y, z, blockName, boundingBox, updatedAt: Date.now(),
    });
  }

  /** 给一段长方体批量填同样的方块（含端点）*/
  fillBox(
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    blockName: string, boundingBox: 'block' | 'empty',
  ): void {
    for (let x = x1; x <= x2; x++)
      for (let y = y1; y <= y2; y++)
        for (let z = z1; z <= z2; z++)
          this.setBlock(x, y, z, blockName, boundingBox);
  }

  // ── WorldMapStore 接口 ──
  getBlock(x: number, y: number, z: number): StoredBlock | null {
    return this.blocks.get(key(x, y, z)) ?? null;
  }
  upsertBatch(_blocks: StoredBlock[]): void { /* 不需要 */ }
  getRegion(): StoredBlock[] { return []; }
  chunkHasData(): boolean { return true; }
  getStats(): WorldMapStats { return { totalBlocks: this.blocks.size, chunksWithData: 1 }; }
  close(): void { /* noop */ }
  decayConfidence(): number | null { return null; }
  forgetBlock(): void { /* noop */ }
  updateBlock(): void { /* noop */ }
}

function key(x: number, y: number, z: number): string { return `${x}:${y}:${z}`; }

/**
 * 铺一条沿 X 轴的 walkable 走廊：
 *   ground (y-1) = stone(block) · feet (y) = air(empty) · head (y+1) = air(empty)
 */
function fillCorridorX(
  store: MockWorldMapStore,
  xMin: number, xMax: number, y: number, z: number,
): void {
  for (let x = xMin; x <= xMax; x++) {
    store.setBlock(x, y - 1, z, 'stone', 'block');
    store.setBlock(x, y,     z, 'air',   'empty');
    store.setBlock(x, y + 1, z, 'air',   'empty');
  }
}

// ──────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────

describe('GlobalVoxelPlanner · FEAT-L1-02', () => {

  // T1 · strict 模式：已知区域直线路径
  it('T1 · strict 已知区域 → success=true · 路径首尾贴近 start/goal', () => {
    const store = new MockWorldMapStore();
    fillCorridorX(store, -2, 52, 64, 0);

    const planner = new GlobalVoxelPlannerImpl(store);
    const result = planner.plan({ x: 0, y: 64, z: 0 }, { x: 50, y: 64, z: 0 }, {
      unknownPolicy: 'strict',
    });

    assert.equal(result.success, true);
    assert.ok(result.path.length > 0);
    // 首节点应是 start
    assert.equal(result.path[0].x, 0);
    assert.equal(result.path[0].z, 0);
    // 末节点应是 goal
    const last = result.path[result.path.length - 1];
    assert.equal(last.x, 50);
    assert.equal(last.z, 0);
  });

  // T2 · strict 模式：未知格阻断
  it('T2 · strict + 中间未知列 → success=false · 路径空', () => {
    const store = new MockWorldMapStore();
    // 走廊 0..24 + 26..50（中间 x=25 整列没有任何记忆）
    fillCorridorX(store, -2, 24, 64, 0);
    fillCorridorX(store, 26, 52, 64, 0);

    const planner = new GlobalVoxelPlannerImpl(store);
    const result = planner.plan({ x: 0, y: 64, z: 0 }, { x: 50, y: 64, z: 0 }, {
      unknownPolicy: 'strict',
    });

    assert.equal(result.success, false);
    assert.equal(result.stoppedAtFrontier, false);
    assert.equal(result.path.length, 0);
  });

  // T3 · frontier 模式：停在未知格边界
  it('T3 · frontier 模式 → success=false · stoppedAtFrontier=true · frontier 贴近 x=25', () => {
    const store = new MockWorldMapStore();
    fillCorridorX(store, -2, 24, 64, 0);
    fillCorridorX(store, 26, 52, 64, 0);

    const planner = new GlobalVoxelPlannerImpl(store);
    const result = planner.plan({ x: 0, y: 64, z: 0 }, { x: 50, y: 64, z: 0 }, {
      unknownPolicy: 'frontier',
    });

    assert.equal(result.success, false);
    assert.equal(result.stoppedAtFrontier, true);
    assert.ok(result.frontierPosition);
    // frontier 位置应是探索到未知格时的下一格（其中至少 x 坐标接近 25）
    assert.ok(
      Math.abs(result.frontierPosition!.x - 25) <= 2,
      `frontier.x ${result.frontierPosition!.x} 应贴近 25`,
    );
    // frontier 模式产出非空路径（朝 frontier 走）
    assert.ok(result.path.length > 0);
  });

  // T4 · 迭代上限保护
  it('T4 · maxIterations=50 · 不死循环 · 有限时间返回', () => {
    const store = new MockWorldMapStore();
    // 起点周围有走廊，目标完全未知 → 让 A* 漫无目的扩展
    fillCorridorX(store, -10, 10, 64, 0);

    const planner = new GlobalVoxelPlannerImpl(store);
    const startTs = Date.now();
    const result = planner.plan({ x: 0, y: 64, z: 0 }, { x: 1000, y: 64, z: 1000 }, {
      unknownPolicy: 'strict',
      maxIterations: 50,
    });
    const elapsed = Date.now() - startTs;

    assert.ok(result.iterationsUsed <= 50, `iterations=${result.iterationsUsed}`);
    assert.ok(elapsed < 2000, `elapsed=${elapsed}ms 必须 < 2s`);
    assert.equal(result.success, false);
  });

  // T5 · 高度差场景（goal 在不同 y · 6 邻居 A* 行为）
  it('T5 · goal 不同 y · frontier 模式给出朝目标推进的路径', () => {
    const store = new MockWorldMapStore();
    // 6 邻居 voxel A* 在 "feet=empty + ground=block" 判定下无法直接斜跨 y，
    // 但 frontier 模式遇到未知格仍应当尽量朝 goal 推进。
    fillCorridorX(store, -2, 30, 64, 0);

    const planner = new GlobalVoxelPlannerImpl(store);
    const result = planner.plan({ x: 0, y: 64, z: 0 }, { x: 30, y: 68, z: 0 }, {
      unknownPolicy: 'frontier',
    });

    // 至少应推进到 x>=20（足够接近 X 维度 goal），frontier 应有定义
    const lastNode = result.path[result.path.length - 1] ?? result.frontierPosition;
    assert.ok(lastNode, 'path 或 frontierPosition 至少有一个');
    assert.ok(
      lastNode!.x >= 20 || result.success,
      `路径末端 x=${lastNode!.x} 应至少推进到 x>=20`,
    );
  });

  // 额外：起终相同
  it('T6 · 起点=终点 → success=true · path 至少含 start', () => {
    const store = new MockWorldMapStore();
    fillCorridorX(store, -2, 2, 64, 0);
    const planner = new GlobalVoxelPlannerImpl(store);
    const result = planner.plan({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, {
      unknownPolicy: 'strict',
    });
    assert.equal(result.success, true);
    assert.ok(result.path.length >= 1);
  });
});
