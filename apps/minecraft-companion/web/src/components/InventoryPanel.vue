<!--
  InventoryPanel · FEAT-WEBUI-02 背包/物品展示
  数据源：worldState.inventory（bot:v2:worldState 推送）
    inventory = { items:[{name,count,slot,durability?,maxDurability?}], held, freeSlots }
  物品贴图：浏览器直连第三方 CDN（链接·非打包 Mojang 素材）。
    名字归一化 → 依次试 items/ → blocks/ 多候选 → 全失败降级为「分类配色方块+缩写」（永不破图/空白）。
-->
<template>
  <section class="inv-panel mc-panel" aria-labelledby="inventory-title">
    <header class="inv-head">
      <span id="inventory-title" class="inv-title"><McIcon name="backpack" :size="16" /> 背包</span>
      <span v-if="inv" class="inv-meta">{{ inv.items?.length || 0 }} 占用 · {{ inv.freeSlots ?? '?' }} 空格</span>
      <span v-else class="inv-meta">等待数据</span>
    </header>
    <div v-if="!inv" class="inv-empty mc-empty-state">
      <McIcon name="backpack" :size="26" />
      <h3>暂无背包数据</h3>
      <p>伙伴进入游戏并完成首次感知后，这里会显示手持物和物品格。</p>
    </div>
    <template v-else>
      <!-- 手持 -->
      <div class="inv-held" v-if="heldName">
        <span class="held-label">手持</span>
        <div class="inv-slot held">
          <img
            v-if="iconState(heldName).src"
            :src="iconState(heldName).src"
            class="slot-icon"
            @error="onIconError(heldName)"
            alt=""
          />
          <span v-else class="slot-fallback" :style="{ background: catColor(heldName) }">{{ shortName(heldName) }}</span>
          <span class="slot-name-tip">{{ cleanName(heldName) }}</span>
        </div>
      </div>

      <!-- 物品格子 -->
      <div class="inv-grid">
        <div
          v-for="(it, i) in inv.items"
          :key="it.slot ?? i"
          class="inv-slot"
          :class="{ active: heldName && it.name === heldName }"
          :title="cleanName(it.name) + (it.durability != null ? `  耐久 ${it.durability}/${it.maxDurability}` : '')"
        >
          <img
            v-if="iconState(it.name).src"
            :src="iconState(it.name).src"
            class="slot-icon"
            @error="onIconError(it.name)"
            alt=""
          />
          <span v-else class="slot-fallback" :style="{ background: catColor(it.name) }">{{ shortName(it.name) }}</span>
          <span class="slot-count" v-if="it.count > 1">{{ it.count }}</span>
          <span
            class="slot-dura"
            v-if="it.durability != null && it.maxDurability"
            :style="{ width: (100 * it.durability / it.maxDurability) + '%' }"
          ></span>
        </div>
        <div v-if="!inv.items || inv.items.length === 0" class="inv-empty mc-empty-state">
          <h3>背包是空的</h3>
          <p>获得物品后会自动出现在这里。</p>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, reactive } from 'vue';
import McIcon from './icons/McIcon.vue';

const props = defineProps({
  worldState: { type: Object, default: null },
});

// 图标走后端代理 + 磁盘缓存：客户端只访问同源 localhost（秒开·缓存后离线·绕开 CDN 抽风/CORS）。
// 后端 /api/icon/:name 内部从 jsDelivr 镜像取 item→block 并缓存；这里单候选，取不到 → 分类降级。
function candidates(name) {
  return [`/api/icon/${cleanName(name)}`];
}

const inv = computed(() => props.worldState?.inventory ?? null);
const heldName = computed(() => {
  const h = inv.value?.held;
  if (!h) return null;
  return typeof h === 'string' ? h : h.name;
});

// 每个物品名维护一个候选索引（reactive）。src 为空 = 候选用尽 → 走分类降级。
const iconIdx = reactive(new Map());
function iconState(name) {
  const cs = candidates(name);
  const idx = iconIdx.get(name) ?? 0;
  return { src: idx < cs.length ? cs[idx] : null };
}
function onIconError(name) {
  iconIdx.set(name, (iconIdx.get(name) ?? 0) + 1); // 试下一个候选；用尽后 iconState.src=null → 降级
}

function cleanName(name) {
  return (name || '').replace('minecraft:', '').trim().toLowerCase();
}
function shortName(name) {
  const n = cleanName(name);
  const parts = n.split('_');
  return parts.length > 1 ? parts.slice(-2).join(' ') : n;
}

// 降级方块的分类配色（命中不了图标时也一眼能分辨大类）
function catColor(name) {
  const n = cleanName(name);
  if (/(log|plank|wood|stick|fence|door|sapling)/.test(n)) return '#7b5a3a';
  if (/(diamond)/.test(n)) return '#3fc7c2';
  if (/(gold)/.test(n)) return '#e0a52f';
  if (/(iron)/.test(n)) return '#c8c8d0';
  if (/(coal|charcoal)/.test(n)) return '#3a3a3e';
  if (/(emerald)/.test(n)) return '#2ea043';
  if (/(redstone|ruby)/.test(n)) return '#c0392b';
  if (/(lapis)/.test(n)) return '#2b5e9c';
  if (/(deepslate|stone|cobble|rock|ore|gravel|andesite|granite|diorite)/.test(n)) return '#7e836e';
  if (/(dirt|grass|mud|clay)/.test(n)) return '#6b5a3a';
  if (/(sand)/.test(n)) return '#d8c98a';
  if (/(water|ice|prismarine)/.test(n)) return '#3b82c4';
  if (/(lava|fire|blaze|magma)/.test(n)) return '#d8503c';
  if (/(wool|wheat|hay|bread|carrot|potato|seed|crop)/.test(n)) return '#c7a13c';
  if (/(meat|beef|pork|chicken|fish|cod|salmon|apple|berry)/.test(n)) return '#b9603f';
  return '#5d7a3c';
}
</script>

<style scoped>
.inv-panel { min-height: 300px; display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.inv-empty { flex: 1; gap: 5px; margin: 12px; color: var(--mc-text-muted); }
.inv-empty h3 { margin: 4px 0 0; color: var(--mc-text-secondary); font-size: 14px; }
.inv-empty p { max-width: 280px; margin: 0; font-size: 11px; }
.inv-head {
  display: flex; justify-content: space-between; align-items: center;
  flex: none; padding: 13px 14px; border-bottom: 1px solid var(--mc-border);
  background: var(--mc-surface); color: var(--mc-text); font-size: 13px; font-weight: 700;
}
.inv-title { display: inline-flex; align-items: center; gap: 6px; }
.inv-meta { color: var(--mc-text-muted); font-weight: 400; font-size: 11px; }
.inv-held { display: flex; align-items: center; gap: 8px; margin: 14px 14px 16px; }
.held-label { font-size: 11px; color: var(--mc-text-muted); }

.inv-grid {
  display: grid;
  grid-template-columns: repeat(9, 1fr);
  gap: 4px;
  padding: 0 14px 14px;
}
.inv-grid > .inv-empty { grid-column: 1 / -1; min-height: 180px; margin: 0; }
@media (max-width: 520px) { .inv-grid { grid-template-columns: repeat(6, 1fr); } }

.inv-slot {
  position: relative;
  aspect-ratio: 1 / 1;
  background: #8b8b8b;
  border: 2px solid;
  border-color: #373737 #fff #fff #373737; /* MC 凹槽风 */
  display: flex; align-items: center; justify-content: center;
  image-rendering: pixelated;
  overflow: hidden;
}
.inv-slot.active { box-shadow: 0 0 0 2px #ffd84d inset; }
.inv-slot.held { width: 44px; height: 44px; aspect-ratio: unset; }
.slot-icon { width: 86%; height: 86%; image-rendering: pixelated; }
.slot-fallback {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  font-size: 8.5px; line-height: 1.05; text-align: center;
  color: #fff; text-shadow: 1px 1px 0 rgba(0,0,0,0.5);
  padding: 1px; word-break: break-word;
  box-shadow: inset -3px -3px 0 rgba(0,0,0,0.25), inset 2px 2px 0 rgba(255,255,255,0.12);
}
.slot-count {
  position: absolute; right: 1px; bottom: 0;
  font-size: 11px; font-weight: 700; color: #fff;
  text-shadow: 1px 1px 0 #3f3f3f;
}
.slot-dura { position: absolute; left: 1px; bottom: 1px; height: 2px; background: #5c8a4f; }
.slot-name-tip { position: absolute; bottom: -14px; left: 0; font-size: 9px; color: var(--mc-text-muted); white-space: nowrap; }
</style>
