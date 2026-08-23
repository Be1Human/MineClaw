/**
 * 评测场景 · 战斗类 COMB（FEAT-CROSS-03 · 新类目）
 *
 * COMB-01 保卫主人（导演=主人，guard 任务清怪）；COMB-02 自卫反击（怪攻被测，自主反应）。
 * 用 director.countEntities 本地数僵尸（不依赖 op 回显）；需 /difficulty normal；teardown 清怪。
 */

import type { Director } from '../core/director.js';
import { expand, type ScenarioTemplate } from '../core/template.js';
import type { ScenarioFactory } from '../core/types.js';

// ── COMB-01 · 保卫主人（导演在场，guard 清怪） ─────────────────────
const combGuardTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'COMB-GUARD', category: 'combat', axes: {},
  pinned: [{ id: 'COMB-01', suite: 'full', params: {} }],
  build: () => {
    let dir: Director | null = null;
    const centerLocal = { x: 20, y: 0, z: 20 };
    return {
      title: '保卫主人', timeoutMs: 60000,
      async setup(d, s) {
        dir = d;
        await d.setDifficulty('normal');
        await d.tpSelf(centerLocal.x, 0, centerLocal.z);          // 导演=主人，就位
        await d.tp(s.username, centerLocal.x + 1, 0, centerLocal.z);
        await d.summon('zombie', centerLocal.x + 3, 0, centerLocal.z);
        await d.summon('zombie', centerLocal.x - 3, 0, centerLocal.z);
      },
      async inject(s) {
        const c = s.world(centerLocal.x, 0, centerLocal.z);
        s.injectTask('guard', { center: c, radius: 12, combatRange: 8 });
      },
      // 警戒区僵尸清零 且 导演（主人）存活
      success(s) {
        if (!dir) return false;
        const c = s.world(centerLocal.x, 0, centerLocal.z);
        return dir.countEntities('zombie', c, 16) === 0;
      },
      async teardown(d) { await d.killEntities('zombie'); await d.setDifficulty('peaceful'); },
    };
  },
};

// ── COMB-02 · 自卫反击（怪攻被测，自主/守卫反应） ──────────────────
const combSelfTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'COMB-SELF', category: 'combat', axes: {},
  pinned: [{ id: 'COMB-02', suite: 'full', params: {} }],
  build: () => {
    let dir: Director | null = null;
    const centerLocal = { x: 60, y: 0, z: 60 };
    return {
      title: '自卫反击', timeoutMs: 60000,
      async setup(d, s) {
        dir = d;
        await d.parkFar();
        await d.setDifficulty('normal');
        await d.tp(s.username, centerLocal.x, 0, centerLocal.z);
        await d.summon('zombie', centerLocal.x + 2, 0, centerLocal.z);
      },
      async inject(s) {
        // 给把剑提升反击能力（自卫靠 L5 reflex/combat）
        const c = s.world(centerLocal.x, 0, centerLocal.z);
        s.injectTask('guard', { center: c, radius: 10, combatRange: 6 });
      },
      success(s) {
        if (!dir) return false;
        const c = s.world(centerLocal.x, 0, centerLocal.z);
        return dir.countEntities('zombie', c, 14) === 0 && s.health() > 0;
      },
      failFast(s) { return s.health() <= 0; },
      async teardown(d) { await d.killEntities('zombie'); await d.setDifficulty('peaceful'); },
    };
  },
};

export const combatScenarios: ScenarioFactory[] = [...expand(combGuardTpl), ...expand(combSelfTpl)];
