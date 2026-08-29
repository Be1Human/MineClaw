import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { desktopPetEnvironmentCopy } from '../../../../apps/minecraft-companion/web/src/lib/desktopPetPresentation.js';

const source = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/components/SettingsPanel.vue', import.meta.url),
  'utf8',
);

test('桌面角色在导航和页面标题中均标记为 Beta', () => {
  assert.match(source, /id: 'desktop-pet'[^\n]+beta: true/);
  assert.match(source, /桌面角色 <span class="beta-badge">Beta<\/span>/);
  assert.match(source, /实验性功能：让一个伙伴以 Minecraft 形象常驻桌面/);
  assert.match(source, /\.beta-badge \{/);
});

test('普通浏览器只保存配置且不声称已经创建桌面窗口', () => {
  const copy = desktopPetEnvironmentCopy(false);
  assert.equal(copy.saveLabel, '仅保存配置');
  assert.match(copy.successMessage, /已保存/);
  assert.match(copy.successMessage, /桌面版/);
  assert.match(copy.notice, /不能创建原生桌面角色/);
  assert.doesNotMatch(copy.successMessage, /已应用/);
});

test('Electron 保留保存并立即应用合同', () => {
  const copy = desktopPetEnvironmentCopy(true);
  assert.equal(copy.saveLabel, '保存并立即应用');
  assert.equal(copy.successMessage, '桌面角色设置已应用');
  assert.equal(copy.notice, '');
  assert.match(source, /desktopPetCopy\.saveLabel/);
  assert.match(source, /showSaved\(desktopPetCopy\.successMessage\)/);
});
