<template>
  <div class="brain-view">
    <!-- 頭部狀態條 -->
    <div class="brain-header">
      <div class="brain-title-row">
        <h2><McIcon name="brain" :size="16" /> Hermes 大脑</h2>
        <div class="brain-model-badge" :class="{ alive: status.alive }">
          <span class="model-dot"></span>
          <span class="model-name">{{ status.model || '未配置' }}</span>
          <span class="sep">·</span>
          <span class="model-status">{{ status.alive ? '就绪' : '离线' }}</span>
        </div>
      </div>
      <p class="brain-subtitle">AI 决策系统的记忆、技能与实时思考流</p>
    </div>

    <!-- 2×2 网格 -->
    <div class="brain-grid">

      <!-- 1. 记忆 -->
      <div class="brain-panel">
        <div class="panel-title">
          <span class="panel-label"><McIcon name="memory" :size="14" /> 记忆</span>
          <span class="panel-count">{{ memories.length }} 条</span>
        </div>
        <div class="panel-body">
          <div v-if="memories.length === 0" class="panel-empty">暂无记忆</div>
          <div v-for="(m, i) in memories.slice(0, 8)" :key="i" class="mem-item">
            <div class="mem-text">{{ m.text }}</div>
          </div>
          <div v-if="memories.length > 8" class="panel-more" @click="showAllMem = !showAllMem">
            {{ showAllMem ? '收起' : `查看全部 ${memories.length} 条 →` }}
          </div>
          <div v-if="showAllMem">
            <div v-for="(m, i) in memories.slice(8)" :key="'x'+i" class="mem-item">
              <div class="mem-text">{{ m.text }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. 技能 -->
      <div class="brain-panel">
        <div class="panel-title">
          <span class="panel-label"><McIcon name="skill" :size="14" /> 技能</span>
          <span class="panel-count">{{ skills.length }} 个</span>
        </div>
        <div class="panel-body">
          <div v-if="skills.length === 0" class="panel-empty">暂无技能</div>
          <div v-for="sk in skills" :key="sk.name" class="skill-item">
            <div class="skill-name">{{ sk.name }}</div>
            <div class="skill-desc">{{ sk.description || '无描述' }}</div>
            <div class="skill-cat">{{ sk.category }}</div>
          </div>
        </div>
      </div>

      <!-- 3. 实时决策流 -->
      <div class="brain-panel">
        <div class="panel-title">
          <span class="panel-label"><McIcon name="activity" :size="14" /> 实时决策流</span>
          <span class="panel-count" :class="{ live: agentSteps.length > 0 }">
            {{ agentSteps.length > 0 ? '● 活跃' : '空闲' }}
          </span>
        </div>
        <div class="panel-body think-stream" ref="streamEl">
          <div v-if="agentSteps.length === 0" class="panel-empty">等待 AI 决策...</div>
          <div v-for="(step, i) in agentSteps.slice(-30)" :key="i" class="think-item">
            <span class="think-badge" :class="step.type">{{ typeLabel(step.type) }}</span>
            <span class="think-text">{{ step.text }}</span>
            <span class="think-time">{{ fmtTime(step.ts) }}</span>
          </div>
        </div>
      </div>

      <!-- 4. 会话历史 -->
      <div class="brain-panel">
        <div class="panel-title">
          <span class="panel-label"><McIcon name="history" :size="14" /> 会话历史</span>
          <span class="panel-count">{{ sessions.length }} 次</span>
        </div>
        <div class="panel-body">
          <div v-if="sessions.length === 0" class="panel-empty">暂无会话记录</div>
          <div v-for="sess in sessions" :key="sess.id" class="sess-item">
            <div class="sess-header">
              <span class="sess-id">{{ sess.id }}</span>
              <span class="sess-time">{{ sess.time }}</span>
            </div>
            <div class="sess-preview">{{ sess.preview }}</div>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue';
import McIcon from './icons/McIcon.vue';

const props = defineProps({
  agentSteps: { type: Array, default: () => [] },
});

const status = ref({ alive: false, model: '', baseUrl: '' });
const memories = ref([]);
const skills = ref([]);
const sessions = ref([]);
const showAllMem = ref(false);
const streamEl = ref(null);

watch(() => props.agentSteps.length, async () => {
  await nextTick();
  if (streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight;
});

async function loadData() {
  try {
    const [sRes, mRes, skRes] = await Promise.all([
      fetch('/api/hermes/status'),
      fetch('/api/hermes/memories'),
      fetch('/api/hermes/skills'),
    ]);
    if (sRes.ok) status.value = await sRes.json();
    if (mRes.ok) {
      const d = await mRes.json();
      memories.value = (d.memories ?? []).filter(m => m.type === 'fact' && m.text.length > 10);
    }
    if (skRes.ok) {
      const d = await skRes.json();
      skills.value = d.skills ?? [];
    }
  } catch {}
}

function typeLabel(t) {
  const m = { turn: 'TURN', tool_call: 'TOOL', tool_result: 'RES', done: 'DONE', error: 'ERR', thought: '思考' };
  return m[t] ?? t.toUpperCase();
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// 模拟会话历史（待接入真实 API）
sessions.value = [
  { id: 'minefriend-0bef', time: '当前', preview: '来我这里 → 好的，我来了！跟随任务启动' },
  { id: 'minefriend-ac72', time: '38分前', preview: '你现在用的是什么 AI 模型？→ DeepSeek V4 Flash' },
];

const timer = setInterval(loadData, 10_000);
onMounted(loadData);
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.brain-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #0c0e08; }

.brain-header {
  padding: 14px 20px 10px;
  border-bottom: 1px solid #20241a;
  background: #15170f; flex-shrink: 0;
}
.brain-title-row { display: flex; align-items: center; gap: 12px; }
.brain-title-row h2 { display: inline-flex; align-items: center; gap: 6px; font-size: 15px; color: #e7e3d4; }
.brain-subtitle { font-size: 11px; color: #7e836e; margin-top: 3px; }

.brain-model-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 6px;
  background: #20241a; border: 1px solid #3a4030;
  font-size: 11px;
}
.brain-model-badge.alive { background: #1b2e14; border-color: #5d9c3c44; }
.model-dot { width: 6px; height: 6px; border-radius: 50%; background: #6b6f5e; flex-shrink: 0; }
.brain-model-badge.alive .model-dot { background: #5d9c3c; animation: pulse 2s infinite; }
.model-name { color: #7cc24e; font-weight: 600; }
.sep { color: #6b6f5e; }
.model-status { color: #7e836e; }

/* 2×2 grid */
.brain-grid {
  flex: 1; overflow: hidden;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}
.brain-panel {
  border-right: 1px solid #20241a;
  border-bottom: 1px solid #20241a;
  display: flex; flex-direction: column; overflow: hidden;
}
.brain-panel:nth-child(2n) { border-right: none; }
.brain-panel:nth-child(3), .brain-panel:nth-child(4) { border-bottom: none; }

.panel-title {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px;
  font-size: 11px; font-weight: 600; color: #e7e3d4;
  border-bottom: 1px solid #20241a;
  background: #0c0e08; flex-shrink: 0;
}
.panel-label { display: inline-flex; align-items: center; gap: 5px; }
.panel-count { font-size: 10px; color: #7e836e; font-weight: 400; }
.panel-count.live { color: #5d9c3c; }

.panel-body {
  flex: 1; overflow-y: auto; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 4px;
}
.panel-empty { color: #6b6f5e; font-size: 11px; padding: 12px 0; text-align: center; }
.panel-more { font-size: 10px; color: #7cc24e; cursor: pointer; text-align: center; padding: 4px 0; }

/* 记忆 */
.mem-item {
  padding: 5px 8px; border-radius: 4px;
  background: #15170f; border: 1px solid #20241a; font-size: 11px;
}
.mem-text { color: #cdd2c0; line-height: 1.5; }

/* 技能 */
.skill-item {
  padding: 6px 8px; border-radius: 5px;
  background: #15170f; border: 1px solid #20241a; font-size: 11px;
}
.skill-name { color: #e7e3d4; font-weight: 500; margin-bottom: 1px; }
.skill-desc { color: #7e836e; font-size: 10px; }
.skill-cat { font-size: 9px; color: #e0a52f; margin-top: 2px; }

/* 思考流 */
.think-stream { gap: 3px; }
.think-item { display: flex; align-items: baseline; gap: 6px; font-size: 11px; padding: 2px 0; }
.think-badge { flex-shrink: 0; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 700; }
.think-badge.turn { background: #1b2e14; color: #7cc24e; }
.think-badge.tool_call { background: #2b2410; color: #e0a52f; }
.think-badge.tool_result { background: #20241a; color: #7e836e; }
.think-badge.done { background: #18361a; color: #5d9c3c; }
.think-badge.error { background: #3a1410; color: #d8503c; }
.think-badge.thought { background: #1a1a3d; color: #7cc24e; }
.think-text { flex: 1; color: #cdd2c0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.think-time { color: #6b6f5e; flex-shrink: 0; font-size: 10px; }

/* 会话 */
.sess-item {
  padding: 6px 8px; border-radius: 5px;
  background: #15170f; border: 1px solid #20241a; font-size: 11px; cursor: pointer;
}
.sess-item:hover { border-color: #3a4030; }
.sess-header { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.sess-id { font-family: var(--mc-font-mono); color: #7cc24e; font-size: 10px; }
.sess-time { font-size: 10px; color: #6b6f5e; margin-left: auto; }
.sess-preview { color: #7e836e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@keyframes pulse { 0%,100%{opacity:1}50%{opacity:.4} }
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-thumb { background: #3a4030; border-radius: 2px; }
</style>
