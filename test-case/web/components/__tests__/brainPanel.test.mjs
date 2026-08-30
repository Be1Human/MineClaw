import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer } from 'vite';
import { migrateMemoryWorkspaceTabs } from '../../../../apps/minecraft-companion/web/src/lib/brainNavigation.js';

let vite;
let BrainPanel;
let SettingsPanel;

before(async () => {
  vite = await createServer({
    configFile: 'vite.config.js',
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  BrainPanel = (await vite.ssrLoadModule('/src/components/BrainPanel.vue')).default;
  SettingsPanel = (await vite.ssrLoadModule('/src/components/SettingsPanel.vue')).default;
});

after(async () => { await vite?.close(); });

test('大脑使用单一产品命名并展示四个内部子页', async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(BrainPanel, {
      botId: 'profile-a',
      profile: { name: 'LanYi', llmConfigId: 'agent-a', personality: { description: '安静可靠' } },
      botStatus: { status: 'awake', companionPhase: 'awake', currentBehavior: '思考中' },
      activeTab: 'overview',
    }),
  }));

  assert.match(html, />大脑</);
  assert.match(html, /LanYi/);
  for (const label of ['概览', '决策', '记忆', '能力']) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /Hermes/i);
});

test('伙伴概览只消费传入 Profile 和状态，A/B 不串内容', async () => {
  const renderBrain = (botId, name, behavior) => renderToString(createSSRApp({
    render: () => h(BrainPanel, {
      botId,
      profile: { name, personality: { description: `${name}-persona` } },
      botStatus: { status: 'offline', currentBehavior: behavior },
      activeTab: 'overview',
    }),
  }));

  const [a, b] = await Promise.all([renderBrain('a', '伙伴 A', '等待'), renderBrain('b', '伙伴 B', '采集')]);
  assert.match(a, /伙伴 A/);
  assert.match(a, /等待/);
  assert.doesNotMatch(a, /伙伴 B|采集/);
  assert.match(b, /伙伴 B/);
  assert.match(b, /采集/);
  assert.doesNotMatch(b, /伙伴 A|等待/);
});

test('决策子页过滤空仲裁和内部检查，只显示有效决定', async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(BrainPanel, {
      botId: 'profile-a',
      profile: { name: '伙伴 A' },
      activeTab: 'decision',
      agentSteps: [
        { type: 'proactive.arbitrated', data: { kind: 'none' }, timestamp: '2026-08-30T15:00:00.000Z' },
        { type: 'proactive.evaluated', data: { kind: 'idle', reason: 'within_follow_distance' }, timestamp: '2026-08-30T15:00:01.000Z' },
        { type: 'tool_call', data: { toolName: 'action_execute' }, timestamp: '2026-08-30T15:00:02.000Z' },
      ],
    }),
  }));

  assert.match(html, /0 条有效决策/);
  assert.match(html, /伙伴正在待命/);
  assert.doesNotMatch(html, /仲裁 · none|>none<|>Tick<|action_execute/);
});

test('决策子页用人话展示决定原因和结果，并合并连续重复项', async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(BrainPanel, {
      botId: 'profile-a',
      profile: { name: '伙伴 A' },
      activeTab: 'decision',
      agentSteps: [
        { type: 'proactive.request', data: { requestText: '跟随主人' }, timestamp: '2026-08-30T15:01:00.000Z' },
        { type: 'proactive.suppressed', data: { requestText: '自动采集', reason: 'foreground_busy' }, timestamp: '2026-08-30T15:01:01.000Z' },
        { type: 'proactive.suppressed', data: { requestText: '自动采集', reason: 'foreground_busy' }, timestamp: '2026-08-30T15:01:02.000Z' },
        { type: 'task.completed', data: { summary: '已把铁镐交给你' }, timestamp: '2026-08-30T15:01:03.000Z' },
        { type: 'unknown.empty', data: {}, timestamp: '2026-08-30T15:01:04.000Z' },
      ],
    }),
  }));

  assert.match(html, /3 条有效决策/);
  assert.match(html, /决定行动/);
  assert.match(html, /跟随主人/);
  assert.match(html, /暂不执行：自动采集/);
  assert.match(html, /原因：正在优先执行当前任务/);
  assert.equal((html.match(/暂不执行：自动采集/g) || []).length, 1);
  assert.match(html, />完成</);
  assert.match(html, /已把铁镐交给你/);
  assert.doesNotMatch(html, /unknown\.empty/);
});

test('大脑挂载真实 MemoryPanel 且不再读取全局旧接口或模拟会话', () => {
  const source = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/components/BrainPanel.vue', import.meta.url), 'utf8');
  assert.match(source, /<MemoryPanel[^>]+:botId="botId"/);
  assert.doesNotMatch(source, /\/api\/hermes\/(?:status|memories|skills)/);
  assert.doesNotMatch(source, /模拟会话|sessions\.value/);

  const memorySource = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/components/MemoryPanel.vue', import.meta.url), 'utf8');
  for (const contract of ['/facts', '/sources', '/restore', '/index/rebuild', '/export']) {
    assert.match(memorySource, new RegExp(contract.replace('/', '\\/')));
  }
});

test('旧顶层 memory 选择迁入对应伙伴的大脑记忆子页', () => {
  const result = migrateMemoryWorkspaceTabs(
    { a: 'memory', b: 'trace', c: 'brain' },
    { a: 'decision', c: 'capabilities' },
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.workspaceTabs, { a: 'brain', b: 'trace', c: 'brain' });
  assert.deepEqual(result.brainTabs, { a: 'memory', c: 'capabilities' });

  const noChange = migrateMemoryWorkspaceTabs({ b: 'trace' }, { b: 'overview' });
  assert.equal(noChange.changed, false);
  assert.deepEqual(noChange.workspaceTabs, { b: 'trace' });
  assert.deepEqual(noChange.brainTabs, { b: 'overview' });
});

test('App 移除顶层记忆并按伙伴持久化大脑子页', () => {
  const source = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/App.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\{ id: 'memory', name: '记忆' \}/);
  assert.doesNotMatch(source, /v-else-if="workspaceView === 'memory'"/);
  assert.match(source, /v-model:active-tab="brainTab"/);
  assert.match(source, /mc\.brainTabs\.v1/);
  assert.match(source, /migrateMemoryWorkspaceTabs/);
});

test('全局设置移除无效 Hermes 配置空壳', async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(SettingsPanel, {
      scope: 'global',
      initialSection: 'llm-configs',
    }),
  }));

  for (const label of ['LLM Agent 配置', '服务器配置', '桌面角色', '高级 / 调试']) {
    assert.match(html, new RegExp(label.replace('/', '\\/')));
  }
  assert.match(html, /Chat Completions/);
  assert.match(html, /Responses/);
  assert.doesNotMatch(html, /Hermes|Bridge/i);

  const source = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/components/SettingsPanel.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /activeSection === 'hermes'|loadHermesStatus|\/api\/hermes\/status/);
  assert.doesNotMatch(source, /hermesEnabled|hermesMemory|hermesTimeout|重启 Bridge|导出技能包/);
  assert.match(source, /v-model="llmConfigForm\.api"/);
  assert.match(source, /value: 'openai-completions'/);
  assert.match(source, /value: 'openai-responses'/);
  assert.match(source, /store:false/);
  assert.match(source, /历史由 MineClaw 本地保存/);
  assert.match(source, /api: llmConfigForm\.api/);
  assert.match(source, /llmApiLabel\(data\.api\)/);
});
