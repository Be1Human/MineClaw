import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  hasIcon,
  iconAliases,
  iconDefinitions,
  iconNames,
  resolveIcon,
} from '../../../../apps/minecraft-companion/web/src/icons/iconDefinitions.js';

const requiredIcons = [
  'unknown', 'settings', 'close', 'plus', 'minus', 'undo', 'play', 'stop', 'compass', 'health',
  'thinking', 'brain', 'tool', 'success', 'error', 'finish', 'gather',
  'craft', 'task', 'door', 'stuck', 'critic', 'memory', 'skill', 'activity',
  'history', 'backpack', 'route', 'pen', 'fill', 'eyedropper', 'erase', 'bot',
  'refresh', 'trash', 'package', 'key', 'warning', 'id-card', 'server',
  'character', 'world', 'day', 'night', 'shield', 'blocked', 'disabled', 'eye',
  'food', 'goal', 'external-link', 'lightning', 'status-dot', 'connected',
  'disconnected',
];

const componentSource = readFileSync(
  new URL('../../../../apps/minecraft-companion/web/src/components/icons/McIcon.vue', import.meta.url),
  'utf8',
);

test('the registry exposes frozen 16x16 definitions with a deterministic fallback', () => {
  assert.equal(hasIcon('unknown'), true);
  assert.equal(hasIcon('missing-icon'), false);
  assert.equal(resolveIcon('missing-icon'), iconDefinitions.unknown);
  assert.equal(new Set(iconNames).size, iconNames.length);
  assert.deepEqual(iconNames.slice().sort(), requiredIcons.slice().sort());
  assert.equal(iconDefinitions.unknown.viewBox, '0 0 16 16');
  assert.ok(Object.isFrozen(iconDefinitions));
  assert.ok(Object.isFrozen(iconDefinitions.unknown));
  assert.ok(Object.isFrozen(iconDefinitions.unknown.layers));

  for (const definition of Object.values(iconDefinitions)) {
    assert.equal(definition.viewBox, '0 0 16 16');
    assert.ok(definition.layers.length > 0);
    for (const layer of definition.layers) {
      assert.match(layer.d, /^M/);
      assert.doesNotMatch(layer.d, /\d+\.\d+/);
      assert.doesNotMatch(layer.d, /url\(|https?:|data:/i);
      assert.ok(['primary', 'accent'].includes(layer.tone));
    }
  }

  for (const [alias, target] of Object.entries(iconAliases)) {
    assert.equal(iconDefinitions[alias], iconDefinitions[target]);
  }
});

test('McIcon declares crisp SVG sizing, color inheritance and accessible modes', () => {
  assert.match(componentSource, /class="mc-icon"/);
  assert.match(componentSource, /:viewBox="definition\.viewBox"/);
  assert.match(componentSource, /:width="normalizedSize"/);
  assert.match(componentSource, /:height="normalizedSize"/);
  assert.match(componentSource, /shape-rendering="crispEdges"/);
  assert.match(componentSource, /'var\(--mc-icon-accent, currentColor\)'/);
  assert.match(componentSource, /:role="label \? 'img' : undefined"/);
  assert.match(componentSource, /:aria-label="label \|\| undefined"/);
  assert.match(componentSource, /:aria-hidden="label \? undefined : 'true'"/);
  assert.match(componentSource, /typeof props\.size === 'number' \? `\$\{props\.size\}px`/);
});

test('the renderer stays business-agnostic and definition-driven', () => {
  assert.match(componentSource, /definition\.layers/);
  assert.match(componentSource, /resolveIcon\(props\.name\)/);
  assert.doesNotMatch(componentSource, /switch\s*\(|case\s+['"]/);
  assert.doesNotMatch(componentSource, /settings|task|thinking|warning/);
});
