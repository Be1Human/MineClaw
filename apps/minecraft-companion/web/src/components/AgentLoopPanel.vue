<template>
  <div class="agent-loop-panel">
    <div v-if="steps.length === 0" class="empty-state">
      <div class="empty-icon">🧠</div>
      <p>等待轨迹更新...</p>
    </div>
    <div v-else class="step-list" ref="stepListEl">
      <div
        v-for="(step, i) in steps"
        :key="i"
        class="step-item"
        :class="norm(step.type)"
      >
        <div class="step-icon">{{ getIcon(step.type) }}</div>
        <div class="step-content">
          <div class="step-header">
            <span class="step-type">{{ getLabel(step.type) }}</span>
            <span class="step-time">{{ formatTime(step.timestamp) }}</span>
          </div>
          <div class="step-body" v-if="getBody(step)">{{ getBody(step) }}</div>
          <div class="step-detail" v-if="hasDetail(step.type)">
            <code>{{ formatDetail(step) }}</code>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';

const props = defineProps({
  steps: { type: Array, default: () => [] }
});

const stepListEl = ref(null);

watch(() => props.steps.length, async () => {
  await nextTick();
  if (stepListEl.value) {
    stepListEl.value.scrollTop = stepListEl.value.scrollHeight;
  }
});

// 把原始 bus 事件类型归一到样式/分组类别
function norm(type) {
  if (type === 'l7.thought') return 'thinking';
  if (type === 'l7.tool_call' || type === 'l7.tool_use') return 'tool_call';
  if (type === 'l7.tool_result') return 'tool_result';
  if (type === 'l7.tool_error' || type === 'atomic.craft.fail') return 'tool_error';
  if (type === 'l7.turn_started' || type === 'l7.idle_turn_started') return 'turn_start';
  if (type === 'l7.turn_finished') return 'turn_end';
  if (type.startsWith('gather.')) return 'gather';
  if (type.startsWith('provision.') || type.startsWith('atomic.craft')) return 'craft';
  if (type.startsWith('task.')) return 'task';
  if (type.startsWith('door.')) return 'door';
  if (type.startsWith('stuck.') || type === 'navigation.stuck_unrecovered') return 'stuck';
  if (type === 'critic.verdict') return 'critic';
  return 'other';
}

function getIcon(type) {
  const map = {
    turn_start: '▶', thinking: '💭', tool_call: '🔧', tool_result: '✅',
    tool_error: '❌', turn_end: '🏁', gather: '⛏', craft: '🔨',
    task: '📋', door: '🚪', stuck: '🪤', critic: '⚖',
  };
  return map[norm(type)] || '·';
}

function getLabel(type) {
  const map = {
    turn_start: '开始', thinking: '思考', tool_call: '调用工具', tool_result: '工具结果',
    tool_error: '错误', turn_end: '结束', gather: '采集', craft: '合成',
    task: '任务', door: '开门', stuck: '脱困', critic: '评测',
  };
  return map[norm(type)] || type;
}

function getBody(step) {
  const d = step.data || {};
  switch (step.type) {
    case 'l7.idle_turn_started': return '主动找事做';
    case 'l7.thought': return d.thought || '';
    case 'l7.turn_finished': return d.message || '';
    case 'l7.tool_error': return d.error || '';
    case 'gather.progress': return `${d.material} ${d.have}/${d.count}${d.done ? ' ✓' : ''}`;
    case 'provision.step': return `${d.target}：${d.step}`;
    case 'provision.subtask': return `派生 ${d.kind} ${d.material || d.item || ''}`;
    case 'provision.done': return `${d.item}×${d.count} ✓`;
    case 'atomic.craft.success': return `${d.item}×${d.count}`;
    case 'atomic.craft.fail': return `${d.item} 失败：${d.error || ''}`;
    case 'task.created': return `新建 ${d.kind || ''}`;
    case 'task.started': return `启动 ${d.kind || ''}`;
    case 'task.completed': return `完成 ${d.kind || ''}`;
    case 'task.failed': return `失败 ${d.kind || ''} ${d.reason || ''}`;
    case 'door.opened': return `${d.block || ''}`;
    case 'stuck.recovery': return `stage${d.stage} ${d.action || ''}`;
    case 'navigation.stuck_unrecovered': return '多次脱困无效';
    case 'critic.verdict': return `${d.taskKind || ''} → ${d.status || ''} ${d.reason || ''}`;
    default: return '';
  }
}

function hasDetail(type) {
  return type === 'l7.tool_call' || type === 'l7.tool_use' || type === 'l7.tool_result';
}

function formatDetail(step) {
  const d = step.data || {};
  if (step.type === 'l7.tool_call' || step.type === 'l7.tool_use') {
    const input = JSON.stringify(d.input || {}).slice(0, 120);
    return `${d.tool}(${input})`;
  }
  if (step.type === 'l7.tool_result') {
    const ms = d.durationMs || 0;
    const result = JSON.stringify(d.result || {}).slice(0, 100);
    return `${d.tool} → ${result}  [${ms}ms]`;
  }
  return '';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
</script>

<style scoped>
.agent-loop-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #6b6f5e;
}
.empty-icon { font-size: 32px; margin-bottom: 8px; opacity: 0.5; }

.step-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
}

.step-item {
  display: flex;
  gap: 8px;
  padding: 4px 6px;
  margin-bottom: 2px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.5;
}
.step-item.turn_start { background: #1b2e14; border-left: 2px solid #7cc24e; }
.step-item.thinking { background: #1b1e14; border-left: 2px solid #9a78c4; }
.step-item.tool_call { background: #0f2318; border-left: 2px solid #5d9c3c; }
.step-item.tool_result { background: #15170f; border-left: 2px solid #3a4030; }
.step-item.tool_error { background: #2d1315; border-left: 2px solid #d8503c; }
.step-item.turn_end { background: #20241a; border-left: 2px solid #7e836e; }
.step-item.gather { background: #0f2318; border-left: 2px solid #5fae3a; }
.step-item.craft { background: #1c1605; border-left: 2px solid #e0a52f; }
.step-item.task { background: #0d1b2e; border-left: 2px solid #5d9c3c; }
.step-item.door { background: #15170f; border-left: 2px solid #7e836e; }
.step-item.stuck { background: #2d1f13; border-left: 2px solid #db6d28; }
.step-item.critic { background: #1b1e14; border-left: 2px solid #b59ad6; }
.step-item.other { background: #15170f; border-left: 2px solid #3a4030; }

.step-icon { flex-shrink: 0; width: 16px; text-align: center; }
.step-content { flex: 1; min-width: 0; }
.step-header { display: flex; justify-content: space-between; align-items: center; }
.step-type { font-weight: 600; color: #e7e3d4; font-size: 10px; text-transform: uppercase; }
.step-time { color: #6b6f5e; font-size: 10px; }
.step-body { color: #cdd2c0; margin-top: 2px; word-break: break-word; }
.step-detail {
  margin-top: 3px;
  font-family: var(--mc-font-mono);
  font-size: 10px;
  color: #7e836e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step-detail code { background: none; padding: 0; }
</style>
