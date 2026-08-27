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
            <p>显示当前伙伴本次运行产生的最近决策事件。</p>
          </div>
          <span>{{ agentSteps.length }} 条</span>
        </div>
        <div v-if="agentSteps.length === 0" class="empty-state mc-empty-state">尚无决策事件。伙伴开始思考或执行任务后会显示在这里。</div>
        <div v-else class="decision-list">
          <article v-for="(step, index) in agentSteps.slice(-80).reverse()" :key="step.eventId || step.seq || index" class="decision-item mc-panel">
            <span class="decision-type" :class="stepTone(step.type)">{{ typeLabel(step.type) }}</span>
            <div>
              <p>{{ stepText(step) }}</p>
              <time>{{ formatTime(step.ts || step.timestamp) }}</time>
            </div>
          </article>
        </div>
      </section>

      <MemoryPanel v-else-if="activeTab === 'memory'" :key="botId" :botId="botId" />

      <section v-else class="capability-view mc-page">
        <div class="section-copy mc-section-copy">
          <div class="eyebrow mc-eyebrow">CAPABILITIES</div>
          <h3>伙伴能力</h3>
          <p>能力状态来自当前伙伴的角色卡，不读取全局目录。</p>
        </div>
        <div v-if="capabilities.length === 0" class="empty-state mc-empty-state">当前伙伴还没有可展示的能力配置。</div>
        <div v-else class="capability-grid">
          <article v-for="capability in capabilities" :key="capability.id" :class="['mc-panel', { disabled: !capability.enabled }]">
            <McIcon :name="capability.icon" :size="18" />
            <div>
              <strong>{{ capability.label }}</strong>
              <span>{{ capability.enabled ? '已启用' : '未启用' }}</span>
            </div>
          </article>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { BRAIN_TAB_IDS } from '../lib/brainNavigation.js';
import McIcon from './icons/McIcon.vue';
import MemoryPanel from './MemoryPanel.vue';

const props = defineProps({
  botId: { type: String, default: '' },
  profile: { type: Object, default: null },
  botStatus: { type: Object, default: null },
  agentSteps: { type: Array, default: () => [] },
  activeTab: { type: String, default: 'overview' },
});

const emit = defineEmits(['update:activeTab']);

const tabs = [
  { id: 'overview', label: '概览', icon: 'brain' },
  { id: 'decision', label: '决策', icon: 'activity' },
  { id: 'memory', label: '记忆', icon: 'memory' },
  { id: 'capabilities', label: '能力', icon: 'skill' },
];

const capabilityLabels = {
  chat: { label: '聊天', icon: 'chat' },
  memory: { label: '记忆', icon: 'memory' },
  minecraft: { label: 'Minecraft', icon: 'bot' },
  voice: { label: '语音', icon: 'activity' },
};

const capabilities = computed(() => {
  const configured = props.profile?.characterCard?.performance?.capabilities;
  if (!configured || typeof configured !== 'object') return [];
  return Object.entries(configured).map(([id, enabled]) => ({
    id,
    enabled: Boolean(enabled),
    label: capabilityLabels[id]?.label || id,
    icon: capabilityLabels[id]?.icon || 'skill',
  }));
});

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

function typeLabel(type = '') {
  return ({
    turn: '回合',
    tool_call: '工具',
    tool_result: '结果',
    done: '完成',
    error: '错误',
    thought: '思考',
    'l7.thought': '思考',
  })[type] || String(type || '事件').replace(/^.*\./, '');
}

function stepTone(type = '') {
  if (String(type).includes('error')) return 'error';
  if (String(type).includes('tool')) return 'tool';
  if (String(type).includes('done')) return 'done';
  return 'thought';
}

function stepText(step) {
  if (typeof step?.text === 'string' && step.text.trim()) return step.text;
  if (typeof step?.data === 'string' && step.data.trim()) return step.data;
  const data = step?.data;
  if (data && typeof data === 'object') {
    for (const key of ['thought', 'message', 'summary', 'status', 'toolName', 'name']) {
      if (typeof data[key] === 'string' && data[key].trim()) return data[key];
    }
  }
  return typeLabel(step?.type);
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
.decision-type.tool { background:rgba(217,170,76,.1); color:#e4bd6d; }
.decision-type.done { background:var(--mc-accent-soft); color:var(--mc-accent-strong); }
.decision-type.error { background:rgba(228,111,101,.11); color:#f1a9a2; }
.decision-item p { margin:0; color:var(--mc-text-secondary); font-size:12px; line-height:1.5; word-break:break-word; }
.decision-item time { display:block; margin-top:4px; color:var(--mc-text-muted); font:10px var(--mc-font-mono); }
.empty-state { margin-top:20px; }
.capability-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-top:20px; }
.capability-grid article { display:flex; align-items:center; gap:12px; padding:15px; color:var(--mc-accent); }
.capability-grid article.disabled { opacity:.48; color:var(--mc-text-muted); }
.capability-grid article div { display:flex; flex-direction:column; gap:4px; }
.capability-grid strong { color:var(--mc-text); font-size:13px; }
.capability-grid span { color:inherit; font-size:11px; }
@media (max-width:700px) {
  .brain-heading p { max-width:240px; }
  .overview-grid { grid-template-columns:1fr; }
  .decision-item { grid-template-columns:54px minmax(0,1fr); }
}
</style>
