/**
 * 🔀 DetourPlanner — 按需绕障规划（FEAT-L1-07）
 *
 * 只在 L0 pathfinder 直冲卡死（NavStuckSentinel 判定贪心撞墙）时触发，
 * 在 WorldMapStore 记忆地图上跑一次体素 A*，产出**稀疏中继点**（waypoint）
 * 让 pathfinder 逐段绕过障碍。
 *
 * 设计取舍（FEAT-L1-07 §5）：复用既有 GlobalVoxelPlanner 的体素 A* 引擎，
 * 但改为**按需调用**（罕见触发）—— 全量体素 A* 的高成本因稀有而可接受，
 * 不预先上 HPA* 或八叉树（懒优化：不为未触发的瓶颈上重武器）。
 */

import type { Vec3 } from '../../adapter/types.js';
import type { WorldMapStore } from '../infra/worldMapStore.js';
import { GlobalVoxelPlannerImpl } from './globalVoxelPlanner.js';
import { tuning } from '../infra/tuning.js';

export interface DetourResult {
  /** 稀疏中继点（不含起点；末点接近 goal 或 frontier） */
  waypoints: Vec3[];
  /** A* 是否真的抵达 goal（false = 只到 frontier / 无路） */
  reachedGoal: boolean;
}

export class DetourPlanner {
  private readonly voxel: GlobalVoxelPlannerImpl;

  constructor(private readonly worldMap: WorldMapStore) {
    this.voxel = new GlobalVoxelPlannerImpl(worldMap);
  }

  plan(start: Vec3, goal: Vec3): DetourResult {
    const res = this.voxel.plan(start, goal, {
      unknownPolicy: 'frontier',
      maxIterations: tuning().nav.detourMaxIter,
    });

    if (!res.path || res.path.length < 2) {
      return { waypoints: [], reachedGoal: false };
    }

    return {
      waypoints: sparsify(res.path, tuning().nav.detourWaypointGap),
      reachedGoal: res.success,
    };
  }
}

/**
 * 稀疏化：每隔 gap 格取一个 waypoint（含末点），丢掉起点。
 * 体素 A* 出的是逐格密集路径，pathfinder 不需要每格中继 —— 取稀疏锚点即可。
 */
export function sparsify(path: Vec3[], gap: number): Vec3[] {
  if (path.length <= 1) return [];
  const out: Vec3[] = [];
  let last = path[0];
  for (let i = 1; i < path.length; i++) {
    const p = path[i];
    const dx = p.x - last.x, dy = p.y - last.y, dz = p.z - last.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= gap) {
      out.push(p);
      last = p;
    }
  }
  // 保证末点（goal/frontier）一定在
  const tail = path[path.length - 1];
  if (out.length === 0 || out[out.length - 1] !== tail) out.push(tail);
  return out;
}
