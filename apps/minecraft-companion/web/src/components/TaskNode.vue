<template>
  <div class="task-node" :class="{ 'task-node--root': depth === 0 }">
    <button
      type="button"
      class="task-row"
      :class="['state-' + task.state, { 'task-row--expandable': children.length > 0 }]"
      :aria-expanded="children.length > 0 ? expanded : undefined"
      @click="toggleExpanded"
    >
      <span class="expand-btn" v-if="children.length > 0">{{ expanded ? '▾' : '▸' }}</span>
      <span class="expand-placeholder" v-else></span>
      <span class="state-dot" :class="'dot-' + task.state"></span>
      <span class="task-title">{{ displayName }}</span>
      <span class="task-state-badge" :class="'badge-' + task.state">{{ statusText }}</span>
      <span v-if="task.parentId" class="subtask-label">子步骤</span>
    </button>
    <!-- FEAT-WEBUI-08 · 当前能力（NPC 行为，实时） -->
    <div class="task-phase" v-if="task.progress && task.progress.phase">
      <McIcon name="tool" :size="13" /> {{ task.progress.phase }}
    </div>
    <!-- Progress bar / 进度文字（采集 have/count、合成步骤等） -->
    <div class="progress-bar-wrap" v-if="progressText !== ''">
      <div class="progress-track" v-if="progressValue !== null">
        <span class="progress-bar" :style="{ width: progressValue + '%' }"></span>
      </div>
      <span class="progress-text">{{ progressText }}</span>
    </div>
    <!-- Children -->
    <div v-if="expanded && children.length > 0" class="task-children">
      <TaskNode
        v-for="child in children"
        :key="child.id"
        :task="child"
        :children="childrenOf(child.id)"
        :allTasks="allTasks"
        :depth="depth + 1"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import McIcon from './icons/McIcon.vue';

const props = defineProps({
  task: { type: Object, required: true },
  children: { type: Array, default: () => [] },
  allTasks: { type: Array, default: () => [] },
  depth: { type: Number, default: 0 }
});

const expanded = ref(true);

// 给主人看的是【真正目标】= label（后端 taskLabel 据 params 生成，如"采集 橡木 ×8"/"走到 (55,-60,58)"）。
// 前端绝不再翻译 kind/函数名——没 label 就显示中性占位，宁可笼统也不暴露程序名词。
const ZH_STATE = { running: '进行中', paused: '暂停', pending: '待启动', completed: '已完成', failed: '失败', cancelled: '已取消' };
const displayName = computed(() => {
  const l = props.task.label;
  return (typeof l === 'string' && l.trim()) ? l.trim() : '正在忙…';
});
const statusText = computed(() => ZH_STATE[props.task.state] || '进行中');

function childrenOf(parentId) {
  return props.allTasks.filter(t => t.parentId === parentId);
}

function toggleExpanded() {
  if (props.children.length > 0) expanded.value = !expanded.value;
}

const progressValue = computed(() => {
  if (!props.task.progress) return null;
  const p = props.task.progress;
  // Support: number / {plotsDone,total} / {done,total} / {have,count}(采集)
  if (typeof p === 'number') return Math.min(100, Math.max(0, p));
  if (p.plotsDone !== undefined && p.total !== undefined) return Math.round((p.plotsDone / p.total) * 100);
  if (p.done !== undefined && p.total !== undefined) return Math.round((p.done / p.total) * 100);
  if (p.have !== undefined && p.count !== undefined && p.count > 0) return Math.min(100, Math.round((p.have / p.count) * 100));
  return null;
});

const progressText = computed(() => {
  if (!props.task.progress) return '';
  const p = props.task.progress;
  if (typeof p === 'number') return `${p}%`;
  if (p.plotsDone !== undefined && p.total !== undefined) return `${p.plotsDone}/${p.total}`;
  if (p.done !== undefined && p.total !== undefined) return `${p.done}/${p.total}`;
  if (p.have !== undefined && p.count !== undefined) return `${p.have}/${p.count}`;
  if (p.step) return String(p.step);   // 合成：显示当前解析步骤（采集X/合成Y…）
  return '';
});
</script>

<style scoped>
.task-node {
  min-width: 0;
  font-size: 12px;
}

.task-row {
  width: 100%;
  display: grid;
  grid-template-columns: 12px 8px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
  padding: 8px;
  margin-bottom: 2px;
  background: #20241a;
  border: 2px solid #0c0e08;
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.045), inset -2px -2px 0 rgba(0,0,0,0.3);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
  transition: background 0.15s;
}

.task-node--root > .task-row { padding: 10px 9px; border-left: 4px solid #5d9c3c; }
.task-node--root > .state-paused { border-left-color: #e3b341; }
.task-node--root > .state-pending { border-left-color: #7cc24e; }
.task-row--expandable { cursor: pointer; }
.task-row--expandable:hover { background: #292e22; }
.task-row:focus-visible { outline: 2px solid #e3b341; outline-offset: 1px; }

.expand-btn {
  color: #7cc24e;
  font-size: 10px;
  width: 12px;
  flex-shrink: 0;
}

.expand-placeholder {
  width: 12px;
  flex-shrink: 0;
}

.state-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border: 1px solid #0c0e08;
}

.dot-running    { background: #5d9c3c; box-shadow: 0 0 4px #5d9c3c66; }
.dot-paused     { background: #e3b341; }
.dot-completed  { background: #6b6f5e; }
.dot-failed     { background: #d8503c; }
.dot-cancelled  { background: #7e836e; }
.dot-pending    { background: #7cc24e; }

.task-title {
  min-width: 0;
  color: #e7e3d4;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.task-node--root > .task-row .task-title {
  display: -webkit-box;
  overflow: hidden;
  font-size: 13px;
  font-weight: 800;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
/* FEAT-WEBUI-08 · 底层 kind 退成小灰字（调试可见） */
.task-kind-tech {
  font-size: 9px;
  color: #7e836e;
  font-family: var(--mc-font-mono);
  opacity: 0.7;
  flex-shrink: 0;
}
/* FEAT-WEBUI-08 · 当前能力行（NPC 行为） */
.task-phase {
  font-size: 11px;
  color: #7cc24e;
  margin: 4px 7px 5px 32px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.task-state-badge {
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid currentColor;
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
}

.badge-running    { background: #18361a; color: #5d9c3c; }
.badge-paused     { background: #2b2410; color: #e3b341; }
.badge-completed  { background: #20241a; color: #6b6f5e; }
.badge-failed     { background: #3a1410; color: #d8503c; }
.badge-cancelled  { background: #20241a; color: #7e836e; }
.badge-pending    { background: #1b2414; color: #7cc24e; }

.task-priority {
  font-size: 10px;
  color: #6b6f5e;
  font-family: var(--mc-font-mono);
  flex-shrink: 0;
}

.subtask-label {
  font-size: 9px;
  color: #7cc24e;
  background: #1b2414;
  padding: 1px 4px;
  flex-shrink: 0;
}

.progress-bar-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 5px 8px 7px 32px;
}

.progress-track {
  flex: 1;
  height: 7px;
  overflow: hidden;
  background: #0c0e08;
  border: 1px solid #000;
}
.progress-bar {
  display: block;
  height: 100%;
  background: #4c7a2a;
  box-shadow: inset 0 2px 0 rgba(255,255,255,0.12);
  transition: width 0.3s steps(8, end);
}

.progress-text {
  font-size: 10px;
  color: #7e836e;
  font-family: var(--mc-font-mono);
  flex-shrink: 0;
  min-width: 30px;
  text-align: right;
}

.task-children {
  margin: 3px 0 5px 14px;
  padding-left: 7px;
  border-left: 2px solid #30372a;
}

@media (max-width: 640px) {
  .task-row { grid-template-columns: 10px 7px minmax(0, 1fr) auto; gap: 5px; padding: 7px 6px; }
  .subtask-label { display: none; }
  .task-state-badge { padding-inline: 4px; font-size: 9px; }
  .task-phase, .progress-bar-wrap { margin-left: 25px; }
  .task-children { margin-left: 7px; padding-left: 5px; }
}
</style>
