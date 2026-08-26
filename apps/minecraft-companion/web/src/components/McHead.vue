<!--
  McHead · FEAT-WEBUI-11
  从皮肤纹理本地渲染头像（canvas 裁 face(8,8,8,8) + hat(40,8,8,8) 叠加 · 像素风 · 离线可用）。
  props: texture(URL/dataURL·空走默认) · size(px)
-->
<template>
  <canvas ref="cv" :width="size" :height="size"
    :style="{ width: size + 'px', height: size + 'px', imageRendering: 'pixelated', display: 'block' }"></canvas>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import defaultSkin from '../assets/skins/07-lanyi.png';

const props = defineProps({
  texture: { type: String, default: '' },
  size: { type: Number, default: 40 },
});

const cv = ref(null);

function draw() {
  const c = cv.value;
  if (!c) return;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const s = props.size;
    ctx.clearRect(0, 0, s, s);
    // 脸 8,8,8,8 放大铺满
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, s, s);
    // 帽层 40,8,8,8 叠加
    try { ctx.drawImage(img, 40, 8, 8, 8, 0, 0, s, s); } catch { /* ignore */ }
  };
  img.onerror = () => { if (img.src !== defaultSkin) img.src = defaultSkin; };
  img.src = props.texture || defaultSkin;
}

onMounted(draw);
watch(() => props.texture, draw);
watch(() => props.size, draw);
</script>
