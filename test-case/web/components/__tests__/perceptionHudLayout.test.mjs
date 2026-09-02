import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/App.vue', import.meta.url),
  'utf8',
);
const sceneSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/components/PerceptionScene3D.vue', import.meta.url),
  'utf8',
);

test('真实世界 HUD 避开顶部模式与视角控制区', () => {
  assert.match(
    appSource,
    /\.perception-scene\s*\{[^}]*--perception-hud-top-safe-area:\s*112px;/,
  );
  assert.match(appSource, /\.perception-stage-toolbar\s*\{[^}]*top:\s*14px;/);
  assert.match(appSource, /\.perception-camera-controls\s*\{[^}]*top:\s*66px;/);

  assert.match(
    sceneSource,
    /\.hud-top-left\s*\{[^}]*top:\s*var\(--perception-hud-top-safe-area,\s*12px\)/,
  );
  assert.match(
    sceneSource,
    /\.hud-top-right\s*\{[^}]*top:\s*var\(--perception-hud-top-safe-area,\s*12px\)/,
  );
});
