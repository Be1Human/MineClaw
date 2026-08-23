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

export function traceEventTone(type) {
  if (type === 'llm.call.failed' || type === 'trace.persistence_gap') return 'danger';
  if (type === 'llm.call.cancelled' || type === 'context.source.omitted') return 'warn';
  if (type === 'llm.response.recorded' || type === 'session.terminal') return 'success';
  if (type === 'llm.request.recorded') return 'request';
  return 'neutral';
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
