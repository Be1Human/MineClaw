<!--
  ChatBox · 聊天输入框（本地状态隔离）

  性能要点：输入框的文本状态 text 是组件内部 ref，打字只重渲染本组件，
  不会触发父组件（App.vue 巨型单体）整树重渲染重排。仅在「发送」时才向上 emit，
  把高频按键事件挡在小组件内。
-->
<template>
  <div style="display:flex; gap:6px; margin-top:6px;">
    <input v-model="text" @keydown.enter="emitSend" placeholder="跟伙伴说点什么…"
      style="flex:1; padding:9px 11px; background:#0c0e08; border:2px solid #000; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); color:#e7e3d4; font-family:var(--mc-font-body); font-size:13px;" />
    <button @click="emitSend" :disabled="!text.trim() || sending"
      style="padding:9px 16px; cursor:pointer; background:#4c9a2a; border:2px solid #2b5e16; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.28), inset -2px -2px 0 rgba(0,0,0,0.3), 0 3px 0 #214b13; color:#fff; font-weight:700; font-size:13px;">发送</button>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const emit = defineEmits(['send']);

const text = ref('');
const sending = ref(false);

function emitSend() {
  const t = text.value.trim();
  if (!t || sending.value) return;
  sending.value = true;
  emit('send', t, (result = {}) => {
    if (result.accepted === true && text.value.trim() === t) text.value = '';
    sending.value = false;
  });
}
</script>
