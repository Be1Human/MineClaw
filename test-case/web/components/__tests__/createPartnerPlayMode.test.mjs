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
const profileStoreSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/src/hub/profileStore.ts', import.meta.url),
  'utf8',
);

test('FEAT-WEBUI-28 | create dialog exposes survival and locks unavailable creative mode', () => {
  assert.match(appSource, /<span>游戏模式<\/span><select v-model="form\.playMode"/);
  assert.match(appSource, /<option value="survival">生存模式<\/option>/);
  assert.match(appSource, /<option value="creative" disabled>创造模式（暂未开放）<\/option>/);
  assert.match(appSource, /playMode:\s*'survival'/);

  const authField = appSource.indexOf('<span>验证方式</span>');
  const playModeField = appSource.indexOf('<span>游戏模式</span>');
  assert.ok(authField >= 0 && playModeField > authField, '游戏模式应位于验证方式右侧的后一个网格单元');
});

test('FEAT-WEBUI-28 | create request submits playMode and preserves the dialog on API errors', () => {
  assert.match(appSource, /playMode:\s*form\.value\.playMode/);
  assert.match(appSource, /if \(!res\.ok\) throw new Error/);
  assert.match(appSource, /createProfileError\.value = error instanceof Error/);
  assert.match(appSource, /:disabled="createProfileSubmitting"/);
  assert.match(appSource, /v-if="createProfileError"[^>]*role="alert"/);

  const responseGuard = appSource.indexOf('if (!res.ok) throw new Error');
  const profileInsert = appSource.indexOf('profiles.value.push(profile)', responseGuard);
  assert.ok(responseGuard >= 0 && profileInsert > responseGuard, '错误响应必须在写入伙伴列表前被拦截');
});

test('FEAT-WEBUI-28 | dialog remains responsive and does not issue server gamemode commands', () => {
  assert.match(themeSource, /\.mc-form-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(themeSource, /@media\s*\(max-width:\s*850px\)[\s\S]*?\.mc-form-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(appSource, /\.create-partner-error\s*\{[^}]*grid-column:1 \/ -1/);
  assert.doesNotMatch(appSource, /\/gamemode\b/i);
  assert.doesNotMatch(profileStoreSource, /\/gamemode\b/i);
});
