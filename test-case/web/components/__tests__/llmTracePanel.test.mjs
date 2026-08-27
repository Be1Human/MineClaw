import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer } from 'vite';
import {
  TRACE_EVENT_WINDOW,
  cacheStatusText,
  fetchTraceJson,
  formatCachePercent,
  formatCacheSummary,
  formatCallCache,
  formatTraceJson,
  formatTraceTokens,
  mergeTraceEvents,
  orderTraceEventsNewestFirst,
  traceQuery,
} from '../../../../apps/minecraft-companion/web/src/lib/llmTrace.js';

let vite;
let LlmTracePanel;

before(async () => {
  vite = await createServer({
    configFile: 'vite.config.js', server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  });
  LlmTracePanel = (await vite.ssrLoadModule('/src/components/LlmTracePanel.vue')).default;
});

after(async () => { await vite?.close(); });

test('未选择 Profile 时显示明确空状态且不发请求', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('unexpected'); };
  try {
    const html = await renderToString(createSSRApp({ render: () => h(LlmTracePanel, { botId: '' }) }));
    assert.match(html, /先选择一个伙伴/);
    assert.match(html, /Profile 隔离/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('轨迹工作台包含三段式视图、五页签、完整复制和窄屏钻取合同', () => {
  const source = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/components/LlmTracePanel.vue', import.meta.url), 'utf8');
  for (const text of ['CONVERSATION / TURNS', 'EVENT LEDGER', 'CALL INSPECTOR', 'Input', 'Output', 'Context', 'Tools', 'Timing']) {
    assert.match(source, new RegExp(text));
  }
  assert.match(source, /复制完整 Input/);
  assert.match(source, /Raw JSON/);
  assert.match(source, /mobilePane === 'sessions'/);
  assert.match(source, /mobilePane === 'events'/);
  assert.match(source, /mobilePane === 'detail'/);
  assert.match(source, /@media \(max-width:850px\)/);
  assert.match(source, /afterSeq: newestSeq\.value/);
  assert.match(source, /beforeSeq: older \? firstSeq/);
  assert.match(source, /本轮/);
  assert.match(source, /Timing \/ Usage/);
  assert.match(source, /cacheEligibleInputTokens/);
  assert.match(source, /对话累计/);
  assert.match(source, /全部回合/);
  assert.match(source, /selectedTurn/);
  assert.match(source, /interactionSessionId: turnId/);
  assert.match(source, /displayedEvents/);
  assert.match(source, /scrollLedgerTop/);
  assert.match(source, /following\.value = el\.scrollTop < 72/);
  assert.ok(source.indexOf('v-for="event in displayedEvents"') < source.indexOf("loadingOlder ? '加载中…' : '加载更早事件'"));
});

test('缓存指标格式化区分真实零命中、未提供和数据覆盖率', () => {
  const zero = { cacheStatus: 'reported', cacheHitRate: 0, reportedCalls: 1, totalCalls: 2 };
  assert.equal(formatCachePercent(zero), '0.0%');
  assert.equal(formatCacheSummary(zero), '缓存 0.0% · 1/2 calls');
  assert.equal(formatCacheSummary({ cacheStatus: 'unsupported', cacheHitRate: null, reportedCalls: 0, totalCalls: 3 }), '缓存 — · 未提供 · 0/3 calls');
  assert.equal(formatCallCache({ cacheStatus: 'reported', cacheHitRate: 0.736, usage: { cachedInputTokens: 8_200, cacheEligibleInputTokens: 11_500 } }), '命中 73.6% · 8.2k/11.5k');
  assert.equal(cacheStatusText('unavailable'), '不可用');
  assert.equal(formatTraceTokens(1_500_000), '1.5m');
});

test('10,000 事件合并窗口有界、去重且可分别保留最新或最早页', () => {
  const all = Array.from({ length: 10_000 }, (_, index) => ({ seq: index + 1, eventId: `e-${index + 1}` }));
  const latest = mergeTraceEvents([], all);
  assert.equal(TRACE_EVENT_WINDOW, 500);
  assert.equal(latest.length, 500);
  assert.equal(latest[0].seq, 9501);
  assert.equal(latest.at(-1).seq, 10_000);

  const oldest = mergeTraceEvents(all.slice(300, 700), all.slice(0, 400), { keep: 'oldest' });
  assert.equal(oldest.length, 500);
  assert.equal(oldest[0].seq, 1);
  assert.equal(oldest.at(-1).seq, 500);
  assert.equal(new Set(oldest.map(event => event.seq)).size, 500);
});

test('事件展示投影按 seq 从新到旧且不修改内部升序窗口', () => {
  const internal = [{ seq: 1 }, { seq: 3 }, { seq: 2 }];
  const displayed = orderTraceEventsNewestFirst(internal);
  assert.deepEqual(displayed.map(event => event.seq), [3, 2, 1]);
  assert.deepEqual(internal.map(event => event.seq), [1, 3, 2]);
});

test('1 MB Input 可无损格式化，折叠由详情滚动容器承载', () => {
  const content = 'x'.repeat(1024 * 1024);
  const formatted = formatTraceJson({ messages: [{ role: 'system', content }] });
  assert.ok(formatted.length > content.length);
  assert.ok(formatted.includes(content));
  const source = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/components/LlmTracePanel.vue', import.meta.url), 'utf8');
  assert.match(source, /max-height:360px/);
  assert.match(source, /overflow:auto/);
});

test('查询编码保留 Unicode/游标并将服务端错误转成可判断错误', async () => {
  const query = traceQuery({ sessionId: '交互 A', afterSeq: 8, cursor: 'a/b+c', empty: '' });
  assert.match(query, /sessionId=%E4%BA%A4%E4%BA%92\+A/);
  assert.match(query, /afterSeq=8/);
  assert.match(query, /cursor=a%2Fb%2Bc/);
  assert.doesNotMatch(query, /empty/);

  await assert.rejects(
    () => fetchTraceJson(async () => new Response(JSON.stringify({ error: 'trace_unavailable', message: 'not active' }), { status: 503, headers: { 'content-type': 'application/json' } }), '/trace'),
    error => error.status === 503 && error.code === 'trace_unavailable' && error.message === 'not active',
  );
});

test('App 一级工作区顺序固定并把旧 agent 标签迁移到 trace', () => {
  const source = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/App.vue', import.meta.url), 'utf8');
  const ids = ['play', 'brain', 'trace', 'settings'];
  const positions = ids.map(id => source.indexOf(`{ id: '${id}', name:`));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  assert.doesNotMatch(source, /\{ id: 'memory', name: '记忆' \}/);
  assert.doesNotMatch(source, /\{ id: 'evolution', name: '进化' \}|\{ id: 'bench', name: '测试台' \}/);
  assert.doesNotMatch(source, /<PlannerEvolutionPanel|<BenchPanel/);
  assert.match(source, /workspaceViewsByProfile\.value\[profileId\] = 'trace'/);
  assert.match(source, /<LlmTracePanel/);
  assert.doesNotMatch(source, /<AgentLoopPanel/);
});
