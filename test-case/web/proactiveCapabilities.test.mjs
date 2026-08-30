import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  proactiveCapabilityCards,
} from '../../apps/minecraft-companion/web/src/lib/proactiveCapabilities.js';
import { capabilityControlCards } from '../../apps/minecraft-companion/web/src/lib/capabilityControls.js';

test('FEAT-CROSS-25 · unknown registered plugins render without adding a UI id mapping', () => {
  const cards = proactiveCapabilityCards({
    catalog: [{
      id: 'third_party_patrol',
      label: '第三方巡逻',
      description: '由测试能力包动态注册',
      enabled: true,
    }],
    states: [{ id: 'third_party_patrol', state: 'candidate', reason: 'area_changed' }],
    lease: { active: null, releasing: null },
  });
  assert.deepEqual(cards, [{
    id: 'proactive:third_party_patrol',
    enabled: true,
    label: '第三方巡逻',
    icon: 'activity',
    description: '由测试能力包动态注册',
    statusLabel: 'candidate · area_changed',
  }]);

  const settings = readFileSync(join(process.cwd(), 'web', 'src', 'components', 'SettingsPanel.vue'), 'utf8');
  assert.match(settings, /v-for="capability in proactiveCapabilities"/);
  assert.doesNotMatch(settings, /auto_follow|auto_stockpile/);
  const brain = readFileSync(join(process.cwd(), 'web', 'src', 'components', 'BrainPanel.vue'), 'utf8');
  assert.match(brain, /capabilityControlCards/);
  assert.match(brain, /capability\.control\.href/);
  assert.doesNotMatch(brain, /auto_follow|auto_stockpile|memory_consolidation/);
  assert.match(brain, /proactive\.request/);
  assert.match(brain, /proactive\.released/);
});

test('FEAT-CROSS-23 · generic control descriptors render unknown capability switches without UI branching', () => {
  const cards = capabilityControlCards({
    capabilities: [{
      id: 'service:third_party_summary',
      label: '第三方摘要',
      description: '由服务端动态注册',
      icon: 'memory',
      kind: 'internal_service',
      enabled: true,
      defaultEnabled: false,
      statusLabel: '运行中',
      control: { method: 'PATCH', href: '/api/bots/test/capabilities/service%3Athird_party_summary' },
    }],
  });
  assert.deepEqual(cards, [{
    id: 'service:third_party_summary',
    label: '第三方摘要',
    description: '由服务端动态注册',
    icon: 'memory',
    kind: 'internal_service',
    enabled: true,
    defaultEnabled: false,
    statusLabel: '运行中',
    control: { method: 'PATCH', href: '/api/bots/test/capabilities/service%3Athird_party_summary' },
  }]);
});
