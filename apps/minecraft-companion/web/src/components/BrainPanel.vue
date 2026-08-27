<template>
  <section class="brain-view">
    <header class="brain-header">
      <div class="brain-heading">
        <div>
          <h2><McIcon name="brain" :size="17" />大脑</h2>
          <p>{{ profile?.name || '当前伙伴' }}的思考、记忆与能力都集中在这里。</p>
        </div>
        <span class="brain-state" :class="brainStateTone">{{ brainStateLabel }}</span>
      </div>

      <nav class="brain-tabs" aria-label="大脑工作区">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          :class="{ active: activeTab === tab.id }"
          @click="selectTab(tab.id)"
        >
          <McIcon :name="tab.icon" :size="13" />
          {{ tab.label }}
        </button>
      </nav>
    </header>

    <div class="brain-content">
      <section v-if="activeTab === 'overview'" class="overview-view">
        <div class="section-copy">
          <div class="eyebrow">OVERVIEW</div>
          <h3>当前伙伴概览</h3>
          <p>这里只展示当前伙伴的真实配置和运行状态。</p>
        </div>

        <div class="overview-grid">
          <article class="overview-card">
            <span>伙伴</span>
            <strong>{{ profile?.name || '未选择' }}</strong>
            <small>{{ profile?.personality?.description || '尚未填写性格描述' }}</small>
          </article>
          <article class="overview-card">
            <span>大脑状态</span>
            <strong>{{ brainStateLabel }}</strong>
            <small>{{ botStatus?.lastActivity || '暂无最近活动' }}</small>
          </article>
          <article class="overview-card">
            <span>AI Agent</span>
            <strong>{{ profile?.llmConfigId ? '已配置' : '未配置' }}</strong>
            <small>{{ profile?.llmConfigId ? '使用当前伙伴选择的全局配置' : '请在伙伴设置中选择配置' }}</small>
          </article>
          <article class="overview-card">
            <span>当前动作</span>
            <strong>{{ botStatus?.currentBehavior || '空闲' }}</strong>
            <small>{{ connectionLabel }}</small>
          </article>
        </div>
      </section>

      <section v-else-if="activeTab === 'decision'" class="decision-view">
        <div class="section-copy decision-heading">
          <div>
            <div class="eyebrow">DECISION STREAM</div>
            <h3>实时决策</h3>
            <p>显示当前伙伴本次运行产生的最近决策事件。</p>
          </div>
          <span>{{ agentSteps.length }} 条</span>
        </div>
        <div v-if="agentSteps.length === 0" class="empty-state">尚无决策事件。伙伴开始思考或执行任务后会显示在这里。</div>
        <div v-else class="decision-list">
          <article v-for="(step, index) in agentSteps.slice(-80).reverse()" :key="step.eventId || step.seq || index" class="decision-item">
            <span class="decision-type" :class="stepTone(step.type)">{{ typeLabel(step.type) }}</span>
            <div>
              <p>{{ stepText(step) }}</p>
              <time>{{ formatTime(step.ts || step.timestamp) }}</time>
            </div>
          </article>
        </div>
      </section>

      <MemoryPanel v-else-if="activeTab === 'memory'" :key="botId" :botId="botId" />

      <section v-else class="capability-view">
        <div class="section-copy">
          <div class="eyebrow">CAPABILITIES</div>
          <h3>伙伴能力</h3>
          <p>能力状态来自当前伙伴的角色卡，不读取全局目录。</p>
        </div>
        <div v-if="capabilities.length === 0" class="empty-state">当前伙伴还没有可展示的能力配置。</div>
        <div v-else class="capability-grid">
          <article v-for="capability in capabilities" :key="capability.id" :class="{ disabled: !capability.enabled }">
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
.brain-view { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; background:#0c0e08; color:#e7e3d4; }
.brain-header { flex:none; padding:16px 20px 0; background:#15170f; border-bottom:2px solid #0c0e08; }
.brain-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }
.brain-heading h2 { display:flex; align-items:center; gap:7px; margin:0; color:#f2f0df; font-family:var(--mc-font-pixel); font-size:16px; }
.brain-heading p,.section-copy p { margin:6px 0 0; color:#7e836e; font-size:12px; }
.brain-state { flex:none; padding:5px 9px; border:2px solid #0d0f0a; background:#272d1d; color:#aab09b; font-size:11px; font-weight:700; }
.brain-state.ready { background:#243619; color:#b9eca0; }
.brain-state.error { background:#47221e; color:#ffc0b8; }
.brain-tabs { display:flex; gap:5px; margin-top:15px; overflow-x:auto; }
.brain-tabs button { display:inline-flex; align-items:center; gap:6px; padding:9px 13px; border:2px solid #0d0f0a; border-bottom:0; background:#20241a; color:#929985; cursor:pointer; font:700 12px var(--mc-font-body); white-space:nowrap; }
.brain-tabs button.active { background:#4c7a2a; color:#fff; box-shadow:inset 1px 1px 0 rgba(255,255,255,.2); }
.brain-content { flex:1; min-width:0; min-height:0; display:flex; overflow:hidden; }
.overview-view,.decision-view,.capability-view { flex:1; min-height:0; overflow:auto; padding:24px; }
.section-copy h3 { margin:5px 0 0; color:#e7e3d4; font-size:16px; }
.eyebrow { color:#8fb66f; font-family:var(--mc-font-pixel); font-size:9px; }
.overview-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; margin-top:20px; }
.overview-card { min-height:112px; display:flex; flex-direction:column; padding:17px; background:#1b1e14; border:2px solid #0c0e08; box-shadow:inset 1px 1px 0 rgba(255,255,255,.05),0 4px 0 rgba(0,0,0,.25); }
.overview-card span { color:#7e836e; font-size:11px; }
.overview-card strong { margin-top:10px; color:#f0eddd; font-size:17px; }
.overview-card small { margin-top:auto; padding-top:12px; color:#8f9682; font-size:11px; line-height:1.5; }
.decision-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }
.decision-heading > span { padding:5px 8px; background:#20241a; color:#8f9682; font:12px var(--mc-font-mono); }
.decision-list { display:flex; flex-direction:column; gap:7px; margin-top:18px; }
.decision-item { display:grid; grid-template-columns:64px minmax(0,1fr); gap:10px; padding:11px 12px; background:#15170f; border:1px solid #2a2f23; }
.decision-type { align-self:start; padding:3px 5px; background:#26331c; color:#9fd47b; text-align:center; font-size:10px; font-weight:700; }
.decision-type.tool { background:#3b321c; color:#e0c58b; }
.decision-type.done { background:#1f3b22; color:#a7e38c; }
.decision-type.error { background:#43231f; color:#efb0a8; }
.decision-item p { margin:0; color:#cdd2c0; font-size:12px; line-height:1.5; word-break:break-word; }
.decision-item time { display:block; margin-top:4px; color:#6b6f5e; font:10px var(--mc-font-mono); }
.empty-state { margin-top:20px; padding:44px 20px; border:2px dashed #343a2b; background:#15170f; color:#8f9682; text-align:center; font-size:12px; }
.capability-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-top:20px; }
.capability-grid article { display:flex; align-items:center; gap:12px; padding:15px; background:#20251a; border:2px solid #0c0e08; color:#8fd06c; }
.capability-grid article.disabled { opacity:.48; color:#8f9682; }
.capability-grid article div { display:flex; flex-direction:column; gap:4px; }
.capability-grid strong { color:#e7e3d4; font-size:13px; }
.capability-grid span { color:inherit; font-size:11px; }
@media (max-width:700px) {
  .brain-header { padding:13px 14px 0; }
  .brain-heading p { max-width:240px; }
  .overview-view,.decision-view,.capability-view { padding:16px; }
  .overview-grid { grid-template-columns:1fr; }
  .decision-item { grid-template-columns:54px minmax(0,1fr); }
}
</style>
