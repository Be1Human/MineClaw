<template>
  <section v-if="visible" class="lan-world-panel" :class="{ compact }" aria-label="已发现的局域网世界">
    <div v-if="worlds.length" class="lan-world-heading">
      <span class="lan-world-pulse" aria-hidden="true"></span>
      <strong>发现局域网世界</strong>
      <small>{{ worlds.length }} 个</small>
    </div>
    <p v-if="snapshot.state === 'unavailable' && !worlds.length" class="lan-world-unavailable" role="status">
      局域网发现暂不可用<span v-if="snapshot.error">：{{ snapshot.error }}</span>
    </p>
    <div v-else class="lan-world-list">
      <article v-for="world in worlds" :key="world.id" class="lan-world-card">
        <div class="lan-world-copy">
          <strong :title="world.motd">{{ world.motd }}</strong>
          <small>{{ world.host }}:{{ world.port }}</small>
        </div>
        <button
          type="button"
          :disabled="disabled || Boolean(joiningWorldId)"
          :aria-label="`让 ${profileName || '当前伙伴'} 加入 ${world.motd}`"
          @click="$emit('join', world)"
        >
          {{ joiningWorldId === world.id ? '加入中…' : '让伙伴加入' }}
        </button>
      </article>
    </div>
    <p v-if="error && worlds.length" class="lan-world-error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { projectLanWorldSnapshot } from '../lib/lanWorldPresentation.js';

const props = defineProps({
  snapshot: { type: Object, required: true },
  profileName: { type: String, default: '' },
  joiningWorldId: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  error: { type: String, default: '' },
  compact: { type: Boolean, default: false },
});

defineEmits(['join']);

const projected = computed(() => projectLanWorldSnapshot(props.snapshot));
const worlds = computed(() => projected.value.worlds);
const visible = computed(() => worlds.value.length > 0 || projected.value.state === 'unavailable');
</script>

<style scoped>
.lan-world-panel { display:flex; min-width:0; flex-direction:column; gap:8px; padding:10px; background:rgba(10,17,12,.94); border:1px solid rgba(105,201,74,.28); border-radius:var(--mc-radius-sm); box-shadow:0 14px 34px rgba(0,0,0,.28); backdrop-filter:blur(12px); }
.lan-world-heading { display:flex; min-width:0; align-items:center; gap:7px; color:var(--mc-accent-strong); }
.lan-world-heading strong { overflow:hidden; flex:1; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.lan-world-heading small { color:var(--mc-text-muted); font:9px var(--mc-font-mono); }
.lan-world-pulse { width:7px; height:7px; flex:none; background:var(--mc-accent); border-radius:50%; box-shadow:0 0 9px rgba(105,201,74,.75); }
.lan-world-list { display:flex; max-height:190px; flex-direction:column; gap:6px; overflow:auto; }
.lan-world-card { display:flex; min-width:0; align-items:center; gap:10px; padding:8px; background:rgba(255,255,255,.025); border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); }
.lan-world-copy { display:flex; min-width:0; flex:1; flex-direction:column; gap:3px; }
.lan-world-copy strong { overflow:hidden; color:var(--mc-text); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.lan-world-copy small { overflow:hidden; color:var(--mc-text-muted); font:9px var(--mc-font-mono); text-overflow:ellipsis; white-space:nowrap; }
.lan-world-card button { min-height:30px; flex:none; padding:6px 9px; cursor:pointer; background:var(--mc-accent); border:0; border-radius:var(--mc-radius-xs); color:#081007; font-size:10px; font-weight:900; white-space:nowrap; }
.lan-world-card button:hover:not(:disabled) { background:var(--mc-accent-strong); }
.lan-world-card button:disabled { cursor:not-allowed; filter:saturate(.35); opacity:.42; }
.lan-world-error,.lan-world-unavailable { margin:0; color:var(--mc-danger); font-size:10px; line-height:1.45; }
.compact { padding:8px; box-shadow:none; }
.compact .lan-world-list { max-height:150px; }
.compact .lan-world-card { align-items:stretch; flex-direction:column; gap:7px; }
.compact .lan-world-card button { width:100%; }
</style>

