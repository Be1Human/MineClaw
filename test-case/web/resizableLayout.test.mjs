import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  TRACE_LAYOUT_CONFIG,
  WORKSPACE_LAYOUT_CONFIG,
  constrainPanePair,
  readStoredPanePair,
  resizePanePair,
  storePanePair,
} from '../../apps/minecraft-companion/web/src/lib/resizableLayout.js';

test('invalid and out-of-range pane widths fall back or clamp safely', () => {
  assert.deepEqual(
    constrainPanePair({ first: 'broken', second: Number.POSITIVE_INFINITY }, WORKSPACE_LAYOUT_CONFIG),
    WORKSPACE_LAYOUT_CONFIG.defaults,
  );
  assert.deepEqual(
    constrainPanePair({ first: 10, second: 5000 }, WORKSPACE_LAYOUT_CONFIG),
    { first: 180, second: 600 },
  );
});

test('workspace keeps the center pane usable when the container shrinks', () => {
  const layout = constrainPanePair({ first: 360, second: 600 }, WORKSPACE_LAYOUT_CONFIG, 900);
  assert.deepEqual(layout, { first: 258, second: 300 });
  assert.ok(layout.first + layout.second + WORKSPACE_LAYOUT_CONFIG.fixedSpace + WORKSPACE_LAYOUT_CONFIG.remainingMin <= 900);
});

test('trace layout preserves the detail minimum and supports independent resize deltas', () => {
  const sessionResize = resizePanePair(TRACE_LAYOUT_CONFIG.defaults, 'first', 60, TRACE_LAYOUT_CONFIG, 1200);
  const eventResize = resizePanePair(sessionResize, 'second', 80, TRACE_LAYOUT_CONFIG, 1200);
  assert.deepEqual(eventResize, { first: 310, second: 420 });
  assert.ok(eventResize.first + eventResize.second + TRACE_LAYOUT_CONFIG.fixedSpace + TRACE_LAYOUT_CONFIG.remainingMin <= 1200);
});

test('layout preference storage round-trips and corrupt JSON falls back', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  storePanePair(storage, WORKSPACE_LAYOUT_CONFIG, { first: 312, second: 488 });
  assert.deepEqual(readStoredPanePair(storage, WORKSPACE_LAYOUT_CONFIG), { first: 312, second: 488 });

  values.set(WORKSPACE_LAYOUT_CONFIG.storageKey, '{oops');
  assert.deepEqual(readStoredPanePair(storage, WORKSPACE_LAYOUT_CONFIG), WORKSPACE_LAYOUT_CONFIG.defaults);
});

test('resize handles use the existing seams without a permanent decorative line', async () => {
  const handle = await readFile(new URL('../../apps/minecraft-companion/web/src/components/layout/McResizeHandle.vue', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../apps/minecraft-companion/web/src/App.vue', import.meta.url), 'utf8');
  const trace = await readFile(new URL('../../apps/minecraft-companion/web/src/components/LlmTracePanel.vue', import.meta.url), 'utf8');

  assert.match(handle, /setPointerCapture/);
  assert.match(handle, /ArrowLeft/);
  assert.doesNotMatch(handle, /mc-resize-handle::after/);
  assert.match(app, /label="调整伙伴栏宽度"/);
  assert.match(app, /label="调整控制面板宽度"/);
  assert.match(trace, /grid-template-columns:[^;]+ 0 [^;]+ 0 /);
  assert.match(trace, /\.trace-resizer \{ width:8px;/);
});
