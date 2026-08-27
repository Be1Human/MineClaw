<template>
  <svg
    class="mc-icon"
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="definition.viewBox"
    :width="normalizedSize"
    :height="normalizedSize"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    focusable="false"
    shape-rendering="crispEdges"
  >
    <path
      v-for="(layer, index) in definition.layers"
      :key="index"
      :d="layer.d"
      :fill="layer.tone === 'accent' ? 'var(--mc-icon-accent, currentColor)' : 'currentColor'"
      :fill-rule="layer.fillRule"
    />
  </svg>
</template>

<script setup>
import { computed, watchEffect } from 'vue';
import { hasIcon, resolveIcon } from '../../icons/iconDefinitions.js';

const props = defineProps({
  name: { type: String, default: 'unknown' },
  size: { type: [Number, String], default: '1em' },
  label: { type: String, default: '' },
});

const definition = computed(() => resolveIcon(props.name));
const normalizedSize = computed(() => (
  typeof props.size === 'number' ? `${props.size}px` : props.size
));

watchEffect(() => {
  if (import.meta.env.DEV && !hasIcon(props.name)) {
    console.warn(`[McIcon] Unknown icon "${props.name}"; rendering "unknown".`);
  }
});
</script>

<style scoped>
.mc-icon {
  display: inline-block;
  flex: 0 0 auto;
  overflow: visible;
  vertical-align: -0.125em;
}
</style>
