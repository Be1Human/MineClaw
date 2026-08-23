<!--
  SkinEditor · FEAT-WEBUI-11
  64×64 皮肤编辑器：画笔/填充/吸色/橡皮 + 调色板 + 撤销 + 上传 + Mojang 取，
  右侧内嵌 McCharacter 实时 3D 预览。保存 emit('save',{skinTexture,skinModel})。
-->
<template>
  <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:flex-start;">
    <!-- 左：画布 + 工具 -->
    <div style="display:flex; flex-direction:column; gap:10px;">
      <!-- 预设选择器 -->
      <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
        <span style="font-size:11px; color:#7e836e; font-weight:700;">预设</span>
        <span v-for="p in presets" :key="p.url" @click="usePreset(p)" :title="p.name"
          style="cursor:pointer; line-height:0; border:2px solid #0c0e08; box-shadow:inset 1px 1px 0 rgba(0,0,0,0.5);"
          @mouseenter="(e)=>e.currentTarget.style.borderColor='#cfeeb0'" @mouseleave="(e)=>e.currentTarget.style.borderColor='#0c0e08'">
          <McHead :texture="p.url" :size="30" />
        </span>
      </div>
      <!-- 工具条 -->
      <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
        <button v-for="t in toolList" :key="t.id" @click="tool = t.id" :title="t.name"
          :style="toolBtnStyle(t.id)">{{ t.icon }}</button>
        <span style="width:1px; height:22px; background:#0c0e08; margin:0 2px;"></span>
        <button @click="undo" :disabled="!history.length" title="撤销" :style="toolBtnStyle('_undo')">↶</button>
        <input type="color" v-model="color" title="颜色"
          style="width:34px; height:30px; padding:0; border:2px solid #0c0e08; background:#0c0e08; cursor:pointer;" />
      </div>
      <!-- 调色板 -->
      <div style="display:flex; gap:4px; flex-wrap:wrap; max-width:330px;">
        <span v-for="(c, i) in palette" :key="i" @click="color = c"
          :style="{ width:'18px', height:'18px', background:c, border:'2px solid '+(color===c?'#cfeeb0':'#0c0e08'), cursor:'pointer' }"></span>
      </div>
      <!-- 编辑画布 -->
      <canvas ref="disp" :width="64*zoom" :height="64*zoom"
        style="image-rendering:pixelated; background:repeating-conic-gradient(#1a1d12 0% 25%,#22271a 0% 50%) 0 0/16px 16px; border:2px solid #0c0e08; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); cursor:crosshair; touch-action:none;"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp"></canvas>
      <!-- Mojang 取：内联输入 + 拉取 -->
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
        <span style="font-size:11px; color:#7e836e; font-weight:700;">Mojang</span>
        <input v-model="mojangName" @keydown.enter="fromMojang()" placeholder="正版玩家用户名"
          style="width:150px; padding:7px 9px; background:#0c0e08; border:2px solid #000; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); color:#e7e3d4; font-family:var(--mc-font-body); font-size:12.5px;" />
        <button @click="fromMojang()" :disabled="mojangLoading" :style="fileBtnStyle">{{ mojangLoading ? '拉取中…' : '拉取' }}</button>
        <span style="width:1px; height:22px; background:#0c0e08; margin:0 2px;"></span>
        <button @click="openSite('https://namemc.com/minecraft-skins')" :style="linkBtnStyle" title="NameMC · 找用户名 / 浏览热门皮肤">找用户名 ↗</button>
        <button @click="openSite('https://www.minecraftskins.com')" :style="linkBtnStyle" title="皮肤站 · 下载 PNG 再用上传">下载皮肤 ↗</button>
      </div>
      <!-- 最近用户名 -->
      <div v-if="recentNames.length" style="display:flex; gap:4px; flex-wrap:wrap;">
        <span v-for="n in recentNames" :key="n" @click="fromMojang(n)" :title="'拉取 '+n"
          style="cursor:pointer; padding:3px 8px; background:#20241a; border:2px solid #0d0f0a; color:#9aa08c; font-size:11.5px;">{{ n }}</span>
      </div>

      <!-- 来源 + 体型 + 保存 -->
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <label :style="fileBtnStyle">上传PNG
          <input type="file" accept="image/png" @change="onUpload" style="display:none;" />
        </label>
        <div style="display:flex; gap:4px;">
          <button @click="model='classic'" :style="modelBtnStyle('classic')">经典</button>
          <button @click="model='slim'" :style="modelBtnStyle('slim')">纤细</button>
        </div>
        <button @click="save" :style="saveBtnStyle">保存</button>
      </div>
      <div v-if="hint" style="font-size:12px; color:#e6c98a;">{{ hint }}</div>
    </div>

    <!-- 右：实时 3D 预览 -->
    <div style="width:200px; height:300px; flex:none; background:#0c0e08; border:2px solid #0c0e08; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5);">
      <McCharacter :texture="previewUrl" :model="model" animation="idle" :autoRotate="false" />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import { loadSkinToCanvas, inferModelType } from 'skinview-utils';
import McCharacter from './McCharacter.vue';
import defaultSkin from '../assets/default-skin.png';

const props = defineProps({
  texture: { type: String, default: '' },
  initModel: { type: String, default: 'classic' },
});
const emit = defineEmits(['save']);

const zoom = 7;
const disp = ref(null);
const tool = ref('pen');
const color = ref('#5d9c3c');
const model = ref(props.initModel === 'slim' ? 'slim' : 'classic');
const previewUrl = ref('');
const hint = ref('');
const history = ref([]); // ImageData 快照栈

const toolList = [
  { id: 'pen', name: '画笔', icon: '✎' },
  { id: 'fill', name: '填充', icon: '▣' },
  { id: 'pick', name: '吸色', icon: '⊙' },
  { id: 'erase', name: '橡皮', icon: '⌫' },
];
const palette = ['#e2b48c','#4a3426','#5c9c3c','#3c4870','#3a322e','#d8503c','#e0a52f','#7cc24e',
  '#ffffff','#000000','#8a8a8a','#cdd2c0','#5b8cff','#22c55e','#a07e62','#5b5560'];

// 原创预设皮肤（自带·可直接套用）
const presetMods = import.meta.glob('../assets/skins/*.png', { eager: true, query: '?url', import: 'default' });
const presetNames = { '01-forest': '森林冒险', '02-ocean': '海蓝旅者', '03-ember': '烈焰战士', '04-ninja': '暗夜忍者', '05-knight': '黄金骑士', '06-sakura': '粉樱少女' };
const presets = Object.entries(presetMods)
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([path, url]) => {
    const key = path.split('/').pop().replace('.png', '');
    return { url, name: presetNames[key] || key };
  });

function usePreset(p) {
  model.value = 'classic';
  hint.value = '已载入预设：' + p.name + '（记得保存）';
  loadInto(p.url);
}

// 用系统浏览器打开皮肤站（Electron 走 shell.openExternal，浏览器 fallback window.open）
function openSite(url) {
  if (typeof window !== 'undefined' && window.electronAPI?.openExternal) window.electronAPI.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

// 64×64 离屏纹理画布（真相源）
let tex, tctx;

function toolBtnStyle(id) {
  const on = tool.value === id;
  return `width:30px;height:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;background:${on?'#4c7a2a':'#272d1d'};border:2px solid ${on?'#2b5e16':'#0d0f0a'};box-shadow:inset 1px 1px 0 rgba(255,255,255,0.1);color:${on?'#fff':'#cdd2c0'};font-size:14px;`;
}
const fileBtnStyle = 'padding:7px 11px;cursor:pointer;background:#272d1d;border:2px solid #0d0f0a;box-shadow:inset 1px 1px 0 rgba(255,255,255,0.06);color:#cdd2c0;font-weight:700;font-size:12.5px;';
const linkBtnStyle = 'padding:7px 11px;cursor:pointer;background:#1c2414;border:2px solid #0d0f0a;box-shadow:inset 1px 1px 0 rgba(255,255,255,0.05);color:#9fe27a;font-weight:700;font-size:12.5px;';
function modelBtnStyle(m) {
  const on = model.value === m;
  return `padding:7px 11px;cursor:pointer;background:${on?'#4c7a2a':'#20241a'};border:2px solid ${on?'#2b5e16':'#0d0f0a'};color:${on?'#fff':'#9aa08c'};font-weight:700;font-size:12.5px;`;
}
const saveBtnStyle = 'padding:7px 16px;cursor:pointer;background:#4c9a2a;border:2px solid #2b5e16;box-shadow:inset 1px 1px 0 rgba(255,255,255,0.28), inset -2px -2px 0 rgba(0,0,0,0.3), 0 3px 0 #214b13;color:#fff;font-weight:700;font-size:12.5px;text-shadow:1px 1px 0 rgba(0,0,0,0.4);';

function hex(r, g, b) { return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''); }
function parseHex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function render() {
  const ctx = disp.value.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 64 * zoom, 64 * zoom);
  ctx.drawImage(tex, 0, 0, 64 * zoom, 64 * zoom);
  // 像素网格
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 64; i += 1) {
    const p = i * zoom + 0.5;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 64 * zoom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(64 * zoom, p); ctx.stroke();
  }
  previewUrl.value = tex.toDataURL('image/png');
}

function snapshot() {
  history.value.push(tctx.getImageData(0, 0, 64, 64));
  if (history.value.length > 24) history.value.shift();
}
function undo() {
  const last = history.value.pop();
  if (last) { tctx.putImageData(last, 0, 0); render(); }
}

function texelAt(ev) {
  const r = disp.value.getBoundingClientRect();
  const x = Math.floor((ev.clientX - r.left) / r.width * 64);
  const y = Math.floor((ev.clientY - r.top) / r.height * 64);
  if (x < 0 || y < 0 || x > 63 || y > 63) return null;
  return { x, y };
}

function paint(x, y) {
  if (tool.value === 'erase') { tctx.clearRect(x, y, 1, 1); return; }
  const [r, g, b] = parseHex(color.value);
  tctx.fillStyle = `rgba(${r},${g},${b},1)`;
  tctx.clearRect(x, y, 1, 1);
  tctx.fillRect(x, y, 1, 1);
}

function floodFill(x, y) {
  const img = tctx.getImageData(0, 0, 64, 64);
  const d = img.data;
  const idx = (px, py) => (py * 64 + px) * 4;
  const t = idx(x, y);
  const target = [d[t], d[t + 1], d[t + 2], d[t + 3]];
  const [r, g, b] = parseHex(color.value);
  const repl = [r, g, b, 255];
  if (target[0] === repl[0] && target[1] === repl[1] && target[2] === repl[2] && target[3] === repl[3]) return;
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cy < 0 || cx > 63 || cy > 63) continue;
    const o = idx(cx, cy);
    if (d[o] !== target[0] || d[o + 1] !== target[1] || d[o + 2] !== target[2] || d[o + 3] !== target[3]) continue;
    d[o] = repl[0]; d[o + 1] = repl[1]; d[o + 2] = repl[2]; d[o + 3] = repl[3];
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  tctx.putImageData(img, 0, 0);
}

function pick(x, y) {
  const p = tctx.getImageData(x, y, 1, 1).data;
  if (p[3] > 0) color.value = hex(p[0], p[1], p[2]);
}

let drawing = false;
function onDown(ev) {
  const t = texelAt(ev); if (!t) return;
  if (tool.value === 'pick') { pick(t.x, t.y); return; }
  snapshot();
  if (tool.value === 'fill') { floodFill(t.x, t.y); render(); return; }
  drawing = true; paint(t.x, t.y); render();
}
function onMove(ev) {
  if (!drawing) return;
  const t = texelAt(ev); if (!t) return;
  paint(t.x, t.y); render();
}
function onUp() { drawing = false; }

function loadInto(url, inferM = false) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      // 标准规范化：旧版 64×32 自动补全为 64×64、统一尺寸（根治背部/四肢发黑+错位）
      loadSkinToCanvas(tex, img);
      if (inferM) model.value = inferModelType(tex) === 'slim' ? 'slim' : 'classic';
    } catch {
      tctx.clearRect(0, 0, 64, 64);
      tctx.drawImage(img, 0, 0, 64, 64);
    }
    tctx.imageSmoothingEnabled = false; // canvas 尺寸可能被重置，重新关插值
    history.value = [];
    render();
  };
  img.onerror = () => { hint.value = '皮肤加载失败，已用默认皮肤'; img.src = defaultSkin; };
  img.src = url || defaultSkin;
}

function onUpload(ev) {
  const f = ev.target.files?.[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { hint.value = '已载入上传皮肤（记得保存）'; loadInto(String(reader.result), true); };
  reader.readAsDataURL(f);
}

const mojangName = ref('');
const mojangLoading = ref(false);
const recentNames = ref([]);
try { recentNames.value = JSON.parse(localStorage.getItem('mc.mojangNames') || '[]'); } catch { /* ignore */ }

function rememberName(name) {
  const list = [name, ...recentNames.value.filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, 8);
  recentNames.value = list;
  try { localStorage.setItem('mc.mojangNames', JSON.stringify(list)); } catch { /* ignore */ }
}

async function fromMojang(nameArg) {
  const name = String(nameArg ?? mojangName.value).trim();
  if (!name) { hint.value = '先输入正版玩家用户名'; return; }
  mojangLoading.value = true;
  hint.value = `从 Mojang 拉取 ${name} …`;
  try {
    const r = await fetch(`/api/skin/mojang?name=${encodeURIComponent(name)}`);
    if (!r.ok) { hint.value = `没找到玩家「${name}」或其皮肤`; return; }
    const { skinUrl, skinDataUrl, model: m } = await r.json();
    model.value = m === 'slim' ? 'slim' : 'classic';
    rememberName(name);
    mojangName.value = name;
    hint.value = `已拉取 ${name} 的皮肤（记得保存）`;
    loadInto(skinDataUrl || skinUrl);
  } catch {
    hint.value = 'Mojang 拉取失败（检查网络）';
  } finally {
    mojangLoading.value = false;
  }
}

function save() {
  emit('save', { skinTexture: tex.toDataURL('image/png'), skinModel: model.value });
  hint.value = '已保存 ✓';
}

onMounted(() => {
  tex = document.createElement('canvas');
  tex.width = 64; tex.height = 64;
  tctx = tex.getContext('2d');
  tctx.imageSmoothingEnabled = false;
  loadInto(props.texture);
});

watch(() => props.texture, (v) => loadInto(v));
</script>
