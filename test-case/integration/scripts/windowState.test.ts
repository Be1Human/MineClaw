import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DEFAULT_WINDOW_STATE,
  MINIMUM_WINDOW_SIZE,
  normalizeWindowState,
} from '../../../apps/minecraft-companion/electron/windowState.js';

const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];

test('missing or invalid window state uses safe defaults', () => {
  assert.deepEqual(normalizeWindowState(null, displays), DEFAULT_WINDOW_STATE);
  assert.deepEqual(normalizeWindowState({ width: 'bad', height: null }, displays), DEFAULT_WINDOW_STATE);
});

test('window size is constrained to the supported desktop range', () => {
  const state = normalizeWindowState({ width: 100, height: 200, maximized: true }, displays);
  assert.equal(state.width, MINIMUM_WINDOW_SIZE.width);
  assert.equal(state.height, MINIMUM_WINDOW_SIZE.height);
  assert.equal(state.maximized, true);
});

test('visible saved position is restored and off-screen position is discarded', () => {
  assert.deepEqual(
    normalizeWindowState({ x: 120, y: 80, width: 1400, height: 900 }, displays),
    { x: 120, y: 80, width: 1400, height: 900, maximized: false },
  );
  assert.deepEqual(
    normalizeWindowState({ x: 5000, y: 5000, width: 1400, height: 900 }, displays),
    { width: 1400, height: 900, maximized: false },
  );
});

test('multi-display state remains valid when it intersects any work area', () => {
  const state = normalizeWindowState(
    { x: -1100, y: 100, width: 1000, height: 700 },
    [{ x: -1280, y: 0, width: 1280, height: 1024 }, ...displays],
  );
  assert.equal(state.x, -1100);
  assert.equal(state.y, 100);
});

test('main window explicitly keeps native resize edges and state persistence', async () => {
  const source = await readFile(new URL('../../../apps/minecraft-companion/electron/main.ts', import.meta.url), 'utf8');
  assert.match(source, /resizable:\s*true/);
  assert.match(source, /thickFrame:\s*true/);
  assert.match(source, /getNormalBounds\(\)/);
  assert.match(source, /window-state\.json/);
  assert.doesNotMatch(source, /show:\s*false/);
});
