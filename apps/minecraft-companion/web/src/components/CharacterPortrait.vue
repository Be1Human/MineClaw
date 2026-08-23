<!--
  CharacterPortrait · FEAT-WEBUI-05 AI 角色形象（皮肤全身静态图）
  - 来源：mc-heads.net/body/<skinName>/<size>（与头像同源，零新增依赖）
  - 失败回退：mc-heads.net 的 Steve 占位 → 再失败则首字母方块
  - 像素渲染（image-rendering: pixelated）
  - 名字优先级：profile.skinName（用户在 SettingsPanel 配置）→ profile.name
-->
<template>
  <div class="char-portrait">
    <div class="char-frame">
      <img
        v-if="src && !errored"
        :src="src"
        :alt="skinName"
        class="char-img"
        @error="onErr"
        @load="errored = false"
      />
      <div v-else class="char-fallback">
        <div class="cf-letter">{{ (skinName || '?')[0]?.toUpperCase() }}</div>
        <div class="cf-tip">皮肤加载失败</div>
      </div>
    </div>
    <div class="char-name" v-if="showName">{{ skinName }}</div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({
  skinName: { type: String, required: true },
  size: { type: Number, default: 300 },
  showName: { type: Boolean, default: false },
});

const errored = ref(false);

const src = computed(() => {
  if (!props.skinName) return '';
  return `https://mc-heads.net/body/${encodeURIComponent(props.skinName)}/${props.size}`;
});

// 切换 bot 时重置 error
watch(() => props.skinName, () => { errored.value = false; });

function onErr() {
  errored.value = true;
}
</script>

<style scoped>
.char-portrait {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.char-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 7;     /* 全身像比例约 1:2.3，3:7 接近 */
  max-width: 140px;
  background: linear-gradient(180deg, #1a1f27 0%, #11151b 100%);
  border: 1px solid #2a3138;
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.char-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
.char-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #7e836e;
}
.cf-letter {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  background: linear-gradient(135deg, #4c7a2a, #5d9c3c);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 700;
}
.cf-tip {
  font-size: 10px;
  color: #7e836e;
}
.char-name {
  font-size: 11px;
  color: #7e836e;
  font-family: var(--mc-font-mono);
}
</style>
