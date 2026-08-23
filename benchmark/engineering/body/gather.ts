/**
 * 评测场景 · 采集类（FEAT-CROSS-03 · 模板化）
 *
 * 用 /setblock 合成"树"（原木柱），可复现（不依赖真实生物群系）。
 * gather 用 game.dig 直接挖（不走 pathfinder 的 canDig），故无需给工具。
 *
 * 模板参数轴：dist(搜索半径) × count(目标数) × trees(布树数) → 矩阵实例。
 * pinned：GATHER-01/02（原 13 场景之二，full 套件）。
 */

import type { Director } from '../core/director.js';
import { expand, type ScenarioTemplate } from '../core/template.js';
import type { ScenarioFactory } from '../core/types.js';

interface GatherParams { dist: number; count: number; trees: number }

/**
 * 以 (40,0,40) 为中心，沿圆周等角布 n 棵原木柱，半径 = dist。
 * BUG-CROSS-29：夹具容量必须覆盖目标数量；保留 trees 参数，只按需增加树干高度。
 */
async function placeTrees(d: Director, n: number, dist: number, requiredCount: number): Promise<void> {
  const logsPerTree = Math.max(3, Math.ceil(requiredCount / Math.max(1, n)));
  for (let i = 0; i < n; i++) {
    const ang = (i / Math.max(1, n)) * Math.PI * 2;
    const lx = 40 + Math.round(Math.cos(ang) * dist);
    const lz = 40 + Math.round(Math.sin(ang) * dist);
    await d.fill({ x: lx, y: 0, z: lz }, { x: lx, y: logsPerTree - 1, z: lz }, 'oak_log');
  }
}

const gatherTpl: ScenarioTemplate<GatherParams> = {
  idPrefix: 'GATHER',
  category: 'gather',
  axes: { dist: [8, 16, 32], count: [1, 4], trees: [1, 3] },
  pinned: [
    { id: 'GATHER-01', suite: 'full', params: { dist: 8, count: 1, trees: 1 } },
    { id: 'GATHER-02', suite: 'full', params: { dist: 32, count: 4, trees: 3 } },
  ],
  build: (p) => ({
    title: `采 ${p.count} 原木（半径${p.dist}·${p.trees}树）`,
    timeoutMs: 60000 + p.count * 30000,
    async setup(d, s) {
      await d.parkFar();
      await d.clearInv(s.username);
      await placeTrees(d, p.trees, p.dist, p.count);
      await d.tp(s.username, 40, 0, 40);
    },
    async inject(s) {
      s.injectTask('gather_material', { material: 'oak_log', count: p.count, maxDistance: p.dist + 16 });
    },
    success(s) { return s.invCount('oak_log') >= p.count; },
    failFast(s) { return s.hasDiedSinceReset(); },
  }),
};

export const gatherScenarios: ScenarioFactory[] = expand(gatherTpl);
