<template>
  <div class="critic-panel">
    <div class="panel-header">
      <span class="panel-title">&#9878; Critic 评测</span>
      <span class="panel-count">{{ verdicts.length }} 条</span>
    </div>
    <div v-if="verdicts.length === 0" class="panel-empty">暂无评测记录</div>
    <div v-for="(v, i) in verdicts" :key="i" class="verdict-card" :class="verdictClass(v)">
      <div class="verdict-top">
        <span class="verdict-kind">{{ v.taskKind ?? '—' }}</span>
        <span class="verdict-badge" :class="badgeClass(v)">{{ verdictLabel(v) }}</span>
        <span class="verdict-time">{{ formatTime(v.timestamp) }}</span>
      </div>
      <div class="verdict-detail" v-if="v.detail">{{ v.detail }}</div>
    </div>
  </div>
</template>

<script setup>
import { defineProps } from 'vue';

const props = defineProps({
  verdicts: {
    type: Array,
    default: () => []
  }
});

function verdictLabel(v) {
  // 优先用 status 字段（更精确）
  if (v.status === 'success') return '通过';
  if (v.status === 'partial') return '进行中';
  if (v.status === 'fail')    return '失败';
  if (v.status === 'unknown') return '未知';
  // 兼容旧数据（只有 passed 字段）
  if (v.passed === true) return '通过';
  if (v.passed === false) return '未通过';
  if (v.score != null) return v.score >= 0.6 ? '通过' : '未通过';
  return '未知';
}

function verdictClass(v) {
  if (v.status === 'success' || v.passed === true) return 'card-passed';
  if (v.status === 'partial' || v.passed === null)  return 'card-partial';
  if (v.status === 'fail'    || v.passed === false)  return 'card-failed';
  return 'card-unknown';
}

function badgeClass(v) {
  if (v.status === 'success' || v.passed === true) return 'badge-passed';
  if (v.status === 'partial' || v.passed === null)  return 'badge-partial';
  if (v.status === 'fail'    || v.passed === false)  return 'badge-failed';
  return 'badge-unknown';
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
</script>

<style scoped>
.critic-panel {
  background: #15170f;
  border: 1px solid #3a4030;
  border-radius: 8px;
  padding: 12px;
  font-size: 13px;
  color: #cdd2c0;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.panel-title {
  font-weight: 600;
  font-size: 14px;
}

.panel-count {
  background: #20241a;
  border: 1px solid #3a4030;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: #7e836e;
}

.panel-empty {
  color: #6b6f5e;
  font-style: italic;
  text-align: center;
  padding: 12px 0;
}

.verdict-card {
  padding: 8px 10px;
  border-radius: 6px;
  margin-bottom: 6px;
  border: 1px solid;
  background: #0c0e08;
}

.card-passed  { border-color: #4c7a2a; }
.card-partial { border-color: #e3b341; }
.card-failed  { border-color: #b33b2a; }
.card-unknown { border-color: #3a4030; }

.verdict-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.verdict-kind {
  flex: 1;
  font-family: var(--mc-font-mono);
  font-size: 12px;
  color: #e7e3d4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.verdict-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 600;
  flex-shrink: 0;
}

.badge-passed  { background: #18361a; color: #5d9c3c; }
.badge-partial { background: #2b2410; color: #e3b341; }
.badge-failed  { background: #3a1410; color: #d8503c; }
.badge-unknown { background: #20241a; color: #6b6f5e; }

.verdict-time {
  font-size: 10px;
  color: #6b6f5e;
  font-family: var(--mc-font-mono);
  flex-shrink: 0;
}

.verdict-detail {
  margin-top: 4px;
  font-size: 11px;
  color: #7e836e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
