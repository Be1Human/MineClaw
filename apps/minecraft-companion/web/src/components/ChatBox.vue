<!--
  ChatBox · 聊天输入框（本地状态隔离）

  性能要点：输入框的文本状态 text 是组件内部 ref，打字只重渲染本组件，
  不会触发父组件（App.vue 巨型单体）整树重渲染重排。仅在「发送」时才向上 emit，
  把高频按键事件挡在小组件内。
-->
<template>
  <div class="chat-composer">
    <input v-model="text" @keydown.enter="emitSend" placeholder="跟伙伴说点什么…"
      aria-label="聊天消息" />
    <button
      @click="emitSend"
      :disabled="!text.trim() || sending"
      :aria-label="sending ? '发送中' : '发送消息'"
      :title="sending ? '发送中' : '发送消息'"
    ><McIcon name="send" :size="16" /></button>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import McIcon from './icons/McIcon.vue';

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

<style scoped>
.chat-composer { display:flex; flex:none; gap:8px; padding-top:10px; border-top:1px solid var(--mc-border); }
.chat-composer input { min-width:0; min-height:40px; flex:1; padding:9px 12px; background:var(--mc-bg); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-sm); color:var(--mc-text); font-size:12px; transition:border-color var(--mc-duration-fast),box-shadow var(--mc-duration-fast); }
.chat-composer input::placeholder { color:var(--mc-text-muted); }
.chat-composer input:focus { border-color:rgba(105,201,74,.55); outline:0; box-shadow:0 0 0 3px rgba(105,201,74,.09); }
.chat-composer button { display:grid; width:44px; min-width:44px; min-height:40px; place-items:center; padding:0; cursor:pointer; background:linear-gradient(180deg,#397a3a,#2a5c30); border:1px solid rgba(105,201,74,.5); border-radius:var(--mc-radius-sm); color:#effdeb; transition:background var(--mc-duration-fast),opacity var(--mc-duration-fast); }
.chat-composer button:hover:not(:disabled) { background:var(--mc-accent-strong); }
.chat-composer button:disabled { cursor:not-allowed; opacity:.38; }
@media (max-width:420px) {
  .chat-composer { gap:6px; }
  .chat-composer button { width:40px; min-width:40px; }
}
</style>
