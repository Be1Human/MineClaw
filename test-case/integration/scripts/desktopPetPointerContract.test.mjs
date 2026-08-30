import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const appDir = resolve(import.meta.dirname, '../../../apps/minecraft-companion');

test('桌面角色窗口与画布同宽并默认转发穿透 mousemove', async () => {
  const source = await readFile(resolve(appDir, 'electron/desktopPetController.ts'), 'utf8');
  assert.match(source, /const PET_WIDTH = 160/);
  assert.match(source, /setIgnoreMouseEvents\(true, \{ forward: true \}\)/);
  assert.match(source, /isCurrentPetSender\(senderId\)/);
});

test('桌面角色移除整页原生拖拽并使用受控拖动 IPC', async () => {
  const [renderer, preload, main] = await Promise.all([
    readFile(resolve(appDir, 'web/src/DesktopPet.vue'), 'utf8'),
    readFile(resolve(appDir, 'electron/preload.ts'), 'utf8'),
    readFile(resolve(appDir, 'electron/main.ts'), 'utf8'),
  ]);
  assert.doesNotMatch(renderer, /-webkit-app-region\s*:\s*drag/);
  assert.match(renderer, /isOpaqueCanvasPixel/);
  assert.match(preload, /beginDesktopPetDrag/);
  assert.match(preload, /setDesktopPetMousePassthrough/);
  assert.match(main, /desktop-pet:drag-begin/);
  assert.match(main, /desktop-pet:set-mouse-passthrough/);
});
