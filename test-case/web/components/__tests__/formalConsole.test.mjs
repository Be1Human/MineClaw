import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/App.vue', import.meta.url),
  'utf8',
);
const themeSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/theme-mc.css', import.meta.url),
  'utf8',
);

test('正式版控制台使用语义设计变量与三栏应用骨架', () => {
  assert.match(themeSource, /--mc-bg:\s*#090d0b/);
  assert.match(themeSource, /--mc-surface-raised:\s*#151d17/);
  assert.match(themeSource, /--mc-accent:\s*#69c94a/);
  assert.match(themeSource, /--mc-border:\s*rgba/);
  assert.match(appSource, /class="mineclaw-app"/);
  assert.match(appSource, /class="app-header"/);
  assert.match(appSource, /class="partner-sidebar"/);
  assert.match(appSource, /grid-template-columns:240px minmax\(0,1fr\) 400px/);
});

test('正式外壳保留产品导航与 Hub 状态并移除草方块齿边', () => {
  assert.match(appSource, />MineClaw<\/span>/);
  assert.match(appSource, />AI COMPANION CONSOLE<\/span>/);
  assert.match(appSource, /Hub 已连接/);
  assert.match(appSource, /aria-label="伙伴工作区"/);
  assert.match(appSource, /class="partner-list-item"/);
  assert.doesNotMatch(appSource, /grass teeth|TOP BAR \(grass block\)/);
  assert.doesNotMatch(appSource, /mask-image:repeating-linear-gradient\(90deg,#000 0 7px/);
});
