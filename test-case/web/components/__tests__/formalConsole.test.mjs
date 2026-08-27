import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const appSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/App.vue', import.meta.url),
  'utf8',
);
const themeSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/theme-mc.css', import.meta.url),
  'utf8',
);
const chatBoxSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/components/ChatBox.vue', import.meta.url),
  'utf8',
);
const electronMainSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/electron/main.ts', import.meta.url),
  'utf8',
);
const electronPreloadSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/electron/preload.ts', import.meta.url),
  'utf8',
);

const formalAssetPaths = {
  ambient: '../../../../apps/minecraft-companion/web/public/assets/formal-console/console-ambient-bg.webp',
  perception: '../../../../apps/minecraft-companion/web/public/assets/formal-console/perception-field-bg.webp',
  character: '../../../../apps/minecraft-companion/web/public/assets/formal-console/character-display-bg.webp',
  empty: '../../../../apps/minecraft-companion/web/public/assets/formal-console/partner-empty-illustration.webp',
};

function readWebpMeta(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  const bytes = readFileSync(url);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');

  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
      alpha: Boolean(bytes[20] & 0x10),
      size: statSync(url).size,
    };
  }
  assert.equal(chunk, 'VP8 ');
  assert.equal(bytes.subarray(23, 26).toString('hex'), '9d012a');
  return {
    width: bytes.readUInt16LE(26) & 0x3fff,
    height: bytes.readUInt16LE(28) & 0x3fff,
    alpha: false,
    size: statSync(url).size,
  };
}

test('正式版控制台使用语义设计变量与三栏应用骨架', () => {
  assert.match(themeSource, /--mc-bg:\s*#090d0b/);
  assert.match(themeSource, /--mc-surface-raised:\s*#151d17/);
  assert.match(themeSource, /--mc-accent:\s*#69c94a/);
  assert.match(themeSource, /--mc-border:\s*rgba/);
  assert.match(appSource, /class="mineclaw-app"/);
  assert.match(appSource, /class="app-header"/);
  assert.match(appSource, /class="partner-sidebar"/);
  assert.match(appSource, /grid-template-columns:clamp\(220px,16\.63vw,278px\) minmax\(0,1fr\) clamp\(340px,24\.88vw,416px\)/);
  assert.match(appSource, /\.partner-workspace-bar \{[^}]*grid-column:2;/);
  assert.match(appSource, /\.play-control \{ grid-column:3; grid-row:1 \/ 3; \}/);
});

test('正式外壳保留产品导航与 Hub 状态并移除草方块齿边', () => {
  assert.match(appSource, />MineClaw<\/span>/);
  assert.doesNotMatch(appSource, /AI COMPANION CONSOLE/);
  assert.match(appSource, /Hub 已连接/);
  assert.match(appSource, /class="hub-popover"/);
  assert.match(appSource, /aria-label="伙伴工作区"/);
  assert.match(appSource, /class="partner-list-item"/);
  assert.doesNotMatch(appSource, /grass teeth|TOP BAR \(grass block\)/);
  assert.doesNotMatch(appSource, /mask-image:repeating-linear-gradient\(90deg,#000 0 7px/);
});

test('感知空态使用四层局部扫描环且不伪造世界数据', () => {
  assert.equal((appSource.match(/class="scan-ring /g) || []).length, 4);
  assert.match(appSource, /@keyframes radarPulse/);
  assert.match(appSource, /@keyframes radarSweep/);
  assert.match(appSource, /class="perception-stage-heading"/);
  assert.match(appSource, /class="perception-primary-action"/);
  assert.match(appSource, /class="world-preview-tabs" role="group" aria-label="世界预览模式"/);
  assert.match(appSource, /worldPreviewPresentation\.actionLabel/);
  assert.match(appSource, /worldPreviewPresentation\.message/);
  assert.match(appSource, /const perceptionTelemetry = computed/);
  assert.match(appSource, /entities: Array\.isArray\(state\?\.entities\) \? state\.entities\.length : '—'/);
  assert.match(appSource, /v-if="!worldPreviewPresentation\.shouldMountScene" class="perception-empty"/);
  assert.match(appSource, /v-if="worldPreviewPresentation\.shouldMountScene" class="perception-scene"/);
  assert.doesNotMatch(appSource, /v-if="currentWorldState" class="perception-mode-control"/);
  assert.doesNotMatch(appSource, /setInterval\([^)]*scan|requestAnimationFrame\([^)]*scan/i);
});

test('伙伴检查器使用正式信息层级并保留交流功能入口', () => {
  assert.match(appSource, /class="play-control partner-inspector"/);
  assert.match(appSource, /class="partner-hero-card"/);
  assert.match(appSource, /class="inspector-header"/);
  assert.match(appSource, /class="partner-current-state"/);
  assert.doesNotMatch(appSource, /class="inspector-chips"/);
  assert.match(appSource, /<nav class="control-tabs" aria-label="伙伴详情">/);
  assert.match(appSource, /class="interaction-summary"/);
  assert.match(appSource, /class="chat-panel-header"/);
  assert.match(appSource, /v-for="\(msg, i\) in filteredMessages"/);
  assert.match(appSource, /class="chat-panel interaction-chat"/);
  assert.match(appSource, /<ChatBox @send="sendChat"/);
  assert.match(chatBoxSource, /<McIcon name="send"/);
  assert.doesNotMatch(appSource, /:style="tabStyle\(t\.id\)"/);
});

test('桌面标题栏提供最小化、最大化与关闭的完整窗口行为', () => {
  assert.match(appSource, /@click="winMax"/);
  assert.match(appSource, /name="maximize"/);
  assert.match(electronPreloadSource, /toggleMaximize:\s*\(\) => ipcRenderer\.invoke\('window:toggle-maximize'\)/);
  assert.match(electronMainSource, /ipcMain\.handle\('window:toggle-maximize'/);
  assert.match(electronMainSource, /isMaximized\(\)/);
});

test('窄屏折叠感知舞台并为伙伴交流保留完整主列', () => {
  assert.match(appSource, /@media \(max-width:860px\)/);
  assert.match(appSource, /\.play-stage \{ display:none; \}/);
  assert.match(appSource, /\.play-control \{ grid-column:2; grid-row:2; padding:12px; \}/);
  assert.match(appSource, /@media \(max-width:640px\)/);
  assert.match(appSource, /grid-template-columns:64px minmax\(0,1fr\)/);
  assert.match(appSource, /class="world-preview-tabs inspector-world-preview-tabs"/);
  assert.match(appSource, /\.inspector-world-preview \{ display:flex;/);
  assert.match(appSource, /\.partner-workspace-shell:not\(\.is-play-workspace\) \.play-control \{ display:none; \}/);
});

test('正式版位图素材全部接入真实消费点', () => {
  assert.match(appSource, /url\('\/assets\/formal-console\/console-ambient-bg\.webp'\)/);
  assert.match(appSource, /url\('\/assets\/formal-console\/perception-field-bg\.webp'\)/);
  assert.match(appSource, /url\('\/assets\/formal-console\/character-display-bg\.webp'\)/);
  assert.match(appSource, /src="\/assets\/formal-console\/partner-empty-illustration\.webp"/);
  assert.doesNotMatch(appSource, /inspector-empty-mark/);
});

test('正式版位图尺寸、透明通道和体积符合运行时预算', () => {
  const ambient = readWebpMeta(formalAssetPaths.ambient);
  const perception = readWebpMeta(formalAssetPaths.perception);
  const character = readWebpMeta(formalAssetPaths.character);
  const empty = readWebpMeta(formalAssetPaths.empty);

  assert.deepEqual([ambient.width, ambient.height, ambient.alpha], [1600, 900, false]);
  assert.deepEqual([perception.width, perception.height, perception.alpha], [1600, 900, false]);
  assert.deepEqual([character.width, character.height, character.alpha], [768, 768, false]);
  assert.deepEqual([empty.width, empty.height, empty.alpha], [640, 640, true]);
  assert.ok(
    ambient.size + perception.size + character.size + empty.size <= 1.5 * 1024 * 1024,
    '正式版位图总大小必须不超过 1.5 MB',
  );
});
