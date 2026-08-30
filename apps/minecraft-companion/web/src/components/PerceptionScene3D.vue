<template>
  <div class="perception-3d" ref="containerRef">
    <canvas ref="canvasRef"></canvas>

    <div v-if="worldMode === 'authentic'" class="world-mode-panel">
      <button v-if="showVisualRetry" class="resync-button" @click="emit('request-resync')">重试</button>
      <div class="world-mode-status" :class="visualStatusState" aria-live="polite">
        <div class="world-mode-status-copy">{{ visualStatusMessage }}</div>
        <div
          v-if="visualWorldStatus?.state === 'loading'"
          class="world-loading-progress"
          :class="{ indeterminate: !visualProgressDeterminate }"
          role="progressbar"
          :aria-label="visualStatusMessage"
          :aria-valuemin="visualProgressDeterminate ? 0 : undefined"
          :aria-valuemax="visualProgressDeterminate ? visualProgressTotal : undefined"
          :aria-valuenow="visualProgressDeterminate ? visualProgressCurrent : undefined"
        >
          <span :style="visualProgressDeterminate ? { width: `${visualProgressPercent}%` } : undefined"></span>
        </div>
      </div>
      <div v-if="diagnostics.length" class="world-mode-warning">
        缺失素材 {{ diagnostics.length }} 项，已使用紫黑占位
      </div>
    </div>

    <!-- HUD: 左上角 - 自身状态 -->
    <div class="hud hud-top-left" v-if="worldState && worldState.self">
      <div class="hud-title">BOT 状态</div>
      <div class="hud-row">
        <McIcon class="hud-icon health" name="health" :size="14" />
        <span class="hud-value">{{ worldState.self.health }}/{{ worldState.self.maxHealth }}</span>
        <div class="hud-bar">
          <div class="hud-bar-fill health" :style="{ width: (worldState.self.health / worldState.self.maxHealth * 100) + '%' }"></div>
        </div>
      </div>
      <div class="hud-row">
        <McIcon class="hud-icon food" name="food" :size="14" />
        <span class="hud-value">{{ worldState.self.food }}/20</span>
        <div class="hud-bar">
          <div class="hud-bar-fill food" :style="{ width: (worldState.self.food / 20 * 100) + '%' }"></div>
        </div>
      </div>
      <div class="hud-row">
        <span class="hud-label">POS</span>
        <span class="hud-value mono">{{ fmtPosPrecise(worldState.self.position) }}</span>
      </div>
      <div class="hud-row">
        <span class="hud-label">CELL</span>
        <span class="hud-value mono">{{ fmtCell(worldState.self.position) }}</span>
      </div>
      <div class="hud-row" v-if="nearestDoorInfo">
        <span class="hud-label" style="color:#fbbf24">门</span>
        <span class="hud-value mono">{{ nearestDoorInfo }}</span>
      </div>
      <div class="hud-row">
        <span class="hud-label">{{ worldState.environment.isDay ? 'DAY' : 'NIGHT' }}</span>
        <span class="hud-value">{{ worldState.environment.dimension }}</span>
        <span class="hud-value" v-if="worldState.environment.isRaining">RAIN</span>
      </div>
      <div class="hud-row" v-if="worldState.navigation && worldState.navigation.hasGoal">
        <span class="hud-label nav-label">NAV</span>
        <span class="hud-value nav-value" v-if="worldState.navigation.goalPosition">
          <McIcon name="goal" :size="12" /> {{ fmtPos(worldState.navigation.goalPosition) }}
        </span>
        <span class="hud-value nav-value" v-else>导航中...</span>
      </div>
      <div class="hud-row" v-if="worldState.navigation && worldState.navigation.plannedRoute">
        <span class="hud-label nav-label" :style="{ color: planColor }">PLAN</span>
        <span class="hud-value nav-value plan-rainbow" v-if="isGlobalPlan">
          <McIcon name="route" :size="12" /> {{ worldState.navigation.plannedRoute.mode }} ·
          {{ worldState.navigation.plannedRoute.points.length }} 点
        </span>
        <span class="hud-value nav-value" v-else :style="{ color: planColor }">
          {{ worldState.navigation.plannedRoute.mode }} ·
          {{ worldState.navigation.plannedRoute.points.length }} 点
        </span>
      </div>
      <div class="hud-row">
        <span class="hud-label">MAP</span>
        <span class="hud-value mono">{{ totalBlocks }} 方块</span>
      </div>
    </div>

    <!-- HUD: 右上角 - 感知统计 -->
    <div class="hud hud-top-right" v-if="worldState">
      <div class="hud-title">感知范围</div>
      <div class="hud-row">
        <span class="hud-label">实体</span>
        <span class="hud-value">{{ worldState.entities.length }}</span>
      </div>
      <div class="hud-row">
        <span class="hud-label">方块</span>
        <span class="hud-value">{{ worldState.blocks.length }}</span>
      </div>
      <div class="hud-row">
        <span class="hud-label">威胁</span>
        <span class="hud-value threat">{{ worldState.threats.length }}</span>
      </div>
      <div class="hud-row">
        <span class="hud-label">快照</span>
        <span class="hud-value mono">{{ fmtTime(worldState.timestamp) }}</span>
      </div>
    </div>

    <!-- HUD: 左下角 - 威胁警报 -->
    <div class="hud hud-bottom-left" v-if="worldState && worldState.threats.length > 0">
      <div class="hud-title threat-title"><McIcon name="warning" :size="12" /> 威胁警报</div>
      <div v-for="(t, i) in worldState.threats.slice(0, 5)" :key="i"
           class="threat-item" :class="'severity-' + t.severity">
        <span class="threat-severity">{{ t.severity.toUpperCase() }}</span>
        <span class="threat-desc">{{ t.description }}</span>
      </div>
    </div>

    <!-- 无数据状态 -->
    <div class="no-data-overlay" v-if="!worldState">
      <McIcon class="no-data-icon" name="eye" :size="56" />
      <div class="no-data-text">等待感知数据...</div>
      <div class="no-data-hint">Bot 上线后将实时渲染三维感知空间</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PlayerObject } from 'skinview3d';
import { chunkKeyOf, blockKey as bkey, takeDirtyChunks, selectEvictions } from '../lib/chunkGrid.js';
import { mineflayerYawBasis, mineflayerYawToThreeRotation } from '../lib/minecraftOrientation.js';
import defaultSkin from '../assets/skins/07-lanyi.png';
import McIcon from './icons/McIcon.vue';
import { PerceptionRendererRegistry } from '../lib/authentic/rendererRegistry.js';
import { AuthenticWorldRenderer } from '../lib/authentic/AuthenticWorldRenderer.js';
import { ResourcePackClient } from '../lib/authentic/resourcePackClient.js';
import { isCompatibleMinecraftVersion, selectBuiltinResourcePack } from '../lib/authentic/resourcePackSelection.js';

const props = defineProps({
  worldState: { type: Object, default: null },
  skinTexture: { type: String, default: '' },
  skinModel: { type: String, default: 'slim' },
  followBot: { type: Boolean, default: true },
  worldMode: { type: String, default: 'simple' },
  visualWorldStore: { type: Object, default: null },
  visualWorldRevision: { type: Number, default: 0 },
  visualWorldStatus: { type: Object, default: () => ({ state: 'idle', message: '' }) },
  visualWorldConfig: { type: Object, default: null },
});
const emit = defineEmits(['update:followBot', 'request-resync', 'visual-render-progress']);

const containerRef = ref(null);
const canvasRef = ref(null);
const totalBlocks = ref(0);
const builtinResourcePack = ref(null);
const packError = ref('');
const modeError = ref('');
const diagnostics = ref([]);
const packClient = new ResourcePackClient();
const visualStatusState = computed(() => modeError.value || packError.value ? 'error' : props.visualWorldStatus?.state ?? 'idle');
const visualStatusMessage = computed(() => modeError.value || packError.value || props.visualWorldStatus?.message || '等待真实世界数据');
const showVisualRetry = computed(() => Boolean(modeError.value || packError.value || props.visualWorldStatus?.state === 'error'));
const visualProgressTotal = computed(() => Math.max(0, Number(props.visualWorldStatus?.total) || 0));
const visualProgressCurrent = computed(() => Math.min(visualProgressTotal.value, Math.max(0, Number(props.visualWorldStatus?.current) || 0)));
const visualProgressDeterminate = computed(() => visualProgressTotal.value > 0);
const visualProgressPercent = computed(() => visualProgressDeterminate.value
  ? Math.round(visualProgressCurrent.value / visualProgressTotal.value * 100)
  : 0);

const isGlobalPlan = computed(() => {
  const m = props.worldState?.navigation?.plannedRoute?.mode;
  return !!(m && m.startsWith('global_'));
});
const planColor = computed(() => {
  const m = props.worldState?.navigation?.plannedRoute?.mode;
  if (!m) return '#a78bfa';
  if (m.startsWith('global_')) return '#ff5f6d';
  if (m === 'local_only') return '#00e5ff';
  if (m === 'local_voxel_then_pf') return '#a78bfa';
  return '#a78bfa';
});

let renderer, scene, camera, controls;
let worldRendererRegistry = null;
let authenticWorldRenderer = null;
let animFrameId = null;
let _lastFrameTs = 0;
// 相机旋转的流畅度对帧率高度敏感：30fps 平移/转视角天生显顿。
// 实测渲染极轻（JS ~95% idle）、GPU 充裕，故放到 60fps 让旋转跟手。
const TARGET_FPS = 60;
const _frameMinMs = 1000 / TARGET_FPS;

let entityMeshes = new Map();
let botMesh = null;
let botPlayer = null;
let botSkinTexture = null;
let botSkinLoadVersion = 0;
let botDirectionMesh = null;
let threatRings = [];

// ── FEAT-WEBUI-07 · 渲染调参集中 ──
const RENDER_TUNING = {
  CHUNK_SIZE: 16,                   // XZ 平面 chunk 边长
  MAX_CHUNK_REBUILDS_PER_FRAME: 4,  // 每帧最多重建的脏 chunk 数（防首载同帧重建全部卡死）
  OCCLUDE_CYLINDER_RADIUS: 0.9,     // 相机→bot 遮挡圆柱半径
  OCCLUDE_DITHER_KEEP: 0.35,        // 遮挡区 dither 保留比例
  // 已探索方块持久化保留：不按数量淘汰，只有 Bot 紧贴范围内确认变 air 时才清除
  PRUNE_RADIUS_XZ: 2,
  PRUNE_RADIUS_Y: 2,
  // BUG-WEBUI-04 · 防 worldBlockMap 无限累积致开局/越玩越卡：
  // 超出 EVICT 半径的远块淘汰；总量再设硬上限（兜底），超了从最远开始砍。
  EVICT_RADIUS_XZ: 56,   // 距 bot 水平超过此值的块淘汰（chunk 边 16，约 ±3.5 chunk）
  EVICT_RADIUS_Y: 40,    // 垂直淘汰半径
  MAX_BLOCKS: 8000,      // 渲染方块总量硬上限（兜底，防极端）
};

let worldBlockMap = new Map();   // bkey → block · 全局索引（HUD 计数 / prune / 持久化）
let chunkIndex = new Map();      // chunkKey → Set<bkey> · chunk 成员索引
let chunkMeshes = new Map();     // chunkKey → InstancedMesh[] · 每 chunk 独立 mesh 组
let dirtyChunks = new Set();     // 待重建 chunk · 方块变化只标脏所在 chunk
const STORAGE_KEY = 'perception3d_worldBlocks';
let blockMeshGroup = null;

// 共享几何/材质：chunk 重建只换自己的 InstancedMesh，几何与材质全场景复用、从不随重建销毁
const sharedBoxGeom = new THREE.BoxGeometry(1, 1, 1);
// 比固体块明显瘦小，让人一眼看出是"占位但可穿过"
const sharedPassableGeom = new THREE.BoxGeometry(0.45, 0.95, 0.45);
const materialCache = new Map(); // `${color}_${category}` → Material

// GPU 遮挡（设计文档 §2.3）：遮挡判断在 fragment shader 里做，
// 所有方块材质共享同一组 uniform —— 相机/bot 移动只更新 uniform 值，零 CPU 重建。
const occlusionUniforms = {
  uCamPos: { value: new THREE.Vector3() },
  uBotPos: { value: new THREE.Vector3() },
  uCylR2: { value: RENDER_TUNING.OCCLUDE_CYLINDER_RADIUS ** 2 },
  uDitherKeep: { value: RENDER_TUNING.OCCLUDE_DITHER_KEEP },
  // bot 模型全高（脚→头顶约 1.85，取 1.9 留余量）· 遮挡覆盖全身用
  uBotHeight: { value: 1.9 },
};

function injectOcclusion(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCamPos = occlusionUniforms.uCamPos;
    shader.uniforms.uBotPos = occlusionUniforms.uBotPos;
    shader.uniforms.uCylR2 = occlusionUniforms.uCylR2;
    shader.uniforms.uDitherKeep = occlusionUniforms.uDitherKeep;
    shader.uniforms.uBotHeight = occlusionUniforms.uBotHeight;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vOcclWorldPos;`
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
         vec4 _occlWp = vec4(transformed, 1.0);
         #ifdef USE_INSTANCING
           _occlWp = instanceMatrix * _occlWp;
         #endif
         vOcclWorldPos = (modelMatrix * _occlWp).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <clipping_planes_pars_fragment>',
        `#include <clipping_planes_pars_fragment>
         uniform vec3 uCamPos;
         uniform vec3 uBotPos;
         uniform float uCylR2;
         uniform float uDitherKeep;
         uniform float uBotHeight;
         varying vec3 vOcclWorldPos;
         float bayer4x4(vec2 p) {
           int x = int(mod(p.x, 4.0));
           int y = int(mod(p.y, 4.0));
           int idx = x + y * 4;
           float m[16];
           m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
           m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
           m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
           m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
           return m[idx] / 16.0;
         }`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         {
           // 遮挡锚从「bot 脚底单点」改为「按方块高度取 bot 身体竖直线段(脚→头)对应点」，
           // 覆盖 bot 全身高度，不再只半透下半身前的墙。水平半径 uCylR2 不变。
           float _ay = clamp(vOcclWorldPos.y, uBotPos.y, uBotPos.y + uBotHeight);
           vec3 _anchor = vec3(uBotPos.x, _ay, uBotPos.z);
           vec3 _axis = uCamPos - _anchor;
           float _len = length(_axis);
           if (_len > 0.0001) {
             vec3 _dir = _axis / _len;
             vec3 _rel = vOcclWorldPos - _anchor;
             float _proj = dot(_rel, _dir);
             if (_proj > 0.5 && _proj < _len - 0.5) {
               vec3 _perp = _rel - _dir * _proj;
               if (dot(_perp, _perp) < uCylR2 && bayer4x4(gl_FragCoord.xy) > uDitherKeep) discard;
             }
           }
         }`
      );
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'occl_dither_v3';
  return mat;
}

function getBlockMaterial(color, category) {
  const key = color + '_' + category;
  let mat = materialCache.get(key);
  if (mat) return mat;

  const isSpecial = category === 'hazard' || category === 'resource' || category === 'interactive';
  const isLiquid = category === 'liquid';
  if (category === 'passable') {
    // 可穿过的占位方块（门/活板门/栅栏门/地毯/告示牌/torch/植被等）：
    // 半透明 + 缩小，与固体块视觉区分，便于一眼判断 A* 是否真的把它当墙
    mat = new THREE.MeshPhongMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.25,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      flatShading: true,
    });
  } else {
    mat = new THREE.MeshPhongMaterial({
      color,
      emissive: isSpecial ? color : 0x000000,
      emissiveIntensity: isSpecial ? 0.35 : 0,
      transparent: isLiquid || isSpecial,
      opacity: isLiquid ? 0.45 : (isSpecial ? 0.9 : 1.0),
      flatShading: true,
    });
  }
  injectOcclusion(mat);
  materialCache.set(key, mat);
  return mat;
}

let navPathLine = null;
let navGoalMarker = null;
let plannedRouteLine = null;
let _lastNavKey = '';   // cache nav state → skip TubeGeometry rebuild when path unchanged

let botWorldPos = new THREE.Vector3(0, 0, 0);
let firstUpdate = true;

const BLOCK_COLORS = {
  grass_block: 0x4a8c3f, short_grass: 0x5a9e4f, tall_grass: 0x5a9e4f,
  stone: 0x7a7a7a, cobblestone: 0x6b6b6b, andesite: 0x858585, diorite: 0xc0c0c0, granite: 0x9a6b4a,
  dirt: 0x8b6c42, coarse_dirt: 0x7a5c32, rooted_dirt: 0x8b6040,
  oak_log: 0x6b4226, spruce_log: 0x4a3520, birch_log: 0xc4b89a, jungle_log: 0x6a5020, acacia_log: 0x6a4030, dark_oak_log: 0x3a2510,
  oak_leaves: 0x2d6e1e, spruce_leaves: 0x1e4a1e, birch_leaves: 0x4a8e3f, jungle_leaves: 0x2a7a1a,
  oak_planks: 0xb08850, spruce_planks: 0x6a4a2a, birch_planks: 0xc4b480,
  water: 0x2196f3, lava: 0xff5722,
  sand: 0xdec98b, gravel: 0x838383, clay: 0x9ea5ad,
  iron_ore: 0xd4a574, coal_ore: 0x3a3a3a, gold_ore: 0xffd700, diamond_ore: 0x4af5ff, copper_ore: 0xc07040, lapis_ore: 0x2244aa,
  deepslate_iron_ore: 0xb48a5a, deepslate_coal_ore: 0x2a2a2a, deepslate_gold_ore: 0xddbb00, deepslate_diamond_ore: 0x3ad5dd,
  deepslate: 0x4a4a4a, cobbled_deepslate: 0x424242, bedrock: 0x333333,
  glass: 0xaaddff, glass_pane: 0xaaddff,
  chest: 0xb08030, crafting_table: 0x8a6030, furnace: 0x888888, enchanting_table: 0x6a2a2a,
  torch: 0xffcc00, lantern: 0xffaa00,
  fire: 0xff4400, cactus: 0x2a8a2a, magma_block: 0xcc4400,
};

const CATEGORY_COLORS = {
  solid: 0x484f58, liquid: 0x2196f3, hazard: 0xda3633, resource: 0x238636, interactive: 0xd29922,
};

const ENTITY_COLORS = {
  hostile: 0xf85149, passive: 0x3fb950, player: 0xe6edf3,
  item: 0xd29922, neutral: 0x8b949e, other: 0x8b949e,
};

const THREAT_SEVERITY_COLORS = {
  critical: 0xff0000, high: 0xff4444, medium: 0xff8800, low: 0xffcc00,
};

function getBlockColor(block) {
  return BLOCK_COLORS[block.name] ?? CATEGORY_COLORS[block.category] ?? 0x484f58;
}

async function ensureBuiltinResourcePack() {
  const gameVersion = props.visualWorldStore?.gameVersion ?? '';
  const current = builtinResourcePack.value;
  if (current && isCompatibleMinecraftVersion(current.minecraftVersion, gameVersion)) return current;
  try {
    const packs = await packClient.list();
    const next = selectBuiltinResourcePack(packs, { gameVersion });
    if (!next) throw new Error(gameVersion ? `未找到适用于 Minecraft ${gameVersion} 的内置真实资源` : '内置真实资源尚未就绪');
    if (next.id !== current?.id) {
      builtinResourcePack.value = next;
      packClient.select(next);
      authenticWorldRenderer?.setPack(next);
    }
    packError.value = '';
    return next;
  } catch (error) {
    packError.value = error.message;
    throw error;
  }
}

function recordAuthenticDiagnostic(entry) {
  diagnostics.value.push({ ...entry, at: Date.now() });
  if (diagnostics.value.length > 20) diagnostics.value.splice(0, diagnostics.value.length - 20);
}

async function activateWorldMode() {
  const registry = worldRendererRegistry;
  if (!registry) return;
  modeError.value = '';
  if (props.worldMode === 'simple') {
    await registry.activate('simple');
    return;
  }
  try {
    if (!props.visualWorldStore || props.visualWorldStore.status !== 'ready') {
      // Preparing/receiving is an expected loading phase, not an error. Keep
      // the simple terrain interactive until an atomic authentic frame exists.
      if (props.visualWorldStatus?.state === 'error') throw new Error(props.visualWorldStatus.message || '真实世界数据加载失败');
      await registry.activate('simple');
      return;
    }
    if (!props.visualWorldConfig) throw new Error('真实渲染配置尚未就绪');
    const pack = await ensureBuiltinResourcePack();
    if (worldRendererRegistry !== registry) return;
    authenticWorldRenderer?.setFocusPosition(botWorldPos);
    authenticWorldRenderer?.setStore(props.visualWorldStore);
    authenticWorldRenderer?.setPack(pack);
    await registry.activate('authentic');
  } catch (error) {
    modeError.value = `${error.message}；已保留简略版`;
    await worldRendererRegistry.activate('simple');
  }
}

function initScene() {
  const container = containerRef.value;
  const canvas = canvasRef.value;
  if (!container || !canvas) return;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25)); // 限像素比·高分屏大幅省 GPU
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0x0a0e14, 1);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0e14, 0.004);

  camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 1500);
  camera.position.set(18, 22, 18);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxDistance = 300;
  controls.minDistance = 3;
  controls.maxPolarAngle = Math.PI * 0.85;

  scene.add(new THREE.AmbientLight(0x556688, 0.8));
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.9);
  dir1.position.set(15, 30, 10);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0x4488cc, 0.3);
  dir2.position.set(-10, 10, -15);
  scene.add(dir2);
  scene.add(new THREE.HemisphereLight(0x88aacc, 0x443322, 0.4));

  blockMeshGroup = new THREE.Group();
  scene.add(blockMeshGroup);

  worldRendererRegistry = new PerceptionRendererRegistry({ scene, camera });
  worldRendererRegistry.register('simple', () => ({
    activate: () => { blockMeshGroup.visible = true; },
    deactivate: () => { blockMeshGroup.visible = false; },
  }));
  worldRendererRegistry.register('authentic', () => {
    if (!props.visualWorldConfig) throw new Error('真实渲染配置尚未就绪');
    authenticWorldRenderer = new AuthenticWorldRenderer({
      scene,
      config: props.visualWorldConfig,
      packClient,
      onDiagnostic: recordAuthenticDiagnostic,
      onProgress: progress => emit('visual-render-progress', progress),
    });
    authenticWorldRenderer.setFocusPosition(botWorldPos);
    authenticWorldRenderer.setStore(props.visualWorldStore);
    authenticWorldRenderer.setPack(builtinResourcePack.value);
    return authenticWorldRenderer;
  });
  void worldRendererRegistry.activate('simple');

  createBotMarker();
  animate();
}

function createBotMarker() {
  // ── Bot 自身：Profile 真实 MC 皮肤；纹理失败时回退唯一内置蓝衣 ──
  botMesh = new THREE.Group();

  botPlayer = new PlayerObject();
  botPlayer.name = 'botSkinPlayer';
  botPlayer.backEquipment = null;
  botPlayer.skin.visible = false;
  // skinview3d 使用像素单位且模型原点在身体中心附近；缩放并抬高到脚底 y=0。
  botPlayer.scale.setScalar(0.05);
  botPlayer.position.y = 0.8125;
  botMesh.add(botPlayer);
  loadBotSkin();

  // 脚底发光环（双层）
  const innerRing = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.6, 24),
    new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  );
  innerRing.rotation.x = -Math.PI / 2;
  innerRing.position.y = 0.02;
  botMesh.add(innerRing);

  const outerRing = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 1.1, 32),
    new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false }),
  );
  outerRing.rotation.x = -Math.PI / 2;
  outerRing.position.y = 0.02;
  outerRing.name = 'botOuterRing';
  botMesh.add(outerRing);

  scene.add(botMesh);

  // 朝向锥（保持原有，标示 bot 面朝方向）
  const dirGeom = new THREE.ConeGeometry(0.2, 2.5, 6);
  const dirMat = new THREE.MeshPhongMaterial({
    color: 0x60a5fa, emissive: 0x60a5fa, emissiveIntensity: 0.3,
    transparent: true, opacity: 0.3, side: THREE.DoubleSide,
  });
  botDirectionMesh = new THREE.Mesh(dirGeom, dirMat);
  scene.add(botDirectionMesh);
}

function applyBotSkinModel() {
  if (!botPlayer) return;
  botPlayer.skin.modelType = props.skinModel === 'slim' ? 'slim' : 'default';
}

function loadBotSkinSource(source, loadVersion, allowFallback) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    if (!botPlayer || loadVersion !== botSkinLoadVersion) return;
    const nextTexture = new THREE.CanvasTexture(image);
    nextTexture.magFilter = THREE.NearestFilter;
    nextTexture.minFilter = THREE.NearestFilter;
    nextTexture.generateMipmaps = false;
    nextTexture.colorSpace = THREE.SRGBColorSpace;
    nextTexture.needsUpdate = true;

    const previousTexture = botSkinTexture;
    botSkinTexture = nextTexture;
    botPlayer.skin.map = nextTexture;
    applyBotSkinModel();
    botPlayer.skin.visible = true;
    previousTexture?.dispose();
  };
  image.onerror = () => {
    if (!botPlayer || loadVersion !== botSkinLoadVersion) return;
    if (allowFallback) loadBotSkinSource(defaultSkin, loadVersion, false);
  };
  image.src = source;
}

function loadBotSkin() {
  if (!botPlayer) return;
  const loadVersion = ++botSkinLoadVersion;
  loadBotSkinSource(props.skinTexture || defaultSkin, loadVersion, Boolean(props.skinTexture));
}

function updateScene(ws) {
  if (!scene || !ws || !ws.self) return;

  const bp = ws.self.position;
  botWorldPos.set(bp.x, bp.y, bp.z);
  authenticWorldRenderer?.setFocusPosition(bp);

  botMesh.position.set(bp.x, bp.y, bp.z);
  // Mineflayer yaw: 0=北(-Z)，PlayerObject 的本地正面为 +Z。
  botMesh.rotation.y = mineflayerYawToThreeRotation(ws.self.yaw, '+z');

  // 方向锥：从 bot 身体中心向前延伸
  const { forward } = mineflayerYawBasis(ws.self.yaw);
  const dd = 2.0;
  const dirX = bp.x + forward.x * dd;
  const dirZ = bp.z + forward.z * dd;
  botDirectionMesh.position.set(dirX, bp.y + 0.9, dirZ);
  botDirectionMesh.rotation.set(0, 0, 0); // 重置
  botDirectionMesh.lookAt(bp.x + forward.x * (dd + 1), bp.y + 0.9, bp.z + forward.z * (dd + 1));
  botDirectionMesh.rotateX(Math.PI / 2); // 锥尖朝前

  mergeBlocks(ws.blocks);
  updateEntities(ws.entities);
  updateThreats(ws.threats, ws.entities);
  updateNavigation(ws.navigation);

  if (props.followBot) {
    const botCenter = new THREE.Vector3(bp.x, bp.y + 1, bp.z);
    if (firstUpdate) {
      camera.position.set(bp.x + 18, bp.y + 22, bp.z + 18);
      controls.target.copy(botCenter);
      firstUpdate = false;
    } else {
      const offset = camera.position.clone().sub(controls.target);
      controls.target.copy(botCenter);
      camera.position.copy(botCenter).add(offset);
    }
  }
}

/** 方块入索引（worldBlockMap + chunkIndex）并标脏所在 chunk */
function addBlockToIndex(key, b) {
  worldBlockMap.set(key, b);
  const ck = chunkKeyOf(b.x, b.z, RENDER_TUNING.CHUNK_SIZE);
  let members = chunkIndex.get(ck);
  if (!members) {
    members = new Set();
    chunkIndex.set(ck, members);
  }
  members.add(key);
  dirtyChunks.add(ck);
}

/** 方块出索引并标脏所在 chunk（prune 清 air 用） */
function removeBlockFromIndex(key, b) {
  worldBlockMap.delete(key);
  const ck = chunkKeyOf(b.x, b.z, RENDER_TUNING.CHUNK_SIZE);
  const members = chunkIndex.get(ck);
  if (members) {
    members.delete(key);
    if (members.size === 0) chunkIndex.delete(ck);
  }
  dirtyChunks.add(ck);
}

function mergeBlocks(blocks) {
  const now = Date.now();
  let changed = false;

  const freshKeys = new Set();
  for (const block of blocks) {
    // 渲染裁剪：仅当一个实心块"六面均被实心包围"时才剔除（仍保留在导航占用图里）。
    // 兼容旧字段 exposedTop：若新字段缺失则回退到旧语义，避免后端未升级时整面墙完全不显示。
    if (block.category === 'solid') {
      const visible = block.exposedAny !== undefined ? block.exposedAny : block.exposedTop;
      if (visible === false) continue;
    }
    const key = bkey(block.position.x, block.position.y, block.position.z);
    freshKeys.add(key);

    const existing = worldBlockMap.get(key);
    if (existing) {
      existing.lastSeen = now;
      if (existing.name !== block.name || existing.category !== block.category) {
        existing.name = block.name;
        existing.category = block.category;
        existing.color = getBlockColor(block);
        dirtyChunks.add(chunkKeyOf(existing.x, existing.z, RENDER_TUNING.CHUNK_SIZE));
        changed = true;
      }
    } else {
      addBlockToIndex(key, {
        x: Math.round(block.position.x),
        y: Math.round(block.position.y),
        z: Math.round(block.position.z),
        name: block.name,
        category: block.category,
        color: getBlockColor(block),
        lastSeen: now,
      });
      changed = true;
    }
  }

  // 仅在 Bot 紧贴范围内（PRUNE_RADIUS_XZ/Y）允许清除"应该看到却没看到"的方块，
  // 避免远处/被遮挡的已探索记忆被误删。
  const bx = botWorldPos.x, by = botWorldPos.y, bz = botWorldPos.z;
  const { PRUNE_RADIUS_XZ, PRUNE_RADIUS_Y } = RENDER_TUNING;
  for (const [key, b] of worldBlockMap) {
    if (freshKeys.has(key)) continue;
    const dx = b.x - bx, dy = b.y - by, dz = b.z - bz;
    if (Math.abs(dx) <= PRUNE_RADIUS_XZ && Math.abs(dy) <= PRUNE_RADIUS_Y && Math.abs(dz) <= PRUNE_RADIUS_XZ) {
      removeBlockFromIndex(key, b);
      changed = true;
    }
  }

  // BUG-WEBUI-04 · 淘汰远块 + 总量兜底，防无限累积越玩越卡
  if (evictFarBlocks()) changed = true;

  totalBlocks.value = worldBlockMap.size;

  // 每次有变化都保存（避免刷新丢数据）
  if (changed) {
    saveWorldBlocks();
  }
}

/**
 * BUG-WEBUI-04 · worldBlockMap 上限治理。
 * ① 淘汰超出 EVICT 半径的远块（只保留 bot 周边可视邻域）。
 * ② 若仍超 MAX_BLOCKS，从最远的块开始砍到上限内（兜底）。
 * 返回是否发生淘汰（用于触发保存）。
 */
function evictFarBlocks() {
  const { EVICT_RADIUS_XZ, EVICT_RADIUS_Y, MAX_BLOCKS } = RENDER_TUNING;
  const blocks = [];
  for (const [key, b] of worldBlockMap) blocks.push({ key, x: b.x, y: b.y, z: b.z });
  const toEvict = selectEvictions(blocks, botWorldPos, {
    radiusXZ: EVICT_RADIUS_XZ, radiusY: EVICT_RADIUS_Y, maxBlocks: MAX_BLOCKS,
  });
  for (const key of toEvict) {
    const b = worldBlockMap.get(key);
    if (b) removeBlockFromIndex(key, b);
  }
  return toEvict.length > 0;
}

let _saveTimer = null;

function saveWorldBlocks() {
  // Debounce: JSON.stringify of 16k+ blocks is sync-heavy; batch saves to every 5s
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    _doSave();
  }, 5000);
}

function _doSave() {
  try {
    const arr = [];
    for (const [, b] of worldBlockMap) {
      arr.push([b.x, b.y, b.z, b.name, b.category, b.color]);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch (_) {}
}

function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _doSave();
}

function loadWorldBlocks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    let arr = JSON.parse(raw);
    // BUG-WEBUI-04 · 旧缓存可能累积上万块；加载时按 MAX_BLOCKS 截断，
    // 防一开就重建/渲染全部致卡死。bot 连上后 evictFarBlocks 再按距离精修。
    if (Array.isArray(arr) && arr.length > RENDER_TUNING.MAX_BLOCKS) {
      arr = arr.slice(arr.length - RENDER_TUNING.MAX_BLOCKS); // 保留最近写入的一批
      // 截断后立即回写，避免下次又读到超大数组
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch (_) {}
    }
    const now = Date.now();
    for (const item of arr) {
      const [x, y, z, name, category, color] = item;
      const key = bkey(x, y, z);
      // addBlockToIndex 自动把所有涉及 chunk 标脏 → animate 里限量分帧重建，首载不卡死
      addBlockToIndex(key, { x, y, z, name, category: category || 'solid', color, lastSeen: now });
    }
    totalBlocks.value = worldBlockMap.size;
  } catch (_) {}
}

/**
 * FEAT-WEBUI-07 · 重建单个 chunk 的 InstancedMesh 组。
 * 只 dispose / 重建该 chunk 自己的 mesh，其余 chunk 的 mesh 引用完全不动（AC1）。
 * 遮挡 dither 不再参与分桶 —— 已迁 GPU shader（injectOcclusion），相机移动零重建（AC2）。
 */
function rebuildChunk(ck) {
  const old = chunkMeshes.get(ck);
  if (old) {
    for (const m of old) {
      blockMeshGroup.remove(m);
      m.dispose(); // 只释放 InstancedMesh 实例缓冲；几何/材质是全场景共享的，不销毁
    }
    chunkMeshes.delete(ck);
  }

  const members = chunkIndex.get(ck);
  if (!members || members.size === 0) return;

  // chunk 内按 颜色+类别 分桶
  const buckets = new Map();
  for (const key of members) {
    const b = worldBlockMap.get(key);
    if (!b) continue;
    const bucketKey = b.color + '_' + b.category;
    let arr = buckets.get(bucketKey);
    if (!arr) {
      arr = [];
      buckets.set(bucketKey, arr);
    }
    arr.push(b);
  }

  const dummy = new THREE.Object3D();
  const meshes = [];
  for (const [, arr] of buckets) {
    const isPassable = arr[0].category === 'passable';
    const mesh = new THREE.InstancedMesh(
      isPassable ? sharedPassableGeom : sharedBoxGeom,
      getBlockMaterial(arr[0].color, arr[0].category),
      arr.length,
    );
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      // MC 方块整数坐标 (X,Y,Z) 是方块**最小角**，方块占 (X→X+1, Y→Y+1, Z→Z+1)。
      // BoxGeometry size=1 mesh 中心需要在 (X+0.5, Y+0.5, Z+0.5) 才跟世界坐标系一致。
      // 前提：感知层传过来的 p.x/y/z 已经是整数（block.position）——见 collector.ts 的修复。
      dummy.position.set(p.x + 0.5, p.y + 0.5, p.z + 0.5);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (isPassable) mesh.renderOrder = 2;
    blockMeshGroup.add(mesh);
    meshes.push(mesh);
  }
  if (meshes.length > 0) chunkMeshes.set(ck, meshes);
}

/** animate 每帧调用：限量消化脏 chunk，剩余留到后续帧 */
function processDirtyChunks() {
  if (dirtyChunks.size === 0) return;
  const batch = takeDirtyChunks(dirtyChunks, RENDER_TUNING.MAX_CHUNK_REBUILDS_PER_FRAME);
  for (const ck of batch) rebuildChunk(ck);
}

function normalizeEntitySkinSource(source) {
  if (typeof source !== 'string' || !source.trim()) return defaultSkin;
  return source.trim().replace(/^http:\/\/textures\.minecraft\.net\//i, 'https://textures.minecraft.net/');
}

function createPlayerEntityVisual(group, entity) {
  const player = new PlayerObject();
  player.name = 'serverSkinPlayer';
  player.backEquipment = null;
  player.skin.visible = false;
  player.scale.setScalar(0.05);
  player.position.y = 0.8125;
  group.add(player);
  group.userData.playerSkin = {
    entityId: entity.id,
    player,
    skinTexture: null,
    skinKey: '',
    skinLoadVersion: 0,
    removed: false,
  };

  const label = createTextSprite(entity.name, 0x60a5fa);
  label.position.y = 2.1;
  group.add(label);

  const baseRing = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.7, 24),
    new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  );
  baseRing.rotation.x = -Math.PI / 2;
  baseRing.position.y = 0.02;
  group.add(baseRing);

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 6, 8),
    new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.15, depthWrite: false }),
  );
  beam.position.y = 4.8;
  group.add(beam);
}

function loadPlayerEntitySkinSource(state, source, modelType, loadVersion, allowFallback) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    const current = entityMeshes.get(state.entityId)?.userData.playerSkin;
    if (state.removed || current !== state || loadVersion !== state.skinLoadVersion) return;

    const nextTexture = new THREE.CanvasTexture(image);
    nextTexture.magFilter = THREE.NearestFilter;
    nextTexture.minFilter = THREE.NearestFilter;
    nextTexture.generateMipmaps = false;
    nextTexture.colorSpace = THREE.SRGBColorSpace;
    nextTexture.needsUpdate = true;

    const previousTexture = state.skinTexture;
    state.skinTexture = nextTexture;
    state.player.skin.map = nextTexture;
    state.player.skin.modelType = modelType;
    state.player.skin.visible = true;
    previousTexture?.dispose();
  };
  image.onerror = () => {
    const current = entityMeshes.get(state.entityId)?.userData.playerSkin;
    if (state.removed || current !== state || loadVersion !== state.skinLoadVersion) return;
    if (allowFallback) loadPlayerEntitySkinSource(state, defaultSkin, 'slim', loadVersion, false);
  };
  image.src = source;
}

function updatePlayerEntitySkin(group, entity) {
  const state = group.userData.playerSkin;
  if (!state) return;
  const source = normalizeEntitySkinSource(entity.skinUrl);
  const modelType = entity.skinModel === 'slim' ? 'slim' : (source === defaultSkin ? 'slim' : 'default');
  const skinKey = `${source}\u0000${modelType}`;
  if (state.skinKey === skinKey) return;

  state.skinKey = skinKey;
  const loadVersion = ++state.skinLoadVersion;
  loadPlayerEntitySkinSource(state, source, modelType, loadVersion, source !== defaultSkin);
}

function disposeEntityGroup(group) {
  const playerSkin = group.userData.playerSkin;
  if (playerSkin) {
    playerSkin.removed = true;
    playerSkin.skinLoadVersion += 1;
    playerSkin.skinTexture?.dispose();
    playerSkin.skinTexture = null;
    playerSkin.player.skin.map = null;
  }

  const disposedGeometries = new Set();
  const disposedMaterials = new Set();
  const disposedTextures = new Set();
  group.traverse(child => {
    if (child.geometry && !disposedGeometries.has(child.geometry)) {
      disposedGeometries.add(child.geometry);
      child.geometry.dispose();
    }
    const materials = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
    for (const material of materials) {
      if (material.map && !disposedTextures.has(material.map)) {
        disposedTextures.add(material.map);
        material.map.dispose();
      }
      if (!disposedMaterials.has(material)) {
        disposedMaterials.add(material);
        material.dispose();
      }
    }
  });
}

function updateEntities(entities) {
  const currentIds = new Set();

  for (const entity of entities) {
    const key = entity.id;
    currentIds.add(key);
    const color = ENTITY_COLORS[entity.category] ?? 0x8b949e;

    let group = entityMeshes.get(key);
    if (!group) {
      group = new THREE.Group();

      if (entity.category === 'player') {
        // ── 服务器玩家：player_info 真实皮肤；缺失/失败时回退唯一蓝衣 ──
        createPlayerEntityVisual(group, entity);

      } else if (entity.category === 'hostile') {
        // ── 敌对生物：红色菱形 + 警示环 ──
        const marker = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.5, 0),
          new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }),
        );
        marker.name = 'marker';
        marker.position.y = 0.8;
        group.add(marker);

        const label = createTextSprite(entity.name, color);
        label.position.y = 1.6;
        group.add(label);

        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.5, 0.7, 16),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.02;
        group.add(ring);

      } else if (entity.category === 'item') {
        // ── 掉落物：小发光球 ──
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.18, 8, 8),
          new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.7, transparent: true, opacity: 0.85 }),
        );
        marker.name = 'marker';
        marker.position.y = 0.3;
        group.add(marker);

        const label = createTextSprite(entity.name, color);
        label.position.y = 0.8;
        group.add(label);

      } else {
        // ── 其他生物（被动/中立）：圆润胶囊体 ──
        const marker = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.3, 0.6, 4, 8),
          new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.4, transparent: true, opacity: 0.85 }),
        );
        marker.name = 'marker';
        marker.position.y = 0.6;
        group.add(marker);

        const label = createTextSprite(entity.name, color);
        label.position.y = 1.4;
        group.add(label);
      }

      scene.add(group);
      entityMeshes.set(key, group);
    }

    if (entity.category === 'player') updatePlayerEntitySkin(group, entity);

    // 所有实体统一以脚底为基准（position.y = 地面 y）
    group.position.set(entity.position.x, entity.position.y, entity.position.z);
    // 玩家/生物跟随 yaw 旋转
    if (entity.yaw != null) {
      group.rotation.y = mineflayerYawToThreeRotation(entity.yaw, entity.category === 'player' ? '+z' : '-z');
    }
  }

  for (const [key, group] of entityMeshes) {
    if (!currentIds.has(key)) {
      scene.remove(group);
      disposeEntityGroup(group);
      entityMeshes.delete(key);
    }
  }
}

function updateThreats(threats, entities) {
  for (const ring of threatRings) {
    scene.remove(ring);
    ring.geometry.dispose();
    ring.material.dispose();
  }
  threatRings = [];

  for (const threat of threats) {
    if (threat.entityId == null) continue;
    const entity = entities.find(e => e.id === threat.entityId);
    if (!entity) continue;
    const radius = threat.distance ?? entity.distance;
    if (radius > 20) continue;

    const color = THREAT_SEVERITY_COLORS[threat.severity] ?? 0xff8800;
    const ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true,
      opacity: threat.severity === 'critical' ? 0.25 : 0.12,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.3, radius + 0.3, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(botWorldPos.x, botWorldPos.y + 0.05, botWorldPos.z);
    scene.add(ring);
    threatRings.push(ring);
  }
}

function updateNavigation(nav) {
  // Skip full geometry rebuild if nav state hasn't meaningfully changed
  const navKey = nav?.hasGoal
    ? `${nav.path?.length ?? 0}|${nav.goalPosition?.x ?? 0},${nav.goalPosition?.y ?? 0},${nav.goalPosition?.z ?? 0}|${nav.plannedRoute?.points?.length ?? 0}`
    : 'none';
  if (navKey === _lastNavKey) return;
  _lastNavKey = navKey;

  if (navPathLine) {
    navPathLine.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
    scene.remove(navPathLine);
    navPathLine = null;
  }
  if (navGoalMarker) {
    navGoalMarker.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
    scene.remove(navGoalMarker);
    navGoalMarker = null;
  }
  if (!nav || !nav.hasGoal) return;

  if (nav.path && nav.path.length > 1) {
    navPathLine = new THREE.Group();
    const pts = nav.path.map(p => new THREE.Vector3(p.x, p.y + 0.15, p.z));

    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.3);
    const tubeGeom = new THREE.TubeGeometry(curve, Math.max(pts.length * 4, 20), 0.12, 6, false);
    const tubeMat = new THREE.MeshPhongMaterial({
      color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 0.4,
      transparent: true, opacity: 0.6, side: THREE.DoubleSide,
    });
    navPathLine.add(new THREE.Mesh(tubeGeom, tubeMat));

    const glowTube = new THREE.TubeGeometry(curve, Math.max(pts.length * 4, 20), 0.25, 6, false);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff, transparent: true, opacity: 0.12,
      side: THREE.DoubleSide, depthWrite: false,
    });
    navPathLine.add(new THREE.Mesh(glowTube, glowMat));

    const dotCount = Math.floor(curve.getLength() / 1.5);
    const dotGeom = new THREE.SphereGeometry(0.18, 6, 6);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9,
    });
    for (let i = 0; i <= dotCount; i++) {
      const t = i / Math.max(dotCount, 1);
      const dot = new THREE.Mesh(dotGeom, dotMat);
      const pt = curve.getPointAt(t);
      dot.position.copy(pt);
      navPathLine.add(dot);
    }

    scene.add(navPathLine);
  }

  if (nav.goalPosition) {
    navGoalMarker = new THREE.Group();

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 12, 16),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    beam.position.y = 6;
    navGoalMarker.add(beam);

    const diamond = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.6, 0),
      new THREE.MeshPhongMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 0.7, transparent: true, opacity: 0.9 }),
    );
    diamond.position.y = 1.5;
    diamond.name = 'goalDiamond';
    navGoalMarker.add(diamond);

    const ringInner = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 1.0, 32),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    ringInner.rotation.x = -Math.PI / 2;
    ringInner.position.y = 0.05;
    navGoalMarker.add(ringInner);

    const ringOuter = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 1.6, 32),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false }),
    );
    ringOuter.rotation.x = -Math.PI / 2;
    ringOuter.position.y = 0.05;
    ringOuter.name = 'goalRingOuter';
    navGoalMarker.add(ringOuter);

    navGoalMarker.position.set(nav.goalPosition.x, nav.goalPosition.y, nav.goalPosition.z);
    scene.add(navGoalMarker);
  }

  updatePlannedRoute(nav.plannedRoute);
}

function updatePlannedRoute(route) {
  if (plannedRouteLine) {
    plannedRouteLine.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
        else c.material.dispose();
      }
    });
    scene.remove(plannedRouteLine);
    plannedRouteLine = null;
  }
  if (!route || !route.points || route.points.length < 2) return;

  plannedRouteLine = new THREE.Group();

  // 与方块渲染保持同一坐标系：方块 mesh 中心放在 (X+0.5, Y+0.5, Z+0.5) = cell 真实中心。
  // waypoint 对齐到所在格 cell 中心 = floor + 0.5（整数 waypoint floor 后还是自身；
  // 浮点 start/goal 取所在 cell 中心）。
  const pts = route.points.map(p => new THREE.Vector3(
    Math.floor(p.x) + 0.5,
    Math.floor(p.y) + 0.5,
    Math.floor(p.z) + 0.5,
  ));

  // 模式 → 颜色方案
  const isGlobal = route.mode && route.mode.startsWith('global_');
  const SOLID_COLOR_BY_MODE = {
    local_only: 0x00e5ff,
    local_voxel_then_pf: 0xa78bfa,
  };
  const labelColorByMode = {
    local_only: 0x00e5ff,
    local_voxel_then_pf: 0xa78bfa,
    global_voxel_then_pf: 0xff5f6d,
    global_chunk_then_pf: 0xfbbf24,
    global_segments: 0xff5f6d,
    global_live_pathfinder: 0x00e5ff,
  };

  // ===== 1. 折线本体：直线段 LineSegments，不做任何曲线拟合 =====
  const linePositions = [];
  const lineColors = [];
  const tmpColor = new THREE.Color();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    if (isGlobal) {
      const hueA = (i / Math.max(1, pts.length - 1)) * 1.0;
      const hueB = ((i + 1) / Math.max(1, pts.length - 1)) * 1.0;
      tmpColor.setHSL(hueA, 1.0, 0.55);
      lineColors.push(tmpColor.r, tmpColor.g, tmpColor.b);
      tmpColor.setHSL(hueB, 1.0, 0.55);
      lineColors.push(tmpColor.r, tmpColor.g, tmpColor.b);
    } else {
      const solid = SOLID_COLOR_BY_MODE[route.mode] ?? 0xa78bfa;
      tmpColor.setHex(solid);
      lineColors.push(tmpColor.r, tmpColor.g, tmpColor.b);
      lineColors.push(tmpColor.r, tmpColor.g, tmpColor.b);
    }
  }
  if (linePositions.length > 0) {
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    lineGeom.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      linewidth: 1, // 多数 WebGL 实现都忽略此值，由屏幕像素决定线宽
    });
    plannedRouteLine.add(new THREE.LineSegments(lineGeom, lineMat));
  }

  // ===== 2. 每个 waypoint 的格子轮廓：1×1×1 wireframe cube，对齐到该格 =====
  // 这是关键诊断信息——你能直接看出 A* 选了哪些格子。如果某个格子在墙后/门洞里，
  // 这个轮廓就会画在那里，跟感知层渲染的方块比对就能发现规划错误。
  const cellGeom = new THREE.BoxGeometry(0.95, 0.95, 0.95); // 0.95 比格子小一点，避免 z-fighting
  const wireMaterial = (hex) => new THREE.LineBasicMaterial({
    color: hex, transparent: true, opacity: 0.85, depthTest: true,
  });
  for (let i = 0; i < pts.length; i++) {
    let hex;
    if (i === 0) hex = 0xffffff;                              // 起点白
    else if (i === pts.length - 1) hex = 0xfbbf24;            // 终点金黄
    else if (isGlobal) {
      const hueT = i / Math.max(1, pts.length - 1);
      hex = new THREE.Color().setHSL(hueT, 1.0, 0.55).getHex();
    } else {
      hex = SOLID_COLOR_BY_MODE[route.mode] ?? 0xa78bfa;
    }
    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(cellGeom),
      wireMaterial(hex),
    );
    wire.position.set(pts[i].x, pts[i].y, pts[i].z);
    plannedRouteLine.add(wire);

    // 中心小球（方便看清节点）
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(i === 0 || i === pts.length - 1 ? 0.18 : 0.12, 10, 10),
      new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.9 }),
    );
    dot.position.copy(pts[i]);
    plannedRouteLine.add(dot);
  }

  // 模式文字标签置于路线中点上方
  if (route.mode) {
    const midIdx = Math.floor(pts.length / 2);
    const labelColor = labelColorByMode[route.mode] ?? 0xa78bfa;
    const sprite = createTextSprite(route.mode, labelColor);
    sprite.position.copy(pts[midIdx]);
    sprite.position.y += 1.6;
    plannedRouteLine.add(sprite);
  }

  // done 状态半透明淡出
  if (route.done) {
    plannedRouteLine.traverse(c => {
      if (c.material && c.material.opacity != null) {
        c.material.opacity *= 0.4;
        c.material.transparent = true;
      }
    });
  }

  scene.add(plannedRouteLine);
}

function createTextSprite(text, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 256;
  canvas.height = 64;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 4;
  ctx.strokeText(text, 128, 32);
  ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
  ctx.fillText(text, 128, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.5, 0.6, 1);
  return sprite;
}

function animate(now) {
  animFrameId = requestAnimationFrame(animate);
  if (!renderer || !scene || !camera) return;
  // 窗口最小化/不在前台 → 不渲染（省电省卡）
  if (typeof document !== 'undefined' && document.hidden) return;
  // 限 30fps：未到下一帧时刻就跳过本帧渲染
  if (now !== undefined) {
    if (now - _lastFrameTs < _frameMinMs) return;
    _lastFrameTs = now;
  }

  if (controls) controls.update();

  const t = Date.now() * 0.003;
  if (botMesh) botMesh.position.y = botWorldPos.y + Math.sin(t) * 0.05;

  for (const [, group] of entityMeshes) {
    const marker = group.getObjectByName('marker');
    if (marker) marker.rotation.y += 0.015;
  }

  if (navGoalMarker) {
    const d = navGoalMarker.getObjectByName('goalDiamond');
    if (d) { d.rotation.y += 0.03; d.position.y = 1.5 + Math.sin(t * 1.5) * 0.3; }
    const ro = navGoalMarker.getObjectByName('goalRingOuter');
    if (ro) {
      const pulse = 1.0 + Math.sin(t * 2) * 0.15;
      ro.scale.set(pulse, pulse, pulse);
    }
  }

  if (navPathLine) {
    const dotOpacity = 0.5 + Math.sin(t * 3) * 0.4;
    navPathLine.traverse(c => {
      if (c.isMesh && c.geometry?.type === 'SphereGeometry') {
        c.material.opacity = dotOpacity;
      }
    });
  }

  // FEAT-WEBUI-07：遮挡走 GPU uniform（相机/bot 移动零重建），方块变化只重建脏 chunk
  occlusionUniforms.uCamPos.value.copy(camera.position);
  occlusionUniforms.uBotPos.value.copy(botWorldPos);
  processDirtyChunks();
  worldRendererRegistry?.tick({ now, camera, botPosition: botWorldPos });

  renderer.render(scene, camera);
}

function handleResize() {
  const container = containerRef.value;
  if (!container || !renderer || !camera) return;
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

function resetCamera() {
  if (!camera || !controls) return;
  camera.position.set(botWorldPos.x + 18, botWorldPos.y + 22, botWorldPos.z + 18);
  controls.target.set(botWorldPos.x, botWorldPos.y + 1, botWorldPos.z);
  controls.update();
  emit('update:followBot', true);
}

defineExpose({ resetCamera });

function fmtPos(pos) {
  if (!pos) return '---';
  return `${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}`;
}

function fmtPosPrecise(pos) {
  if (!pos) return '---';
  return `${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`;
}

function fmtCell(pos) {
  if (!pos) return '---';
  return `(${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`;
}

const nearestDoorInfo = computed(() => {
  const blocks = props.worldState?.blocks;
  const self = props.worldState?.self?.position;
  if (!blocks || !self) return null;
  let best = null;
  let bestD = Infinity;
  for (const b of blocks) {
    const n = b.name || '';
    if (!(n.endsWith('_door') || n.endsWith('_trapdoor') || n.endsWith('_fence_gate'))) continue;
    const dx = b.position.x - self.x;
    const dy = b.position.y - self.y;
    const dz = b.position.z - self.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = b; }
  }
  if (!best) return null;
  const dist = Math.sqrt(bestD).toFixed(2);
  return `${best.name} (${best.position.x},${best.position.y},${best.position.z}) Δ${dist}`;
});

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function cleanup() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  authenticWorldRenderer?.dispose();
  authenticWorldRenderer = null;
  worldRendererRegistry = null;
  botSkinLoadVersion++;
  botSkinTexture?.dispose();
  botSkinTexture = null;
  if (botMesh) {
    scene?.remove(botMesh);
    botMesh.traverse(c => {
      c.geometry?.dispose();
      if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
      else c.material?.dispose();
    });
    botMesh = null;
    botPlayer = null;
  }
  if (botDirectionMesh) {
    scene?.remove(botDirectionMesh);
    botDirectionMesh.geometry.dispose();
    botDirectionMesh.material.dispose();
    botDirectionMesh = null;
  }
  for (const [, meshes] of chunkMeshes) {
    for (const m of meshes) { blockMeshGroup?.remove(m); m.dispose(); }
  }
  chunkMeshes.clear();
  chunkIndex.clear();
  dirtyChunks.clear();
  sharedBoxGeom.dispose();
  sharedPassableGeom.dispose();
  for (const [, mat] of materialCache) mat.dispose();
  materialCache.clear();
  worldBlockMap.clear();
  for (const [, group] of entityMeshes) {
    scene?.remove(group);
    disposeEntityGroup(group);
  }
  entityMeshes.clear();
  for (const ring of threatRings) { scene?.remove(ring); ring.geometry.dispose(); ring.material.dispose(); }
  threatRings = [];
  if (navPathLine) { navPathLine.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); scene?.remove(navPathLine); }
  if (navGoalMarker) { navGoalMarker.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); scene?.remove(navGoalMarker); }
  if (plannedRouteLine) {
    plannedRouteLine.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
        else c.material.dispose();
      }
    });
    scene?.remove(plannedRouteLine);
    plannedRouteLine = null;
  }
  if (controls) controls.dispose();
  if (renderer) renderer.dispose();
}

let _lastSceneUpdateMs = 0;
watch(() => props.worldState, (ws) => {
  if (!ws) return;
  const now = Date.now();
  if (now - _lastSceneUpdateMs < 200) return;  // cap Three.js scene updates at 5fps
  _lastSceneUpdateMs = now;
  updateScene(ws);
}, { deep: false });
watch(() => props.skinTexture, loadBotSkin);
watch(() => props.skinModel, applyBotSkinModel);
watch(() => props.worldMode, () => { void activateWorldMode(); });
watch(() => props.visualWorldRevision, () => {
  authenticWorldRenderer?.setStore(props.visualWorldStore);
  if (props.worldMode === 'authentic') void activateWorldMode();
});
watch(() => props.visualWorldConfig, () => {
  if (props.worldMode === 'authentic') void activateWorldMode();
});
function handleBeforeUnload() { flushSave(); }

// ResizeObserver：当容器从 display:none 变回可见时（v-show 切换），
// clientWidth/Height 从 0 变为正值 → 触发 handleResize 恢复渲染
let _resizeObserver = null;

onMounted(() => {
  initScene();
  loadWorldBlocks();
  void activateWorldMode();
  window.addEventListener('resize', handleResize);
  window.addEventListener('beforeunload', handleBeforeUnload);
  if (props.worldState) updateScene(props.worldState);

  // 监听容器尺寸变化（v-show 切回游玩 tab 时触发）
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    _resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          handleResize();
        }
      }
    });
    _resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  flushSave();
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  _resizeObserver?.disconnect();
  _resizeObserver = null;
  cleanup();
});
</script>

<style scoped>
.perception-3d { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0a0e14; }
.perception-3d canvas { display: block; width: 100%; height: 100%; }
.world-mode-panel {
  position: absolute; z-index: 16; top: 108px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 300px;
  pointer-events: auto;
}
.resync-button { border: 0; padding: 6px 12px; background: #7a4b2f; color: #fff; font: 10px var(--mc-font-pixel); cursor: pointer; }
.world-mode-status { width: min(430px,calc(100vw - 40px)); padding: 7px 9px; background: rgba(12,14,8,.9); color: #b8bea8; font: 10px var(--mc-font-body); text-align: center; }
.world-mode-status-copy { min-height: 14px; }
.world-mode-status.error { color: #ff9b85; }
.world-mode-status.ready { color: #9ee47b; }
.world-loading-progress { position:relative; height:5px; margin-top:6px; overflow:hidden; background:#263023; border:1px solid #3e4a39; }
.world-loading-progress > span { display:block; height:100%; background:linear-gradient(90deg,#4d9f36,#9ee47b); transition:width 140ms ease; }
.world-loading-progress.indeterminate > span { position:absolute; width:38%; animation:world-loading-slide 1.05s ease-in-out infinite; }
.world-mode-warning { max-width:430px; padding:4px 8px; background:rgba(42,32,8,.88); color:#e6c76a; font:10px var(--mc-font-body); text-align:center; }
@keyframes world-loading-slide { from { transform:translateX(-110%); } to { transform:translateX(285%); } }

.hud {
  position: absolute;
  background: rgba(13, 17, 23, 0.88);
  border: 1px solid rgba(48, 54, 61, 0.8);
  border-radius: 8px;
  padding: 10px 14px;
  backdrop-filter: blur(8px);
  font-size: 12px;
  pointer-events: auto;
  z-index: 10;
}

.hud-title {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
  color: #7cc24e; margin-bottom: 8px; padding-bottom: 4px;
  border-bottom: 1px solid rgba(88, 166, 255, 0.2);
}

.hud-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; color: #cdd2c0; }
.hud-icon { width: 18px; flex-shrink: 0; }
.hud-icon.health { color: #d8503c; }
.hud-icon.food { color: #e0a52f; }

.hud-label {
  font-size: 10px; font-weight: 600; color: #7e836e;
  text-transform: uppercase; letter-spacing: 0.5px; min-width: 36px;
}

.hud-value { color: #e7e3d4; font-weight: 500; }
.hud-value.threat { color: #d8503c; font-weight: 700; }
.hud-value.mono { font-family: var(--mc-font-mono); font-size: 11px; }
.nav-label { color: #00e5ff; }
.nav-value { display: inline-flex; align-items: center; gap: 4px; color: #00e5ff; }
.plan-rainbow {
  background: linear-gradient(90deg, #ff0040, #ff8c00, #ffd700, #00e676, #00b0ff, #7c4dff, #ff4081);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  font-weight: 700;
  animation: rainbow-flow 3s linear infinite;
}
@keyframes rainbow-flow {
  0% { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}

.hud-bar { flex: 1; height: 4px; background: #20241a; border-radius: 2px; overflow: hidden; min-width: 60px; }
.hud-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }
.hud-bar-fill.health { background: linear-gradient(90deg, #d8503c, #b33b2a); }
.hud-bar-fill.food { background: linear-gradient(90deg, #e0a52f, #e3b341); }

.hud-top-left { top: 12px; left: 12px; min-width: 200px; }
.hud-top-right { top: 12px; right: 12px; min-width: 140px; }
.hud-bottom-left { bottom: 12px; left: 12px; max-width: 300px; }

.threat-title { display: flex; align-items: center; gap: 5px; color: #d8503c !important; border-bottom-color: rgba(248, 81, 73, 0.3) !important; }
.threat-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }
.threat-severity { font-size: 9px; font-weight: 800; padding: 1px 6px; border-radius: 3px; letter-spacing: 0.5px; }
.severity-critical .threat-severity { background: #d8503c; color: #fff; }
.severity-high .threat-severity { background: #b33b2a; color: #fff; }
.severity-medium .threat-severity { background: #e0a52f; color: #0c0e08; }
.severity-low .threat-severity { background: #6b6f5e; color: #e7e3d4; }
.threat-desc { color: #cdd2c0; }

.no-data-overlay {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(10, 14, 20, 0.9); z-index: 20;
}
.no-data-icon { color: #7e836e; opacity: 0.3; margin-bottom: 12px; }
.no-data-text { font-size: 16px; color: #7e836e; font-weight: 500; }
.no-data-hint { font-size: 12px; color: #6b6f5e; margin-top: 6px; }
</style>
