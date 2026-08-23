/**
 * 评测场景 · 卡死恢复类（FEAT-CROSS-03 · 模板化）
 *
 * 本需求最关键的回归基线：脱困是 5 套检测器混战的重灾区。
 * 阶段〇 用现有（未改造）的 StuckMonitor/EscapeStrategy/StuckRecovery 跑出基线数字。
 */

import type { Director } from '../core/director.js';
import type { Loc } from '../core/director.js';
import { expand, type ScenarioTemplate } from '../core/template.js';
import type { ScenarioFactory } from '../core/types.js';

/** 在 (cx,_,cz) 造一个 2 格深的 1×1 竖井（3×3 石基 + 中心掏空） */
async function buildPit(d: Director, cx: number, cz: number): Promise<void> {
  await d.fill({ x: cx - 1, y: -4, z: cz - 1 }, { x: cx + 1, y: -1, z: cz + 1 }, 'stone');
  await d.setblock(cx, -1, cz, 'air');
  await d.setblock(cx, -2, cz, 'air');
}

// ── REC-01/02 · 2 格深坑脱困（有/无方块） ─────────────────────────
const recPitTpl: ScenarioTemplate<{ hasBlocks: boolean; cx: number; cz: number }> = {
  idPrefix: 'REC-PIT', category: 'recover', axes: {},
  pinned: [
    { id: 'REC-01', suite: 'full', params: { hasBlocks: true, cx: 10, cz: 10 } },
    { id: 'REC-02', suite: 'full', params: { hasBlocks: false, cx: 14, cz: 14 } },
  ],
  build: (p) => ({
    title: `2 格深坑脱困(${p.hasBlocks ? '有' : '无'}方块)`,
    timeoutMs: p.hasBlocks ? 60000 : 90000,
    async setup(d, s) {
      await d.parkFar();
      await buildPit(d, p.cx, p.cz);
      await d.clearInv(s.username);
      if (p.hasBlocks) await d.give(s.username, 'cobblestone', 16);
      await d.tp(s.username, p.cx, -2, p.cz);
    },
    async inject(s) { s.injectMove(s.world(p.cx + 10, 0, p.cz), { timeoutMs: p.hasBlocks ? 58000 : 88000 }); },
    sample(s) { s.injectMove(s.world(p.cx + 10, 0, p.cz), { timeoutMs: p.hasBlocks ? 58000 : 88000 }); },
    success(s) { return s.pos().y >= s.anchorY() - 0.3; },
  }),
};

// ── REC-03 · 贴墙角卡死恢复 ───────────────────────────────────────
const recCornerTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'REC-CORNER', category: 'recover', axes: {},
  pinned: [{ id: 'REC-03', suite: 'full', params: {} }],
  build: () => {
    const c = { cx: 30, cz: 30 };
    let startPos: Loc = { x: 0, y: 0, z: 0 };
    return {
      title: '贴墙角卡死恢复', timeoutMs: 30000,
      async setup(d, s) {
        await d.parkFar();
        await d.fill({ x: c.cx, y: 0, z: c.cz }, { x: c.cx + 4, y: 2, z: c.cz }, 'stone');
        await d.fill({ x: c.cx, y: 0, z: c.cz }, { x: c.cx, y: 2, z: c.cz + 4 }, 'stone');
        await d.tp(s.username, c.cx + 1, 0, c.cz + 1);
      },
      async inject(s) { startPos = s.pos(); s.injectMove(s.world(c.cx - 5, 0, c.cz - 5), { timeoutMs: 28000 }); },
      sample(s) { s.injectMove(s.world(c.cx - 5, 0, c.cz - 5), { timeoutMs: 28000 }); },
      success(s) {
        const pp = s.pos();
        return Math.sqrt((pp.x - startPos.x) ** 2 + (pp.z - startPos.z) ** 2) > 3;
      },
    };
  },
};

export const recoverScenarios: ScenarioFactory[] = [...expand(recPitTpl), ...expand(recCornerTpl)];
