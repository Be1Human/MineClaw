<!--
  McCharacter · FEAT-WEBUI-11
  skinview3d 渲染真实 3D MC 形象（复用顶层 three ^0.184）。
  props: texture(URL/dataURL·空走默认皮肤) · model(classic|slim|auto-detect) · animation(idle|walk|run|fly|none) · autoRotate · zoom
-->
<template>
  <canvas ref="cv" style="display:block; width:100%; height:100%;"></canvas>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { SkinViewer, IdleAnimation, WalkingAnimation, RunningAnimation, FlyingAnimation } from 'skinview3d';
import defaultSkin from '../assets/skins/07-lanyi.png';

const props = defineProps({
  texture: { type: String, default: '' },
  model: { type: String, default: 'auto-detect' },
  animation: { type: String, default: 'idle' },
  autoRotate: { type: Boolean, default: false },
  zoom: { type: Number, default: 0.95 },
});

const cv = ref(null);
let viewer = null;
let ro = null;
const onVisibility = () => { if (viewer) viewer.renderPaused = document.hidden; };

function makeAnim(name) {
  switch (name) {
    case 'walk': return new WalkingAnimation();
    case 'run': return new RunningAnimation();
    case 'fly': return new FlyingAnimation();
    case 'none': return null;
    case 'idle':
    default: {
      // idle 自带手臂自然摆动；它原本的头动只有 ~6° 看不出 → 关掉，叠加明显的头部左右看
      const a = new IdleAnimation();
      try { a.headBobbing = false; } catch { /* 旧版无此属性 */ }
      a.addAnimation((player, progress) => {
        const head = player?.skin?.head;
        if (!head) return;
        head.rotation.y = Math.sin(progress * 0.7) * 0.55;  // 左右看 ~±31°·周期≈9s
        head.rotation.x = Math.sin(progress * 1.1) * 0.12;  // 轻微点头
      });
      return a;
    }
  }
}

function applyAnim() { if (viewer) viewer.animation = makeAnim(props.animation); }

async function loadSkin() {
  if (!viewer) return;
  const url = props.texture || defaultSkin;
  try {
    await viewer.loadSkin(url, { model: props.model });
  } catch {
    try { await viewer.loadSkin(defaultSkin, { model: 'classic' }); } catch { /* ignore */ }
  }
}

onMounted(() => {
  const w = cv.value.clientWidth || 220;
  const h = cv.value.clientHeight || 300;
  viewer = new SkinViewer({ canvas: cv.value, width: w, height: h });
  try { viewer.pixelRatio = Math.min(window.devicePixelRatio, 1.25); } catch { /* 旧版无此属性 */ }
  document.addEventListener('visibilitychange', onVisibility);
  viewer.autoRotate = props.autoRotate;
  viewer.controls.enableZoom = false;
  viewer.controls.enablePan = false;
  // 收窄视场角 → 消除默认 ~70° 的广角畸变（更接近正交/长焦观感）
  viewer.fov = 28;
  // 拉近 → 角色充满画面（FOV 变小已放大，zoom 配合微调）
  viewer.zoom = props.zoom;
  applyAnim();
  loadSkin();

  // 性能：skinview3d 的 draw() 每帧自我 rAF 重排，且每帧跑全屏 FXAA 后处理，
  // 默认随显示器刷新率（高刷屏可达 144+fps）狂渲一个本就微动的 idle 角色 → 吃满渲染线程。
  // idle 角色限到 ~20fps 完全够看；空跳帧只重排不渲染（近零成本），渲染开销砍到 1/3~1/7。
  const minDeltaMs = 1000 / 20;
  let lastDrawTs = 0;
  const origDraw = viewer.draw.bind(viewer);
  viewer.draw = () => {
    const now = performance.now();
    if (now - lastDrawTs < minDeltaMs) {
      viewer.animationID = requestAnimationFrame(viewer.draw);
      return;
    }
    lastDrawTs = now;
    origDraw(); // 内部 render + 调度下一帧
  };

  // 响应容器尺寸变化
  ro = new ResizeObserver(() => {
    if (!viewer || !cv.value) return;
    const cw = cv.value.clientWidth, ch = cv.value.clientHeight;
    if (cw > 0 && ch > 0) viewer.setSize(cw, ch);
  });
  ro.observe(cv.value);
});

watch(() => props.texture, loadSkin);
watch(() => props.model, loadSkin);
watch(() => props.animation, applyAnim);
watch(() => props.autoRotate, (v) => { if (viewer) viewer.autoRotate = v; });
watch(() => props.zoom, (v) => { if (viewer && Number.isFinite(v) && v > 0) viewer.zoom = v; });

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility);
  try { ro?.disconnect(); } catch { /* ignore */ }
  try { viewer?.dispose(); } catch { /* ignore */ }
  viewer = null;
});
</script>
