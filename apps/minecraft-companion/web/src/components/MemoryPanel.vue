<template>
  <section class="memory-shell mc-page">
    <header class="memory-header mc-panel">
      <div class="mc-section-copy">
        <div class="eyebrow mc-eyebrow">CHAT MEMORY · 槽位优先记忆</div>
        <h1>记忆控制台</h1>
        <p>常用信息进入官方槽位；无法归类的长期信息单独放在“模型发现”中等待治理。</p>
      </div>
      <div class="header-actions">
        <button class="mc-button" :disabled="!botId || busy" @click="migrateLegacyFacts">整理旧记忆</button>
        <button class="mc-button" :disabled="!botId || busy" @click="exportMarkdown">导出 Markdown</button>
        <button class="mc-button primary" :disabled="!botId || busy" @click="refreshAll">刷新</button>
      </div>
    </header>

    <div v-if="!botId" class="empty-state mc-empty-state">请先选择一个伙伴。</div>
    <template v-else>
      <div v-if="notice" :class="['notice', 'mc-notice', noticeKind]">{{ notice }}</div>

      <section class="memory-section mc-panel">
        <div class="section-heading">
          <div>
            <div class="mc-eyebrow">OFFICIAL SLOTS · 官方定义</div>
            <h2>常用记忆槽 <span>{{ filledCount }} / {{ totalSlots }}</span></h2>
            <p>空槽位只是尚未得知，不会生成“未知”记忆，也不会进入对话上下文。</p>
          </div>
          <label class="toggle-label">
            <input v-model="showEmptySlots" type="checkbox" />
            显示空槽位
          </label>
        </div>

        <div class="toolbar mc-toolbar">
          <input v-model="slotQuery" class="mc-field-control" type="search" placeholder="搜索槽位或已记内容" />
          <select v-model="selectedGroup" class="mc-field-control">
            <option value="">全部分组</option>
            <option v-for="group in groups" :key="group" :value="group">{{ group }}</option>
          </select>
          <span class="count">{{ visibleSlots.length }} 个槽位</span>
        </div>

        <div v-if="loading" class="empty-state mc-empty-state">正在读取记忆…</div>
        <div v-else-if="visibleSlots.length === 0" class="empty-state mc-empty-state">当前条件下没有槽位。</div>
        <div v-else class="slot-groups">
          <section v-for="group in groupedSlots" :key="group.name" class="slot-group">
            <header>
              <h3>{{ group.name }}</h3>
              <span>{{ group.filled }} / {{ group.items.length }}</span>
            </header>
            <div class="slot-list">
              <article v-for="slot in group.items" :key="slot.definition.slotKey" class="slot-row">
                <div class="slot-copy">
                  <div class="slot-title">
                    <strong>{{ slot.definition.title }}</strong>
                    <span v-if="slot.definition.capturePolicy === 'explicit_only'" class="policy-chip">仅显式填写</span>
                  </div>
                  <div v-if="slot.values.length" class="slot-values">
                    <span v-for="value in slot.values" :key="value.id" class="value-chip">{{ displayValue(value.value) }}</span>
                  </div>
                  <span v-else class="slot-empty">—</span>
                </div>
                <div class="slot-actions">
                  <button class="mc-button" :disabled="busy" @click="startSlotEdit(slot)">{{ slot.values.length ? (slot.definition.valueType === 'set' ? '添加' : '编辑') : '填写' }}</button>
                  <template v-for="value in slot.values" :key="`actions-${value.id}`">
                    <button class="mc-button subtle" :disabled="busy" @click="showSlotSources(value)">来源</button>
                    <button class="mc-button danger subtle" :disabled="busy" @click="removeSlotValue(value)">清空</button>
                  </template>
                </div>

                <div v-if="editingSlotKey === slot.definition.slotKey" class="inline-editor">
                  <input v-model="editingSlotValue" class="mc-field-control" :placeholder="slotInputHint(slot)" @keyup.enter="saveSlot(slot)" />
                  <button class="mc-button primary" :disabled="busy || !editingSlotValue.trim()" @click="saveSlot(slot)">保存</button>
                  <button class="mc-button" :disabled="busy" @click="cancelSlotEdit">取消</button>
                </div>

                <div v-if="sourceValueId && slot.values.some(value => value.id === sourceValueId)" class="sources">
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
          </section>
        </div>
      </section>

      <section class="memory-section mc-panel">
        <div class="section-heading">
          <div>
            <div class="mc-eyebrow">MODEL DISCOVERIES · 目录外信息</div>
            <h2>模型发现 <span>{{ dynamicFacts.length }} 条</span></h2>
            <p>候选不会参与普通召回；批准、重复确认或映射到官方槽位后才会生效。</p>
          </div>
        </div>

        <div class="toolbar mc-toolbar">
          <input v-model="factQuery" class="mc-field-control" type="search" placeholder="搜索模型发现" />
          <select v-model="factStatus" class="mc-field-control" @change="loadFacts">
            <option value="candidate">待确认</option>
            <option value="active">已生效</option>
            <option value="rejected">已拒绝</option>
            <option value="deleted">已删除</option>
            <option value="">全部状态</option>
          </select>
          <button class="mc-button" :disabled="busy" @click="loadFacts">检索</button>
        </div>

        <div v-if="!loading && dynamicFacts.length === 0" class="empty-state mc-empty-state">当前没有模型扩展记忆。</div>
        <div v-else class="fact-grid">
          <article v-for="fact in dynamicFacts" :key="fact.id" class="fact-card">
            <div class="fact-topline">
              <span :class="['status-chip', `status-${fact.status}`]">{{ statusLabel(fact.status) }}</span>
              <span class="kind-chip">{{ kindLabel(fact.kind) }}</span>
              <time>{{ formatTime(fact.updatedAt) }}</time>
            </div>
            <p class="fact-text">{{ fact.text }}</p>
            <div class="fact-meta">
              <span>可信度 {{ percent(fact.confidence) }}</span>
              <span>来源 {{ fact.sourceMessageIds.length }}</span>
            </div>
            <div class="fact-actions">
              <button class="mc-button" :disabled="busy" @click="showFactSources(fact)">查看来源</button>
              <button v-if="fact.status === 'candidate'" class="mc-button primary" :disabled="busy" @click="approveFact(fact)">批准</button>
              <button v-if="fact.status === 'candidate'" class="mc-button danger" :disabled="busy" @click="rejectFact(fact)">拒绝</button>
              <button v-if="fact.status === 'candidate'" class="mc-button" :disabled="busy" @click="startMapping(fact)">映射到槽位</button>
              <button v-if="fact.status === 'active'" class="mc-button danger" :disabled="busy" @click="removeFact(fact)">软删除</button>
            </div>

            <div v-if="mappingFactId === fact.id" class="inline-editor mapping-editor">
              <select v-model="mappingSlotKey" class="mc-field-control">
                <option value="">选择官方槽位</option>
                <option v-for="slot in slots" :key="slot.definition.slotKey" :value="slot.definition.slotKey">{{ slot.definition.group }} · {{ slot.definition.title }}</option>
              </select>
              <input v-model="mappingValue" class="mc-field-control" placeholder="写入槽位的值" />
              <button class="mc-button primary" :disabled="busy || !mappingSlotKey || !mappingValue.trim()" @click="mapFact(fact)">确认映射</button>
              <button class="mc-button" @click="cancelMapping">取消</button>
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
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

interface SlotDefinition {
  slotKey: string;
  group: string;
  title: string;
  valueType: 'scalar' | 'set' | 'enum' | 'date' | 'structured';
  capturePolicy: 'automatic' | 'corroborated' | 'explicit_only';
}
interface SlotValue { id:string; slotKey:string; value:unknown; status:string; sourceMessageIds:string[]; updatedAt:number }
interface SlotView { definition:SlotDefinition; values:SlotValue[] }
interface MemoryFact { id:string; scope:'user'|'agent'; kind:string; text:string; status:string; confidence:number; importance:number; sourceMessageIds:string[]; updatedAt:number }
interface SourceMessage { id:string; role:string; content:string; timestamp:number }

const props = defineProps<{ botId?: string }>();
const slots = ref<SlotView[]>([]);
const facts = ref<MemoryFact[]>([]);
const totalSlots = ref(100);
const loading = ref(false);
const busy = ref(false);
const slotQuery = ref('');
const factQuery = ref('');
const selectedGroup = ref('');
const showEmptySlots = ref(false);
const factStatus = ref('candidate');
const notice = ref('');
const noticeKind = ref<'ok'|'error'>('ok');
const editingSlotKey = ref('');
const editingValueId = ref('');
const editingSlotValue = ref('');
const sourceValueId = ref('');
const sourceFactId = ref('');
const sources = ref<SourceMessage[]>([]);
const sourcesLoading = ref(false);
const mappingFactId = ref('');
const mappingSlotKey = ref('');
const mappingValue = ref('');

const filledCount = computed(() => slots.value.filter(slot => slot.values.length > 0).length);
const groups = computed(() => [...new Set(slots.value.map(slot => slot.definition.group))]);
const visibleSlots = computed(() => slots.value.filter(slot => {
  if (!showEmptySlots.value && slot.values.length === 0) return false;
  if (selectedGroup.value && slot.definition.group !== selectedGroup.value) return false;
  const query = slotQuery.value.trim().toLowerCase();
  return !query || `${slot.definition.title} ${slot.definition.group} ${slot.values.map(value => displayValue(value.value)).join(' ')}`.toLowerCase().includes(query);
}));
const groupedSlots = computed(() => groups.value.map(name => {
  const items = visibleSlots.value.filter(slot => slot.definition.group === name);
  return { name, items, filled: items.filter(slot => slot.values.length).length };
}).filter(group => group.items.length));
const dynamicFacts = computed(() => {
  const query = factQuery.value.trim().toLowerCase();
  return facts.value.filter(fact => !query || fact.text.toLowerCase().includes(query));
});

watch(() => props.botId, () => {
  slots.value = [];
  facts.value = [];
  cancelSlotEdit();
  cancelMapping();
  if (props.botId) void refreshAll();
}, { immediate: true });

function endpoint(path = ''): string { return `/api/bots/${encodeURIComponent(props.botId ?? '')}/chat-memory${path}`; }

async function refreshAll(): Promise<void> {
  if (!props.botId) return;
  loading.value = true;
  try { await Promise.all([loadSlots(), loadFacts()]); }
  finally { loading.value = false; }
}

async function loadSlots(): Promise<void> {
  const response = await fetch(endpoint('/slots'));
  if (!response.ok) { showNotice(await responseError(response), 'error'); return; }
  const body = await response.json() as { total?:number; slots?:SlotView[] };
  totalSlots.value = body.total ?? 100;
  slots.value = body.slots ?? [];
}

async function loadFacts(): Promise<void> {
  if (!props.botId) return;
  const params = new URLSearchParams();
  if (factStatus.value) params.set('status', factStatus.value);
  if (factQuery.value.trim()) params.set('query', factQuery.value.trim());
  const response = await fetch(`${endpoint('/facts')}?${params}`);
  if (!response.ok) { facts.value = []; showNotice(await responseError(response), 'error'); return; }
  facts.value = ((await response.json()) as { facts?:MemoryFact[] }).facts ?? [];
}

function startSlotEdit(slot: SlotView): void {
  editingSlotKey.value = slot.definition.slotKey;
  const current = slot.definition.valueType === 'set' ? undefined : slot.values[0];
  editingValueId.value = current?.id ?? '';
  editingSlotValue.value = current ? displayValue(current.value) : '';
}
function cancelSlotEdit(): void { editingSlotKey.value = ''; editingValueId.value = ''; editingSlotValue.value = ''; }
function slotInputHint(slot: SlotView): string { return slot.definition.valueType === 'date' ? 'YYYY-MM-DD' : slot.definition.valueType === 'set' ? '每次添加一项' : '填写记忆内容'; }

async function saveSlot(slot: SlotView): Promise<void> {
  const raw = editingSlotValue.value.trim();
  if (!raw) return;
  const value: unknown = slot.definition.valueType === 'structured' ? { note: raw } : raw;
  await mutate(async () => {
    const path = editingValueId.value ? `/slot-values/${encodeURIComponent(editingValueId.value)}` : `/slots/${encodeURIComponent(slot.definition.slotKey)}/values`;
    const response = await fetch(endpoint(path), { method: editingValueId.value ? 'PATCH' : 'POST', headers: jsonHeaders(), body: JSON.stringify({ value }) });
    if (!response.ok) throw new Error(await responseError(response));
    cancelSlotEdit();
    await loadSlots();
    showNotice('槽位已保存', 'ok');
  });
}

async function removeSlotValue(value: SlotValue): Promise<void> {
  await mutate(async () => {
    const response = await fetch(endpoint(`/slot-values/${encodeURIComponent(value.id)}`), { method: 'DELETE' });
    if (!response.ok) throw new Error(await responseError(response));
    await loadSlots();
    showNotice('槽位已清空，可在历史中恢复', 'ok');
  });
}

async function showSlotSources(value: SlotValue): Promise<void> {
  sourceFactId.value = '';
  sourceValueId.value = sourceValueId.value === value.id ? '' : value.id;
  if (!sourceValueId.value) return;
  await loadSources(`/slot-values/${encodeURIComponent(value.id)}/sources`);
}
async function showFactSources(fact: MemoryFact): Promise<void> {
  sourceValueId.value = '';
  sourceFactId.value = sourceFactId.value === fact.id ? '' : fact.id;
  if (!sourceFactId.value) return;
  await loadSources(`/facts/${encodeURIComponent(fact.id)}/sources`);
}
async function loadSources(path: string): Promise<void> {
  sourcesLoading.value = true;
  sources.value = [];
  try {
    const response = await fetch(endpoint(path));
    if (!response.ok) throw new Error(await responseError(response));
    sources.value = ((await response.json()) as { sources?:SourceMessage[] }).sources ?? [];
  } catch (error) { showNotice(errorMessage(error), 'error'); }
  finally { sourcesLoading.value = false; }
}

async function approveFact(fact: MemoryFact): Promise<void> { await factAction(fact, 'approve', '候选已批准'); }
async function rejectFact(fact: MemoryFact): Promise<void> { await factAction(fact, 'reject', '候选已拒绝'); }
async function factAction(fact: MemoryFact, action: string, message: string): Promise<void> {
  await mutate(async () => {
    const response = await fetch(endpoint(`/facts/${encodeURIComponent(fact.id)}/${action}`), { method: 'POST' });
    if (!response.ok) throw new Error(await responseError(response));
    await loadFacts();
    showNotice(message, 'ok');
  });
}
async function removeFact(fact: MemoryFact): Promise<void> {
  await mutate(async () => {
    const response = await fetch(endpoint(`/facts/${encodeURIComponent(fact.id)}`), { method: 'DELETE' });
    if (!response.ok) throw new Error(await responseError(response));
    await loadFacts();
    showNotice('模型扩展记忆已软删除', 'ok');
  });
}

function startMapping(fact: MemoryFact): void { mappingFactId.value = fact.id; mappingValue.value = fact.text.replace(/^我(?:喜欢|不喜欢|希望)/, '').trim(); mappingSlotKey.value = ''; }
function cancelMapping(): void { mappingFactId.value = ''; mappingSlotKey.value = ''; mappingValue.value = ''; }
async function mapFact(fact: MemoryFact): Promise<void> {
  await mutate(async () => {
    const slot = slots.value.find(item => item.definition.slotKey === mappingSlotKey.value);
    const value: unknown = slot?.definition.valueType === 'structured' ? { note: mappingValue.value.trim() } : mappingValue.value.trim();
    const response = await fetch(endpoint(`/facts/${encodeURIComponent(fact.id)}/map-to-slot`), { method:'POST', headers:jsonHeaders(), body:JSON.stringify({ slotKey:mappingSlotKey.value, value }) });
    if (!response.ok) throw new Error(await responseError(response));
    cancelMapping();
    await Promise.all([loadSlots(), loadFacts()]);
    showNotice('已映射到官方槽位', 'ok');
  });
}

async function migrateLegacyFacts(): Promise<void> {
  await mutate(async () => {
    const response = await fetch(endpoint('/slot-migration/apply'), { method:'POST' });
    if (!response.ok) throw new Error(await responseError(response));
    const result = await response.json() as { migrated:number; dynamicCandidates:number; rejected:number };
    await Promise.all([loadSlots(), loadFacts()]);
    showNotice(`旧记忆整理完成：${result.migrated} 条进入槽位，${result.dynamicCandidates} 条保留为扩展，${result.rejected} 条拒绝`, 'ok');
  });
}

async function exportMarkdown(): Promise<void> {
  await mutate(async () => {
    const response = await fetch(endpoint('/export'));
    if (!response.ok) throw new Error(await responseError(response));
    const blob = new Blob([await response.text()], { type:'text/markdown;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `chat-memory-${props.botId}.md`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  });
}

async function mutate(run: () => Promise<void>): Promise<void> {
  busy.value = true;
  try { await run(); } catch (error) { showNotice(errorMessage(error), 'error'); }
  finally { busy.value = false; }
}
function displayValue(value: unknown): string { return typeof value === 'string' ? value : value && typeof value === 'object' && 'note' in value ? String((value as { note:unknown }).note) : JSON.stringify(value); }
function jsonHeaders(): Record<string,string> { return { 'content-type':'application/json' }; }
function showNotice(message:string, kind:'ok'|'error'): void { notice.value = message; noticeKind.value = kind; }
function errorMessage(error:unknown): string { return error instanceof Error ? error.message : '操作失败'; }
async function responseError(response:Response): Promise<string> { try { const body = await response.json() as { error?:string; rejected?:string }; return body.error ?? body.rejected ?? `请求失败 (${response.status})`; } catch { return `请求失败 (${response.status})`; } }
function formatTime(value:number): string { return new Date(value).toLocaleString('zh-CN', { hour12:false }); }
function percent(value:number): string { return `${Math.round(value * 100)}%`; }
function kindLabel(kind:string): string { return ({ preference:'偏好', identity:'身份', relationship:'关系', commitment:'承诺', boundary:'边界', project:'项目', agent_note:'伙伴笔记' } as Record<string,string>)[kind] ?? kind; }
function statusLabel(status:string): string { return ({ candidate:'待确认', active:'已生效', rejected:'已拒绝', deleted:'已删除', superseded:'已取代' } as Record<string,string>)[status] ?? status; }
</script>

<style scoped>
.memory-shell{display:flex;flex-direction:column;gap:14px;min-height:100%}.memory-header,.section-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.memory-header{padding:20px}.memory-header h1,.section-heading h2{margin:4px 0 6px}.memory-header p,.section-heading p{margin:0;color:var(--mc-text-muted)}.header-actions,.slot-actions,.fact-actions,.inline-editor{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.memory-section{padding:18px}.section-heading h2 span{font-size:.8em;color:var(--mc-accent-strong)}.toggle-label{display:flex;align-items:center;gap:8px;color:var(--mc-text-muted);white-space:nowrap}.toolbar{margin:16px 0}.toolbar input{flex:1;min-width:220px}.slot-groups{display:grid;gap:14px}.slot-group{border:1px solid var(--mc-border);border-radius:8px;overflow:hidden}.slot-group>header{display:flex;justify-content:space-between;padding:10px 14px;background:var(--mc-surface-raised)}.slot-group h3{margin:0;font-size:14px}.slot-group>header span,.count{color:var(--mc-text-muted)}.slot-list{display:grid}.slot-row{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:12px;padding:12px 14px;border-top:1px solid var(--mc-border);position:relative}.slot-row:first-child{border-top:0}.slot-title{display:flex;align-items:center;gap:8px}.slot-values{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.value-chip,.policy-chip,.status-chip,.kind-chip{display:inline-flex;border:1px solid var(--mc-border);border-radius:999px;padding:3px 8px;font-size:12px}.value-chip{background:var(--mc-accent-soft);color:var(--mc-accent-strong)}.policy-chip{color:#d9aa52;border-color:#6a5425}.slot-empty{display:block;margin-top:6px;color:var(--mc-text-muted)}.mc-button.subtle{padding:5px 8px}.inline-editor,.sources{grid-column:1/-1}.inline-editor{padding:10px;background:var(--mc-surface-raised);border-radius:6px}.inline-editor input{min-width:260px;flex:1}.mapping-editor select{min-width:280px}.sources{padding:10px;border-left:2px solid var(--mc-accent);background:var(--mc-surface-raised)}.sources-title{font-weight:700;margin-bottom:7px}.sources blockquote{margin:6px 0;padding:7px 10px;border-left:2px solid var(--mc-border)}.sources blockquote span{display:block;color:var(--mc-text-muted);font-size:11px}.fact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}.fact-card{padding:14px;border:1px solid var(--mc-border);border-radius:8px;background:var(--mc-surface-raised)}.fact-topline,.fact-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.fact-topline time{margin-left:auto;color:var(--mc-text-muted);font-size:12px}.fact-text{min-height:36px}.fact-meta{color:var(--mc-text-muted);font-size:12px;margin-bottom:12px}.status-active{color:var(--mc-accent-strong)}.status-candidate{color:#d9aa52}.status-rejected,.status-deleted{color:#cc7777}.notice{margin:0}.empty-state{padding:28px}@media(max-width:850px){.memory-header,.section-heading{flex-direction:column}.slot-row{grid-template-columns:1fr}.slot-actions{justify-content:flex-start}.fact-grid{grid-template-columns:1fr}}
</style>
