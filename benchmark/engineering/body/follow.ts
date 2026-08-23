/**
 * 评测场景 · 跟随类（FEAT-CROSS-03 · 模板化）
 *
 * 跟随场景里【导演 = 主人】：subject.ownerName 由 runner 设为导演 username，
 * 导演不 parkFar，靠 pathfinder 走折线，subject 用 follow_owner 任务跟。
 * 导演引用在 setup(d,s) 时捕获进闭包，供 inject/sample/success 使用。
 */

import type { Director } from '../core/director.js';
import { expand, type ScenarioTemplate } from '../core/template.js';
import type { ScenarioFactory } from '../core/types.js';

async function placeDoor(d: Director, lx: number, ly: number, lz: number): Promise<void> {
  const lo = d.world(lx, ly, lz);
  const hi = d.world(lx, ly + 1, lz);
  await d.cmd(`/setblock ${lo.x} ${lo.y} ${lo.z} minecraft:oak_door[half=lower,facing=north,open=false]`, 80);
  await d.cmd(`/setblock ${hi.x} ${hi.y} ${hi.z} minecraft:oak_door[half=upper,facing=north,open=false]`, 80);
}

// ── FOLLOW-01 · 导演走 50 格折线跟随（≥80% 采样点距离 ≤6） ──────────
const follow50Tpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'FOLLOW-PATH', category: 'follow', axes: {},
  pinned: [{ id: 'FOLLOW-01', suite: 'full', params: {} }],
  build: () => {
    let dir: Director | null = null;
    let samples = 0, within = 0, walkDone = false;
    const path: Array<[number, number, number]> = [
      [12, 0, 0], [12, 0, 12], [24, 0, 12], [24, 0, 0], [36, 0, 0], [36, 0, 10], [46, 0, 10],
    ];
    return {
      title: '导演走 50 格折线跟随', timeoutMs: 80000,
      async setup(d, s) {
        dir = d; samples = 0; within = 0; walkDone = false;
        await d.tpSelf(2, 0, 0);
        await d.tp(s.username, 0, 0, 0);
      },
      async inject(s) {
        s.injectTask('follow_owner', { ownerName: dir!.username });
        void dir!.walkPath(path, 20000).then(() => { walkDone = true; });
      },
      sample(s) { if (dir) { samples++; if (s.distTo(dir.pos()) <= 6) within++; } },
      success() { return walkDone && samples > 0 && within / samples >= 0.8; },
    };
  },
};

// ── FOLLOW-02 · 导演穿门跟随 ──────────────────────────────────────
const followDoorTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'FOLLOW-DOOR', category: 'follow', axes: {},
  pinned: [{ id: 'FOLLOW-02', suite: 'full', params: {} }],
  build: () => {
    let dir: Director | null = null;
    return {
      title: '导演穿门跟随', timeoutMs: 60000,
      async setup(d, s) {
        dir = d;
        await d.fill({ x: -2, y: 0, z: 5 }, { x: 2, y: 2, z: 5 }, 'stone');
        await d.setblock(0, 0, 5, 'air');
        await d.setblock(0, 1, 5, 'air');
        await placeDoor(d, 0, 0, 5);
        await d.tpSelf(0, 0, 2);
        await d.tp(s.username, 0, 0, 0);
      },
      async inject(s) {
        s.injectTask('follow_owner', { ownerName: dir!.username });
        void dir!.walkPath([[0, 0, 12]], 30000);
      },
      success(s) {
        if (!dir) return false;
        return s.pos().z > s.world(0, 0, 6).z && s.distTo(dir.pos()) <= 4;
      },
    };
  },
};

export const followScenarios: ScenarioFactory[] = [...expand(follow50Tpl), ...expand(followDoorTpl)];
