<template>
  <section class="memory-shell mc-page">
    <header class="memory-header mc-panel">
      <div class="mc-section-copy">
        <div class="eyebrow mc-eyebrow">CHAT MEMORY · 纯聊天记忆</div>
        <h1>记忆控制台</h1>
        <p>查看、检索和治理当前伙伴的长期事实；删除为可恢复的软删除。</p>
      </div>
      <div class="header-actions">
        <button class="mc-button" :disabled="!botId || busy" @click="rebuildIndex">重建索引</button>
        <button class="mc-button" :disabled="!botId || busy" @click="exportMarkdown">导出 Markdown</button>
        <button class="mc-button primary" :disabled="!botId || busy" @click="loadFacts">刷新</button>
      </div>
    </header>

    <div v-if="!botId" class="empty-state mc-empty-state">请先选择一个伙伴。</div>
    <template v-else>
      <div class="toolbar mc-toolbar">
        <input v-model="query" class="mc-field-control" type="search" placeholder="搜索记忆正文" @keyup.enter="loadFacts" />
        <select v-model="status" class="mc-field-control" @change="loadFacts">
          <option value="active">Active</option>
          <option value="candidate">Candidate</option>
          <option value="superseded">Superseded</option>
          <option value="deleted">Deleted</option>
          <option value="rejected">Rejected</option>
          <option value="expired">Expired</option>
          <option value="">全部状态</option>
        </select>
        <button class="mc-button" :disabled="busy" @click="loadFacts">检索</button>
        <span class="count">{{ facts.length }} 条</span>
      </div>

      <div v-if="notice" :class="['notice', 'mc-notice', noticeKind]">{{ notice }}</div>
      <div v-if="loading" class="empty-state mc-empty-state">正在读取记忆…</div>
      <div v-else-if="facts.length === 0" class="empty-state mc-empty-state">
        {{ unavailable ? '伙伴运行时未启动，启动后才能管理其记忆。' : '当前筛选条件下没有记忆。' }}
      </div>
      <div v-else class="fact-grid">
        <article v-for="fact in facts" :key="fact.id" class="fact-card mc-panel">
          <div class="fact-topline">
            <span :class="['status-chip', `status-${fact.status}`]">{{ fact.status }}</span>
            <span class="kind-chip">{{ kindLabel(fact.kind) }}</span>
            <span class="scope-chip">{{ fact.scope === 'agent' ? '伙伴' : '主人' }}</span>
            <time>{{ formatTime(fact.updatedAt) }}</time>
          </div>

          <textarea v-if="editingId === fact.id" v-model="editingText" class="mc-field-control" rows="4" />
          <p v-else class="fact-text">{{ fact.text }}</p>

          <div class="fact-meta">
            <span>可信度 {{ percent(fact.confidence) }}</span>
            <span>重要性 {{ percent(fact.importance) }}</span>
            <span>来源 {{ fact.sourceMessageIds.length }}</span>
          </div>

          <div class="fact-actions">
            <template v-if="editingId === fact.id">
              <button class="mc-button primary" :disabled="busy || !editingText.trim()" @click="saveEdit(fact)">保存</button>
              <button class="mc-button" :disabled="busy" @click="cancelEdit">取消</button>
            </template>
            <template v-else>
              <button class="mc-button" :disabled="busy" @click="showSources(fact)">查看来源</button>
              <button v-if="fact.status === 'active'" class="mc-button" :disabled="busy" @click="startEdit(fact)">编辑</button>
              <button v-if="fact.status === 'active'" class="mc-button danger" :disabled="busy" @click="removeFact(fact)">软删除</button>
              <button v-if="['superseded', 'deleted'].includes(fact.status)" class="mc-button primary" :disabled="busy" @click="restoreFact(fact)">恢复</button>
            </template>
          </div>

          <div v-if="sourceFactId === fact.id" class="sources">
            <div class="sources-title">来源消息</div>
            <div v-if="sourcesLoading">正在读取…</div>
            <div v-else-if="sources.length === 0">没有可用来源。</div>
            <blockquote v-for="source in sources" :key="source.id">
              <span>{{ source.role }} · {{ formatTime(source.timestamp) }}</span>
              {{ source.content }}
            </blockquote>
          </div>
        </article>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

interface MemoryFact {
  id: string;
  scope: 'user' | 'agent';
  kind: string;
  text: string;
  status: string;
  confidence: number;
  importance: number;
  sourceMessageIds: string[];
  updatedAt: number;
}

interface SourceMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

const props = defineProps<{ botId?: string }>();
const facts = ref<MemoryFact[]>([]);
const query = ref('');
const status = ref('active');
const loading = ref(false);
const busy = ref(false);
const unavailable = ref(false);
const notice = ref('');
const noticeKind = ref<'ok' | 'error'>('ok');
const editingId = ref('');
const editingText = ref('');
const sourceFactId = ref('');
const sources = ref<SourceMessage[]>([]);
const sourcesLoading = ref(false);

watch(() => props.botId, () => {
  facts.value = [];
  sourceFactId.value = '';
  if (props.botId) void loadFacts();
}, { immediate: true });

function endpoint(path = ''): string {
  return `/api/bots/${encodeURIComponent(props.botId ?? '')}/chat-memory${path}`;
}

async function loadFacts(): Promise<void> {
  if (!props.botId) return;
  loading.value = true;
  unavailable.value = false;
  try {
    const params = new URLSearchParams();
    if (status.value) params.set('status', status.value);
    if (query.value.trim()) params.set('query', query.value.trim());
    const response = await fetch(`${endpoint('/facts')}?${params}`);
    unavailable.value = response.status === 404;
    if (!response.ok) throw new Error(await responseError(response));
    facts.value = ((await response.json()) as { facts?: MemoryFact[] }).facts ?? [];
  } catch (error) {
    facts.value = [];
    showNotice(error instanceof Error ? error.message : '读取失败', 'error');
  } finally {
    loading.value = false;
  }
}

function startEdit(fact: MemoryFact): void {
  editingId.value = fact.id;
  editingText.value = fact.text;
}

function cancelEdit(): void {
  editingId.value = '';
  editingText.value = '';
}

async function saveEdit(fact: MemoryFact): Promise<void> {
  await mutate(async () => {
    const response = await fetch(endpoint(`/facts/${encodeURIComponent(fact.id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: editingText.value.trim() }),
    });
    if (!response.ok) throw new Error(await responseError(response));
    cancelEdit();
    showNotice('记忆已更新，新旧版本均保留审计记录。');
  });
}

async function removeFact(fact: MemoryFact): Promise<void> {
  await mutate(async () => {
    const response = await fetch(endpoint(`/facts/${encodeURIComponent(fact.id)}`), { method: 'DELETE' });
    if (!response.ok) throw new Error(await responseError(response));
    showNotice('记忆已软删除，可在 Deleted 筛选中恢复。');
  });
}

async function restoreFact(fact: MemoryFact): Promise<void> {
  await mutate(async () => {
    const response = await fetch(endpoint(`/facts/${encodeURIComponent(fact.id)}/restore`), { method: 'POST' });
    if (!response.ok) throw new Error(await responseError(response));
    showNotice('记忆已恢复，冲突的后继版本已退出 Active。');
  });
}

async function showSources(fact: MemoryFact): Promise<void> {
  if (sourceFactId.value === fact.id) {
    sourceFactId.value = '';
    return;
  }
  sourceFactId.value = fact.id;
  sources.value = [];
  sourcesLoading.value = true;
  try {
    const response = await fetch(endpoint(`/facts/${encodeURIComponent(fact.id)}/sources`));
    if (!response.ok) throw new Error(await responseError(response));
    sources.value = ((await response.json()) as { sources?: SourceMessage[] }).sources ?? [];
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '来源读取失败', 'error');
  } finally {
    sourcesLoading.value = false;
  }
}

async function rebuildIndex(): Promise<void> {
  await mutate(async () => {
    const response = await fetch(endpoint('/index/rebuild'), { method: 'POST' });
    if (!response.ok) throw new Error(await responseError(response));
    const result = (await response.json()) as { indexed?: number };
    showNotice(`索引重建完成，共 ${result.indexed ?? 0} 条原始消息。`);
  });
}

async function exportMarkdown(): Promise<void> {
  if (!props.botId) return;
  busy.value = true;
  try {
    const response = await fetch(endpoint('/export'));
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `chat-memory-${props.botId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    showNotice('Markdown 已导出。');
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '导出失败', 'error');
  } finally {
    busy.value = false;
  }
}

async function mutate(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  try {
    await action();
    await loadFacts();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '操作失败', 'error');
  } finally {
    busy.value = false;
  }
}

function showNotice(message: string, kind: 'ok' | 'error' = 'ok'): void {
  notice.value = message;
  noticeKind.value = kind;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; rejected?: string };
    return body.error ?? body.rejected ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function kindLabel(kind: string): string {
  return ({ preference: '偏好', identity: '身份', relationship: '关系', commitment: '承诺', boundary: '边界', project: '项目', agent_note: '伙伴笔记' } as Record<string, string>)[kind] ?? kind;
}

function percent(value: number): string { return `${Math.round(value * 100)}%`; }
function formatTime(value: number): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
</script>

<style scoped>
.memory-shell { position:relative; z-index:2; }
.memory-header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:20px; }
h1 { margin:8px 0 5px; color:var(--mc-text); font-family:var(--mc-font-body); font-size:18px; }
p { margin:0; color:var(--mc-text-secondary); }
.header-actions,.toolbar,.fact-actions,.fact-topline,.fact-meta { display:flex; align-items:center; gap:8px; }
.header-actions { flex-wrap:wrap; justify-content:flex-end; }
.toolbar { margin:18px 0; }
.toolbar input { flex:1; min-width:180px; }
.toolbar select { width:auto; min-width:152px; }
.count { margin-left:auto; color:var(--mc-text-muted); font-family:var(--mc-font-mono); }
.notice { margin-bottom:14px; }
.fact-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:14px; }
.fact-card { padding:16px; }
.fact-topline { flex-wrap:wrap; }
.fact-topline time { margin-left:auto; color:var(--mc-text-muted); font-size:12px; }
.status-chip,.kind-chip,.scope-chip { padding:4px 7px; font-size:11px; border:1px solid var(--mc-border); border-radius:999px; background:var(--mc-surface-raised); }
.status-active { color:var(--mc-accent-strong); background:var(--mc-accent-soft); }
.status-deleted,.status-rejected,.status-expired { color:#f1a9a2; background:rgba(228,111,101,.11); }
.status-superseded { color:#e4bd6d; background:rgba(217,170,76,.1); }
.fact-text { min-height:48px; margin:15px 0; color:var(--mc-text); line-height:1.6; white-space:pre-wrap; }
textarea { margin:14px 0; }
.fact-meta { flex-wrap:wrap; padding-top:10px; border-top:1px solid var(--mc-border); color:var(--mc-text-muted); font-size:12px; }
.fact-actions { margin-top:13px; flex-wrap:wrap; }
.sources { margin-top:14px; padding:12px; background:var(--mc-bg-elevated); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); color:var(--mc-text-secondary); }
.sources-title { margin-bottom:9px; color:var(--mc-text); font-weight:700; }
blockquote { margin:8px 0; padding:9px 11px; border-left:2px solid var(--mc-accent); border-radius:0 var(--mc-radius-xs) var(--mc-radius-xs) 0; background:var(--mc-surface); white-space:pre-wrap; }
blockquote span { display:block; margin-bottom:5px; color:var(--mc-text-muted); font-size:11px; }
@media (max-width:800px) { .memory-header { flex-direction:column; } .header-actions { justify-content:flex-start; } .fact-grid { grid-template-columns:1fr; } .toolbar { flex-wrap:wrap; } }
</style>
