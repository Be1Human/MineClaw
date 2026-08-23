/**
 * 评测场景 · 生存类 SURV（FEAT-CROSS-03 · 新类目）
 *
 * 验证 L5 survival 策略的自主反应（进食 / 夜袭存活）。
 * 需 /difficulty normal（默认服可能 peaceful 不掉饿/不刷怪攻击性）；teardown 还原。
 */

import { expand, type ScenarioTemplate } from '../core/template.js';
import type { ScenarioFactory } from '../core/types.js';

// ── SURV-01 · 饥饿进食（喂面包 → 自主进食回升 food） ────────────────
const survEatTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'SURV-EAT', category: 'survival', axes: {},
  pinned: [{ id: 'SURV-01', suite: 'full', params: {} }],
  build: () => ({
    title: '饥饿进食', timeoutMs: 120000,
    async setup(d, s) {
      await d.parkFar();
      await d.setDifficulty('normal');
      await d.clearInv(s.username);
      await d.give(s.username, 'bread', 5);
      await d.tp(s.username, 50, 0, 50);
      // 快速掉饿：饥饿效果 10s·放大 5
      await d.cmd(`/effect give ${s.username} minecraft:hunger 10 5`, 150);
    },
    // 无任务注入：靠 L5 survival 自主进食
    async inject() { /* autonomous */ },
    // food 回升 ≥18 且未死亡
    success(s) { return s.food() >= 18 && s.health() > 0; },
    async teardown(d, s) {
      await d.cmd(`/effect clear ${s.username}`, 100);
      await d.setDifficulty('peaceful');
    },
  }),
};

// ── SURV-02 · 夜晚受袭存活 ────────────────────────────────────────
const survNightTpl: ScenarioTemplate<Record<string, never>> = {
  idPrefix: 'SURV-NIGHT', category: 'survival', axes: {},
  pinned: [{ id: 'SURV-02', suite: 'full', params: {} }],
  build: () => ({
    title: '夜晚受袭存活', timeoutMs: 90000,
    async setup(d, s) {
      await d.parkFar();
      await d.setDifficulty('normal');
      await d.cmd('/time set night', 150);
      await d.tp(s.username, 50, 0, 50);
      await d.summon('zombie', 52, 0, 52);
      await d.summon('zombie', 48, 0, 48);
    },
    async inject() { /* autonomous · L5 survival/flee 反应 */ },
    // "存活 90s"：全程不死，到 timeout 时 HP ≥ 10 即胜；中途死亡立即判负
    success() { return false; },
    failFast(s) { return s.health() <= 0; },
    endCheck(s) { return s.health() >= 10; },
    async teardown(d) {
      await d.killEntities('zombie');
      await d.setDifficulty('peaceful');
      await d.cmd('/time set day', 100);
    },
  }),
};

export const survivalScenarios: ScenarioFactory[] = [...expand(survEatTpl), ...expand(survNightTpl)];
