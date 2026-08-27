<template>
  <div class="task-tree">
    <div v-if="showHeader" class="tree-header">
      <span class="tree-title"><McIcon name="task" :size="16" /> 任务树</span>
      <span class="tree-count">{{ rootTasks.length }} 进行中</span>
      <span v-if="archivedCount > 0" class="tree-archived" :title="'已结束 ' + archivedCount + ' 个（已存档，不在此展示）'">归档 {{ archivedCount }}</span>
    </div>
    <div v-if="rootTasks.length === 0" class="tree-empty">暂无进行中的任务</div>
    <div v-for="task in rootTasks" :key="task.id" class="tree-root">
      <TaskNode :task="task" :children="childrenOf(task.id)" :allTasks="props.tasks" :depth="0" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import TaskNode from './TaskNode.vue';
import McIcon from './icons/McIcon.vue';

const props = defineProps({
  tasks: {
    type: Array,
    default: () => []
  },
  showHeader: { type: Boolean, default: true }
});

// 顶层只展示「进行中」：running / paused / pending。
// completed / failed / cancelled 的顶层任务视为已结束 → 归档可查。
// 子步骤（带 parentId，如 goal_exec 拆解出的 goto/dig/craft 镜像节点）则【全状态展示】，
// 让主人实时看到拆解序列：已完成的灰、正在跑的绿、失败的红。
const ACTIVE = new Set(['running', 'paused', 'pending']);
// 顶层进行中任务
const rootTasks = computed(() => props.tasks.filter(t => !t.parentId && ACTIVE.has(t.state)));
// 归档计数：只数【顶层】已结束任务，子步骤镜像不计入（否则每个 goto/dig 都刷爆归档数）
const archivedCount = computed(() => props.tasks.filter(t => !t.parentId && !ACTIVE.has(t.state)).length);

// 子节点：父任务下的全部步骤（含已完成/失败），保留拆解序列
function childrenOf(parentId) {
  return props.tasks.filter(t => t.parentId === parentId);
}
</script>

<style scoped>
.task-tree {
  min-width: 0;
  font-size: 13px;
  color: #cdd2c0;
}

.tree-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.tree-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 14px;
}

.tree-count {
  background: #20241a;
  border: 1px solid #3a4030;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: #7e836e;
}

.tree-archived { color: #7e836e; font-size: 11px; }

.tree-empty {
  color: #6b6f5e;
  font-style: italic;
  text-align: center;
  padding: 12px 0;
}

.tree-root {
  margin-bottom: 8px;
}
.tree-root:last-child { margin-bottom: 0; }
</style>
