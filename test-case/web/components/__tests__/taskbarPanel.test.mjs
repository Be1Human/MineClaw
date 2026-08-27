import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer } from 'vite';

let vite;
let TaskBarPanel;

before(async () => {
  vite = await createServer({
    configFile: 'vite.config.js',
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  TaskBarPanel = (await vite.ssrLoadModule('/src/components/TaskBarPanel.vue')).default;
});

after(async () => {
  await vite?.close();
});

async function renderTaskbar(props) {
  return renderToString(createSSRApp({ render: () => h(TaskBarPanel, props) }));
}

test('任务栏组件渲染 loading / empty / error 三种明确状态', async () => {
  const loading = await renderTaskbar({ botName: 'LanYi', state: 'loading', tasks: [] });
  assert.match(loading, /正在读取任务/);
  assert.match(loading, /正在同步 LanYi 的最新进度/);
  assert.equal((loading.match(/skeleton-card/g) || []).length, 3);

  const empty = await renderTaskbar({ botName: 'LanYi', state: 'ready', tasks: [] });
  assert.match(empty, /现在没有任务/);
  assert.match(empty, /给 LanYi 一个目标后/);

  const error = await renderTaskbar({ botName: 'LanYi', state: 'error', error: 'V2 runtime not active', tasks: [] });
  assert.match(error, /暂时读不到任务/);
  assert.match(error, /V2 runtime not active/);
  assert.match(error, /重新读取/);
});

test('正常态展示汇总、根任务、阶段、进度和子步骤', async () => {
  const tasks = [
    {
      id: 'root-running', state: 'running', label: '收集 2 个橡木原木',
      progress: { have: 1, count: 2, phase: '正在寻找橡树' },
    },
    {
      id: 'child-completed', parentId: 'root-running', state: 'completed',
      label: '走到橡树附近', progress: { done: 1, total: 1 },
    },
    { id: 'root-archived', state: 'completed', label: '旧任务' },
  ];
  const ready = await renderTaskbar({ botName: 'LanYi', state: 'ready', tasks });

  assert.match(ready, /当前目标/);
  assert.match(ready, /收集 2 个橡木原木/);
  assert.match(ready, /正在寻找橡树/);
  assert.match(ready, /1\/2/);
  assert.match(ready, /走到橡树附近/);
  assert.match(ready, /归档/);
  assert.doesNotMatch(ready, />旧任务</);
});

test('控制标签收敛调试入口并保持唯一任务入口', () => {
  const appSource = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/App.vue', import.meta.url), 'utf8');
  const statusIndex = appSource.indexOf("{ id: 'status', name: '状态' }");
  const tasksIndex = appSource.indexOf("{ id: 'tasks', name: '任务栏' }");
  const inventoryIndex = appSource.indexOf("{ id: 'inventory', name: '背包' }");
  assert.ok(statusIndex < tasksIndex && tasksIndex < inventoryIndex);
  assert.doesNotMatch(appSource, /\{ id: 'runtime', name: '运行时' \}/);
  assert.match(appSource, /\{ id: 'trace', name: '轨迹' \}/);
  assert.doesNotMatch(appSource, /\{ id: 'agent', name: '轨迹' \}/);
  assert.match(appSource, /legacyTab === 'agent'/);
  assert.doesNotMatch(appSource, /name:\s*'Agent'/);
  assert.equal((appSource.match(/<TaskBarPanel/g) || []).length, 1);
  assert.doesNotMatch(appSource, /<V2StatusPanel|<CriticPanel/);
  assert.doesNotMatch(appSource, /fetch\('\/api\/v2\/(?:status|critic|supervisor-alerts)'\)/);
  assert.match(appSource, /\/api\/bots\/\$\{encodeURIComponent\(botId\)\}\/v2\/supervisor-alerts/);
  assert.match(appSource, /<AlertBanner :alerts="v2Alerts"/);
});
