<template>
  <main class="pet-stage" :class="[`mode-${state.mode}`, `face-${state.facing}`]">
    <div class="pet-model">
      <DesktopPet3D
        v-if="profile"
        :texture="profile.skinTexture || ''"
        :model="profile.skinModel || 'slim'"
        :animation="state.animation"
        :facing="state.facing"
      />
    </div>
  </main>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import DesktopPet3D from './components/DesktopPet3D.vue';

const profile = ref(null);
const state = reactive({ profileId: '', mode: 'fixed', animation: 'idle', facing: 'right' });
let unsubscribe = null;

async function applyState(next) {
  Object.assign(state, next || {});
  if (!state.profileId) return;
  const response = await fetch(`/api/profiles/${state.profileId}`);
  if (response.ok) profile.value = await response.json();
}

onMounted(() => {
  unsubscribe = window.electronAPI?.onDesktopPetState?.(applyState);
  void fetch('/api/desktop-pet')
    .then(response => response.ok ? response.json() : null)
    .then(config => config?.profileId && applyState({
      profileId: config.profileId,
      mode: config.mode || 'fixed',
      animation: 'idle',
      facing: 'right',
    }));
});

onBeforeUnmount(() => unsubscribe?.());
</script>

<style>
.pet-stage { width:100%; height:100%; background:transparent; overflow:hidden; user-select:none; }
.pet-stage.mode-fixed { -webkit-app-region:drag; cursor:grab; }
.pet-stage.mode-fixed:active { cursor:grabbing; }
.pet-model { width:100%; height:100%; }
canvas { pointer-events:none; }
</style>
