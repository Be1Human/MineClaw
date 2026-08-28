<template>
  <section class="trace-panel mc-subsystem" aria-label="LLM 调用轨迹工作台">
    <header class="trace-header mc-subsystem-header">
      <div>
        <div class="trace-kicker mc-eyebrow">TRACE WORKBENCH</div>
        <h1>LLM 调用轨迹</h1>
        <p>逐次查看 MainBrain 与 GoalAgent 真正发送给模型的输入、上下文和工具。</p>
      </div>
      <div class="trace-actions">
        <span class="live-pill" :class="{ active: polling }"><i></i>{{ polling ? '实时追踪' : '历史模式' }}</span>
        <button type="button" :disabled="!botId || loadingSessions" @click="refreshAll">刷新</button>
        <a v-if="botId && selectedSession" class="button-link" :href="exportUrl" download>导出 JSONL</a>
      </div>
    </header>

    <div v-if="!botId" class="trace-state mc-empty-state large">
      <strong>先选择一个伙伴</strong><span>轨迹按伙伴 Profile 隔离，选择后才能读取。</span>
    </div>

    <template v-else>
      <form class="trace-filters mc-toolbar" @submit.prevent="applyFilters">
        <label><span>搜索</span><input v-model="draftFilters.q" class="mc-field-control" placeholder="消息、事件或 payload" /></label>
        <label><span>Agent</span><select v-model="draftFilters.agent" class="mc-field-control"><option value="">全部</option><option value="mainbrain">MainBrain</option><option value="goalagent">GoalAgent</option><option value="system">System</option></select></label>
        <label><span>节点</span><select v-model="draftFilters.node" class="mc-field-control"><option value="">全部</option><option v-for="node in nodeOptions" :key="node" :value="node">{{ node }}</option></select></label>
        <label><span>Task ID</span><input v-model="draftFilters.taskId" class="mc-field-control" placeholder="可选" /></label>
        <button class="primary" type="submit">应用筛选</button>
        <button type="button" @click="clearFilters">清空</button>
      </form>

      <div class="mobile-crumbs" aria-label="移动端轨迹导航">
        <button :class="{ active: mobilePane === 'sessions' }" @click="mobilePane = 'sessions'">对话/回合</button>
        <button :disabled="!selectedSession" :class="{ active: mobilePane === 'events' }" @click="mobilePane = 'events'">账本</button>
        <button :disabled="!selectedEvent" :class="{ active: mobilePane === 'detail' }" @click="mobilePane = 'detail'">详情</button>
      </div>

      <div class="trace-workspace">
        <aside class="session-column" :class="{ 'mobile-hidden': mobilePane !== 'sessions' }">
          <div class="column-heading"><div><span>CONVERSATION / TURNS</span><strong>持续对话与回合</strong></div><b>{{ sessions.length }}</b></div>
          <div v-if="loadingSessions" class="trace-state"><span class="spinner"></span><span>正在读取对话…</span></div>
          <div v-else-if="sessionError" class="trace-state error"><strong>暂时读不到轨迹</strong><span>{{ sessionError }}</span><button @click="loadSessions(true)">重试</button></div>
          <div v-else-if="!sessions.length" class="trace-state"><strong>还没有调用轨迹</strong><span>和伙伴聊一句，或委托一个游戏目标后再来看。</span></div>
          <div v-else class="session-list">
            <section v-for="session in sessions" :key="session.sessionId" class="conversation-group">
              <button class="session-row" :class="{ active: selectedSession?.sessionId === session.sessionId }" @click="selectSession(session)">
                <span class="session-status" :class="session.status"></span>
                <span class="session-copy"><strong>{{ session.title }}</strong><small>{{ formatDate(session.updatedAt) }} · {{ session.turnCount }} 回合 · {{ session.callCount }} 调用</small><small class="cache-summary" :class="cacheTone(session.cache)">{{ formatCacheSummary(session.cache, '对话累计') }}</small><span><em v-for="agent in session.agents" :key="agent">{{ agentLabel(agent) }}</em></span></span>
              </button>
              <div v-if="selectedSession?.sessionId === session.sessionId" class="turn-list" aria-label="对话回合">
                <button class="turn-row" :class="{ active: !selectedTurn }" @click="selectTurn(null)"><strong>全部回合</strong><small>{{ session.eventCount }} 事件 · {{ session.turnCount }} 回合</small></button>
                <button v-for="turnItem in [...(session.turns || [])].reverse()" :key="turnItem.key" class="turn-row" :class="{ active: selectedTurn?.key === turnItem.key }" @click="selectTurn(turnItem)"><strong>{{ turnItem.title }}</strong><small>{{ formatTime(turnItem.startedAt) }} · {{ turnItem.eventCount }} 事件 · {{ turnItem.callCount }} 调用</small><small class="cache-summary" :class="cacheTone(turnItem.cache)">{{ formatCacheSummary(turnItem.cache, '本轮') }}</small></button>
              </div>
            </section>
            <button v-if="sessionHasMore" class="load-more" :disabled="loadingMoreSessions" @click="loadMoreSessions">{{ loadingMoreSessions ? '加载中…' : '加载更多会话' }}</button>
          </div>
        </aside>

        <main class="event-column" :class="{ 'mobile-hidden': mobilePane !== 'events' }">
          <div class="column-heading"><div><span>EVENT LEDGER</span><strong>{{ selectedTurn ? `回合 · ${selectedTurn.title}` : '全部回合账本' }}</strong></div><b v-if="selectedSession">#{{ selectedSession.lastSeq }}</b></div>
          <div v-if="!selectedSession" class="trace-state"><strong>选择一个会话</strong><span>这里会按 seq 展示双 Agent 的完整事件链。</span></div>
          <div v-else-if="loadingEvents" class="trace-state"><span class="spinner"></span><span>正在读取事件…</span></div>
          <div v-else-if="eventError" class="trace-state error"><strong>事件加载失败</strong><span>{{ eventError }}</span><button @click="loadEvents()">重试</button></div>
          <template v-else>
            <div ref="ledgerEl" class="event-ledger" tabindex="0" @scroll="onLedgerScroll">
              <button v-for="event in displayedEvents" :key="event.eventId" class="event-row" :class="[traceEventTone(event.type), { active: selectedEvent?.eventId === event.eventId }]" @click="selectEvent(event)">
                <span class="event-seq">{{ event.seq }}</span>
                <span class="event-rail"><i></i></span>
                <span class="event-copy"><span><em :class="event.agent">{{ agentLabel(event.agent) }}</em><time>{{ formatTime(event.occurredAt) }}</time></span><strong>{{ eventLabel(event.type) }}</strong><small>{{ event.node || event.taskId || event.callId || payloadPreview(event.payload) }}</small><small v-if="event.turnCache" class="cache-summary" :class="cacheTone(event.turnCache)">{{ formatCacheSummary(event.turnCache, '本轮') }}</small><small v-else-if="event.type === 'llm.request.recorded' && event.cache" class="cache-summary" :class="cacheTone(event.cache)">{{ formatCallCache(event.cache) }}</small></span>
              </button>
              <button v-if="eventsHaveOlder" class="load-more" :disabled="loadingOlder" @click="loadOlderEvents">{{ loadingOlder ? '加载中…' : '加载更早事件' }}</button>
            </div>
            <button v-if="newEventCount" class="new-events top" @click="resumeFollowing">{{ newEventCount }} 条新事件 · 回到顶部</button>
          </template>
        </main>

        <aside class="detail-column" :class="{ 'mobile-hidden': mobilePane !== 'detail' }">
          <div class="column-heading"><div><span>CALL INSPECTOR</span><strong>调用检查器</strong></div><b v-if="selectedEvent">#{{ selectedEvent.seq }}</b></div>
          <div v-if="!selectedEvent" class="trace-state"><strong>选择一个事件</strong><span>选择 LLM 调用后默认打开 Input；普通事件显示结构化 payload。</span></div>
          <div v-else-if="detailLoading" class="trace-state"><span class="spinner"></span><span>正在读取完整调用…</span></div>
          <div v-else-if="detailError" class="trace-state error"><strong>调用详情加载失败</strong><span>{{ detailError }}</span></div>
          <template v-else-if="callDetail">
            <nav class="detail-tabs" aria-label="调用详情页签">
              <button v-for="tab in detailTabs" :key="tab.id" :class="{ active: detailTab === tab.id }" @click="detailTab = tab.id">{{ tab.name }}</button>
            </nav>
            <div class="detail-scroll">
              <section v-if="detailTab === 'input'" class="detail-section">
                <div class="detail-toolbar"><strong>模型实际输入</strong><button @click="copyJson(callDetail.request)">复制完整 Input</button></div>
                <dl class="fact-grid"><div><dt>模型</dt><dd>{{ callDetail.request.model || '未知' }}</dd></div><div><dt>状态</dt><dd>{{ callStatusLabel(callDetail.status) }}</dd></div><div><dt>Call ID</dt><dd>{{ callDetail.callId }}</dd></div><div><dt>超时</dt><dd>{{ formatDuration(callDetail.request.timeoutMs) }}</dd></div></dl>
                <div class="subheading"><strong>Messages</strong><span>{{ requestMessages.length }} 条 · 保持原始顺序</span><button @click="rawInput = !rawInput">{{ rawInput ? '结构化视图' : 'Raw JSON' }}</button></div>
                <pre v-if="rawInput" class="json-block">{{ pretty(callDetail.request) }}</pre>
                <div v-else class="message-list"><article v-for="(message, index) in requestMessages" :key="index" class="message-card"><header><span>#{{ index + 1 }}</span><strong>{{ message.role || 'unknown' }}</strong><small v-if="message.name">{{ message.name }}</small></header><pre>{{ messageContent(message) }}</pre></article></div>
              </section>
              <section v-else-if="detailTab === 'output'" class="detail-section"><div class="detail-toolbar"><strong>模型返回 / 失败</strong><button @click="copyJson(callDetail.response)">复制</button></div><pre class="json-block">{{ pretty(callDetail.response) }}</pre></section>
              <section v-else-if="detailTab === 'context'" class="detail-section"><ContextRefs title="已选上下文" :items="contextSelected"/><ContextRefs title="被裁剪上下文" :items="contextOmitted" omitted/></section>
              <section v-else-if="detailTab === 'tools'" class="detail-section"><div class="detail-toolbar"><strong>提供给模型的 Tools</strong><button @click="copyJson(callDetail.tools)">复制 Schema</button></div><pre class="json-block">{{ pretty(callDetail.tools) }}</pre><div class="subheading"><strong>本次调用关联事件</strong><span>{{ toolEvents.length }} 条</span></div><article v-for="event in toolEvents" :key="event.eventId" class="tool-event"><strong>{{ eventLabel(event.type) }}</strong><small>#{{ event.seq }} · {{ event.node || '未标节点' }}</small><pre>{{ pretty(event.payload) }}</pre></article><div v-if="!toolEvents.length" class="inline-empty">没有关联的工具调用或结果。</div></section>
              <section v-else class="detail-section">
                <div class="cache-hero" :class="cacheTone(callDetail)"><span>缓存命中率</span><strong>{{ formatCachePercent(callDetail) }}</strong><small>{{ cacheStatusText(callDetail.cacheStatus) }} · {{ formatTraceTokens(callDetail.usage.cachedInputTokens) }}/{{ formatTraceTokens(callDetail.usage.cacheEligibleInputTokens) }} cached/eligible</small></div>
                <div class="subheading"><strong>Usage</strong><span>Provider 实际上报</span></div>
                <dl class="fact-grid"><div><dt>Input tokens</dt><dd>{{ formatTraceTokens(callDetail.usage.inputTokens) }}</dd></div><div><dt>Output tokens</dt><dd>{{ formatTraceTokens(callDetail.usage.outputTokens) }}</dd></div><div><dt>Cached input</dt><dd>{{ formatTraceTokens(callDetail.usage.cachedInputTokens) }}</dd></div><div><dt>Cache miss</dt><dd>{{ formatTraceTokens(callDetail.usage.cacheMissInputTokens) }}</dd></div><div><dt>Cache eligible</dt><dd>{{ formatTraceTokens(callDetail.usage.cacheEligibleInputTokens) }}</dd></div><div><dt>数据来源</dt><dd>{{ callDetail.usage.source }}</dd></div></dl>
                <div class="subheading"><strong>Timing</strong><span>调用生命周期</span></div>
                <dl class="timing-list"><div><dt>请求记录</dt><dd>{{ formatDate(callDetail.timing.requestedAt) }}</dd></div><div><dt>调用结束</dt><dd>{{ callDetail.timing.finishedAt ? formatDate(callDetail.timing.finishedAt) : '尚未记录' }}</dd></div><div><dt>耗时</dt><dd>{{ formatDuration(callDetail.timing.durationMs) }}</dd></div><div><dt>Agent / Node</dt><dd>{{ agentLabel(callDetail.requestEvent.agent) }} / {{ callDetail.requestEvent.node || '未标节点' }}</dd></div><div><dt>Revision / Epoch</dt><dd>{{ callDetail.requestEvent.stateRevision ?? '—' }} / {{ callDetail.requestEvent.epoch ?? '—' }}</dd></div></dl>
              </section>
            </div>
          </template>
          <div v-else class="detail-scroll"><div class="detail-toolbar"><strong>{{ eventLabel(selectedEvent.type) }}</strong><button @click="copyJson(selectedEvent.payload)">复制 payload</button></div><dl class="fact-grid"><div><dt>Agent</dt><dd>{{ agentLabel(selectedEvent.agent) }}</dd></div><div><dt>Node</dt><dd>{{ selectedEvent.node || '—' }}</dd></div><div><dt>Task</dt><dd>{{ selectedEvent.taskId || '—' }}</dd></div><div><dt>Call</dt><dd>{{ selectedEvent.callId || '—' }}</dd></div></dl><pre class="json-block">{{ pretty(selectedEvent.payload) }}</pre></div>
        </aside>
      </div>
      <div class="copy-toast" role="status" aria-live="polite">{{ copyMessage }}</div>
    </template>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { cacheStatusText, fetchTraceJson, formatCachePercent, formatCacheSummary, formatCallCache, formatTraceJson, formatTraceTokens, mergeTraceEvents, orderTraceEventsNewestFirst, traceEventTone, traceQuery } from '../lib/llmTrace.js';

const props = defineProps({ botId: { type: String, default: '' } });
const sessions = ref([]), selectedSession = ref(null), selectedTurn = ref(null), events = ref([]), selectedEvent = ref(null), callDetail = ref(null);
const loadingSessions = ref(false), loadingMoreSessions = ref(false), loadingEvents = ref(false), loadingOlder = ref(false), detailLoading = ref(false);
const sessionError = ref(''), eventError = ref(''), detailError = ref('');
const sessionCursor = ref(null), sessionHasMore = ref(false), eventsHaveOlder = ref(false), newestSeq = ref(0);
const following = ref(true), newEventCount = ref(0), ledgerEl = ref(null), mobilePane = ref('sessions');
const detailTab = ref('input'), rawInput = ref(false), copyMessage = ref('');
const filters = ref({ q: '', agent: '', node: '', taskId: '' });
const draftFilters = ref({ ...filters.value });
const detailTabs = [{ id: 'input', name: 'Input' }, { id: 'output', name: 'Output' }, { id: 'context', name: 'Context' }, { id: 'tools', name: 'Tools' }, { id: 'timing', name: 'Timing / Usage' }];
let generation = 0, listAbort, detailAbort, pollTimer, copyTimer;

const nodeOptions = computed(() => [...new Set(sessions.value.flatMap(session => session.nodes || []))].sort());
const displayedEvents = computed(() => orderTraceEventsNewestFirst(events.value));
const exportUrl = computed(() => props.botId && selectedSession.value ? `/api/bots/${encodeURIComponent(props.botId)}/v2/llm-traces/export${traceQuery({ sessionId: selectedSession.value.sessionId })}` : '#');
const polling = computed(() => Boolean(props.botId && selectedSession.value));
const requestMessages = computed(() => Array.isArray(callDetail.value?.request?.messages) ? callDetail.value.request.messages : []);
const contextSelected = computed(() => Array.isArray(callDetail.value?.context?.selected) ? callDetail.value.context.selected : []);
const contextOmitted = computed(() => Array.isArray(callDetail.value?.context?.omitted) ? callDetail.value.context.omitted : []);
const toolEvents = computed(() => (callDetail.value?.events || []).filter(event => event.type === 'tool.call' || event.type === 'tool.result'));

const ContextRefs = defineComponent({
  props: { title: String, items: Array, omitted: Boolean },
  setup(inner) { return () => h('section', { class: 'context-block' }, [h('div', { class: 'subheading' }, [h('strong', inner.title), h('span', `${inner.items?.length || 0} 项`)]), ...(inner.items?.length ? inner.items.map(item => h('article', { class: ['context-ref', inner.omitted && 'omitted'] }, [h('strong', item.kind || 'unknown'), h('code', item.ref || '—'), item.reason ? h('small', item.reason) : null])) : [h('div', { class: 'inline-empty' }, '没有记录。')])]); },
});

async function loadSessions(reset = false) {
  if (!props.botId) return;
  const run = generation;
  if (reset) { listAbort?.abort(); listAbort = new AbortController(); sessions.value = []; sessionCursor.value = null; selectedSession.value = null; selectedTurn.value = null; selectedEvent.value = null; callDetail.value = null; loadingSessions.value = true; }
  else loadingMoreSessions.value = true;
  sessionError.value = '';
  try {
    const data = await fetchTraceJson(fetch, `/api/bots/${encodeURIComponent(props.botId)}/v2/llm-traces/sessions${traceQuery({ cursor: reset ? '' : sessionCursor.value, limit: 50, taskId: filters.value.taskId, q: filters.value.q })}`, listAbort?.signal);
    if (run !== generation) return;
    sessions.value = reset ? data.sessions : [...sessions.value, ...data.sessions];
    sessionCursor.value = data.nextCursor; sessionHasMore.value = data.hasMore;
    if (reset && sessions.value[0]) await selectSession(sessions.value[0]);
  } catch (error) { if (error.name !== 'AbortError' && run === generation) sessionError.value = traceErrorMessage(error); }
  finally { if (run === generation) { loadingSessions.value = false; loadingMoreSessions.value = false; } }
}
async function loadMoreSessions() { if (sessionHasMore.value && !loadingMoreSessions.value) await loadSessions(false); }

async function selectSession(session) {
  selectedSession.value = session; selectedTurn.value = null; selectedEvent.value = null; callDetail.value = null; detailError.value = ''; mobilePane.value = 'events';
  await loadEvents();
}
async function selectTurn(turnItem) {
  selectedTurn.value = turnItem; selectedEvent.value = null; callDetail.value = null; detailError.value = ''; mobilePane.value = 'events';
  await loadEvents();
}
async function loadEvents(options = {}) {
  if (!props.botId || !selectedSession.value) return;
  const run = generation, sessionId = selectedSession.value.sessionId, turnId = selectedTurn.value?.interactionSessionId, older = options.older === true;
  if (!older) { events.value = []; loadingEvents.value = true; newestSeq.value = 0; }
  else loadingOlder.value = true;
  eventError.value = '';
  try {
    const firstSeq = events.value[0]?.seq;
    const data = await fetchTraceJson(fetch, `/api/bots/${encodeURIComponent(props.botId)}/v2/llm-traces/events${traceQuery({ sessionId, interactionSessionId: turnId, beforeSeq: older ? firstSeq : undefined, limit: 200, agent: filters.value.agent, node: filters.value.node, taskId: filters.value.taskId, q: filters.value.q })}`, listAbort?.signal);
    if (run !== generation || selectedSession.value?.sessionId !== sessionId || selectedTurn.value?.interactionSessionId !== turnId) return;
    events.value = older ? mergeTraceEvents(events.value, data.events, { keep: 'oldest' }) : data.events;
    updateSelectedSessionProjection(data);
    eventsHaveOlder.value = data.hasMore;
    newestSeq.value = Math.max(newestSeq.value, ...data.events.map(event => event.seq), 0);
    if (!older) { following.value = true; newEventCount.value = 0; await scrollLedgerTop(); }
  } catch (error) { if (error.name !== 'AbortError' && run === generation) eventError.value = traceErrorMessage(error); }
  finally { if (run === generation) { loadingEvents.value = false; loadingOlder.value = false; } }
}
async function loadOlderEvents() { if (eventsHaveOlder.value && !loadingOlder.value) await loadEvents({ older: true }); }

async function pollEvents() {
  if (!props.botId || !selectedSession.value || loadingEvents.value) return;
  const run = generation, sessionId = selectedSession.value.sessionId, turnId = selectedTurn.value?.interactionSessionId;
  try {
    const data = await fetchTraceJson(fetch, `/api/bots/${encodeURIComponent(props.botId)}/v2/llm-traces/events${traceQuery({ sessionId, interactionSessionId: turnId, afterSeq: newestSeq.value, limit: 200, agent: filters.value.agent, node: filters.value.node, taskId: filters.value.taskId, q: filters.value.q })}`);
    if (run !== generation || selectedSession.value?.sessionId !== sessionId || selectedTurn.value?.interactionSessionId !== turnId) return;
    updateSelectedSessionProjection(data);
    if (!data.events.length) return;
    events.value = mergeTraceEvents(events.value, data.events, { keep: 'latest' });
    newestSeq.value = Math.max(newestSeq.value, ...data.events.map(event => event.seq));
    if (following.value) await scrollLedgerTop(); else newEventCount.value += data.events.length;
  } catch { /* 页面已有历史仍可读；轮询错误由手动刷新显式呈现 */ }
}

async function selectEvent(event) {
  selectedEvent.value = event; callDetail.value = null; detailError.value = ''; detailTab.value = 'input'; rawInput.value = false; mobilePane.value = 'detail';
  if (!event.callId) return;
  detailAbort?.abort(); detailAbort = new AbortController(); detailLoading.value = true;
  const run = generation;
  try {
    const data = await fetchTraceJson(fetch, `/api/bots/${encodeURIComponent(props.botId)}/v2/llm-traces/calls/${encodeURIComponent(event.callId)}`, detailAbort.signal);
    if (run === generation && selectedEvent.value?.eventId === event.eventId) callDetail.value = data.call;
  } catch (error) { if (error.name !== 'AbortError' && run === generation) detailError.value = traceErrorMessage(error); }
  finally { if (run === generation) detailLoading.value = false; }
}

function onLedgerScroll() { const el = ledgerEl.value; if (!el) return; following.value = el.scrollTop < 72; if (following.value) newEventCount.value = 0; }
async function scrollLedgerTop() { await nextTick(); if (ledgerEl.value) ledgerEl.value.scrollTop = 0; }
function resumeFollowing() { following.value = true; newEventCount.value = 0; void scrollLedgerTop(); }
function applyFilters() { filters.value = { ...draftFilters.value }; void loadSessions(true); }
function clearFilters() { draftFilters.value = { q: '', agent: '', node: '', taskId: '' }; applyFilters(); }
function refreshAll() { void loadSessions(true); }
function updateSelectedSessionProjection(data) {
  if (!selectedSession.value || !data.cache) return;
  const updated = { ...selectedSession.value, cache: data.cache, turns: data.turns || [] };
  selectedSession.value = updated;
  if (selectedTurn.value) selectedTurn.value = updated.turns.find(turn => turn.key === selectedTurn.value.key) || null;
  sessions.value = sessions.value.map(session => session.sessionId === updated.sessionId ? updated : session);
}

async function copyJson(value) { const text = typeof value === 'string' ? value : pretty(value); try { await navigator.clipboard.writeText(text); copyMessage.value = '已复制完整内容'; } catch { copyMessage.value = '复制失败，请手动选择'; } clearTimeout(copyTimer); copyTimer = setTimeout(() => { copyMessage.value = ''; }, 1800); }
function pretty(value) { return formatTraceJson(value); }
function messageContent(message) { if (typeof message?.content === 'string') return message.content; return pretty(message?.content ?? message); }
function payloadPreview(payload) { const value = payload?.message || payload?.goal || payload?.outcome || payload?.model; return value ? String(value).slice(0, 100) : '结构化事件'; }
function agentLabel(agent) { return ({ mainbrain: 'MainBrain', goalagent: 'GoalAgent', system: 'System', unknown: 'Unknown' })[agent] || agent; }
function eventLabel(type) { return ({ 'interaction.received': '玩家交互进入', 'llm.request.recorded': 'LLM 请求已记录', 'llm.response.recorded': 'LLM 响应已记录', 'llm.call.failed': 'LLM 调用失败', 'llm.call.cancelled': 'LLM 调用取消', 'trace.persistence_gap': '轨迹持久化缺口', 'delegation.submitted': 'MainBrain 提交委托', 'delegation.accepted': 'GoalAgent 接受委托', 'agent.node.entered': '进入 Agent 节点', 'agent.node.exited': '离开 Agent 节点', 'context.source.selected': '上下文来源选中', 'context.source.omitted': '上下文来源裁剪', 'tool.call': '工具调用', 'tool.result': '工具结果', 'world.observed': '世界观察', 'verdict.recorded': '判据记录', 'session.terminal': '会话终态' })[type] || type; }
function callStatusLabel(status) { return ({ succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '中断', in_flight: '进行中' })[status] || status; }
function cacheTone(metric) { return `cache-${metric?.cacheStatus || 'unknown'}${metric?.cacheHitRate === 0 ? ' cache-zero' : ''}`; }
function formatDuration(value) { return typeof value === 'number' ? (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`) : '未知'; }
function formatDate(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function formatTime(value) { return value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—'; }
function traceErrorMessage(error) { if (error.status === 503) return '伙伴大脑尚未运行，启动伙伴后轨迹服务才可用。'; return error.message || String(error); }

watch(() => props.botId, () => { generation += 1; listAbort?.abort(); detailAbort?.abort(); listAbort = new AbortController(); sessions.value = []; selectedSession.value = null; selectedTurn.value = null; events.value = []; selectedEvent.value = null; callDetail.value = null; mobilePane.value = 'sessions'; if (props.botId) void loadSessions(true); }, { immediate: true });
onMounted(() => { pollTimer = setInterval(() => { void pollEvents(); }, 2000); });
onUnmounted(() => { generation += 1; listAbort?.abort(); detailAbort?.abort(); clearInterval(pollTimer); clearTimeout(copyTimer); });
</script>

<style scoped>
.trace-panel { height:100%; min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.trace-header { flex:none; display:flex; justify-content:space-between; gap:20px; }
.trace-kicker,.column-heading span { color:var(--mc-accent); font:10px var(--mc-font-mono); font-weight:700; letter-spacing:.08em; }
.trace-header h1 { margin:4px 0 3px; color:var(--mc-text); font-family:var(--mc-font-body); font-size:var(--mc-type-page-title); font-weight:700; }.trace-header p { margin:0; color:var(--mc-text-muted); font-size:var(--mc-type-secondary); }
.trace-actions { display:flex; align-items:center; gap:8px; }.button-link { cursor:pointer; text-decoration:none; }.trace-panel button:disabled { opacity:.45; cursor:not-allowed; }
.live-pill { display:flex; align-items:center; gap:7px; padding:7px 9px; border:1px solid var(--mc-border); border-radius:999px; color:var(--mc-text-muted); font-size:11px; }.live-pill i { width:7px; height:7px; border-radius:50%; background:currentColor; }.live-pill.active { color:var(--mc-accent-strong); }.live-pill.active i { box-shadow:0 0 8px currentColor; }
.trace-filters { flex:none; display:grid; grid-template-columns:minmax(170px,1fr) 130px 150px 180px auto auto; gap:8px; align-items:end; }.trace-filters label { display:flex; flex-direction:column; gap:4px; min-width:0; }.trace-filters label span { color:var(--mc-text-muted); font-size:var(--mc-type-secondary); }.trace-filters input,.trace-filters select { min-width:0; height:34px; }
.trace-workspace { flex:1; min-height:0; display:grid; grid-template-columns:250px minmax(300px,.85fr) minmax(360px,1.35fr); }.session-column,.event-column,.detail-column { min-width:0; min-height:0; display:flex; flex-direction:column; }.detail-column { border-right:0; }
.column-heading { flex:none; min-height:48px; padding:8px 11px; display:flex; align-items:center; justify-content:space-between; }.column-heading div { display:flex; flex-direction:column; gap:3px; }.column-heading strong { font-size:13px; }.column-heading b { color:var(--mc-text-muted); font:12px var(--mc-font-mono); }
.session-list,.event-ledger,.detail-scroll { flex:1; min-height:0; overflow:auto; }.conversation-group { border-bottom:1px solid var(--mc-border); }.session-row { width:100%; min-height:88px; display:flex; align-items:flex-start; gap:9px; padding:10px; border:0; background:transparent; box-shadow:none; text-align:left; }.session-row:hover,.session-row.active { background:var(--mc-surface-hover); }.session-row.active { box-shadow:inset 2px 0 var(--mc-accent); }.session-status { flex:none; width:8px; height:8px; margin-top:4px; border-radius:50%; background:var(--mc-text-muted); }.session-status.active,.session-status.completed { background:var(--mc-accent); }.session-status.failed,.session-status.interrupted { background:var(--mc-danger); }.session-status.in_flight { background:var(--mc-warning); }.session-copy { min-width:0; display:flex; flex-direction:column; gap:5px; }.session-copy strong { overflow:hidden; color:var(--mc-text); font-size:12px; text-overflow:ellipsis; white-space:nowrap; }.session-copy small { color:var(--mc-text-muted); font-size:10px; }.session-copy span { display:flex; gap:4px; }.session-copy em,.event-copy em { padding:2px 4px; border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); color:var(--mc-accent-strong); font-size:9px; font-style:normal; }.turn-list { padding:5px 7px 9px 14px; background:var(--mc-bg); }.turn-row { width:100%; min-height:54px; display:flex; flex-direction:column; align-items:flex-start; gap:4px; padding:7px 9px; border:0; border-left:2px solid var(--mc-border-strong); background:transparent; box-shadow:none; text-align:left; }.turn-row:hover,.turn-row.active { background:var(--mc-surface-hover); border-left-color:var(--mc-accent); }.turn-row strong { width:100%; overflow:hidden; color:var(--mc-text-secondary); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }.turn-row small { color:var(--mc-text-muted); font-size:9px; }
.event-ledger { position:relative; padding:6px 0; }.event-row { width:min(100%,360px); min-height:62px; display:grid; grid-template-columns:34px 14px minmax(0,1fr); padding:7px 9px; border:0; background:transparent; box-shadow:none; text-align:left; }.event-row:hover,.event-row.active { background:var(--mc-surface-hover); }.event-row.active { box-shadow:inset 2px 0 var(--mc-accent); }.event-seq { color:var(--mc-text-muted); font:10px var(--mc-font-mono); padding-top:3px; }.event-rail { position:relative; }.event-rail::before { content:''; position:absolute; left:5px; inset-block:0; width:1px; background:var(--mc-border-strong); }.event-rail i { position:absolute; z-index:1; left:2px; top:3px; width:8px; height:8px; border-radius:50%; background:var(--mc-text-muted); border:2px solid var(--mc-bg-elevated); }.event-row.request .event-rail i { background:#62a9e8; }.event-row.success .event-rail i { background:var(--mc-accent); }.event-row.danger .event-rail i { background:var(--mc-danger); }.event-row.warn .event-rail i { background:var(--mc-warning); }.event-copy { min-width:0; display:flex; flex-direction:column; gap:3px; }.event-copy>span { display:flex; justify-content:space-between; gap:6px; }.event-copy em.goalagent { color:#c8a2ff; border-color:rgba(200,162,255,.25); }.event-copy time { color:var(--mc-text-muted); font:9px var(--mc-font-mono); }.event-copy strong { color:var(--mc-text-secondary); font-size:11px; }.event-copy small { overflow:hidden; color:var(--mc-text-muted); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.load-more { width:calc(100% - 16px); margin:8px; border-style:dashed; }.new-events { position:absolute; z-index:3; left:50%; bottom:12px; transform:translateX(-50%); background:#2f6d30; color:white; white-space:nowrap; }.new-events.top { top:52px; bottom:auto; }
.detail-tabs { flex:none; display:flex; gap:3px; padding:7px 8px; overflow-x:auto; }.detail-tabs button { min-height:29px; padding:4px 9px; box-shadow:none; }.detail-scroll { padding:11px; }.detail-section { display:flex; flex-direction:column; gap:12px; }.detail-toolbar,.subheading { display:flex; align-items:center; justify-content:space-between; gap:8px; }.detail-toolbar strong,.subheading strong { color:var(--mc-text); font-size:12px; }.subheading { padding-top:6px; border-top:1px solid var(--mc-border); }.subheading span { margin-left:auto; color:var(--mc-text-muted); font-size:10px; }
.fact-grid { display:grid; grid-template-columns:1fr 1fr; gap:1px; margin:0; background:var(--mc-border); }.fact-grid div,.timing-list div { min-width:0; padding:8px; background:var(--mc-surface); }.fact-grid dt,.timing-list dt { color:var(--mc-text-muted); font-size:9px; }.fact-grid dd,.timing-list dd { margin:3px 0 0; overflow-wrap:anywhere; color:var(--mc-text-secondary); font:11px var(--mc-font-mono); }.json-block,.message-card pre,.tool-event pre { max-height:360px; margin:0; padding:10px; overflow:auto; border:1px solid var(--mc-border); background:var(--mc-bg); color:#b9c7ae; font:11px/1.55 var(--mc-font-mono); white-space:pre-wrap; overflow-wrap:anywhere; }.message-list { display:flex; flex-direction:column; gap:8px; }.message-card { border:1px solid var(--mc-border); background:var(--mc-surface); }.message-card header { display:flex; gap:7px; padding:6px 9px; border-bottom:1px solid var(--mc-border); color:var(--mc-text-muted); font:10px var(--mc-font-mono); }.message-card header strong { color:var(--mc-accent-strong); }.context-block { display:flex; flex-direction:column; gap:7px; }.context-ref { display:grid; grid-template-columns:100px minmax(0,1fr); gap:5px 8px; padding:9px; border:1px solid var(--mc-border); background:var(--mc-surface); }.context-ref strong { color:var(--mc-accent-strong); font-size:10px; }.context-ref code { overflow-wrap:anywhere; color:var(--mc-text-secondary); font-size:10px; }.context-ref small { grid-column:2; color:var(--mc-warning); }.context-ref.omitted { border-color:rgba(217,170,76,.24); }.tool-event { display:flex; flex-direction:column; gap:4px; padding:8px; border:1px solid var(--mc-border); }.tool-event small { color:var(--mc-text-muted); }.timing-list { display:flex; flex-direction:column; gap:1px; margin:0; background:var(--mc-border); }.timing-list div { display:grid; grid-template-columns:120px 1fr; }.inline-empty { padding:12px; border:1px dashed var(--mc-border-strong); color:var(--mc-text-muted); font-size:11px; }
.cache-summary { display:block; overflow:hidden; color:var(--mc-accent); font:9px var(--mc-font-mono); text-overflow:ellipsis; white-space:nowrap; }.cache-summary.cache-zero { color:var(--mc-warning); }.cache-summary.cache-unsupported,.cache-summary.cache-unavailable,.cache-summary.cache-bypass,.cache-summary.cache-unknown { color:var(--mc-text-muted); }.cache-hero { display:grid; grid-template-columns:1fr auto; gap:4px 12px; padding:12px; border:1px solid rgba(105,201,74,.24); border-radius:var(--mc-radius-sm); background:var(--mc-accent-soft); }.cache-hero>span { color:var(--mc-text-secondary); font-size:10px; }.cache-hero>strong { grid-row:1/3; grid-column:2; align-self:center; color:var(--mc-accent-strong); font:700 25px var(--mc-font-mono); }.cache-hero>small { color:var(--mc-text-muted); font:9px var(--mc-font-mono); }.cache-hero.cache-zero { border-color:rgba(217,170,76,.24); }.cache-hero.cache-zero>strong { color:var(--mc-warning); }.cache-hero.cache-unsupported,.cache-hero.cache-unavailable,.cache-hero.cache-bypass { border-color:var(--mc-border); background:var(--mc-surface); }.cache-hero.cache-unsupported>strong,.cache-hero.cache-unavailable>strong,.cache-hero.cache-bypass>strong { color:var(--mc-text-muted); }
.trace-state { flex:1; min-height:150px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:24px; color:var(--mc-text-muted); text-align:center; }.trace-state.large { min-height:0; }.trace-state strong { color:var(--mc-text-secondary); }.trace-state.error strong { color:var(--mc-danger); }.spinner { width:18px; height:18px; border:2px solid var(--mc-border-strong); border-top-color:var(--mc-accent); border-radius:50%; animation:spin .8s linear infinite; }.copy-toast:empty { display:none; }.copy-toast { position:fixed; z-index:30; right:18px; bottom:18px; padding:9px 12px; border:1px solid rgba(105,201,74,.28); border-radius:var(--mc-radius-sm); background:#244d27; color:#fff; box-shadow:var(--mc-shadow-sm); font-size:12px; }.mobile-crumbs { display:none; }.mobile-hidden { display:flex; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (max-width:1100px) { .trace-workspace { grid-template-columns:220px 290px minmax(340px,1fr); }.trace-filters { grid-template-columns:1fr 120px 130px; }.trace-filters button { align-self:end; } }
@media (max-width:850px) { .trace-header { padding:11px; }.trace-header p,.live-pill { display:none; }.trace-header h1 { font-size:var(--mc-type-page-title); }.trace-filters { grid-template-columns:1fr 1fr; max-height:170px; overflow:auto; }.mobile-crumbs { flex:none; display:grid; grid-template-columns:repeat(3,1fr); padding:5px; border-bottom:1px solid var(--mc-border); }.mobile-crumbs button { min-height:34px; border:1px solid transparent; border-radius:var(--mc-radius-xs); background:transparent; color:var(--mc-text-muted); box-shadow:none; }.mobile-crumbs button.active { background:var(--mc-accent-soft); border-color:rgba(105,201,74,.24); color:var(--mc-accent-strong); }.trace-workspace { display:block; position:relative; }.session-column,.event-column,.detail-column { position:absolute; inset:0; border:0; }.event-row { width:100%; }.mobile-hidden { display:none; }.fact-grid { grid-template-columns:1fr; } }
</style>
