<template>
  <div v-if="hasAlerts" class="alert-banner-wrap">
    <!-- Danger banner -->
    <div class="alert-banner" v-if="alerts.suspendedByDanger && alerts.suspendedByDanger.length > 0">
      <span class="alert-icon">&#9888;</span>
      <span class="alert-text">
        危险暂停中：{{ alerts.suspendedByDanger.join('、') }}
      </span>
      <span class="alert-count">{{ alerts.suspendedByDanger.length }} 个任务</span>
    </div>
    <!-- Diagnoses list -->
    <div class="diag-list" v-if="alerts.recentDiagnoses && alerts.recentDiagnoses.length > 0">
      <div class="diag-title">近期诊断</div>
      <div
        v-for="(d, i) in alerts.recentDiagnoses"
        :key="i"
        class="diag-item"
      >
        <span class="diag-category">{{ d.category ?? '—' }}</span>
        <span class="diag-detail">{{ d.detail ?? '' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, defineProps } from 'vue';

const props = defineProps({
  alerts: {
    type: Object,
    default: () => ({ suspendedByDanger: [], recentDiagnoses: [] })
  }
});

const hasAlerts = computed(() => {
  const sd = props.alerts?.suspendedByDanger;
  const rd = props.alerts?.recentDiagnoses;
  return (sd && sd.length > 0) || (rd && rd.length > 0);
});
</script>

<style scoped>
.alert-banner-wrap {
  margin-bottom: 0;
}

.alert-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: #3a1410;
  border: 1px solid #b33b2a66;
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 13px;
}

.alert-icon {
  font-size: 16px;
  color: #d8503c;
  flex-shrink: 0;
}

.alert-text {
  flex: 1;
  color: #ffa198;
  font-weight: 500;
}

.alert-count {
  font-size: 11px;
  color: #d8503c;
  background: #5a1e20;
  padding: 2px 8px;
  border-radius: 8px;
  flex-shrink: 0;
}

.diag-list {
  background: #15170f;
  border: 1px solid #3a4030;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
}

.diag-title {
  font-size: 10px;
  text-transform: uppercase;
  color: #7e836e;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.diag-item {
  display: flex;
  gap: 8px;
  padding: 2px 0;
}

.diag-category {
  color: #e3b341;
  font-weight: 500;
  min-width: 80px;
  flex-shrink: 0;
}

.diag-detail {
  color: #7e836e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
