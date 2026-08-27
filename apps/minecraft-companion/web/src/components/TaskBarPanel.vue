<template>
  <section class="taskbar-panel mc-panel" :data-state="state" aria-labelledby="taskbar-title">
    <header class="taskbar-header">
      <div class="taskbar-heading">
        <div class="taskbar-title-row">
          <span class="taskbar-title-mark" aria-hidden="true"></span>
          <h2 id="taskbar-title">任务栏</h2>
        </div>
        <p>当前伙伴 · <strong>{{ botName }}</strong></p>
      </div>
      <div class="taskbar-summary" aria-label="任务汇总">
        <div class="summary-chip summary-chip--running"><span>{{ runningCount }}</span><small>进行中</small></div>
        <div class="summary-chip summary-chip--paused"><span>{{ pausedCount }}</span><small>暂停</small></div>
        <div class="summary-chip summary-chip--archived"><span>{{ archivedCount }}</span><small>归档</small></div>
      </div>
    </header>

    <div v-if="state === 'loading'" class="taskbar-body taskbar-state taskbar-loading" aria-live="polite">
      <div class="state-icon state-icon--loading" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>正在读取任务</h3>
      <p>正在同步 {{ botName }} 的最新进度…</p>
      <div class="skeleton-list" aria-hidden="true">
        <div v-for="index in 3" :key="index" class="skeleton-card">
          <span class="skeleton-square"></span><span class="skeleton-line"></span><span class="skeleton-badge"></span>
        </div>
      </div>
    </div>
    <div v-else-if="state === 'error'" class="taskbar-body taskbar-state taskbar-state--error" role="alert">
      <div class="state-icon state-icon--error" aria-hidden="true">!</div>
      <h3>暂时读不到任务</h3>
      <p>{{ error || '任务服务暂时不可用' }}</p>
      <button class="retry-button mc-button primary" type="button" @click="$emit('retry')">重新读取</button>
    </div>
    <div v-else-if="activeCount === 0" class="taskbar-body taskbar-state taskbar-state--empty">
      <div class="empty-blocks" aria-hidden="true"><span></span><span></span><span></span></div>
      <h3>现在没有任务</h3>
      <p>给 {{ botName }} 一个目标后，任务和子步骤会出现在这里。</p>
    </div>
    <div v-else class="taskbar-body taskbar-ready">
      <div class="taskbar-section-label"><span>当前目标</span><small>实时刷新</small></div>
      <TaskTree :tasks="tasks" :showHeader="false" />
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import TaskTree from './TaskTree.vue';

const props = defineProps({
  botName: { type: String, default: '未选择伙伴' },
  tasks: { type: Array, default: () => [] },
  state: { type: String, default: 'ready' },
  error: { type: String, default: '' },
});

defineEmits(['retry']);

const ACTIVE = new Set(['running', 'paused', 'pending']);
const rootTasks = computed(() => props.tasks.filter(task => !task.parentId));
const runningCount = computed(() => rootTasks.value.filter(task => task.state === 'running' || task.state === 'pending').length);
const pausedCount = computed(() => rootTasks.value.filter(task => task.state === 'paused').length);
const archivedCount = computed(() => rootTasks.value.filter(task => !ACTIVE.has(task.state)).length);
const activeCount = computed(() => runningCount.value + pausedCount.value);
</script>

<style scoped>
.taskbar-panel {
  flex: 1;
  min-width: 0;
  min-height: 300px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--mc-bg-elevated);
}
.taskbar-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 15px;
  background: var(--mc-surface);
  border-bottom: 1px solid var(--mc-border);
}
.taskbar-heading { min-width: 0; }
.taskbar-title-row { display: flex; align-items: center; gap: 8px; }
.taskbar-title-mark { width: 8px; height: 8px; flex: none; background: var(--mc-accent); border-radius: 50%; box-shadow: 0 0 8px rgba(105,201,74,.42); }
.taskbar-header h2 { margin: 0; color: var(--mc-text); font-size: var(--mc-type-section-title); line-height: 1.4; }
.taskbar-header p { margin: 5px 0 0 16px; overflow: hidden; color: var(--mc-text-muted); font-size: var(--mc-type-secondary); text-overflow: ellipsis; white-space: nowrap; }
.taskbar-header p strong { color: var(--mc-text-secondary); font-weight: 700; }
.taskbar-summary { display: flex; flex: none; gap: 5px; }
.summary-chip { min-width: 47px; padding: 6px 7px 5px; background: var(--mc-bg-elevated); border: 1px solid var(--mc-border); border-radius: var(--mc-radius-sm); text-align: center; }
.summary-chip span { display: block; font-family: var(--mc-font-mono); font-size: var(--mc-type-body); font-weight: 700; line-height: 1.2; }
.summary-chip small { display: block; margin-top: 3px; color: var(--mc-text-muted); font-size: var(--mc-type-micro); white-space: nowrap; }
.summary-chip--running span { color: var(--mc-accent-strong); }
.summary-chip--paused span { color: var(--mc-warning); }
.summary-chip--archived span { color: var(--mc-text-secondary); }
.taskbar-body { flex: 1; min-height: 0; }
.taskbar-ready { overflow-y: auto; padding: 12px; }
.taskbar-section-label { display: flex; align-items: center; justify-content: space-between; margin: 0 2px 8px; color: var(--mc-text-secondary); font-size: var(--mc-type-secondary); font-weight: 800; }
.taskbar-section-label small { color: var(--mc-accent); font-size: var(--mc-type-micro); font-weight: 500; }
.taskbar-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 26px 18px; color: var(--mc-text-muted); text-align: center; }
.taskbar-state h3 { margin: 12px 0 5px; color: var(--mc-text-secondary); font-size: var(--mc-type-section-title); }
.taskbar-state p { max-width: 280px; margin: 0; font-size: var(--mc-type-secondary); line-height: 1.6; }
.state-icon { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid var(--mc-border); border-radius: 50%; }
.state-icon--error { background: rgba(228,111,101,.11); color: #f1a9a2; font-size: 14px; }
.state-icon--loading { grid-template-columns: repeat(3, 5px); gap: 3px; background: var(--mc-surface-raised); }
.state-icon--loading span { width: 5px; height: 5px; border-radius: 50%; background: var(--mc-accent); animation: task-pulse 900ms steps(2, end) infinite; }
.state-icon--loading span:nth-child(2) { animation-delay: 150ms; }
.state-icon--loading span:nth-child(3) { animation-delay: 300ms; }
@keyframes task-pulse { 50% { opacity: .25; } }
.skeleton-list { width: min(100%, 330px); margin-top: 20px; display: grid; gap: 6px; }
.skeleton-card { display: grid; grid-template-columns: 12px 1fr 54px; align-items: center; gap: 9px; padding: 10px; background: var(--mc-surface); border: 1px solid var(--mc-border); border-radius: var(--mc-radius-sm); opacity: .7; }
.skeleton-square { width: 10px; height: 10px; border-radius: 50%; background: var(--mc-border-strong); }
.skeleton-line { height: 8px; border-radius: 4px; background: var(--mc-border); }
.skeleton-badge { height: 14px; border-radius: 7px; background: var(--mc-accent-soft); border: 1px solid rgba(105,201,74,.18); }
.empty-blocks { display: flex; align-items: flex-end; gap: 3px; }
.empty-blocks span { width: 10px; height: 10px; background: var(--mc-border-strong); border-radius: 50%; }
.empty-blocks span:nth-child(2) { transform: translateY(-5px); background: var(--mc-text-muted); }
.empty-blocks span:nth-child(3) { background: var(--mc-accent); }
.taskbar-state--error p { color: #d99189; overflow-wrap: anywhere; }
.retry-button { margin-top: 15px; }
@media (max-width: 640px) {
  .taskbar-header { align-items: flex-start; flex-direction: column; padding: 12px; }
  .taskbar-summary { width: 100%; }
  .summary-chip { flex: 1; min-width: 0; }
  .taskbar-ready { padding: 9px; }
  .taskbar-state { padding: 22px 12px; }
}
</style>
