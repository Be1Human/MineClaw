<!--
  StatusBarsMC · FEAT-WEBUI-06 状态面板 MC 化（血条/饥饿条像素风）
  - 输入：health (0-20)、food (0-20)
  - 10 颗心代表 0-20 HP（每颗 2HP，半格用半填充）
  - 10 个鸡腿代表 0-20 食物（同上）
  - 用纯 SVG 路径绘制，不依赖任何图标库
  - image-rendering: pixelated 让缩放保持像素感
-->
<template>
  <div class="mc-bars">
    <!-- 血条 -->
    <div class="mc-bar-row" :title="`生命 ${health}/20`">
      <span class="bar-label">HP</span>
      <div class="icons">
        <span v-for="i in 10" :key="'h'+i" class="ic">
          <!-- 底色心（深红描边 + 暗灰内） -->
          <svg viewBox="0 0 9 9" class="ic-base">
            <path d="M2 0H4V1H5V0H7V1H8V2H9V6H8V7H7V8H6V7H5V8H4V7H3V6H2V7H1V6H0V2H1V1H2Z" fill="#1f0808" />
            <path d="M3 1H4V2H5V1H6V2H7V3H8V6H7V7H6V6H5V7H4V6H3V5H2V6H1V3H2V2H3Z" fill="#3b1010" />
          </svg>
          <!-- 半颗 / 整颗：用 width 控制裁切 -->
          <svg
            viewBox="0 0 9 9"
            class="ic-fill"
            :style="{ clipPath: `inset(0 ${100 - heartFill(i)}% 0 0)` }"
          >
            <path d="M2 0H4V1H5V0H7V1H8V2H9V6H8V7H7V8H6V7H5V8H4V7H3V6H2V7H1V6H0V2H1V1H2Z" fill="#1f0808" />
            <path d="M3 1H4V2H5V1H6V2H7V3H8V6H7V7H6V6H5V7H4V6H3V5H2V6H1V3H2V2H3Z" fill="#d83a3a" />
            <path d="M2 2H3V3H2Z M4 2H5V3H4Z M6 2H7V3H6Z" fill="#ff8a8a" />
          </svg>
        </span>
      </div>
      <span class="bar-num">{{ health ?? '?' }}/20</span>
    </div>

    <!-- 饥饿条 -->
    <div class="mc-bar-row" :title="`饱食 ${food}/20`">
      <span class="bar-label">FD</span>
      <div class="icons reverse">
        <!-- 鸡腿在 MC 原版里从右到左减少，这里也反过来 -->
        <span v-for="i in 10" :key="'f'+i" class="ic">
          <!-- 底（暗骨色） -->
          <svg viewBox="0 0 9 9" class="ic-base">
            <path d="M2 0H6V1H7V2H8V5H7V6H6V7H5V8H4V9H3V8H2V7H1V6H1V5H0V3H1V2H2Z" fill="#1c1208" />
            <path d="M3 1H6V2H7V4H6V5H5V6H4V7H3V6H2V5H2V4H1V3H2V2H3Z" fill="#3a2a16" />
          </svg>
          <!-- 填充（亮鸡腿色），从右到左收 -->
          <svg
            viewBox="0 0 9 9"
            class="ic-fill"
            :style="{ clipPath: `inset(0 ${100 - foodFill(i)}% 0 0)` }"
          >
            <path d="M2 0H6V1H7V2H8V5H7V6H6V7H5V8H4V9H3V8H2V7H1V6H1V5H0V3H1V2H2Z" fill="#1c1208" />
            <path d="M3 1H6V2H7V4H6V5H5V6H4V7H3V6H2V5H2V4H1V3H2V2H3Z" fill="#a87044" />
            <path d="M3 2H4V3H3Z M5 2H6V3H5Z" fill="#e0b080" />
          </svg>
        </span>
      </div>
      <span class="bar-num">{{ food ?? '?' }}/20</span>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  health: { type: Number, default: null },
  food: { type: Number, default: null },
});

// 第 i 颗心（i=1..10）应填充百分比：
//   2*(i-1) >= hp => 0%
//   2*i <= hp => 100%
//   否则 50%（半颗）
function heartFill(i) {
  const hp = props.health ?? 0;
  if (2 * i <= hp) return 100;
  if (2 * (i - 1) >= hp) return 0;
  return 50;
}

function foodFill(i) {
  const fd = props.food ?? 0;
  // 鸡腿条整体反向：第 1 个图标实际是"最右侧最先掉"的那个
  // 但我们用 row-reverse + 内部 i=1 在最右，所以 i 与 hp 同向直接算
  if (2 * i <= fd) return 100;
  if (2 * (i - 1) >= fd) return 0;
  return 50;
}
</script>

<style scoped>
.mc-bars {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 14px;
  background: #0c0e08;
  border-bottom: 1px solid #20241a;
}
.mc-bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mc-font-mono);
}
.bar-label {
  font-size: 10px;
  font-weight: 700;
  color: #7e836e;
  width: 18px;
  text-align: center;
  letter-spacing: 0.3px;
}
.bar-num {
  font-size: 11px;
  color: #cdd2c0;
  min-width: 38px;
  text-align: right;
}
.icons {
  display: flex;
  gap: 1px;
  flex: 1;
}
.icons.reverse {
  flex-direction: row-reverse;
  justify-content: flex-end;
}
.ic {
  position: relative;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}
.ic-base, .ic-fill {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  shape-rendering: crispEdges;
}
.ic-fill {
  transition: clip-path 0.18s ease-out;
}
</style>
