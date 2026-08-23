<template>
  <section class="taskbar-panel" :data-state="state" aria-labelledby="taskbar-title">
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
      <button class="retry-button" type="button" @click="$emit('retry')">重新读取</button>
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
  background: #11140c;
  border: 2px solid #0c0e08;
  box-shadow: inset 2px 2px 0 rgba(255,255,255,0.035), inset -2px -2px 0 rgba(0,0,0,0.45);
}
.taskbar-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 15px;
  background: #1b1e14;
  border-bottom: 2px solid #0c0e08;
}
.taskbar-heading { min-width: 0; }
.taskbar-title-row { display: flex; align-items: center; gap: 8px; }
.taskbar-title-mark { width: 12px; height: 17px; flex: none; background: #5d9c3c; border: 2px solid #0c0e08; box-shadow: inset -2px -2px 0 rgba(0,0,0,0.25); }
.taskbar-header h2 { margin: 0; color: #f0eddd; font-family: var(--mc-font-pixel); font-size: 12px; line-height: 1.4; text-shadow: 2px 2px 0 #0c0e08; }
.taskbar-header p { margin: 5px 0 0 20px; overflow: hidden; color: #7e836e; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.taskbar-header p strong { color: #b9bda8; font-weight: 700; }
.taskbar-summary { display: flex; flex: none; gap: 5px; }
.summary-chip { min-width: 47px; padding: 6px 5px 5px; background: #15170f; border: 2px solid #0c0e08; box-shadow: inset 1px 1px 0 rgba(255,255,255,0.05); text-align: center; }
.summary-chip span { display: block; font-family: var(--mc-font-pixel); font-size: 11px; line-height: 1.2; }
.summary-chip small { display: block; margin-top: 3px; color: #7e836e; font-size: 9px; white-space: nowrap; }
.summary-chip--running span { color: #8ee06a; }
.summary-chip--paused span { color: #f0c259; }
.summary-chip--archived span { color: #a7ad98; }
.taskbar-body { flex: 1; min-height: 0; }
.taskbar-ready { overflow-y: auto; padding: 12px; }
.taskbar-section-label { display: flex; align-items: center; justify-content: space-between; margin: 0 2px 8px; color: #b9bda8; font-size: 11px; font-weight: 800; }
.taskbar-section-label small { color: #5d9c3c; font-size: 9px; font-weight: 500; }
.taskbar-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 26px 18px; color: #7e836e; text-align: center; }
.taskbar-state h3 { margin: 12px 0 5px; color: #cdd2c0; font-size: 14px; }
.taskbar-state p { max-width: 280px; margin: 0; font-size: 11px; line-height: 1.6; }
.state-icon { display: grid; width: 34px; height: 34px; place-items: center; border: 2px solid #0c0e08; }
.state-icon--error { background: #5a241d; color: #ffb5a8; font-family: var(--mc-font-pixel); font-size: 14px; }
.state-icon--loading { grid-template-columns: repeat(3, 6px); gap: 3px; background: #20241a; }
.state-icon--loading span { width: 6px; height: 6px; background: #5d9c3c; animation: task-pulse 900ms steps(2, end) infinite; }
.state-icon--loading span:nth-child(2) { animation-delay: 150ms; }
.state-icon--loading span:nth-child(3) { animation-delay: 300ms; }
@keyframes task-pulse { 50% { opacity: .25; } }
.skeleton-list { width: min(100%, 330px); margin-top: 20px; display: grid; gap: 6px; }
.skeleton-card { display: grid; grid-template-columns: 12px 1fr 54px; align-items: center; gap: 9px; padding: 10px; background: #1b1e14; border: 2px solid #0c0e08; opacity: .7; }
.skeleton-square { width: 10px; height: 10px; background: #3a4030; }
.skeleton-line { height: 8px; background: #2a2f22; }
.skeleton-badge { height: 14px; background: #20281b; border: 1px solid #35462a; }
.empty-blocks { display: flex; align-items: flex-end; gap: 3px; }
.empty-blocks span { width: 13px; height: 13px; background: #32372b; border: 2px solid #0c0e08; }
.empty-blocks span:nth-child(2) { transform: translateY(-7px); background: #414a35; }
.empty-blocks span:nth-child(3) { background: #4c7a2a; }
.taskbar-state--error p { color: #c9887e; overflow-wrap: anywhere; }
.retry-button { margin-top: 15px; padding: 7px 13px; cursor: pointer; background: #4c7a2a; border: 2px solid #2b5e16; box-shadow: inset 1px 1px 0 rgba(255,255,255,0.25), inset -2px -2px 0 rgba(0,0,0,0.3), 0 2px 0 #17340e; color: #fff; font-family: var(--mc-font-body); font-size: 11px; font-weight: 800; }
.retry-button:focus-visible { outline: 2px solid #e3b341; outline-offset: 2px; }
@media (max-width: 640px) {
  .taskbar-header { align-items: flex-start; flex-direction: column; padding: 12px; }
  .taskbar-summary { width: 100%; }
  .summary-chip { flex: 1; min-width: 0; }
  .taskbar-ready { padding: 9px; }
  .taskbar-state { padding: 22px 12px; }
}
</style>
