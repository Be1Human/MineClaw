/**
 * 🌐 GlobalVoxelPlanner — 全局粗粒度 3D A* 路径规划
 *
 * FEAT-L1-02 Phase 2
 *
 * 依赖 WorldMapStore（记忆地形数据）做 block 级 A*，产出 waypoint 序列。
 * mineflayer-pathfinder 再对每段 waypoint 做精确本地寻路。
 *
 * 可通行判定（对坐标 x,y,z 站立处）：
 *   - 脚位 (x,y,z)：boundingBox==='empty'（空气/门等）
 *   - 头位 (x,y+1,z)：boundingBox==='empty'（2 格净空）
 *   - 地面 (x,y-1,z)：boundingBox==='block'（实体地面）
 * 未知格：strict→不可通行；frontier→标记边界后停止扩展
 */

import type { Vec3 } from '../../adapter/types.js';
import type { WorldMapStore } from '../infra/worldMapStore.js';

export interface GlobalVoxelOptions {
  unknownPolicy: 'strict' | 'frontier';
  maxIterations?: number;
}

export interface GlobalPlanResult {
  success: boolean;
  path: Vec3[];
  stoppedAtFrontier: boolean;
  frontierPosition?: Vec3;
  iterationsUsed: number;
}

export interface GlobalVoxelPlanner {
  plan(start: Vec3, goal: Vec3, options?: GlobalVoxelOptions): GlobalPlanResult;
}

// ─── 内部 A* 实现 ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITER = 50_000;

/** 6 方向邻居（不含对角） */
const OFFSETS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 0, 1], [0, 0, -1],
  [0, 1, 0], [0, -1, 0],
];

type Passability = 'yes' | 'no' | 'unknown';

function isPassableBlock(blockName: string): boolean {
  if (!blockName) return false;
  if (blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air') return true;
  if (blockName.endsWith('_door') || blockName.endsWith('_trapdoor')) return true;
  if (blockName.endsWith('_fence_gate')) return true;
  return false;
}

function canWalkAt(
  worldMap: WorldMapStore,
  x: number,
  y: number,
  z: number,
  policy: 'strict' | 'frontier',
): Passability {
  const feet = worldMap.getBlock(x, y, z);
  const head = worldMap.getBlock(x, y + 1, z);
  const ground = worldMap.getBlock(x, y - 1, z);

  // Unknown feet block
  if (!feet) return policy === 'strict' ? 'no' : 'unknown';

  // Feet must be passable
  const feetPassable = feet.boundingBox === 'empty' || isPassableBlock(feet.blockName);
  if (!feetPassable) return 'no';

  // Head clearance (2 block height for bot)
  if (head) {
    const headPassable = head.boundingBox === 'empty' || isPassableBlock(head.blockName);
    if (!headPassable) return 'no';
  } else if (policy === 'strict') {
    return 'no'; // unknown head in strict mode = not safe
  }

  // Ground must be solid
  if (!ground) return policy === 'strict' ? 'no' : 'unknown';
  if (ground.boundingBox !== 'block') return 'no'; // no solid ground

  return 'yes';
}

// ─── Min-Heap priority queue ──────────────────────────────────────────────────

interface HeapNode {
  key: string;
  f: number;
}

class MinHeap {
  private data: HeapNode[] = [];

  push(node: HeapNode): void {
    this.data.push(node);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  get size(): number { return this.data.length; }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[parent].f <= this.data[i].f) break;
      [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.data[l].f < this.data[smallest].f) smallest = l;
      if (r < n && this.data[r].f < this.data[smallest].f) smallest = r;
      if (smallest === i) break;
      [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
      i = smallest;
    }
  }
}

// ─── A* core ─────────────────────────────────────────────────────────────────

function key(x: number, y: number, z: number): string {
  return `${x}:${y}:${z}`;
}

function heuristic(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function reconstructPath(
  cameFrom: Map<string, string>,
  currentKey: string,
  nodes: Map<string, Vec3>,
): Vec3[] {
  const path: Vec3[] = [];
  let cur = currentKey;
  while (cameFrom.has(cur)) {
    path.unshift(nodes.get(cur)!);
    cur = cameFrom.get(cur)!;
  }
  path.unshift(nodes.get(cur)!); // start node
  return path;
}

// ─── Public Implementation ────────────────────────────────────────────────────

export class GlobalVoxelPlannerImpl implements GlobalVoxelPlanner {
  constructor(private readonly worldMap: WorldMapStore) {}

  plan(start: Vec3, goal: Vec3, options?: GlobalVoxelOptions): GlobalPlanResult {
    const policy = options?.unknownPolicy ?? 'strict';
    const maxIter = options?.maxIterations ?? DEFAULT_MAX_ITER;

    const sx = Math.floor(start.x), sy = Math.floor(start.y), sz = Math.floor(start.z);
    const gx = Math.floor(goal.x), gy = Math.floor(goal.y), gz = Math.floor(goal.z);
    const startKey = key(sx, sy, sz);
    const goalKey = key(gx, gy, gz);

    const open = new MinHeap();
    const gScore = new Map<string, number>();
    const cameFrom = new Map<string, string>();
    const nodes = new Map<string, Vec3>();
    const closed = new Set<string>();

    gScore.set(startKey, 0);
    nodes.set(startKey, { x: sx, y: sy, z: sz });
    open.push({ key: startKey, f: heuristic(sx, sy, sz, gx, gy, gz) });

    let iterations = 0;
    let bestFrontierKey: string | undefined;
    let bestFrontierDist = Infinity;

    while (open.size > 0 && iterations < maxIter) {
      iterations++;
      const { key: curKey } = open.pop()!;
      if (closed.has(curKey)) continue;
      closed.add(curKey);

      if (curKey === goalKey) {
        return {
          success: true,
          path: reconstructPath(cameFrom, curKey, nodes),
          stoppedAtFrontier: false,
          iterationsUsed: iterations,
        };
      }

      const cur = nodes.get(curKey)!;
      const curG = gScore.get(curKey)!;

      for (const [dx, dy, dz] of OFFSETS) {
        const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
        const nKey = key(nx, ny, nz);
        if (closed.has(nKey)) continue;

        const passability = canWalkAt(this.worldMap, nx, ny, nz, policy);

        if (passability === 'no') continue;

        if (passability === 'unknown') {
          // frontier mode: track closest frontier to goal
          if (policy === 'frontier') {
            const distToGoal = heuristic(nx, ny, nz, gx, gy, gz);
            if (distToGoal < bestFrontierDist) {
              bestFrontierDist = distToGoal;
              bestFrontierKey = nKey;
              nodes.set(nKey, { x: nx, y: ny, z: nz });
              cameFrom.set(nKey, curKey);
            }
          }
          continue; // don't expand unknowns
        }

        const stepCost = dy !== 0 ? 1.5 : 1.0; // climbing/descending costs more
        const tentativeG = curG + stepCost;
        if (tentativeG >= (gScore.get(nKey) ?? Infinity)) continue;

        gScore.set(nKey, tentativeG);
        cameFrom.set(nKey, curKey);
        nodes.set(nKey, { x: nx, y: ny, z: nz });
        open.push({ key: nKey, f: tentativeG + heuristic(nx, ny, nz, gx, gy, gz) });
      }
    }

    // Goal not reached — return frontier or failure
    if (policy === 'frontier' && bestFrontierKey) {
      return {
        success: false,
        path: reconstructPath(cameFrom, bestFrontierKey, nodes),
        stoppedAtFrontier: true,
        frontierPosition: nodes.get(bestFrontierKey),
        iterationsUsed: iterations,
      };
    }

    return {
      success: false,
      path: [],
      stoppedAtFrontier: false,
      iterationsUsed: iterations,
    };
  }
}
