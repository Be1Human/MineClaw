<template>
  <div
    class="mc-resize-handle"
    :class="{ 'is-active': active, 'is-disabled': disabled }"
    role="separator"
    :aria-label="label"
    aria-orientation="vertical"
    :aria-disabled="disabled"
    :aria-valuemin="minimum"
    :aria-valuemax="maximum"
    :aria-valuenow="value"
    :tabindex="disabled ? -1 : 0"
    @pointerdown="start"
    @keydown="onKeydown"
    @dblclick="reset"
  ></div>
</template>

<script setup>
import { onUnmounted, ref } from 'vue';

const props = defineProps({
  label: { type: String, required: true },
  value: { type: Number, required: true },
  minimum: { type: Number, required: true },
  maximum: { type: Number, required: true },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['resize', 'commit', 'reset', 'active']);
const active = ref(false);
let lastX = 0;

function start(event) {
  if (props.disabled || event.button !== 0) return;
  event.preventDefault();
  lastX = event.clientX;
  active.value = true;
  emit('active', true);
  event.currentTarget.setPointerCapture?.(event.pointerId);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish, { once: true });
  window.addEventListener('pointercancel', finish, { once: true });
}

function move(event) {
  if (!active.value) return;
  const delta = event.clientX - lastX;
  lastX = event.clientX;
  if (delta) emit('resize', delta);
}

function finish() {
  if (!active.value) return;
  active.value = false;
  window.removeEventListener('pointermove', move);
  window.removeEventListener('pointerup', finish);
  window.removeEventListener('pointercancel', finish);
  emit('active', false);
  emit('commit');
}

function onKeydown(event) {
  if (props.disabled || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const step = event.shiftKey ? 36 : 12;
  emit('resize', event.key === 'ArrowRight' ? step : -step);
  emit('commit');
}

function reset() {
  if (!props.disabled) emit('reset');
}

onUnmounted(finish);
</script>

<style scoped>
.mc-resize-handle { position:relative; z-index:8; min-width:0; cursor:col-resize; touch-action:none; outline:none; }
.mc-resize-handle:focus-visible { outline:1px dashed rgba(105,201,74,.58); outline-offset:-3px; }
.mc-resize-handle.is-active { background:rgba(105,201,74,.055); }
.mc-resize-handle.is-disabled { cursor:default; pointer-events:none; }
</style>
