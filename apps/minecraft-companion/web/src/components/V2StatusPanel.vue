<template>
  <div class="v2-panel">
    <div class="panel-header">
      <span class="panel-title">⚡ v2.0 运行时</span>
      <span class="tick-badge">tick #{{ status.tick ?? '...' }}</span>
    </div>

    <!-- World State -->
    <div class="section" v-if="status.world">
      <div class="section-title">🌍 世界状态</div>
      <div class="info-grid">
        <div class="info-item">
          <span class="label">血量</span>
          <span class="value">{{ status.world.self?.health ?? '-' }}/{{ status.world.self?.maxHealth ?? 20 }}</span>
        </div>
        <div class="info-item" v-if="status.world.owner">
          <span class="label">主人距离</span>
          <span class="value">{{ status.world.owner.distance?.toFixed(1) ?? '-' }}m</span>
        </div>
        <div class="info-item">
          <span class="label">时间</span>
          <span class="value">{{ status.world.environment?.isDay ? '☀️ 白天' : '🌙 夜晚' }}</span>
        </div>
      </div>
    </div>

    <!-- 固化技能（FEAT-CROSS-07 R10）：fast 节点 + ⚡置信度 -->
    <div class="section" v-if="status.learnedStrategies?.length">
      <div class="section-title">🧠 固化技能</div>
      <div v-for="s in status.learnedStrategies" :key="s.id" class="strategy-item" :class="'strat-' + s.state">
        <span class="strategy-name">{{ s.name }}</span>
        <span class="strategy-conf">⚡{{ Math.round((s.confidence ?? 0) * 100) }}%</span>
        <span class="strategy-state">{{ stateLabel(s.state) }}<template v-if="s.ownerVerdict === 'rejected'"> · 主人禁用</template></span>
      </div>
    </div>

    <!-- Supervisor -->
    <div class="section" v-if="status.supervisor">
      <div class="section-title">🛡 Supervisor</div>
      <div v-if="status.supervisor.suspendedByDanger?.length" class="alert-row">
        ⚠️ 危险暂停: {{ status.supervisor.suspendedByDanger.join(', ') }}
      </div>
      <div v-if="status.supervisor.recentDiagnoses?.length" class="diag-row">
        诊断: {{ status.supervisor.recentDiagnoses[status.supervisor.recentDiagnoses.length - 1]?.category }}
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  status: {
    type: Object,
    default: () => ({})
  }
});

function stateLabel(state) {
  return { candidate: '🟡候选', trusted: '🟢可信', blacklisted: '⛔拉黑', disabled: '🚫禁用' }[state] || state;
}
</script>

<style scoped>
.v2-panel {
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
  margin-bottom: 12px;
}

.panel-title { font-weight: 600; font-size: 14px; }

.tick-badge {
  background: #20241a;
  border: 1px solid #3a4030;
  border-radius: 4px;
  padding: 2px 8px;
  font-family: var(--mc-font-mono);
  font-size: 12px;
  color: #7cc24e;
}

.section { margin-bottom: 10px; }
.section-title { color: #7d8590; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }

.info-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.info-item { display: flex; flex-direction: column; min-width: 80px; }
.label { color: #7d8590; font-size: 11px; }
.value { font-weight: 500; }

.strategy-item { display: flex; gap: 8px; align-items: center; padding: 3px 8px; border-radius: 4px; margin-bottom: 2px; background: #20241a; }
.strategy-name { flex: 1; font-weight: 500; }
.strategy-conf { font-family: var(--mc-font-mono); font-size: 12px; color: #7cc24e; }
.strategy-state { font-size: 11px; color: #7d8590; }
.strat-trusted { border-left: 3px solid #4c7a2a; }
.strat-candidate { border-left: 3px solid #e3b341; }
.strat-blacklisted, .strat-disabled { border-left: 3px solid #7e836e; opacity: 0.6; }

.alert-row { color: #e3b341; padding: 4px 0; }
.diag-row { color: #7d8590; font-size: 11px; padding: 2px 0; }
</style>
