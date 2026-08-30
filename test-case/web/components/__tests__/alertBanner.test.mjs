import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer } from 'vite';

let vite;
let AlertBanner;

before(async () => {
  vite = await createServer({
    configFile: 'vite.config.js',
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true },
  });
  AlertBanner = (await vite.ssrLoadModule('/src/components/AlertBanner.vue')).default;
});

after(async () => {
  await vite?.close();
});

async function renderAlert(alerts) {
  return renderToString(createSSRApp({ render: () => h(AlertBanner, { alerts }) }));
}

test('BUG-WEBUI-24 | 仅有内部诊断时不生成用户可见提醒', async () => {
  const html = await renderAlert({
    suspendedByDanger: [],
    recentDiagnoses: [
      { category: 'stuck', detail: 'no_progress:{"taskId":"task-5-1787961018255"}' },
    ],
  });

  assert.doesNotMatch(html, /alert-banner-wrap|近期诊断|stuck|no_progress|task-5-1787961018255/);
});

test('BUG-WEBUI-24 | 诊断与危险并存时只展示危险暂停', async () => {
  const html = await renderAlert({
    suspendedByDanger: ['采集木头', '返回主人'],
    recentDiagnoses: [
      { category: 'stuck', detail: 'no_progress:{"taskId":"task-internal"}' },
    ],
  });

  assert.match(html, /危险暂停中/);
  assert.match(html, /采集木头、返回主人/);
  assert.match(html, /2 个任务/);
  assert.doesNotMatch(html, /近期诊断|stuck|no_progress|task-internal/);
});

test('BUG-WEBUI-24 | 空提醒不生成占位区域', async () => {
  const html = await renderAlert({ suspendedByDanger: [], recentDiagnoses: [] });
  assert.doesNotMatch(html, /alert-banner-wrap|alert-banner/);
});

test('BUG-WEBUI-24 | 组件源码不保留内部诊断模板和样式', () => {
  const source = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/components/AlertBanner.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /recentDiagnoses|近期诊断|diag-list|diag-item|diag-category|diag-detail/);
  assert.match(source, /alerts\.suspendedByDanger\.join/);
});
