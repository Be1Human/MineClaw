/**
 * 评测场景 · 导航类（FEAT-CROSS-03 · 模板化）
 *
 * 坐标约定：局部坐标，subject 脚下 = 局部 y=0（站在世界 anchor.y-1 的石地板上）。
 * 非跟随场景：导演 parkFar，使 owner 不可见，避免规则 idle 自动跟随污染。
 *
 * NAV-01 平地走：带距离参数轴（矩阵）。NAV-02~05：异构场景，各为钉名模板（无矩阵）。
 */

import type { Director } from '../core/director.js';
import { expand, type ScenarioTemplate } from '../core/template.js';
import type { ScenarioFactory } from '../core/types.js';

/** 放一扇 2 格高的木门（局部坐标，门朝北） */
async function placeDoor(d: Director, lx: number, ly: number, lz: number): Promise<void> {
  const lo = d.world(lx, ly, lz);
  const hi = d.world(lx, ly + 1, lz);
  await d.cmd(`/setblock ${lo.x} ${lo.y} ${lo.z} minecraft:oak_door[half=lower,facing=north,open=false]`, 80);
  await d.cmd(`/setblock ${hi.x} ${hi.y} ${hi.z} minecraft:oak_door[half=upper,facing=north,open=false]`, 80);
}

// ── NAV-01 · 平地走 N 格（带距离矩阵） ──────────────────────────────
const navFlatTpl: ScenarioTemplate<{ dist: number }> = {
  idPrefix: 'NAV-FLAT', category: 'nav',
  axes: { dist: [20, 40, 60] },
  pinned: [{ id: 'NAV-01', suite: 'quick', params: { dist: 20 } }],
  build: (p) => ({
    title: `平地走 ${p.dist} 格`,
    timeoutMs: 15000 + p.dist * 800,
    async setup(d, s) { await d.parkFar(); await d.tp(s.username, 0, 0, 0); },
    async inject(s) { s.injectMove(s.world(p.dist, 0, 0), { timeoutMs: 14000 + p.dist * 800 }); },
    sample(s) { s.injectMove(s.world(p.dist, 0, 0), { timeoutMs: 14000 + p.dist * 800 }); },
    success(s) { return s.hdistTo(s.world(p.dist, 0, 0)) < 2; },
  }),
};

// ── NAV-02 · 穿过 1 扇木门 ────────────────────────────────────────
const navDoorTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'NAV-DOOR', category: 'nav', axes: {},
  pinned: [{ id: 'NAV-02', suite: 'quick', params: {} }],
  build: () => ({
    title: '穿过 1 扇木门', timeoutMs: 45000,
    async setup(d, s) {
      await d.parkFar();
      await d.fill({ x: -2, y: 0, z: 5 }, { x: 2, y: 2, z: 5 }, 'stone');
      await d.setblock(0, 0, 5, 'air');
      await d.setblock(0, 1, 5, 'air');
      await placeDoor(d, 0, 0, 5);
      await d.tp(s.username, 0, 0, 0);
    },
    async inject(s) { s.injectMove(s.world(0, 0, 10), { timeoutMs: 43000 }); },
    sample(s) { s.injectMove(s.world(0, 0, 10), { timeoutMs: 43000 }); },
    success(s) { return s.hdistTo(s.world(0, 0, 10)) < 2; },
  }),
};

// ── NAV-03 · 障碍穿行 40 格 ───────────────────────────────────────
const navObstacleTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'NAV-OBST', category: 'nav', axes: {},
  pinned: [{ id: 'NAV-03', suite: 'full', params: {} }],
  build: () => {
    const pillars: Array<[number, number]> = [
      [6, 0], [10, 2], [10, -2], [15, 1], [18, -1], [22, 2],
      [25, -2], [28, 0], [31, 1], [34, -1], [37, 2],
    ];
    return {
      title: '障碍穿行 40 格', timeoutMs: 60000,
      async setup(d, s) {
        await d.parkFar();
        for (const [lx, lz] of pillars) await d.fill({ x: lx, y: 0, z: lz }, { x: lx, y: 3, z: lz }, 'oak_log');
        await d.tp(s.username, 0, 0, 0);
      },
      async inject(s) { s.injectMove(s.world(40, 0, 0), { timeoutMs: 58000 }); },
      sample(s) { s.injectMove(s.world(40, 0, 0), { timeoutMs: 58000 }); },
      success(s) { return s.hdistTo(s.world(40, 0, 0)) < 2.5; },
    };
  },
};

// ── NAV-04 · 上 5 格台阶坡 ────────────────────────────────────────
const navStairsTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'NAV-STAIR', category: 'nav', axes: {},
  pinned: [{ id: 'NAV-04', suite: 'full', params: {} }],
  build: () => ({
    title: '上 5 格台阶坡', timeoutMs: 45000,
    async setup(d, s) {
      await d.parkFar();
      for (let i = 1; i <= 5; i++) await d.fill({ x: 1 + i, y: -1, z: -1 }, { x: 1 + i, y: i - 1, z: 1 }, 'stone');
      await d.tp(s.username, 0, 0, 0);
    },
    async inject(s) { s.injectMove(s.world(6, 5, 0), { timeoutMs: 43000 }); },
    sample(s) { s.injectMove(s.world(6, 5, 0), { timeoutMs: 43000 }); },
    success(s) { return s.pos().y >= s.anchorY() + 4; },
  }),
};

// ── NAV-05 · 目标不可达（封闭房）→ 干净放弃 ───────────────────────
const navUnreachableTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'NAV-UNREACH', category: 'nav', axes: {},
  pinned: [{ id: 'NAV-05', suite: 'full', params: {} }],
  build: () => {
    let injectedAt = 0;
    return {
      title: '目标不可达(封闭房)', timeoutMs: 15000,
      async setup(d, s) {
        await d.parkFar();
        await d.fill({ x: 9, y: -1, z: 9 }, { x: 11, y: 3, z: 11 }, 'stone');
        await d.tp(s.username, 0, 0, 0);
      },
      async inject(s) { injectedAt = Date.now(); s.injectMove(s.world(10, 1, 10), { timeoutMs: 8000 }); },
      success(s) { return s.gaveUpSince(injectedAt); },
    };
  },
};

export const navScenarios: ScenarioFactory[] = [
  ...expand(navFlatTpl),
  ...expand(navDoorTpl),
  ...expand(navObstacleTpl),
  ...expand(navStairsTpl),
  ...expand(navUnreachableTpl),
];
