<template>
  <div class="mineclaw-app">
    <div class="app-ambient" aria-hidden="true"></div>

    <!-- ===================== TOP BAR ===================== -->
    <header class="app-header">
      <div class="app-topbar">
        <!-- brand -->
        <div class="app-brand">
          <img class="app-brand-logo" src="/brand/mineclaw-mark.svg" alt="" aria-hidden="true" />
          <span class="app-brand-name">MineClaw</span>
          <span class="app-brand-edition">AI COMPANION CONSOLE</span>
        </div>

        <div class="app-header-spacer"></div>

        <button
          class="global-settings-button"
          :class="{ active: globalSettingsOpen }"
          title="全局设置"
          aria-label="全局设置"
          @click="globalSettingsOpen = !globalSettingsOpen"
        ><McIcon name="settings" :size="16" /></button>

        <!-- hub status -->
        <div class="app-hub-status" :class="{ offline: !wsConnected }">
          <span class="status-indicator"></span>
          <span>{{ wsConnected ? 'Hub 已连接' : 'Hub 断开' }}</span>
        </div>

        <!-- 无边框窗口控制（自定义标题栏）-->
        <div v-if="isElectron" class="window-controls">
          <button class="window-control" @click="winMin" title="最小化" aria-label="最小化"><McIcon name="minus" :size="12" /></button>
          <button class="window-control danger" @click="winClose" title="关闭到托盘" aria-label="关闭到托盘"><McIcon name="close" :size="12" /></button>
        </div>
      </div>
    </header>

    <section v-if="globalSettingsOpen" class="global-settings-layer">
      <SettingsPanel
        :key="`global:${globalSettingsSection}`"
        scope="global"
        :initialSection="globalSettingsSection"
        @close="globalSettingsOpen = false"
      />
    </section>

    <!-- ===================== PARTNER WORKSPACE ===================== -->
    <div class="partner-workspace-shell">

      <!-- ---------- LEFT · PARTNERS ---------- -->
      <aside class="partner-sidebar">
        <div class="partner-sidebar-header">
          <span class="section-eyebrow">PARTNERS</span>
          <button class="icon-button primary" @click="showCreateForm = true" title="创建伙伴" aria-label="创建伙伴"><McIcon name="plus" :size="13" /></button>
        </div>
        <div class="partner-sidebar-title">我的伙伴</div>

        <div class="partner-list">
          <button v-for="p in profiles" :key="p.id" class="partner-list-item" :class="{ active: selectedProfile?.id === p.id }" @click="selectProfile(p)">
            <span class="partner-avatar">
              <McHead :texture="p.skinTexture || ''" :size="36" />
              <span class="partner-presence-dot" :style="{ background: statusDot(p.id) }"></span>
            </span>
            <span class="partner-list-summary">
              <strong>{{ p.name }}</strong>
              <small>{{ getPresenceText(p.id) }}</small>
            </span>
          </button>
          <div v-if="profiles.length === 0" class="partner-list-empty">还没有伙伴，点 + 创建一个</div>
        </div>

        <div class="partner-sidebar-fill"></div>
        <div class="partner-count">{{ profiles.length }} PARTNERS · {{ onlineCount }} ONLINE</div>
      </aside>

      <section class="partner-workspace-bar">
        <div class="workspace-partner">
          <div v-if="selectedProfile" class="workspace-partner-head">
            <McHead :texture="selectedSkinTexture" :size="32" />
          </div>
          <div class="workspace-partner-copy">
            <strong>{{ selectedProfile?.name || '未选择伙伴' }}</strong>
            <span>{{ selectedProfile ? getStatusLabel(currentFullStatus?.status, currentFullStatus) : '请从左侧选择或创建伙伴' }}</span>
          </div>
        </div>
        <nav class="partner-workspace-tabs" aria-label="伙伴工作区">
          <button
            v-for="tab in workspaceTabs"
            :key="tab.id"
            class="partner-workspace-tab"
            :class="{ active: workspaceView === tab.id }"
            @click="workspaceView = tab.id"
          >{{ tab.name }}</button>
        </nav>
      </section>

      <BrainPanel
        v-if="workspaceView === 'brain'"
        :key="`brain:${selectedProfile?.id || 'empty'}`"
        v-model:active-tab="brainTab"
        :botId="selectedProfile?.id || ''"
        :profile="selectedProfile"
        :botStatus="currentFullStatus"
        :agentSteps="agentLoopSteps"
        class="partner-workspace-panel"
      />
      <LlmTracePanel
        v-else-if="workspaceView === 'trace'"
        :key="`trace:${selectedProfile?.id || 'empty'}`"
        :botId="selectedProfile?.id || ''"
        class="partner-workspace-panel"
      />
      <SettingsPanel
        v-else-if="workspaceView === 'settings'"
        :key="`settings:${selectedProfile?.id || 'global'}`"
        :selectedProfile="selectedProfile"
        :botStatus="currentFullStatus"
        :initialSection="selectedProfile ? 'bot' : 'llm-configs'"
        scope="profile"
        class="partner-workspace-panel"
        @profile-updated="onProfileUpdated"
        @request-global-settings="openGlobalSettings"
      />
      <template v-else>

      <!-- ---------- CENTER · 感知空间 ---------- -->
      <main class="play-stage perception-stage">
        <div class="perception-grid" aria-hidden="true"></div>
        <div class="perception-vignette" aria-hidden="true"></div>

        <!-- 真实 3D 感知（默认关闭·按需开启，避免重 WebGL 拖慢界面 BUG-WEBUI-05） -->
        <div v-if="currentWorldState && show3D" class="perception-scene">
          <PerceptionScene3D
            ref="scene3dRef"
            :worldState="currentWorldState"
            :skinTexture="selectedSkinTexture"
            :skinModel="selectedSkinModel"
            v-model:followBot="followBot"
          />
        </div>
        <!-- 3D 开关 -->
        <div class="perception-mode-control">
          <button class="stage-button" :class="{ active: show3D }" @click="toggle3D">
            <McIcon :name="show3D ? 'stop' : 'play'" :size="13" />
            {{ show3D ? '关闭 3D 感知' : '开启 3D 感知' }}
          </button>
        </div>
        <!-- 3D 关闭时的轻量占位（有 worldState 但未开 3D） -->
        <div v-if="currentWorldState && !show3D" class="perception-online-state">
          <div class="online-compass"><McIcon name="compass" :size="25" /></div>
          <div class="online-state-kicker">WORLD SIGNAL READY</div>
          <div class="online-state-title">{{ selectedProfile?.name }} 在线中</div>
          <div class="online-state-copy">已接收真实感知数据 · 需要时开启 3D 视图</div>
        </div>

        <!-- 外层视角控件：接到 3D 场景 -->
        <div v-if="currentWorldState && show3D" class="perception-camera-controls">
          <button class="stage-button" :class="{ active: followBot }" @click="followBot = !followBot">
            <span class="stage-button-dot"></span>{{ followBot ? '跟随中' : '自由视角' }}
          </button>
          <button class="stage-button" @click="resetSceneCamera">重置视角</button>
        </div>

        <!-- empty state -->
        <div v-if="!currentWorldState" class="perception-empty">
          <div class="scan-field" aria-hidden="true">
            <span class="scan-crosshair horizontal"></span>
            <span class="scan-crosshair vertical"></span>
            <span class="scan-ring ring-one"></span>
            <span class="scan-ring ring-two"></span>
            <span class="scan-ring ring-three"></span>
            <span class="scan-ring ring-four"></span>
            <div class="scan-core">
              <div class="scan-pixel"></div>
            </div>
          </div>
          <div class="scan-kicker">PERCEPTION ARRAY</div>
          <div class="scan-title">等待感知数据</div>
          <div class="scan-copy">伙伴上线后，将在这里呈现实时世界与环境信号</div>
          <div class="sensor-status">
            <span></span>
            <strong>SENSOR · STANDBY</strong>
          </div>
        </div>

        <!-- 外层图例 -->
        <div class="perception-legend">
          <div class="legend-header">
            <span class="legend-header-mark"></span>
            <span>LEGEND · 图例</span>
          </div>
          <div class="legend-grid">
            <div v-for="(lg, i) in legend" :key="i" class="legend-item">
              <span class="legend-swatch" :style="{ background: lg.c }"></span>
              <span>{{ lg.t }}</span>
            </div>
          </div>
        </div>
      </main>

      <!-- ---------- RIGHT · 控制面板 ---------- -->
      <aside class="play-control partner-inspector">

        <template v-if="selectedProfile">
        <!-- header -->
        <div class="inspector-header">
          <div class="inspector-avatar">
            <McHead :texture="selectedSkinTexture" :size="44" />
          </div>
          <div class="inspector-identity">
            <div class="inspector-name">{{ selectedProfile.name }}</div>
            <div class="inspector-presence">
              <span :style="{ background: statusDot(selectedProfile.id) }"></span>
              <small>{{ getStatusLabel(currentFullStatus?.status, currentFullStatus) }}</small>
            </div>
          </div>
          <div class="inspector-actions">
            <button v-if="!inGame" class="inspector-button primary" @click="joinGame" :disabled="!brainReady">进游戏</button>
            <button v-else class="inspector-button danger" @click="leaveGame">退游戏</button>
            <button class="inspector-button ghost danger" @click="deleteProfile(selectedProfile.id)" aria-label="删除伙伴"><McIcon name="trash" :size="13" /></button>
          </div>
        </div>

        <!-- HUD vitals -->
        <div v-if="inGame" class="inspector-vitals">
          <div class="vital-row health">
            <span class="vital-label">HP</span>
            <div class="vital-cells">
              <McIcon v-for="(c, i) in hpCells" :key="i" name="health" :size="16" :style="{ color: c.on ? '#ff4d4d' : '#5a1f1c', '--mc-icon-accent': c.on ? '#ff8a8a' : '#3a1512' }" />
            </div>
            <span class="vital-value">{{ hpLabel }}</span>
          </div>
          <div class="vital-row food">
            <span class="vital-label">FD</span>
            <div class="vital-cells">
              <span v-for="(c, i) in fdCells" :key="i" style="position:relative; flex:none; width:16px; height:15px; display:inline-block;">
                <span :style="{ position:'absolute', right:0, bottom:0, width:'12px', height:'12px', borderRadius:'7px 7px 6px 3px', background: c.on ? '#a9772f' : '#3a2a1c', boxShadow:'inset -2px -2px 0 rgba(0,0,0,0.35), 0 0 0 1px #000' }"></span>
                <span :style="{ position:'absolute', left:0, top:'3px', width:'7px', height:'5px', borderRadius:'3px', background: c.on ? '#cdd2c0' : '#2a2018', boxShadow:'0 0 0 1px #000' }"></span>
              </span>
            </div>
            <span class="vital-value">{{ fdLabel }}</span>
          </div>
        </div>

        <!-- chips -->
        <div class="inspector-chips">
          <div class="status-chip" :class="{ positive: connOk, negative: !connOk }">
            <span>连接</span>
            <McIcon :name="connOk ? 'connected' : 'disconnected'" :size="10" />
            <strong>{{ connOk ? '已接' : '未接' }}</strong>
          </div>
          <div class="status-chip">
            <span>动作</span><strong>{{ currentFullStatus?.currentBehavior || '空闲' }}</strong>
          </div>
          <div class="status-chip activity-chip">
            <span>活动</span><strong>{{ currentFullStatus?.lastActivity || '—' }}</strong>
          </div>
        </div>

        <!-- problem -->
        <div v-if="inGame && !connOk && currentFullStatus?.serverAddress" class="inspector-problem">
          <McIcon name="warning" :size="12" />
          <span>问题 · 服务器</span>
          <strong>{{ currentFullStatus.serverAddress }}</strong>
        </div>

        <!-- tabs -->
        <nav class="control-tabs" aria-label="伙伴详情">
          <button v-for="t in tabs" :key="t.id" class="control-tab" :class="{ active: ctrlTab === t.id }" @click="ctrlTab = t.id">{{ t.name }}</button>
        </nav>

        <!-- content -->
        <div class="inspector-content">

          <!-- 角色交流：状态与聊天合并 -->
          <div v-if="ctrlTab === 'status'" class="interaction-panel">
            <AlertBanner :alerts="v2Alerts" />
            <div class="interaction-summary">
              <div class="interaction-avatar">
                <div class="interaction-status-badge">
                  <span :style="{ width:'7px', height:'7px', background: statusDot(selectedProfile.id) }"></span>
                  <span>{{ (currentFullStatus?.status || 'offline').toUpperCase() }}</span>
                </div>
                <div class="interaction-character">
                  <McCharacter :texture="selectedSkinTexture" :model="selectedSkinModel" animation="idle" :autoRotate="false" :zoom="1.12" />
                </div>
              </div>
              <div class="interaction-summary-copy">
                <div>
                  <div class="interaction-summary-title">当前角色交流</div>
                  <div class="interaction-summary-state">{{ getStatusLabel(currentFullStatus?.status, currentFullStatus) }}</div>
                </div>
                <div class="interaction-summary-detail">
                  <span>动作</span>
                  <strong>{{ currentFullStatus?.currentBehavior || '空闲' }}</strong>
                </div>
                <div class="interaction-summary-detail">
                  <span>活动</span>
                  <strong>{{ currentFullStatus?.lastActivity || '暂无最近活动' }}</strong>
                </div>
                <button class="interaction-skin-button" @click="showSkinEditor = true">编辑皮肤</button>
              </div>
            </div>

            <div class="chat-panel interaction-chat">
              <div ref="messagesEl" class="interaction-messages">
                <div v-if="chatHistoryLoading" class="chat-state">正在加载最近聊天记录…</div>
                <div v-else-if="messages.length === 0" class="chat-state">还没有聊天记录，直接和伙伴说句话吧</div>
                <div v-for="(msg, i) in messages" :key="i" class="chat-message" :class="{ self: msg.self, error: msg.error }">
                  <div v-if="msg.thinking" class="thinking-card" @click="msg.thinkExpanded = !msg.thinkExpanded">
                    <span class="thinking-label"><McIcon name="thinking" :size="10" />思考过程 · {{ msg.thinkExpanded ? '收起' : '展开' }}</span>
                    <div class="thinking-copy" :class="{ expanded: msg.thinkExpanded }">{{ msg.thinking }}</div>
                  </div>
                  <div class="message-bubble">
                    <div class="message-sender">{{ msg.sender }}</div>
                    <div class="message-copy">{{ msg.message }}</div>
                  </div>
                  <div class="message-time">{{ formatTime(msg.timestamp) }}</div>
                </div>
              </div>
              <div v-if="liveThinking" class="thinking-card live" @click="liveThinkExpanded = !liveThinkExpanded">
                <span class="thinking-label"><McIcon name="thinking" :size="10" />正在思考 · {{ liveThinkExpanded ? '收起' : '展开' }}</span>
                <div class="thinking-copy" :class="{ expanded: liveThinkExpanded }">{{ liveThinking }}</div>
              </div>
              <ChatBox @send="sendChat" />
            </div>
          </div>

          <!-- 任务栏 -->
          <TaskBarPanel
            v-else-if="ctrlTab === 'tasks'"
            :botName="selectedProfile?.name || '未选择伙伴'"
            :tasks="v2Tasks"
            :state="v2TaskState"
            :error="v2TaskError"
            @retry="refreshV2Tasks({ showLoading: true })"
          />

          <!-- 背包 -->
          <div v-else-if="ctrlTab === 'inventory'">
            <InventoryPanel :worldState="currentWorldState" />
          </div>

          <!-- 日志 -->
          <div v-else-if="ctrlTab === 'logs'" ref="logsEl" class="inspector-logs">
            <div v-if="logs.length === 0" class="inspector-logs-empty">暂无运行日志</div>
            <div v-for="(log, i) in logs" :key="i" class="inspector-log-row">
              <span>{{ formatTime(log.timestamp) }}</span>
              <strong :class="`level-${log.level}`">{{ log.level }}</strong>
              <p>{{ log.message }}</p>
            </div>
          </div>

        </div>
        </template>

        <!-- 未选中伙伴 -->
        <div v-else class="inspector-empty">
          <div class="inspector-empty-mark"></div>
          <strong>选择一个伙伴</strong>
          <span>在左侧挑一个伙伴，或点 + 创建</span>
        </div>
      </aside>
      </template>
    </div>

    <!-- ===================== 创建表单 overlay ===================== -->
    <div v-if="showCreateForm" style="position:fixed; inset:0; z-index:50; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.6);" @click.self="showCreateForm = false">
      <div style="width:520px; max-width:92vw; max-height:88vh; overflow-y:auto; padding:22px; background:#1b1e14; border:3px solid #0c0e08; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.06), 0 8px 0 rgba(0,0,0,0.5);">
        <div style="font-family:var(--mc-font-pixel); font-size:13px; color:#cfeeb0; text-shadow:2px 2px 0 #0c0e08; margin-bottom:6px;">NEW PARTNER</div>
        <div style="font-size:13px; color:#7e836e; margin-bottom:18px;">取个名字、设定性格，连接到你的 Minecraft 世界</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <label style="grid-column:span 2; display:flex; flex-direction:column; gap:5px;"><span style="font-size:12px; color:#bcc0ab;">名字</span><input v-model="form.name" :style="inputStyle" /></label>
          <label style="grid-column:span 2; display:flex; flex-direction:column; gap:5px;"><span style="font-size:12px; color:#bcc0ab;">性格描述</span><input v-model="form.personality" :style="inputStyle" /></label>
          <label style="display:flex; flex-direction:column; gap:5px;"><span style="font-size:12px; color:#bcc0ab;">MC 服务器地址</span><input v-model="form.host" :style="inputStyle" /></label>
          <label style="display:flex; flex-direction:column; gap:5px;"><span style="font-size:12px; color:#bcc0ab;">端口</span><input v-model.number="form.port" type="number" :style="inputStyle" /></label>
          <label style="display:flex; flex-direction:column; gap:5px;"><span style="font-size:12px; color:#bcc0ab;">验证方式</span>
            <select v-model="form.auth" :style="inputStyle"><option value="offline">离线模式</option><option value="microsoft">微软登录</option></select></label>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
          <button @click="showCreateForm = false" style="padding:9px 16px; cursor:pointer; background:#272d1d; border:2px solid #0d0f0a; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.06); color:#b9bda8; font-weight:700; font-size:13px;">取消</button>
          <button @click="createProfile" style="padding:9px 18px; cursor:pointer; background:#4c9a2a; border:2px solid #2b5e16; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.28), inset -2px -2px 0 rgba(0,0,0,0.3), 0 3px 0 #214b13; color:#fff; font-weight:700; font-size:13px; text-shadow:1px 1px 0 rgba(0,0,0,0.4);">创建伙伴</button>
        </div>
      </div>
    </div>

    <!-- ===================== 皮肤编辑器 overlay ===================== -->
    <div v-if="showSkinEditor && selectedProfile" style="position:fixed; inset:0; z-index:50; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.6);" @click.self="showSkinEditor = false">
      <div style="max-width:94vw; max-height:90vh; overflow:auto; padding:20px; background:#1b1e14; border:3px solid #0c0e08; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.06), 0 8px 0 rgba(0,0,0,0.5);">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
          <span style="font-family:var(--mc-font-pixel); font-size:12px; color:#cfeeb0; text-shadow:2px 2px 0 #0c0e08;">SKIN EDITOR · {{ selectedProfile.name }}</span>
          <button @click="showSkinEditor = false" title="关闭皮肤编辑器" aria-label="关闭皮肤编辑器" style="width:30px; height:30px; cursor:pointer; display:flex; align-items:center; justify-content:center; background:#3a2420; border:2px solid #1a0f0d; color:#f0b4b4; font-family:var(--mc-font-pixel); font-size:11px;"><McIcon name="close" :size="12" /></button>
        </div>
        <SkinEditor :texture="selectedSkinTexture" :initModel="selectedSkinModel" @save="saveSkin" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted, nextTick, watch, computed, markRaw } from 'vue';
import { io } from 'socket.io-client';
import PerceptionScene3D from './components/PerceptionScene3D.vue';
import TaskBarPanel from './components/TaskBarPanel.vue';
import AlertBanner from './components/AlertBanner.vue';
import InventoryPanel from './components/InventoryPanel.vue';
import ChatBox from './components/ChatBox.vue';
import BrainPanel from './components/BrainPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import LlmTracePanel from './components/LlmTracePanel.vue';
import McCharacter from './components/McCharacter.vue';
import McHead from './components/McHead.vue';
import McIcon from './components/icons/McIcon.vue';
import SkinEditor from './components/SkinEditor.vue';
import { BRAIN_TAB_IDS, migrateMemoryWorkspaceTabs } from './lib/brainNavigation.js';
import { CONTROL_TAB_IDS, migrateControlTabs, normalizeControlTab } from './lib/controlNavigation.js';
import { useProfileTasks } from './lib/profileTasks.js';

// 无边框窗口控制（仅 Electron 下显示自定义标题栏按钮）
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
const globalSettingsOpen = ref(false);
const globalSettingsSection = ref('llm-configs');

function openGlobalSettings(section = 'llm-configs') {
  globalSettingsSection.value = section;
  globalSettingsOpen.value = true;
}
const winMin = () => window.electronAPI?.minimize();
const winClose = () => window.electronAPI?.close();

const workspaceTabs = [
  { id: 'play', name: '互动' },
  { id: 'brain', name: '大脑' },
  { id: 'trace', name: '轨迹' },
  { id: 'settings', name: '设置' },
];
const tabs = [
  { id: 'status', name: '角色交流' },
  { id: 'tasks', name: '任务栏' },
  { id: 'inventory', name: '背包' },
  { id: 'logs', name: '日志' },
];
const legend = [
  { c: '#5b8cff', t: 'Bot 自身' }, { c: '#ef4444', t: '敌对生物' }, { c: '#22c55e', t: '友好生物' },
  { c: '#3b82f6', t: '玩家' }, { c: '#f59e0b', t: '掉落物' }, { c: '#8a8a8a', t: '固体方块(挡)' },
  { c: '#c9cdbf', t: '可穿过方块' }, { c: '#dc2626', t: '危险方块' }, { c: '#16a34a', t: '资源方块' },
  { c: '#14b8a6', t: '导航路径' },
];
const inputStyle = 'padding:9px 11px; background:#0c0e08; border:2px solid #000; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); color:#e7e3d4; font-family:var(--mc-font-body); font-size:13px;';

const wsConnected = ref(false);
const profiles = ref([]);
const selectedProfile = ref(null);
const workspaceViewsByProfile = ref({});
const brainTabsByProfile = ref({});
const controlTabsByProfile = ref({});
const noProfileWorkspaceView = ref('play');
const validWorkspaceViews = new Set(workspaceTabs.map((tab) => tab.id));
const legacyWorkspaceViews = new Set([...validWorkspaceViews, 'memory']);
const validBrainTabs = new Set(BRAIN_TAB_IDS);
const validControlTabs = new Set(CONTROL_TAB_IDS);

function persistTabMap(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function readTabMap(key, validValues) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => validValues.has(value)));
  } catch {
    return {};
  }
}

const workspaceView = computed({
  get() {
    const profileId = selectedProfile.value?.id;
    const value = profileId ? workspaceViewsByProfile.value[profileId] : noProfileWorkspaceView.value;
    return validWorkspaceViews.has(value) ? value : 'play';
  },
  set(value) {
    if (!validWorkspaceViews.has(value)) value = 'play';
    const profileId = selectedProfile.value?.id;
    if (!profileId) {
      noProfileWorkspaceView.value = value;
      return;
    }
    workspaceViewsByProfile.value = { ...workspaceViewsByProfile.value, [profileId]: value };
    persistTabMap('mc.workspaceTabs.v1', workspaceViewsByProfile.value);
  },
});

const brainTab = computed({
  get() {
    const profileId = selectedProfile.value?.id;
    const value = profileId ? brainTabsByProfile.value[profileId] : 'overview';
    return validBrainTabs.has(value) ? value : 'overview';
  },
  set(value) {
    if (!validBrainTabs.has(value)) value = 'overview';
    const profileId = selectedProfile.value?.id;
    if (!profileId) return;
    brainTabsByProfile.value = { ...brainTabsByProfile.value, [profileId]: value };
    persistTabMap('mc.brainTabs.v1', brainTabsByProfile.value);
  },
});

const ctrlTab = computed({
  get() {
    const profileId = selectedProfile.value?.id;
    const value = profileId ? controlTabsByProfile.value[profileId] : 'status';
    return validControlTabs.has(value) ? value : 'status';
  },
  set(value) {
    if (!validControlTabs.has(value)) value = 'status';
    const profileId = selectedProfile.value?.id;
    if (!profileId) return;
    controlTabsByProfile.value = { ...controlTabsByProfile.value, [profileId]: value };
    persistTabMap('mc.controlTabs.v1', controlTabsByProfile.value);
  },
});

const showCreateForm = ref(false);
const showSkinEditor = ref(false);
const messages = ref([]);
const chatHistoryLoading = ref(false);
const logs = ref([]);
// BUG-WEBUI-05 · 3D 感知默认关闭（重 WebGL），按需开启，状态持久化
const show3D = ref(false);
const followBot = ref(true);
const scene3dRef = ref(null);
function toggle3D() {
  show3D.value = !show3D.value;
  try { localStorage.setItem('mc.show3D', show3D.value ? '1' : '0'); } catch {}
}
function resetSceneCamera() {
  scene3dRef.value?.resetCamera();
  followBot.value = true;
}
const messagesEl = ref(null);
const logsEl = ref(null);
const activeBots = reactive(new Set());
const botStatuses = reactive(new Map());
const worldStates = reactive(new Map());
const {
  tasks: v2Tasks,
  state: v2TaskState,
  error: v2TaskError,
  selectBot: selectTaskBot,
  refresh: refreshV2Tasks,
} = useProfileTasks();
const v2Alerts = ref({ suspendedByDanger: [], recentDiagnoses: [], narrationCooldowns: {} });
const agentLoopSteps = ref([]);
// FEAT-WEBUI-09 · 常驻单思考气泡
const liveThinking = ref('');
const liveThinkExpanded = ref(false);

const currentWorldState = computed(() => {
  if (!selectedProfile.value) return null;
  return worldStates.get(selectedProfile.value.id) || null;
});

const form = ref({
  name: 'LanYi',
  personality: '活泼开朗的冒险伙伴，喜欢探索和帮助人，偶尔有点小调皮',
  host: '127.0.0.1',
  port: 25565,
  auth: 'offline',
});

const currentFullStatus = computed(() => {
  if (!selectedProfile.value) return null;
  return botStatuses.get(selectedProfile.value.id) || null;
});

// FEAT-WEBUI-11 · 当前伙伴皮肤（空串→组件内走默认皮肤）
const selectedSkinTexture = computed(() => selectedProfile.value?.skinTexture || '');
const selectedSkinModel = computed(() => selectedProfile.value?.skinModel || 'slim');

async function saveSkin({ skinTexture, skinModel }) {
  if (!selectedProfile.value) return;
  const id = selectedProfile.value.id;
  try {
    const res = await fetch(`/api/profiles/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skinTexture, skinModel }),
    });
    if (res.ok) {
      const updated = await res.json();
      const i = profiles.value.findIndex((p) => p.id === id);
      if (i >= 0) profiles.value[i] = updated;
      selectedProfile.value = updated;
    }
  } catch { /* ignore */ }
  showSkinEditor.value = false;
}

const onlineCount = computed(() => profiles.value.filter((p) => {
  const s = botStatuses.get(p.id);
  return s && (s.status === 'awake' || s.status === 'online' || s.status === 'busy');
}).length);

const connOk = computed(() => currentFullStatus.value?.connectionStatus === 'connected');
const companionPhase = computed(() => currentFullStatus.value?.companionPhase || (connOk.value ? 'playing' : (activeBots.has(selectedProfile.value?.id) ? 'awake' : 'offline')));
const brainReady = computed(() => companionPhase.value === 'awake' || companionPhase.value === 'playing');
const inGame = computed(() => companionPhase.value === 'playing' || currentFullStatus.value?.embodied === true || connOk.value);

const hpCells = computed(() => {
  const h = currentFullStatus.value?.health;
  return Array.from({ length: 10 }, (_, i) => ({ on: h != null && i * 2 < Math.round(h) }));
});
const fdCells = computed(() => {
  const f = currentFullStatus.value?.food;
  return Array.from({ length: 10 }, (_, i) => ({ on: f != null && i * 2 < Math.round(f) }));
});
const hpLabel = computed(() => currentFullStatus.value?.health != null ? `${Math.round(currentFullStatus.value.health)}/20` : '?/20');
const fdLabel = computed(() => currentFullStatus.value?.food != null ? `${Math.round(currentFullStatus.value.food)}/20` : '?/20');

function statusDot(id) {
  const s = botStatuses.get(id);
  const map = { awake: '#8ee06a', online: '#5fd13a', busy: '#e0a52f', connecting: '#e0a52f', reconnecting: '#e0a52f', offline: '#6b6f5e', error: '#d8503c' };
  return map[s?.status] || '#6b6f5e';
}

const socket = io({ autoConnect: true });
let pendingChatSettle = null;
socket.on('connect', () => { wsConnected.value = true; });
socket.on('disconnect', () => {
  wsConnected.value = false;
  pendingChatSettle?.({ accepted: false });
  pendingChatSettle = null;
});

socket.on('bot:status', (data) => {
  if (['awake', 'online', 'busy', 'connecting', 'reconnecting', 'offline'].includes(data.status)) {
    activeBots.add(data.botId);
  }
});
socket.on('bot:fullStatus', (data) => {
  activeBots.add(data.botId);
  botStatuses.set(data.botId, data);
});
socket.on('bot:chat', (data) => {
  if (selectedProfile.value && data.botId === selectedProfile.value.id) {
    const profile = selectedProfile.value;
    messages.value.push({
      sender: data.sender, message: data.message, timestamp: data.timestamp,
      self: data.sender === (profile.characterCard?.character?.identity?.name || profile.name),
      thinking: data.thinking || '', turnId: data.turnId || '', thinkExpanded: false,
    });
    scrollBottom(messagesEl);
  }
});
socket.on('bot:log', (data) => {
  if (selectedProfile.value && data.botId === selectedProfile.value.id) {
    logs.value.push(data);
    if (logs.value.length > 300) logs.value.shift();
    scrollBottom(logsEl);
  }
});
socket.on('bot:v2:worldState', (data) => {
  // FEAT-WEBUI-12/BUG-WEBUI-04 · markRaw 阻止 Vue 深度代理上千方块对象（否则每秒重代理→主线程卡死）。
  // Map.set 仍触发 currentWorldState 重算+重渲染（按引用变化），只是不再深响应内部。
  worldStates.set(data.botId, markRaw(data.worldState));
});
socket.on('bot:agentLoop', (data) => {
  if (selectedProfile.value && data.botId === selectedProfile.value.id) {
    agentLoopSteps.value.push({ ...data, ts: Date.now() });
    if (agentLoopSteps.value.length > 200) agentLoopSteps.value.splice(0, 50);
    if (data.type === 'l7.thought' && data.data?.thought) liveThinking.value = data.data.thought;
  }
});

const emptyV2Alerts = () => ({ suspendedByDanger: [], recentDiagnoses: [], narrationCooldowns: {} });

async function refreshV2Alerts() {
  const botId = selectedProfile.value?.id;
  if (!botId || workspaceView.value !== 'play' || ctrlTab.value !== 'status') {
    v2Alerts.value = emptyV2Alerts();
    return;
  }
  try {
    const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/v2/supervisor-alerts`);
    if (!response.ok || selectedProfile.value?.id !== botId) {
      v2Alerts.value = emptyV2Alerts();
      return;
    }
    v2Alerts.value = await response.json();
  } catch {
    v2Alerts.value = emptyV2Alerts();
  }
}

const v2AlertPoll = setInterval(() => { void refreshV2Alerts(); }, 2000);

const v2TaskPoll = setInterval(() => { void refreshV2Tasks(); }, 2000);

onUnmounted(() => {
  clearInterval(v2AlertPoll);
  clearInterval(v2TaskPoll);
});

watch(
  () => selectedProfile.value?.id,
  botId => {
    v2Alerts.value = emptyV2Alerts();
    void selectTaskBot(botId);
    void refreshV2Alerts();
  },
  { flush: 'sync' },
);

watch([workspaceView, ctrlTab], ([view, tab]) => {
  if (view === 'play' && tab === 'status') void refreshV2Alerts();
  if (view !== 'play' || tab !== 'status') return;
  void scrollBottom(messagesEl);
});

function selectProfile(p) {
  selectedProfile.value = p;
  showCreateForm.value = false;
  messages.value = [];
  logs.value = [];
  liveThinking.value = '';
  agentLoopSteps.value = [];
  try { localStorage.setItem('mc.selectedProfileId', p?.id ?? ''); } catch {}
  void ensureBrainStarted(p?.id).then(() => loadChatHistory(p));
}

let chatHistoryRequestId = 0;
async function loadChatHistory(profile) {
  const profileId = profile?.id;
  const requestId = ++chatHistoryRequestId;
  if (!profileId) {
    chatHistoryLoading.value = false;
    return;
  }
  chatHistoryLoading.value = true;
  try {
    const response = await fetch(`/api/bots/${profileId}/chat-memory/messages?limit=50`);
    if (!response.ok) throw new Error(`聊天记录加载失败 (${response.status})`);
    const data = await response.json();
    if (requestId !== chatHistoryRequestId || selectedProfile.value?.id !== profileId) return;
    messages.value = (data.messages ?? []).map(message => ({
      id: message.id,
      sender: message.role === 'bot'
        ? (profile.characterCard?.character?.identity?.name || profile.name)
        : (profile.characterCard?.relationship?.userPersona?.name || profile.ownerUsername || '我'),
      message: message.content,
      timestamp: message.timestamp,
      self: message.role === 'bot',
      thinking: '',
      turnId: '',
      thinkExpanded: false,
    }));
    if (messages.value.length === 0 && profile.characterCard?.world?.greeting) {
      messages.value.push({
        id: `greeting-${profileId}`,
        sender: profile.characterCard.character?.identity?.name || profile.name,
        message: profile.characterCard.world.greeting,
        timestamp: profile.createdAt || Date.now(),
        self: true, thinking: '', turnId: '', thinkExpanded: false,
      });
    }
    nextTick(() => scrollBottom(messagesEl));
  } catch (error) {
    if (requestId === chatHistoryRequestId && selectedProfile.value?.id === profileId) {
      logs.value.push({ level: 'error', message: error.message, timestamp: Date.now() });
    }
  } finally {
    if (requestId === chatHistoryRequestId) chatHistoryLoading.value = false;
  }
}

function getPresenceText(id) {
  const s = botStatuses.get(id);
  if (!s) return '离线';
  return getStatusLabel(s.status, s);
}
function getStatusLabel(status, fullStatus = null) {
  if (fullStatus?.companionPhase === 'awake') return '日常陪聊';
  if (fullStatus?.companionPhase === 'playing') return '游戏中';
  const map = { awake: '日常陪聊', online: '在线游戏中', busy: '忙碌中', connecting: '连接中…', reconnecting: '重连中…', offline: '离线', error: '异常' };
  return map[status] || '离线';
}

async function loadProfiles() {
  const res = await fetch('/api/profiles');
  profiles.value = await res.json();
  const bots = await (await fetch('/api/bots')).json();
  for (const bot of bots) {
    activeBots.add(bot.id);
    if (bot.fullStatus) botStatuses.set(bot.id, bot.fullStatus);
  }
  try {
    workspaceViewsByProfile.value = readTabMap('mc.workspaceTabs.v1', legacyWorkspaceViews);
    brainTabsByProfile.value = readTabMap('mc.brainTabs.v1', validBrainTabs);
    const storedControlTabs = JSON.parse(localStorage.getItem('mc.controlTabs.v1') || '{}');
    const controlMigration = migrateControlTabs(storedControlTabs);
    controlTabsByProfile.value = controlMigration.controlTabs;
    if (controlMigration.changed) persistTabMap('mc.controlTabs.v1', controlTabsByProfile.value);
    // FEAT-WEBUI-16：旧顶层“记忆”迁入当前伙伴“大脑 -> 记忆”。
    const memoryMigration = migrateMemoryWorkspaceTabs(workspaceViewsByProfile.value, brainTabsByProfile.value);
    workspaceViewsByProfile.value = memoryMigration.workspaceTabs;
    brainTabsByProfile.value = memoryMigration.brainTabs;
    if (memoryMigration.changed) {
      persistTabMap('mc.workspaceTabs.v1', workspaceViewsByProfile.value);
      persistTabMap('mc.brainTabs.v1', brainTabsByProfile.value);
    }
    // FEAT-WEBUI-19：旧右侧“轨迹(agent)”迁移为伙伴一级工作区，避免保存值失效。
    const legacyControlMap = storedControlTabs;
    if (legacyControlMap && typeof legacyControlMap === 'object' && !Array.isArray(legacyControlMap)) {
      const migratedProfiles = Object.entries(legacyControlMap)
        .filter(([, value]) => value === 'agent')
        .map(([profileId]) => profileId);
      if (migratedProfiles.length) {
        workspaceViewsByProfile.value = { ...workspaceViewsByProfile.value };
        controlTabsByProfile.value = { ...controlTabsByProfile.value };
        for (const profileId of migratedProfiles) {
          workspaceViewsByProfile.value[profileId] = 'trace';
          controlTabsByProfile.value[profileId] = 'status';
        }
        persistTabMap('mc.workspaceTabs.v1', workspaceViewsByProfile.value);
        persistTabMap('mc.controlTabs.v1', controlTabsByProfile.value);
      }
    }
    const savedId = localStorage.getItem('mc.selectedProfileId');
    if (savedId) {
      const found = profiles.value.find((p) => p.id === savedId);
      if (found) selectProfile(found);
    }
    const legacyTab = localStorage.getItem('mc.ctrlTab');
    const selectedId = selectedProfile.value?.id;
    if (selectedId && legacyTab === 'agent') {
      workspaceViewsByProfile.value = { ...workspaceViewsByProfile.value, [selectedId]: 'trace' };
      persistTabMap('mc.workspaceTabs.v1', workspaceViewsByProfile.value);
    } else if (selectedId && normalizeControlTab(legacyTab) && !controlTabsByProfile.value[selectedId]) {
      controlTabsByProfile.value = { ...controlTabsByProfile.value, [selectedId]: normalizeControlTab(legacyTab) };
      persistTabMap('mc.controlTabs.v1', controlTabsByProfile.value);
    }
    localStorage.removeItem('mc.ctrlTab');
    show3D.value = localStorage.getItem('mc.show3D') === '1';
  } catch {}
}

async function onProfileUpdated(updated) {
  if (updated?.id) {
    const i = profiles.value.findIndex((p) => p.id === updated.id);
    if (i >= 0) profiles.value[i] = updated;
    if (selectedProfile.value?.id === updated.id) selectedProfile.value = updated;
  }
  await loadProfiles();
}

async function createProfile() {
  const body = {
    name: form.value.name,
    personality: { description: form.value.personality, style: 'lively' },
    server: { host: form.value.host, port: form.value.port, auth: form.value.auth },
  };
  const res = await fetch('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const profile = await res.json();
  profiles.value.push(profile);
  selectProfile(profile);
  showCreateForm.value = false;
}

async function deleteProfile(id) {
  await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
  profiles.value = profiles.value.filter((p) => p.id !== id);
  if (selectedProfile.value?.id === id) selectedProfile.value = null;
  const { [id]: _workspace, ...remainingWorkspaceViews } = workspaceViewsByProfile.value;
  const { [id]: _brain, ...remainingBrainTabs } = brainTabsByProfile.value;
  const { [id]: _control, ...remainingControlTabs } = controlTabsByProfile.value;
  workspaceViewsByProfile.value = remainingWorkspaceViews;
  brainTabsByProfile.value = remainingBrainTabs;
  controlTabsByProfile.value = remainingControlTabs;
  persistTabMap('mc.workspaceTabs.v1', remainingWorkspaceViews);
  persistTabMap('mc.brainTabs.v1', remainingBrainTabs);
  persistTabMap('mc.controlTabs.v1', remainingControlTabs);
  activeBots.delete(id);
  botStatuses.delete(id);
}

async function ensureBrainStarted(id) {
  if (!id || activeBots.has(id)) return;
  try {
    const data = await (await fetch(`/api/bots/${id}/start`, { method: 'POST' })).json();
    activeBots.add(id);
    if (data.fullStatus) botStatuses.set(id, data.fullStatus);
  } catch (e) {
    logs.value.push({ level: 'error', message: e.message, timestamp: Date.now() });
  }
}

async function reconnectBot() {
  if (!selectedProfile.value) return;
  const res = await fetch(`/api/bots/${selectedProfile.value.id}/reconnect`, { method: 'POST' });
  if (res.ok) botStatuses.set(selectedProfile.value.id, await res.json());
}

async function joinGame() {
  if (!selectedProfile.value) return;
  await ensureBrainStarted(selectedProfile.value.id);
  const res = await fetch(`/api/bots/${selectedProfile.value.id}/join-game`, { method: 'POST' });
  if (res.ok) botStatuses.set(selectedProfile.value.id, await res.json());
}

async function leaveGame() {
  if (!selectedProfile.value) return;
  const res = await fetch(`/api/bots/${selectedProfile.value.id}/leave-game`, { method: 'POST' });
  if (res.ok) botStatuses.set(selectedProfile.value.id, await res.json());
}

function appendChatSubmitError(message, botId) {
  if (!selectedProfile.value || selectedProfile.value.id !== botId) return;
  messages.value.push({
    sender: '发送失败', message, timestamp: Date.now(), self: false, error: true,
    thinking: '', turnId: '', thinkExpanded: false,
  });
  scrollBottom(messagesEl);
}

function sendChat(text, settle = () => {}) {
  const msg = (text ?? '').trim();
  if (!msg || !selectedProfile.value) { settle({ accepted: false }); return; }
  const botId = selectedProfile.value.id;
  if (!socket.connected) {
    appendChatSubmitError('Hub 未连接，消息尚未发送；草稿已保留，请恢复连接后重试。', botId);
    settle({ accepted: false });
    return;
  }
  pendingChatSettle = settle;
  socket.emit('bot:chat', { botId, message: msg }, (result) => {
    if (pendingChatSettle === settle) pendingChatSettle = null;
    if (result?.accepted !== true) {
      appendChatSubmitError(result?.error?.message || '消息未被接收，请稍后重试。', botId);
    }
    settle(result || { accepted: false });
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function scrollBottom(el) {
  await nextTick();
  if (el.value) el.value.scrollTop = el.value.scrollHeight;
}

onMounted(() => { loadProfiles(); });
</script>

<style>
.mineclaw-app { position:relative; display:flex; height:100vh; min-height:100vh; flex-direction:column; overflow:hidden; background:radial-gradient(circle at 30% -20%,rgba(105,201,74,.07),transparent 34%),var(--mc-bg); color:var(--mc-text); font-family:var(--mc-font-body); }
.app-ambient { position:absolute; z-index:0; inset:0; pointer-events:none; background:radial-gradient(ellipse 80% 70% at 50% 48%,transparent 45%,rgba(0,0,0,.28)); }
.app-header { position:relative; z-index:5; flex:none; }
.app-topbar { display:flex; align-items:center; gap:12px; height:60px; padding:0 18px; background:rgba(13,19,15,.96); border-bottom:1px solid var(--mc-border-strong); box-shadow:0 8px 32px rgba(0,0,0,.12); -webkit-app-region:drag; }
.app-brand { display:flex; min-width:0; align-items:center; gap:10px; }
.app-brand-logo { width:34px; height:34px; flex:none; object-fit:contain; }
.app-brand-name { color:var(--mc-text); font-family:var(--mc-font-pixel); font-size:13px; letter-spacing:.02em; white-space:nowrap; }
.app-brand-edition { margin-left:4px; color:var(--mc-text-muted); font:13px/1 var(--mc-font-mono); letter-spacing:.08em; white-space:nowrap; }
.app-header-spacer { flex:1; }
.global-settings-button,.window-control,.icon-button { display:grid; place-items:center; cursor:pointer; background:transparent; border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); color:var(--mc-text-secondary); transition:color var(--mc-duration-fast),background var(--mc-duration-fast),border-color var(--mc-duration-fast); -webkit-app-region:no-drag; }
.global-settings-button { width:36px; height:34px; }
.global-settings-button:hover,.global-settings-button.active,.window-control:hover,.icon-button:hover { background:var(--mc-surface-hover); border-color:var(--mc-border-strong); color:var(--mc-text); }
.app-hub-status { display:flex; align-items:center; gap:8px; height:34px; padding:0 12px; background:var(--mc-accent-soft); border:1px solid rgba(105,201,74,.24); border-radius:var(--mc-radius-sm); color:var(--mc-accent-strong); font-size:12px; font-weight:700; -webkit-app-region:no-drag; }
.app-hub-status .status-indicator { width:7px; height:7px; background:currentColor; border-radius:50%; box-shadow:0 0 10px currentColor; }
.app-hub-status.offline { background:rgba(228,111,101,.1); border-color:rgba(228,111,101,.22); color:var(--mc-danger); }
.window-controls { display:flex; align-items:center; gap:4px; -webkit-app-region:no-drag; }
.window-control { width:30px; height:30px; }
.window-control.danger:hover { background:rgba(228,111,101,.12); border-color:rgba(228,111,101,.3); color:var(--mc-danger); }
.global-settings-layer { position:absolute; z-index:20; inset:60px 0 0; display:flex; min-width:0; min-height:0; background:var(--mc-bg); }
.partner-workspace-shell { position:relative; z-index:2; display:grid; grid-template-columns:240px minmax(0,1fr) 400px; grid-template-rows:auto minmax(0,1fr); flex:1; min-height:0; }
.partner-sidebar { display:flex; grid-column:1; grid-row:1 / 3; min-height:0; flex-direction:column; padding:18px 14px; background:rgba(13,19,15,.98); border-right:1px solid var(--mc-border); }
.partner-sidebar-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; padding:0 4px; }
.section-eyebrow { color:var(--mc-text-muted); font:10px/1 var(--mc-font-pixel); letter-spacing:.04em; }
.icon-button { width:30px; height:30px; }
.icon-button.primary { background:var(--mc-accent); border-color:transparent; color:#081007; }
.icon-button.primary:hover { background:var(--mc-accent-strong); color:#081007; }
.partner-sidebar-title { margin:0 5px 10px; color:var(--mc-text-secondary); font-size:12px; font-weight:700; }
.partner-list { display:flex; min-height:0; flex-direction:column; gap:6px; overflow-y:auto; padding-right:2px; }
.partner-list-item { position:relative; display:flex; width:100%; align-items:center; gap:11px; padding:9px; cursor:pointer; text-align:left; background:transparent; border:1px solid transparent; border-radius:var(--mc-radius-sm); transition:background var(--mc-duration-fast),border-color var(--mc-duration-fast); }
.partner-list-item:hover { background:rgba(255,255,255,.025); border-color:var(--mc-border); }
.partner-list-item.active { background:var(--mc-accent-soft); border-color:rgba(105,201,74,.26); }
.partner-avatar { position:relative; display:flex; width:42px; height:42px; flex:none; align-items:center; justify-content:center; background:var(--mc-bg); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-xs); }
.partner-presence-dot { position:absolute; right:-3px; bottom:-3px; width:10px; height:10px; border:2px solid var(--mc-surface); border-radius:50%; }
.partner-list-summary { display:flex; min-width:0; flex-direction:column; gap:3px; }
.partner-list-summary strong { overflow:hidden; color:var(--mc-text); font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
.partner-list-summary small { color:var(--mc-text-muted); font-size:11px; }
.partner-list-item.active .partner-list-summary small { color:#91b986; }
.partner-list-empty { padding:10px 5px; color:var(--mc-text-muted); font-size:12px; line-height:1.6; }
.partner-sidebar-fill { flex:1; }
.partner-count { margin-top:14px; padding:14px 5px 0; border-top:1px solid var(--mc-border); color:var(--mc-text-muted); font:13px var(--mc-font-mono); letter-spacing:.04em; }
.partner-workspace-bar { display:flex; grid-column:2 / 4; grid-row:1; min-width:0; min-height:62px; align-items:center; gap:20px; padding:10px 16px; background:var(--mc-bg-elevated); border-bottom:1px solid var(--mc-border); }
.workspace-partner { display:flex; min-width:150px; flex:0 0 auto; align-items:center; gap:9px; }
.workspace-partner-head { display:flex; width:36px; height:36px; align-items:center; justify-content:center; overflow:hidden; background:var(--mc-bg); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-xs); }
.workspace-partner-copy { display:flex; min-width:0; flex-direction:column; gap:2px; }
.workspace-partner-copy strong { max-width:180px; overflow:hidden; color:var(--mc-text); font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
.workspace-partner-copy span { color:var(--mc-text-muted); font-size:11px; white-space:nowrap; }
.partner-workspace-tabs { display:flex; min-width:0; align-items:center; gap:4px; overflow-x:auto; scrollbar-width:none; }
.partner-workspace-tabs::-webkit-scrollbar { display:none; }
.partner-workspace-tab { position:relative; min-height:36px; flex:0 0 auto; padding:7px 14px; cursor:pointer; background:transparent; border:1px solid transparent; border-radius:var(--mc-radius-sm); color:var(--mc-text-muted); font-family:var(--mc-font-body); font-size:13px; font-weight:700; white-space:nowrap; transition:color var(--mc-duration-fast),background var(--mc-duration-fast); }
.partner-workspace-tab:hover { background:rgba(255,255,255,.025); color:var(--mc-text-secondary); }
.partner-workspace-tab.active { background:var(--mc-accent-soft); border-color:rgba(105,201,74,.2); color:var(--mc-accent-strong); }
.partner-workspace-tab.active::after { position:absolute; right:12px; bottom:-11px; left:12px; height:2px; background:var(--mc-accent); content:''; }
.partner-workspace-panel { grid-column:2 / 4; grid-row:2; min-width:0; min-height:0; overflow:hidden; }
.play-stage { grid-column:2; grid-row:2; }
.play-control { grid-column:3; grid-row:2; }
.perception-stage { position:relative; min-width:0; min-height:0; overflow:hidden; background:#080c09; border-right:1px solid var(--mc-border); }
.perception-grid { position:absolute; inset:0; background-image:linear-gradient(rgba(151,184,151,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(151,184,151,.035) 1px,transparent 1px); background-size:32px 32px; }
.perception-grid::before { position:absolute; inset:0; background-image:linear-gradient(rgba(105,201,74,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(105,201,74,.04) 1px,transparent 1px); background-size:160px 160px; content:''; }
.perception-vignette { position:absolute; inset:0; pointer-events:none; background:radial-gradient(ellipse 62% 66% at 50% 48%,rgba(25,45,29,.14),transparent 65%),linear-gradient(180deg,rgba(4,8,5,.08),rgba(4,8,5,.3)); }
.perception-scene { position:absolute; z-index:1; inset:0; }
.perception-mode-control { position:absolute; z-index:4; top:18px; right:18px; }
.perception-camera-controls { position:absolute; z-index:3; top:18px; left:50%; display:flex; gap:8px; transform:translateX(-50%); }
.stage-button { display:inline-flex; min-height:34px; align-items:center; gap:7px; padding:7px 12px; cursor:pointer; background:rgba(17,24,19,.9); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-sm); color:var(--mc-text-secondary); font-size:12px; font-weight:700; white-space:nowrap; transition:background var(--mc-duration-fast),border-color var(--mc-duration-fast),color var(--mc-duration-fast); backdrop-filter:blur(10px); }
.stage-button:hover { background:var(--mc-surface-hover); color:var(--mc-text); }
.stage-button.active { background:var(--mc-accent-soft); border-color:rgba(105,201,74,.3); color:var(--mc-accent-strong); }
.stage-button-dot { width:6px; height:6px; background:currentColor; border-radius:50%; }
.perception-online-state,.perception-empty { position:absolute; z-index:1; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column; text-align:center; }
.online-compass { display:grid; width:64px; height:64px; place-items:center; margin-bottom:18px; background:var(--mc-accent-soft); border:1px solid rgba(105,201,74,.25); border-radius:50%; color:var(--mc-accent-strong); box-shadow:0 0 40px rgba(105,201,74,.08); }
.online-state-kicker,.scan-kicker { color:var(--mc-accent); font:12px/1 var(--mc-font-mono); letter-spacing:.16em; }
.online-state-title,.scan-title { margin-top:12px; color:var(--mc-text); font-size:18px; font-weight:700; }
.online-state-copy,.scan-copy { max-width:360px; margin-top:8px; color:var(--mc-text-muted); font-size:12px; line-height:1.65; }
.scan-field { position:relative; display:grid; width:300px; height:300px; place-items:center; margin-bottom:4px; }
.scan-crosshair { position:absolute; z-index:0; background:linear-gradient(90deg,transparent,rgba(105,201,74,.13),transparent); }
.scan-crosshair.horizontal { width:100%; height:1px; }
.scan-crosshair.vertical { width:1px; height:100%; background:linear-gradient(180deg,transparent,rgba(105,201,74,.13),transparent); }
.scan-ring { position:absolute; width:260px; height:260px; border:1px solid rgba(105,201,74,.55); border-radius:50%; opacity:0; animation:perceptionScan 4s linear infinite; will-change:transform,opacity; }
.scan-ring.ring-two { animation-delay:-1s; }
.scan-ring.ring-three { animation-delay:-2s; }
.scan-ring.ring-four { animation-delay:-3s; }
.scan-core { position:relative; z-index:2; display:grid; width:74px; height:74px; place-items:center; background:rgba(13,23,15,.92); border:1px solid rgba(105,201,74,.56); border-radius:50%; box-shadow:0 0 36px rgba(105,201,74,.13),inset 0 0 22px rgba(105,201,74,.05); }
.scan-core::before,.scan-core::after { position:absolute; background:rgba(105,201,74,.35); content:''; }
.scan-core::before { width:96px; height:1px; }
.scan-core::after { width:1px; height:96px; }
.scan-pixel { position:relative; z-index:2; width:15px; height:15px; background:var(--mc-accent-strong); border-radius:2px; box-shadow:0 0 18px var(--mc-accent),0 0 42px rgba(105,201,74,.55); animation:scanPixel 1.8s ease-in-out infinite; }
.sensor-status { display:flex; align-items:center; gap:8px; margin-top:18px; padding:7px 11px; background:rgba(217,170,76,.055); border:1px solid rgba(217,170,76,.14); border-radius:var(--mc-radius-xs); }
.sensor-status > span { width:6px; height:6px; background:var(--mc-warning); border-radius:50%; box-shadow:0 0 8px rgba(217,170,76,.45); }
.sensor-status strong { color:#b89858; font:12px var(--mc-font-mono); letter-spacing:.08em; }
.perception-legend { position:absolute; z-index:3; right:18px; bottom:18px; width:244px; padding:12px; background:rgba(13,19,15,.9); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); box-shadow:0 12px 32px rgba(0,0,0,.2); backdrop-filter:blur(12px); }
.legend-header { display:flex; align-items:center; gap:8px; margin-bottom:10px; color:var(--mc-text-secondary); font:12px var(--mc-font-mono); letter-spacing:.08em; }
.legend-header-mark { width:8px; height:8px; background:var(--mc-accent); border-radius:2px; box-shadow:0 0 8px rgba(105,201,74,.35); }
.legend-grid { display:grid; grid-template-columns:1fr 1fr; gap:7px 9px; }
.legend-item { display:flex; min-width:0; align-items:center; gap:7px; color:var(--mc-text-muted); font-size:10px; }
.legend-item > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.legend-swatch { width:8px; height:8px; flex:none; border-radius:2px; box-shadow:0 0 0 1px rgba(255,255,255,.08); }
@keyframes perceptionScan { 0% { transform:scale(.24); opacity:0; } 14% { opacity:.65; } 78% { opacity:.12; } 100% { transform:scale(1); opacity:0; } }
@keyframes scanPixel { 0%,100% { transform:scale(.86); opacity:.75; } 50% { transform:scale(1); opacity:1; } }
.partner-inspector { display:flex; min-height:0; flex-direction:column; overflow:hidden; padding:16px; background:var(--mc-surface); }
.inspector-header { display:flex; flex:none; align-items:center; gap:11px; }
.inspector-avatar { display:flex; width:50px; height:50px; flex:none; align-items:center; justify-content:center; overflow:hidden; background:var(--mc-bg); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-xs); }
.inspector-identity { min-width:0; flex:1; }
.inspector-name { overflow:hidden; color:var(--mc-text); font-size:18px; font-weight:900; text-overflow:ellipsis; white-space:nowrap; }
.inspector-presence { display:flex; align-items:center; gap:7px; margin-top:4px; }
.inspector-presence > span { width:7px; height:7px; flex:none; border-radius:50%; box-shadow:0 0 8px currentColor; }
.inspector-presence small { overflow:hidden; color:var(--mc-text-muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.inspector-actions { display:flex; flex:none; gap:6px; }
.inspector-button { min-height:34px; padding:7px 12px; cursor:pointer; border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-sm); font-size:12px; font-weight:800; white-space:nowrap; transition:background var(--mc-duration-fast),opacity var(--mc-duration-fast); }
.inspector-button.primary { background:var(--mc-accent); border-color:transparent; color:#081007; }
.inspector-button.primary:hover:not(:disabled) { background:var(--mc-accent-strong); }
.inspector-button.ghost { display:grid; width:34px; padding:0; place-items:center; background:transparent; color:var(--mc-text-muted); }
.inspector-button.danger:hover { background:rgba(228,111,101,.1); border-color:rgba(228,111,101,.28); color:var(--mc-danger); }
.inspector-button:disabled { cursor:not-allowed; opacity:.35; }
.inspector-vitals { display:flex; flex:none; flex-direction:column; gap:9px; margin-top:12px; padding:11px 12px; background:var(--mc-bg); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); }
.vital-row { display:flex; align-items:center; gap:10px; }
.vital-label { width:28px; flex:none; color:var(--mc-danger); font:9px var(--mc-font-pixel); }
.vital-row.food .vital-label { color:var(--mc-warning); }
.vital-cells { display:flex; flex:1; gap:3px; }
.vital-value { flex:none; color:var(--mc-text-secondary); font:16px var(--mc-font-mono); }
.inspector-chips { display:flex; flex:none; flex-wrap:wrap; gap:6px; margin-top:12px; }
.status-chip { display:flex; min-width:0; align-items:center; gap:6px; padding:6px 9px; background:var(--mc-bg-elevated); border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); }
.status-chip > span { flex:none; color:var(--mc-text-muted); font-size:10px; }
.status-chip strong { overflow:hidden; color:var(--mc-text-secondary); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.status-chip.positive { color:var(--mc-accent-strong); }
.status-chip.negative { color:var(--mc-danger); }
.status-chip.positive strong,.status-chip.negative strong { color:currentColor; }
.activity-chip { flex:1; }
.inspector-problem { display:flex; flex:none; align-items:center; gap:8px; margin-top:9px; padding:8px 10px; background:rgba(217,170,76,.07); border:1px solid rgba(217,170,76,.2); border-radius:var(--mc-radius-xs); color:var(--mc-warning); }
.inspector-problem span { flex:none; font-size:11px; }
.inspector-problem strong { overflow:hidden; font:13px var(--mc-font-mono); text-overflow:ellipsis; white-space:nowrap; }
.control-tabs { display:flex; flex:none; gap:3px; margin-top:14px; padding-bottom:8px; border-bottom:1px solid var(--mc-border); }
.control-tab { position:relative; min-height:32px; flex:1; padding:6px 8px; cursor:pointer; background:transparent; border:0; border-radius:var(--mc-radius-xs); color:var(--mc-text-muted); font-size:11px; font-weight:700; white-space:nowrap; transition:background var(--mc-duration-fast),color var(--mc-duration-fast); }
.control-tab:hover { background:rgba(255,255,255,.025); color:var(--mc-text-secondary); }
.control-tab.active { background:var(--mc-accent-soft); color:var(--mc-accent-strong); }
.control-tab.active::after { position:absolute; right:12px; bottom:-9px; left:12px; height:2px; background:var(--mc-accent); content:''; }
.inspector-content { display:flex; min-height:0; flex:1; flex-direction:column; gap:12px; padding-top:12px; }
.interaction-panel { display:flex; min-height:0; flex:1; flex-direction:column; gap:10px; }
.interaction-summary { display:grid; grid-template-columns:130px minmax(0,1fr); flex:0 0 auto; gap:12px; padding:8px; background:var(--mc-bg-elevated); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); }
.interaction-avatar { position:relative; min-height:126px; overflow:hidden; background:linear-gradient(135deg,rgba(105,201,74,.035),transparent),repeating-conic-gradient(#101611 0% 25%,#141b16 0% 50%) 0 0 / 18px 18px; border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); }
.interaction-status-badge { position:absolute; z-index:2; top:7px; right:7px; display:flex; align-items:center; gap:5px; padding:4px 6px; background:rgba(7,11,8,.84); border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); color:var(--mc-text-muted); font:10px var(--mc-font-mono); letter-spacing:.06em; }
.interaction-status-badge > span:first-child { border-radius:50%; }
.interaction-character { height:126px; }
.interaction-summary-copy { display:flex; min-width:0; flex-direction:column; justify-content:center; gap:7px; }
.interaction-summary-title { color:var(--mc-text); font-size:13px; font-weight:800; }
.interaction-summary-state { margin-top:2px; color:var(--mc-accent-strong); font-size:11px; }
.interaction-summary-detail { display:flex; min-width:0; gap:8px; font-size:11px; }
.interaction-summary-detail span { flex:0 0 auto; color:var(--mc-text-muted); }
.interaction-summary-detail strong { overflow:hidden; color:var(--mc-text-secondary); text-overflow:ellipsis; white-space:nowrap; }
.interaction-skin-button { align-self:flex-start; min-height:28px; padding:5px 9px; cursor:pointer; background:transparent; border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-xs); color:var(--mc-text-secondary); font-size:10px; font-weight:700; }
.interaction-skin-button:hover { background:var(--mc-surface-hover); color:var(--mc-text); }
.chat-panel { overflow:hidden; padding:10px; background:var(--mc-bg-elevated); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); }
.interaction-chat { display:flex; min-height:250px; flex:1; flex-direction:column; }
.interaction-messages { display:flex; min-height:0; flex:1; flex-direction:column; gap:10px; overflow-y:auto; padding:2px 3px 8px; }
.chat-state { padding:24px 0; color:var(--mc-text-muted); font-size:11px; text-align:center; }
.chat-message { display:flex; align-items:flex-start; flex-direction:column; }
.chat-message.self { align-items:flex-end; }
.message-bubble { max-width:88%; padding:8px 10px; background:var(--mc-surface-raised); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm) var(--mc-radius-sm) var(--mc-radius-sm) 2px; }
.chat-message.self .message-bubble { background:rgba(105,201,74,.12); border-color:rgba(105,201,74,.2); border-radius:var(--mc-radius-sm) var(--mc-radius-sm) 2px var(--mc-radius-sm); }
.chat-message.error .message-bubble { background:rgba(228,111,101,.09); border-color:rgba(228,111,101,.24); }
.message-sender { margin-bottom:3px; color:#91b986; font-size:9px; font-weight:800; }
.chat-message.self .message-sender { color:var(--mc-accent-strong); }
.chat-message.error .message-sender { color:var(--mc-danger); }
.message-copy { color:var(--mc-text); font-size:12px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }
.chat-message.error .message-copy { color:#e8b0aa; }
.message-time { margin-top:3px; color:#515c53; font:11px var(--mc-font-mono); }
.thinking-card { max-width:88%; margin-bottom:4px; padding:7px 9px; cursor:pointer; background:rgba(126,105,165,.07); border:1px solid rgba(150,127,195,.16); border-radius:var(--mc-radius-xs); }
.thinking-card.live { max-width:none; margin:6px 0; }
.thinking-label { display:inline-flex; align-items:center; gap:5px; color:#9a88b7; font-size:9px; }
.thinking-copy { display:-webkit-box; margin-top:4px; overflow:hidden; color:#9087a1; font-size:11px; line-height:1.45; white-space:pre-wrap; word-break:break-word; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.thinking-copy.expanded { display:block; overflow:visible; }
.inspector-logs { min-height:260px; flex:1; overflow-y:auto; padding:10px; background:var(--mc-bg); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); font-family:var(--mc-font-mono); }
.inspector-logs-empty { color:var(--mc-text-muted); font-size:13px; }
.inspector-log-row { display:flex; gap:8px; padding:3px 0; color:var(--mc-text-muted); font-size:13px; line-height:1.45; }
.inspector-log-row > span,.inspector-log-row > strong { flex:none; }
.inspector-log-row strong { color:var(--mc-accent); font-weight:400; }
.inspector-log-row .level-error { color:var(--mc-danger); }
.inspector-log-row .level-warn { color:var(--mc-warning); }
.inspector-log-row p { margin:0; color:var(--mc-text-secondary); word-break:break-word; }
.inspector-empty { display:flex; min-height:0; flex:1; align-items:center; justify-content:center; flex-direction:column; gap:10px; color:var(--mc-text-muted); text-align:center; }
.inspector-empty-mark { width:42px; height:42px; background:radial-gradient(circle,var(--mc-accent) 0 16%,transparent 17%),radial-gradient(circle,transparent 0 48%,rgba(105,201,74,.28) 49% 51%,transparent 52%); border-radius:50%; }
.inspector-empty strong { color:var(--mc-text-secondary); font-size:14px; }
.inspector-empty span { font-size:11px; }

@media (max-width:1100px) {
  .partner-workspace-shell { grid-template-columns:200px minmax(0,1fr) 350px; }
  .workspace-partner { min-width:130px; }
  .interaction-summary { grid-template-columns:110px minmax(0,1fr); }
}

@media (max-width:860px) {
  .partner-workspace-shell { grid-template-columns:74px minmax(0,1fr); }
  .partner-sidebar { padding:12px 8px; }
  .partner-sidebar-header { justify-content:center; padding:0; }
  .section-eyebrow,.partner-sidebar-title,.partner-list-summary,.partner-count { display:none; }
  .partner-list-item { justify-content:center; padding:7px 5px; }
  .partner-workspace-bar { grid-column:2; gap:10px; padding:8px 10px; }
  .workspace-partner { min-width:0; }
  .workspace-partner-copy span { display:none; }
  .workspace-partner-copy strong { max-width:94px; font-size:12px; }
  .partner-workspace-tab { min-height:32px; padding:6px 10px; font-size:12px; }
  .partner-workspace-panel { grid-column:2; }
  .play-stage { display:none; }
  .play-control { grid-column:2; }
  .partner-inspector { padding:14px; }
}

@media (max-width:640px) {
  .app-topbar { height:54px; padding:0 12px; overflow:hidden; }
  .app-brand { flex:0 0 auto; gap:8px; }
  .app-brand-logo { width:32px; height:32px; }
  .app-brand-name { font-size:11px; }
  .app-brand-edition,.app-hub-status { display:none; }
  .global-settings-layer { inset:54px 0 0; }
  .partner-workspace-shell { grid-template-columns:64px minmax(0,1fr); }
  .partner-sidebar { padding:10px 6px; }
  .partner-avatar { width:40px; height:40px; }
  .partner-workspace-bar { min-height:54px; }
  .workspace-partner { display:none; }
  .partner-workspace-tabs { width:100%; }
  .partner-workspace-tab { flex:1; padding:6px 7px; }
  .partner-inspector { padding:11px; }
  .inspector-header { gap:8px; }
  .inspector-avatar { width:46px; height:46px; }
  .inspector-name { font-size:16px; }
  .inspector-button { padding:6px 9px; }
  .inspector-button.ghost { width:32px; }
  .inspector-chips { margin-top:9px; }
  .status-chip { padding:5px 7px; }
  .control-tabs { margin-top:10px; }
  .control-tab { padding:5px 4px; font-size:10px; }
  .inspector-content { padding-top:9px; }
  .interaction-summary { grid-template-columns:96px minmax(0,1fr); gap:8px; padding:7px; }
  .interaction-avatar,.interaction-character { min-height:106px; height:106px; }
  .interaction-summary-copy { gap:5px; }
  .interaction-summary-title { font-size:12px; }
  .interaction-summary-detail { font-size:10px; }
  .interaction-chat { min-height:230px; }
}
</style>
