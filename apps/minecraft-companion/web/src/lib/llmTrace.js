export const TRACE_EVENT_WINDOW = 500;

export function traceQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : '';
}

export async function fetchTraceJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || body.error || `轨迹请求失败 (${response.status})`);
    error.status = response.status;
    error.code = body.error;
    throw error;
  }
  return response.json();
}

export function mergeTraceEvents(current, incoming, options = {}) {
  const limit = options.limit ?? TRACE_EVENT_WINDOW;
  const keep = options.keep ?? 'latest';
  const bySeq = new Map([...current, ...incoming].map(event => [event.seq, event]));
  const ordered = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  if (ordered.length <= limit) return ordered;
  return keep === 'oldest' ? ordered.slice(0, limit) : ordered.slice(-limit);
}

export function orderTraceEventsNewestFirst(events) {
  return [...events].sort((left, right) => right.seq - left.seq);
}

const TRACE_EVENT_KINDS = {
  'interaction.received': { kind: 'user', label: '玩家', tone: 'request' },
  'llm.request.recorded': { kind: 'model', label: '模型请求', tone: 'model' },
  'llm.response.recorded': { kind: 'model', label: '模型响应', tone: 'success' },
  'llm.call.failed': { kind: 'error', label: '模型失败', tone: 'danger' },
  'llm.call.cancelled': { kind: 'error', label: '已取消', tone: 'warn' },
  'trace.persistence_gap': { kind: 'error', label: '记录缺口', tone: 'danger' },
  'delegation.submitted': { kind: 'agent', label: '提交委托', tone: 'agent' },
  'delegation.accepted': { kind: 'agent', label: '接受委托', tone: 'success' },
  'agent.node.entered': { kind: 'agent', label: '进入节点', tone: 'agent' },
  'agent.node.exited': { kind: 'agent', label: '离开节点', tone: 'neutral' },
  'context.source.selected': { kind: 'context', label: '上下文', tone: 'context' },
  'context.source.omitted': { kind: 'context', label: '上下文裁剪', tone: 'warn' },
  'tool.call': { kind: 'tool', label: '工具', tone: 'tool' },
  'tool.result': { kind: 'tool-result', label: '结果', tone: 'success' },
  'world.observed': { kind: 'world', label: '世界', tone: 'world' },
  'verdict.recorded': { kind: 'verdict', label: '判据', tone: 'verdict' },
  'session.terminal': { kind: 'terminal', label: '终态', tone: 'success' },
};

export function traceEventPresentation(event = {}) {
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const definition = TRACE_EVENT_KINDS[event.type] ?? { kind: 'unknown', label: '事件', tone: 'neutral' };
  const toolFailed = event.type === 'tool.result' && payload.ok === false;
  return {
    kind: definition.kind,
    label: definition.label,
    tone: toolFailed ? 'danger' : definition.tone,
    summary: traceEventSummary(event, payload),
    meta: Number.isFinite(payload.durationMs) ? formatTraceDuration(payload.durationMs) : '',
  };
}

export function traceEventTone(eventOrType) {
  const event = typeof eventOrType === 'string' ? { type: eventOrType } : eventOrType;
  return traceEventPresentation(event).tone;
}

export function traceEventSummary(event = {}, payload = isPlainObject(event.payload) ? event.payload : {}) {
  const fallback = () => firstTraceText(
    payload.summary,
    payload.message,
    payload.reason,
    payload.outcome,
    event.node,
    event.taskId,
    event.callId,
    event.type,
    '结构化事件',
  );
  switch (event.type) {
    case 'interaction.received':
      return firstTraceText(payload.message, payload.sender, '玩家输入');
    case 'llm.request.recorded': {
      const parts = [firstTraceText(payload.model, payload.provider, '未知模型')];
      if (Number.isFinite(payload.messageCount)) parts.push(`${payload.messageCount} messages`);
      if (Number.isFinite(payload.toolCount)) parts.push(`${payload.toolCount} tools`);
      if (event.cache?.cacheHitRate != null) parts.push(`命中 ${formatCachePercent(event.cache)}`);
      return parts.join(' · ');
    }
    case 'llm.response.recorded': {
      const toolNames = traceToolCallNames(payload.toolCalls);
      const content = normalizeTraceText(payload.content);
      if (content) return content;
      if (toolNames.length) return `调用 ${toolNames.join('、')}`;
      return firstTraceText(payload.finishReason, payload.empty ? '模型返回空内容' : '', '模型响应已记录');
    }
    case 'llm.call.failed':
      return `失败 · ${firstTraceText(payload.failure, payload.reason, payload.status, '未知错误')}`;
    case 'llm.call.cancelled':
      return `取消 · ${firstTraceText(payload.reason, '调用方取消')}`;
    case 'trace.persistence_gap':
      return `${firstTraceText(payload.missingEventType, '未知事件')} · ${firstTraceText(payload.reason, '持久化失败')}`;
    case 'delegation.submitted':
      return `MainBrain → GoalAgent · ${compactTraceValue(payload.request) || fallback()}`;
    case 'delegation.accepted':
      return `GoalAgent 已接单 · ${compactTraceValue(payload.result) || fallback()}`;
    case 'agent.node.entered':
      return `进入 ${firstTraceText(event.node, payload.phase, payload.goalAgentEvent, 'Agent 节点')}`;
    case 'agent.node.exited':
      return `离开 ${firstTraceText(event.node, payload.phase, payload.goalAgentEvent, 'Agent 节点')}`;
    case 'context.source.selected':
      return `选中 ${traceContextSource(payload)}`;
    case 'context.source.omitted':
      return `裁剪 ${traceContextSource(payload)}${payload.reason ? ` · ${normalizeTraceText(payload.reason)}` : ''}`;
    case 'tool.call': {
      const name = firstTraceText(payload.name, payload.tool, '未知工具');
      const args = compactTraceValue(payload.arguments ?? payload.input);
      return args ? `${name} · ${args}` : name;
    }
    case 'tool.result': {
      const name = firstTraceText(payload.name, payload.tool, '未知工具');
      const status = payload.ok === false ? '失败' : payload.ok === true ? '成功' : '已返回';
      const result = compactTraceValue(payload.result ?? payload.content);
      return [name, status, result].filter(Boolean).join(' · ');
    }
    case 'world.observed': {
      const inventory = compactTraceValue(payload.inventory);
      return inventory ? `背包 ${inventory}` : fallback();
    }
    case 'verdict.recorded': {
      const status = payload.ok === false || payload.passed === false ? '未通过' : payload.ok === true || payload.passed === true ? '通过' : '';
      return [status, firstTraceText(payload.summary, payload.reason, payload.outcome, payload.status)].filter(Boolean).join(' · ') || fallback();
    }
    case 'session.terminal':
      return [firstTraceText(payload.outcome, '会话结束'), normalizeTraceText(payload.summary)].filter(Boolean).join(' · ');
    default:
      return compactTraceValue(payload) || fallback();
  }
}

export function compactTraceValue(value, limit = 120) {
  if (value == null) return '';
  if (typeof value === 'string') return normalizeTraceText(value, limit);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const shown = value.slice(0, 3).map(item => compactTraceValue(item, 36)).filter(Boolean);
    if (value.length > 3) shown.push(`+${value.length - 3}`);
    return normalizeTraceText(`[${shown.join(', ')}]`, limit);
  }
  if (!isPlainObject(value)) return normalizeTraceText(String(value), limit);
  const entries = Object.entries(value).slice(0, 4).map(([key, item]) => {
    const text = isPlainObject(item) ? '{…}' : compactTraceValue(item, 36);
    return `${key}=${text || '—'}`;
  });
  if (Object.keys(value).length > 4) entries.push('…');
  return normalizeTraceText(entries.join(', '), limit);
}

export function formatTraceJson(value) {
  return value == null ? '未记录' : JSON.stringify(value, null, 2);
}

export function formatCachePercent(metric) {
  const rate = metric?.cacheHitRate;
  return typeof rate === 'number' && Number.isFinite(rate)
    ? `${(rate * 100).toFixed(1)}%`
    : '—';
}

export function cacheStatusText(status) {
  return ({ reported: '已上报', unsupported: '未提供', unavailable: '不可用', bypass: '已绕过' })[status] || '未知';
}

export function formatTraceTokens(value) {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `${trimDecimal(value / 1_000_000)}m`;
  if (Math.abs(value) >= 1_000) return `${trimDecimal(value / 1_000)}k`;
  return String(value);
}

export function formatCacheSummary(cache, prefix = '缓存') {
  const coverage = `${cache?.reportedCalls || 0}/${cache?.totalCalls || 0} calls`;
  if (cache?.cacheHitRate == null) return `${prefix} — · ${cacheStatusText(cache?.cacheStatus)} · ${coverage}`;
  return `${prefix} ${formatCachePercent(cache)} · ${coverage}`;
}

export function formatCallCache(cache) {
  if (cache?.cacheHitRate == null) return `缓存 ${cacheStatusText(cache?.cacheStatus)}`;
  return `命中 ${formatCachePercent(cache)} · ${formatTraceTokens(cache.usage?.cachedInputTokens)}/${formatTraceTokens(cache.usage?.cacheEligibleInputTokens)}`;
}

function trimDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, '');
}

function normalizeTraceText(value, limit = 180) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function firstTraceText(...values) {
  for (const value of values) {
    const normalized = normalizeTraceText(value);
    if (normalized) return normalized;
  }
  return '';
}

function traceToolCallNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => firstTraceText(item?.name, item?.function?.name)).filter(Boolean).slice(0, 3);
}

function traceContextSource(payload) {
  const ref = firstTraceText(payload.ref, payload.sourceRef, payload.source, payload.kind);
  return ref || compactTraceValue(payload) || '未标来源';
}

function formatTraceDuration(value) {
  return value >= 1000 ? `${trimDecimal(value / 1000)} s` : `${Math.round(value)} ms`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
