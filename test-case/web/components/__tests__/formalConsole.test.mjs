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

test('感知空态使用四层局部扫描环且不伪造世界数据', () => {
  assert.equal((appSource.match(/class="scan-ring /g) || []).length, 4);
  assert.match(appSource, /@keyframes perceptionScan/);
  assert.match(appSource, /animation:perceptionScan 4s linear infinite/);
  assert.match(appSource, /will-change:transform,opacity/);
  assert.match(appSource, /v-if="!currentWorldState" class="perception-empty"/);
  assert.match(appSource, /v-if="currentWorldState && !show3D" class="perception-online-state"/);
  assert.match(appSource, /v-if="currentWorldState && show3D" class="perception-scene"/);
  assert.doesNotMatch(appSource, /setInterval\([^)]*scan|requestAnimationFrame\([^)]*scan/i);
});

test('伙伴检查器使用正式信息层级并保留交流功能入口', () => {
  assert.match(appSource, /class="play-control partner-inspector"/);
  assert.match(appSource, /class="inspector-header"/);
  assert.match(appSource, /class="inspector-chips"/);
  assert.match(appSource, /<nav class="control-tabs" aria-label="伙伴详情">/);
  assert.match(appSource, /class="interaction-summary"/);
  assert.match(appSource, /class="chat-panel interaction-chat"/);
  assert.match(appSource, /<ChatBox @send="sendChat"/);
  assert.doesNotMatch(appSource, /:style="tabStyle\(t\.id\)"/);
});

test('窄屏折叠感知舞台并为伙伴交流保留完整主列', () => {
  assert.match(appSource, /@media \(max-width:860px\)/);
  assert.match(appSource, /\.play-stage \{ display:none; \}/);
  assert.match(appSource, /\.play-control \{ grid-column:2; \}/);
  assert.match(appSource, /@media \(max-width:640px\)/);
  assert.match(appSource, /grid-template-columns:64px minmax\(0,1fr\)/);
  assert.match(appSource, /\.workspace-partner \{ display:none; \}/);
});
