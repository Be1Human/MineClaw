<template>
  <div v-if="hasAlerts" class="alert-banner-wrap">
    <div class="alert-banner">
      <McIcon class="alert-icon" name="warning" :size="16" />
      <span class="alert-text">
        危险暂停中：{{ alerts.suspendedByDanger.join('、') }}
      </span>
      <span class="alert-count">{{ alerts.suspendedByDanger.length }} 个任务</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import McIcon from './icons/McIcon.vue';

const props = defineProps({
  alerts: {
    type: Object,
    default: () => ({ suspendedByDanger: [] })
  }
});

const hasAlerts = computed(() => {
  const sd = props.alerts?.suspendedByDanger;
  return Array.isArray(sd) && sd.length > 0;
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
</style>
