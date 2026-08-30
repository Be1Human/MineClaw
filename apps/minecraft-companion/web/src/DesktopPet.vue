<template>
  <main
    class="pet-stage"
    :class="[`mode-${state.mode}`, `face-${state.facing}`, { 'is-interactive': isInteractive, 'is-dragging': isDragging }]"
    @pointermove="handlePointerMove"
    @pointerdown="handlePointerDown"
    @pointerup="handlePointerEnd"
    @pointercancel="handlePointerEnd"
    @pointerleave="handlePointerLeave"
  >
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
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import DesktopPet3D from './components/DesktopPet3D.vue';
import { isOpaqueCanvasPixel } from './lib/desktopPetPointerHit.js';

const profile = ref(null);
const state = reactive({ profileId: '', mode: 'fixed', animation: 'idle', facing: 'right' });
let unsubscribe = null;
let hitFrame = 0;
let latestPointer = null;
let activePointerId = null;
let passthrough = null;
const isInteractive = ref(false);
const isDragging = ref(false);

function setPassthrough(next) {
  if (passthrough === next) return;
  passthrough = next;
  window.electronAPI?.setDesktopPetMousePassthrough?.(next);
}

function pointerSnapshot(event) {
  return { screenX: event.screenX, screenY: event.screenY };
}

function applyPointerHit(clientX, clientY) {
  if (state.mode === 'wander' || isDragging.value) {
    isInteractive.value = false;
    setPassthrough(state.mode === 'wander');
    return;
  }
  const canvas = document.querySelector('.pet-canvas');
  const hit = Boolean(canvas && isOpaqueCanvasPixel(canvas, clientX, clientY));
  isInteractive.value = hit;
  setPassthrough(!hit);
}

function schedulePointerHit(event) {
  latestPointer = { clientX: event.clientX, clientY: event.clientY };
  if (hitFrame) return;
  hitFrame = requestAnimationFrame(() => {
    hitFrame = 0;
    if (latestPointer) applyPointerHit(latestPointer.clientX, latestPointer.clientY);
  });
}

function handlePointerMove(event) {
  if (isDragging.value) {
    window.electronAPI?.updateDesktopPetDrag?.(pointerSnapshot(event));
    return;
  }
  schedulePointerHit(event);
}

function handlePointerDown(event) {
  if (state.mode !== 'fixed') return;
  const canvas = document.querySelector('.pet-canvas');
  if (!canvas || !isOpaqueCanvasPixel(canvas, event.clientX, event.clientY)) return;
  isDragging.value = true;
  isInteractive.value = true;
  activePointerId = event.pointerId;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  setPassthrough(false);
  window.electronAPI?.beginDesktopPetDrag?.(pointerSnapshot(event));
}

function handlePointerEnd(event) {
  if (!isDragging.value || (activePointerId !== null && event.pointerId !== activePointerId)) return;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  isDragging.value = false;
  activePointerId = null;
  window.electronAPI?.endDesktopPetDrag?.();
  schedulePointerHit(event);
}

function handlePointerLeave() {
  if (isDragging.value) return;
  isInteractive.value = false;
  setPassthrough(true);
}

async function applyState(next) {
  Object.assign(state, next || {});
  if (!state.profileId) return;
  const response = await fetch(`/api/profiles/${state.profileId}`);
  if (response.ok) profile.value = await response.json();
}

onMounted(() => {
  setPassthrough(true);
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

watch(() => state.mode, mode => {
  if (mode !== 'wander') return;
  if (isDragging.value) window.electronAPI?.endDesktopPetDrag?.();
  isDragging.value = false;
  activePointerId = null;
  isInteractive.value = false;
  setPassthrough(true);
});

onBeforeUnmount(() => {
  if (hitFrame) cancelAnimationFrame(hitFrame);
  if (isDragging.value) window.electronAPI?.endDesktopPetDrag?.();
  setPassthrough(true);
  unsubscribe?.();
});
</script>

<style>
.pet-stage { width:100%; height:100%; background:transparent; overflow:hidden; user-select:none; touch-action:none; cursor:default; }
.pet-stage.mode-fixed.is-interactive { cursor:grab; }
.pet-stage.mode-fixed.is-dragging { cursor:grabbing; }
.pet-model { width:100%; height:100%; }
canvas { pointer-events:none; }
</style>
