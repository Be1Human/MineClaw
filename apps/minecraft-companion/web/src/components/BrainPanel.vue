<template>
  <section class="brain-view mc-subsystem">
    <header class="brain-header mc-subsystem-header">
      <div class="brain-heading mc-subsystem-heading">
        <div>
          <h2><McIcon name="brain" :size="17" />大脑</h2>
          <p>{{ profile?.name || '当前伙伴' }}的思考、记忆与能力都集中在这里。</p>
        </div>
        <span class="brain-state mc-status" :class="brainStateTone">{{ brainStateLabel }}</span>
      </div>

      <nav class="brain-tabs mc-subnav" aria-label="大脑工作区">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          :class="['mc-subnav-button', { active: activeTab === tab.id }]"
          @click="selectTab(tab.id)"
        >
          <McIcon :name="tab.icon" :size="13" />
          {{ tab.label }}
        </button>
      </nav>
    </header>

    <div class="brain-content mc-subsystem-content">
      <section v-if="activeTab === 'overview'" class="overview-view mc-page">
        <div class="section-copy mc-section-copy">
          <div class="eyebrow mc-eyebrow">OVERVIEW</div>
          <h3>当前伙伴概览</h3>
          <p>这里只展示当前伙伴的真实配置和运行状态。</p>
        </div>

        <div class="overview-grid">
          <article class="overview-card mc-panel">
            <span>伙伴</span>
            <strong>{{ profile?.name || '未选择' }}</strong>
            <small>{{ profile?.personality?.description || '尚未填写性格描述' }}</small>
          </article>
          <article class="overview-card mc-panel">
            <span>大脑状态</span>
            <strong>{{ brainStateLabel }}</strong>
            <small>{{ botStatus?.lastActivity || '暂无最近活动' }}</small>
          </article>
          <article class="overview-card mc-panel">
            <span>AI Agent</span>
            <strong>{{ profile?.llmConfigId ? '已配置' : '未配置' }}</strong>
            <small>{{ profile?.llmConfigId ? '使用当前伙伴选择的全局配置' : '请在伙伴设置中选择配置' }}</small>
          </article>
          <article class="overview-card mc-panel">
            <span>当前动作</span>
            <strong>{{ botStatus?.currentBehavior || '空闲' }}</strong>
            <small>{{ connectionLabel }}</small>
          </article>
        </div>
      </section>

      <section v-else-if="activeTab === 'decision'" class="decision-view mc-page">
        <div class="section-copy mc-section-copy decision-heading">
          <div>
            <div class="eyebrow mc-eyebrow">DECISION STREAM</div>
            <h3>实时决策</h3>
            <p>只显示伙伴真正做出的选择、原因和结果；空检查不会出现在这里。</p>
          </div>
          <span>{{ decisionSteps.length }} 条有效决策</span>
        </div>
        <div v-if="decisionSteps.length === 0" class="empty-state mc-empty-state">伙伴正在待命。只有决定行动、暂停、完成或失败时才会显示在这里。</div>
        <div v-else class="decision-list">
          <article v-for="item in decisionSteps" :key="item.id" class="decision-item mc-panel">
            <span class="decision-type" :class="item.tone">{{ item.label }}</span>
            <div class="decision-copy">
              <p class="decision-title">{{ item.title }}</p>
              <p v-if="item.detail" class="decision-detail">{{ item.detail }}</p>
              <time>{{ formatTime(item.timestamp) }}</time>
            </div>
          </article>
        </div>
      </section>

      <MemoryPanel v-else-if="activeTab === 'memory'" :key="botId" :botId="botId" />

      <section v-else class="capability-view mc-page">
        <div class="section-copy mc-section-copy">
          <div class="eyebrow mc-eyebrow">CAPABILITIES</div>
          <h3>伙伴能力</h3>
          <p>在这里直接启停已注册的可控能力；具体参数仍在设置页调整。</p>
        </div>
        <p v-if="capabilityError" class="capability-error" role="alert">{{ capabilityError }}</p>
        <div v-if="capabilities.length === 0" class="empty-state mc-empty-state">当前伙伴还没有可展示的能力配置。</div>
        <div v-else class="capability-grid">
          <article v-for="capability in capabilities" :key="capability.id" :class="['mc-panel', { disabled: !capability.enabled }]">
            <McIcon :name="capability.icon" :size="18" />
            <div class="capability-copy">
              <strong>{{ capability.label }}</strong>
              <span>{{ capability.statusLabel || (capability.enabled ? '已启用' : '未启用') }}</span>
              <small v-if="capability.description">{{ capability.description }}</small>
            </div>
            <button
              v-if="capability.control"
              type="button"
              class="capability-toggle"
              :class="{ on: capability.enabled }"
              :disabled="capabilityBusy(capability.id)"
              role="switch"
              :aria-checked="capability.enabled"
              :aria-label="`${capability.enabled ? '关闭' : '开启'}${capability.label}`"
              @click="toggleCapability(capability)"
            >
              <span></span>
            </button>
          </article>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { BRAIN_TAB_IDS } from '../lib/brainNavigation.js';
import McIcon from './icons/McIcon.vue';
import MemoryPanel from './MemoryPanel.vue';
import { capabilityControlCards, emptyCapabilityControlSnapshot } from '../lib/capabilityControls.js';

const props = defineProps({
  botId: { type: String, default: '' },
  profile: { type: Object, default: null },
  botStatus: { type: Object, default: null },
  agentSteps: { type: Array, default: () => [] },
  activeTab: { type: String, default: 'overview' },
});

const emit = defineEmits(['update:activeTab']);
const capabilitySnapshot = ref(emptyCapabilityControlSnapshot());
const capabilityMutations = ref(new Set());
const capabilityError = ref('');

const tabs = [
  { id: 'overview', label: '概览', icon: 'brain' },
  { id: 'decision', label: '决策', icon: 'activity' },
  { id: 'memory', label: '记忆', icon: 'memory' },
  { id: 'capabilities', label: '能力', icon: 'skill' },
];

const capabilities = computed(() => capabilityControlCards(capabilitySnapshot.value));

const ignoredDecisionTypes = new Set([
  'turn',
  'tool_call',
  'tool_result',
  'proactive.evaluated',
  'proactive.arbitrated',
]);

const decisionPresentation = {
  thought: { label: '思考', tone: 'thought' },
  'l7.thought': { label: '思考', tone: 'thought' },
  'proactive.request': { label: '决定行动', tone: 'active' },
  'proactive.suppressed': { label: '暂不执行', tone: 'paused' },
  'proactive.released': { label: '停止行动', tone: 'paused' },
  'task.created': { label: '接受任务', tone: 'active' },
  'task.started': { label: '开始执行', tone: 'active' },
  'task.completed': { label: '完成', tone: 'done' },
  'task.failed': { label: '失败', tone: 'error' },
  'task.paused': { label: '暂停', tone: 'paused' },
  'task.resumed': { label: '继续执行', tone: 'active' },
  'task.cancelled': { label: '取消', tone: 'paused' },
  'goalagent.report': { label: '任务结果', tone: 'done' },
  'goalagent.progress_report.governed': { label: '进展', tone: 'active' },
  'goalagent.continuation': { label: '继续执行', tone: 'active' },
  'critic.verdict': { label: '评估', tone: 'thought' },
  done: { label: '完成', tone: 'done' },
  error: { label: '错误', tone: 'error' },
};

const decisionReasonLabels = {
  foreground_busy: '正在优先执行当前任务',
  disabled: '该能力已关闭',
  active_lease: '已有主动行动正在执行',
  lower_priority: '有更优先的行动需要处理',
  lost_arbitration: '有更优先的行动需要处理',
  owner_offline_or_not_observed: '当前没有看到主人在线',
  within_follow_distance: '已经在主人附近',
  preempted_by_player: '优先执行你刚刚下达的任务',
  player_preempted: '优先执行你刚刚下达的任务',
};

const decisionSteps = computed(() => {
  const projected = props.agentSteps
    .map((step, index) => projectDecisionStep(step, index))
    .filter(Boolean);
  const deduplicated = [];
  for (const item of projected) {
    const previous = deduplicated[deduplicated.length - 1];
    if (previous?.signature === item.signature) deduplicated[deduplicated.length - 1] = item;
    else deduplicated.push(item);
  }
  return deduplicated.slice(-80).reverse();
});

async function loadCapabilities() {
  if (!props.botId) {
    capabilitySnapshot.value = emptyCapabilityControlSnapshot();
    return;
  }
  capabilityError.value = '';
  try {
    const response = await fetch(`/api/bots/${encodeURIComponent(props.botId)}/capabilities`);
    if (!response.ok) throw new Error(`能力目录加载失败（${response.status}）`);
    capabilitySnapshot.value = await response.json();
  } catch {
    capabilitySnapshot.value = emptyCapabilityControlSnapshot();
    capabilityError.value = '能力目录暂时无法加载，请稍后刷新。';
  }
}

function capabilityBusy(id) {
  return capabilityMutations.value.has(id);
}

async function toggleCapability(capability) {
  if (!capability.control || capabilityBusy(capability.id)) return;
  capabilityError.value = '';
  capabilityMutations.value = new Set([...capabilityMutations.value, capability.id]);
  try {
    const response = await fetch(capability.control.href, {
      method: capability.control.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !capability.enabled }),
    });
    if (!response.ok) throw new Error(`能力更新失败（${response.status}）`);
    capabilitySnapshot.value = await response.json();
  } catch {
    capabilityError.value = `${capability.label}更新失败，原状态已保留。`;
  } finally {
    const next = new Set(capabilityMutations.value);
    next.delete(capability.id);
    capabilityMutations.value = next;
  }
}

watch(
  () => [props.botId, props.activeTab],
  ([, tab]) => { if (tab === 'capabilities') void loadCapabilities(); },
  { immediate: true },
);

const brainStateLabel = computed(() => {
  if (!props.botId) return '未选择伙伴';
  if (props.botStatus?.status === 'error') return '异常';
  if (['awake', 'playing'].includes(props.botStatus?.companionPhase)) return '已启动';
  if (['awake', 'online', 'busy'].includes(props.botStatus?.status)) return '已启动';
  return '未启动';
});

const brainStateTone = computed(() => {
  if (props.botStatus?.status === 'error') return 'error';
  return brainStateLabel.value === '已启动' ? 'ready' : 'idle';
});

const connectionLabel = computed(() => (
  props.botStatus?.connectionStatus === 'connected' ? 'Minecraft 已连接' : 'Minecraft 未连接'
));

function selectTab(tabId) {
  emit('update:activeTab', BRAIN_TAB_IDS.includes(tabId) ? tabId : 'overview');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstText(value, keys) {
  if (!isRecord(value)) return '';
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return '';
}

function readableStepText(step, data) {
  if (typeof step?.text === 'string' && step.text.trim()) return step.text.trim();
  if (typeof step?.data === 'string' && step.data.trim()) return step.data.trim();
  return firstText(data, ['requestText', 'thought', 'message', 'summary', 'title', 'name']);
}

function readableReason(data) {
  const raw = firstText(data, ['reason', 'detail', 'outcome']);
  if (!raw) return '';
  if (decisionReasonLabels[raw]) return decisionReasonLabels[raw];
  if (/^[a-z0-9_.:-]+$/i.test(raw)) return '当前条件不满足';
  return raw;
}

function fallbackPresentation(type) {
  if (/error|failed/i.test(type)) return { label: '错误', tone: 'error' };
  if (/complete|done|success/i.test(type)) return { label: '完成', tone: 'done' };
  if (/pause|cancel|stop|suppress|release/i.test(type)) return { label: '暂停', tone: 'paused' };
  if (/start|request|resume|progress/i.test(type)) return { label: '执行', tone: 'active' };
  if (/thought|decision|verdict/i.test(type)) return { label: '思考', tone: 'thought' };
  return { label: '决策', tone: 'thought' };
}

function projectDecisionStep(step, index) {
  const type = typeof step?.type === 'string' ? step.type : '';
  if (!type || ignoredDecisionTypes.has(type)) return null;
  const data = isRecord(step?.data) ? step.data : {};
  const presentation = decisionPresentation[type] || fallbackPresentation(type);
  let title = readableStepText(step, data);
  const reason = readableReason(data);

  if (type === 'proactive.request' && !title) title = '伙伴决定开始一项主动行动';
  if (type === 'proactive.suppressed') title = title ? `暂不执行：${title}` : '当前主动行动暂不执行';
  if (type === 'proactive.released') title = title ? `停止行动：${title}` : '已停止当前主动行动';
  if (type === 'task.created' && !title) title = '已接受新任务';
  if (type === 'task.started' && !title) title = '任务已经开始执行';
  if (type === 'task.completed' && !title) title = '任务已经完成';
  if (type === 'task.failed' && !title) title = '任务未能完成';
  if (type === 'task.paused' && !title) title = '任务已暂停';
  if (type === 'task.resumed' && !title) title = '任务继续执行';
  if (type === 'task.cancelled' && !title) title = '任务已取消';
  if (!title) return null;

  const detailPrefix = /complete|done|success|report/i.test(type) ? '结果' : '原因';
  const detail = reason && reason !== title ? `${detailPrefix}：${reason}` : '';
  const timestamp = step?.timestamp || step?.ts || '';
  const signature = [presentation.label, title, detail].join('|');
  return {
    id: step?.eventId || step?.seq || `${type}-${timestamp || index}`,
    ...presentation,
    title,
    detail,
    timestamp,
    signature,
  };
}

function formatTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}
</script>

<style scoped>
.overview-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; margin-top:20px; }
.overview-card { min-height:112px; display:flex; flex-direction:column; padding:17px; }
.overview-card span { color:var(--mc-text-muted); font-size:11px; }
.overview-card strong { margin-top:10px; color:var(--mc-text); font-size:var(--mc-type-section-title); }
.overview-card small { margin-top:auto; padding-top:12px; color:var(--mc-text-secondary); font-size:11px; line-height:1.5; }
.decision-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }
.decision-heading > span { padding:5px 8px; border-radius:999px; background:var(--mc-surface-raised); color:var(--mc-text-secondary); font:12px var(--mc-font-mono); }
.decision-list { display:flex; flex-direction:column; gap:7px; margin-top:18px; }
.decision-item { display:grid; grid-template-columns:64px minmax(0,1fr); gap:10px; padding:11px 12px; }
.decision-type { align-self:start; padding:3px 5px; border-radius:var(--mc-radius-xs); background:var(--mc-accent-soft); color:var(--mc-accent-strong); text-align:center; font-size:10px; font-weight:700; }
.decision-type.active { background:rgba(217,170,76,.1); color:#e4bd6d; }
.decision-type.paused { background:rgba(148,163,184,.12); color:var(--mc-text-secondary); }
.decision-type.done { background:var(--mc-accent-soft); color:var(--mc-accent-strong); }
.decision-type.error { background:rgba(228,111,101,.11); color:#f1a9a2; }
.decision-item p { margin:0; font-size:12px; line-height:1.5; word-break:break-word; }
.decision-title { color:var(--mc-text); }
.decision-item .decision-detail { margin-top:3px; color:var(--mc-text-secondary); font-size:11px; }
.decision-item time { display:block; margin-top:4px; color:var(--mc-text-muted); font:10px var(--mc-font-mono); }
.empty-state { margin-top:20px; }
.capability-error { margin:14px 0 0; color:#f1a9a2; font-size:11px; }
.capability-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-top:20px; }
.capability-grid article { display:flex; align-items:center; gap:12px; padding:15px; color:var(--mc-accent); }
.capability-grid article.disabled { opacity:.48; color:var(--mc-text-muted); }
.capability-grid article.disabled:has(.capability-toggle) { opacity:1; }
.capability-copy { min-width:0; display:flex; flex:1; flex-direction:column; gap:4px; }
.capability-grid article.disabled .capability-copy { opacity:.48; }
.capability-grid strong { color:var(--mc-text); font-size:13px; }
.capability-grid span { color:inherit; font-size:11px; }
.capability-grid small { color:var(--mc-text-muted); font-size:10px; line-height:1.4; }
.capability-toggle { position:relative; flex:0 0 auto; width:34px; height:19px; margin-left:auto; padding:0; border:1px solid var(--mc-border); border-radius:999px; background:var(--mc-surface-raised); cursor:pointer; }
.capability-toggle > span { position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:var(--mc-text-muted); transition:transform .16s ease,background .16s ease; }
.capability-toggle.on { border-color:var(--mc-accent); background:var(--mc-accent-soft); }
.capability-toggle.on > span { transform:translateX(15px); background:var(--mc-accent-strong); }
.capability-toggle:disabled { cursor:wait; opacity:.55; }
@media (max-width:700px) {
  .brain-heading p { max-width:240px; }
  .overview-grid { grid-template-columns:1fr; }
  .decision-item { grid-template-columns:54px minmax(0,1fr); }
}
</style>
