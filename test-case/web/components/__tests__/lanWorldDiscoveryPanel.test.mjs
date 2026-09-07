import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectLanWorldSnapshot } from '../../../../apps/minecraft-companion/web/src/lib/lanWorldPresentation.js';

const appSource = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/App.vue', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/components/LanWorldDiscoveryPanel.vue', import.meta.url), 'utf8');

test('FEAT-WEBUI-30-002 | LAN 快照过滤非法候选、去重并按最近发现排序', () => {
  assert.deepEqual(projectLanWorldSnapshot({
    state: 'listening',
    worlds: [
      { id: 'old', motd: 'Old', host: '192.168.1.2', port: 51000, lastSeenAt: 10 },
      { id: 'new', motd: 'New\nWorld', host: '192.168.1.3', port: 52000, lastSeenAt: 20 },
      { id: 'old', motd: 'Refreshed', host: '192.168.1.2', port: 51000, lastSeenAt: 30 },
      { id: 'bad', motd: 'Bad', host: '192.168.1.4', port: 70000, lastSeenAt: 40 },
    ],
  }), {
    state: 'listening',
    worlds: [
      { id: 'old', motd: 'Refreshed', host: '192.168.1.2', port: 51000, lastSeenAt: 30 },
      { id: 'new', motd: 'New World', host: '192.168.1.3', port: 52000, lastSeenAt: 20 },
    ],
  });
});

test('FEAT-WEBUI-30-002 | 卡片只在候选或不可用态出现并提供忙碌禁用态', () => {
  assert.match(panelSource, /worlds\.value\.length > 0 \|\| projected\.value\.state === 'unavailable'/);
  assert.match(panelSource, /v-for="world in worlds"/);
  assert.match(panelSource, /\{\{ world\.host \}\}:\{\{ world\.port \}\}/);
  assert.match(panelSource, /:disabled="disabled \|\| Boolean\(joiningWorldId\)"/);
  assert.match(panelSource, /joiningWorldId === world\.id \? '加入中…'/);
  assert.match(panelSource, /@click="\$emit\('join', world\)"/);
});

test('FEAT-WEBUI-30-002 | App 在桌面与窄屏消费快照且加入请求只发送 worldId', () => {
  assert.equal((appSource.match(/<LanWorldDiscoveryPanel/g) || []).length, 2);
  assert.match(appSource, /class="desktop-lan-worlds"/);
  assert.match(appSource, /class="inspector-lan-worlds"/);
  assert.match(appSource, /socket\.on\('minecraft:lan-worlds'/);
  assert.match(appSource, /fetch\('\/api\/minecraft\/lan-worlds'\)/);
  assert.match(appSource, /body: JSON\.stringify\(\{ worldId: world\.id \}\)/);
  assert.doesNotMatch(appSource, /body: JSON\.stringify\(\{ worldId: world\.id,\s*host:/);
  assert.match(appSource, /worldConnectionActions\.has\(botId\)/);
});

