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
        </div>

        <div class="app-header-spacer"></div>

        <!-- hub status -->
        <div class="app-hub-menu">
          <button
            class="app-hub-status"
            :class="{ offline: !wsConnected, active: hubMenuOpen }"
            :aria-expanded="hubMenuOpen"
            @click="hubMenuOpen = !hubMenuOpen"
          >
            <span class="status-indicator"></span>
            <span>{{ wsConnected ? 'Hub 已连接' : 'Hub 断开' }}</span>
            <McIcon name="chevron-down" :size="12" />
          </button>
          <div v-if="hubMenuOpen" class="hub-popover">
            <div class="hub-popover-status">
              <span :class="{ offline: !wsConnected }"></span>
              <div><small>Hub 连接状态</small><strong>{{ wsConnected ? '已连接' : '已断开' }}</strong></div>
            </div>
            <button @click="openGlobalSettings('servers'); hubMenuOpen = false"><McIcon name="server" :size="13" />服务器配置</button>
          </div>
        </div>

        <!-- 无边框窗口控制（自定义标题栏）-->
        <div v-if="isElectron" class="window-controls">
          <button class="window-control" @click="winMin" title="最小化" aria-label="最小化"><McIcon name="minus" :size="12" /></button>
          <button class="window-control" @click="winMax" title="最大化或还原" aria-label="最大化或还原"><McIcon name="maximize" :size="12" /></button>
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
    <div
      class="partner-workspace-shell"
      :class="{ 'sidebar-collapsed': sidebarCollapsed, 'is-play-workspace': workspaceView === 'play' }"
    >

      <!-- ---------- LEFT · PARTNERS ---------- -->
      <aside class="partner-sidebar">
        <div class="partner-sidebar-header">
          <span class="partner-sidebar-heading">伙伴</span>
          <button class="icon-button primary" @click="showCreateForm = true" title="创建伙伴" aria-label="创建伙伴"><McIcon name="plus" :size="13" /></button>
        </div>

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
        <div class="partner-sidebar-footer">
          <button class="sidebar-tool primary-tool" :class="{ active: globalSettingsOpen }" @click="openGlobalSettings()" title="全局设置">
            <McIcon name="settings" :size="15" /><span>全局设置</span>
          </button>
          <button class="sidebar-tool collapse-tool" @click="sidebarCollapsed = !sidebarCollapsed" :aria-label="sidebarCollapsed ? '展开伙伴栏' : '折叠伙伴栏'" :title="sidebarCollapsed ? '展开伙伴栏' : '折叠伙伴栏'">
            <McIcon name="collapse" :size="14" />
          </button>
        </div>
      </aside>

      <section class="partner-workspace-bar">
        <nav class="partner-workspace-tabs" aria-label="伙伴工作区">
          <button
            v-for="tab in workspaceTabs"
            :key="tab.id"
            class="partner-workspace-tab"
            :class="{ active: workspaceView === tab.id }"
            @click="workspaceView = tab.id"
          ><McIcon :name="tab.icon" :size="15" />{{ tab.name }}</button>
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
      <!-- ---------- CENTER · 感知空间 ---------- -->
      <main v-else class="play-stage perception-stage">
        <div class="perception-grid" aria-hidden="true"></div>
        <div class="perception-vignette" aria-hidden="true"></div>

        <div class="perception-stage-toolbar">
          <div class="perception-stage-heading">
            <span></span>
            <strong>感知空间</strong>
          </div>
          <div class="world-preview-tabs" role="group" aria-label="世界预览模式">
            <button
              v-for="mode in worldPreviewModeOptions"
              :key="mode.id"
              :class="{ active: worldPreviewMode === mode.id }"
              :aria-pressed="worldPreviewMode === mode.id"
              :disabled="!selectedProfile"
              @click="worldPreviewMode = mode.id"
            >
              <McIcon :name="mode.icon" :size="13" />{{ mode.label }}
            </button>
          </div>
          <button
            class="perception-primary-action"
            :class="{ leave: worldPreviewPresentation.action === 'disconnect' }"
            :disabled="!worldPreviewPresentation.canAct"
            @click="handleWorldConnectionAction"
          >
            <McIcon :name="worldPreviewPresentation.action === 'disconnect' ? 'stop' : 'play'" :size="13" />
            {{ worldPreviewPresentation.actionLabel }}
          </button>
        </div>

        <!-- 真实 3D 感知（默认关闭·按需开启，避免重 WebGL 拖慢界面 BUG-WEBUI-05） -->
        <div v-if="worldPreviewPresentation.shouldMountScene" class="perception-scene">
          <PerceptionScene3D
            ref="scene3dRef"
            :worldState="currentWorldState"
            :skinTexture="selectedSkinTexture"
            :skinModel="selectedSkinModel"
            :profileId="selectedProfile?.id || ''"
            :worldMode="worldMode"
            :visualWorldStore="visualWorldStore"
            :visualWorldRevision="visualWorldRevision"
            :visualWorldStatus="visualWorldStatus"
            :visualWorldConfig="visualWorldConfig"
            v-model:followBot="followBot"
            @request-resync="requestVisualResync"
          />
        </div>

        <!-- 外层视角控件：接到 3D 场景 -->
        <div v-if="worldPreviewPresentation.shouldMountScene" class="perception-camera-controls">
          <button class="stage-button" :class="{ active: followBot }" @click="followBot = !followBot">
            <span class="stage-button-dot"></span>{{ followBot ? '跟随中' : '自由视角' }}
          </button>
          <button class="stage-button" @click="resetSceneCamera">重置视角</button>
        </div>

        <!-- empty state -->
        <div v-if="!worldPreviewPresentation.shouldMountScene" class="perception-empty">
          <div class="scan-field" aria-hidden="true">
            <span class="scan-crosshair horizontal"></span>
            <span class="scan-crosshair vertical"></span>
            <span class="scan-ring ring-one"></span>
            <span class="scan-ring ring-two"></span>
            <span class="scan-ring ring-three"></span>
            <span class="scan-ring ring-four"></span>
            <div class="scan-core">
              <McHead :texture="selectedSkinTexture" :size="24" />
            </div>
          </div>
        </div>
        <div
          v-if="!worldPreviewPresentation.shouldMountScene"
          class="world-preview-state"
          :class="`is-${worldPreviewPresentation.tone}`"
          role="status"
        >
          <span>{{ worldPreviewPresentation.kicker }}</span>
          <strong>{{ worldPreviewPresentation.title }}</strong>
          <p>{{ worldPreviewPresentation.message }}</p>
        </div>

        <!-- 外层图例 -->
        <div class="perception-legend">
          <div class="radar-legend-list">
            <div v-for="item in radarLegend" :key="item.label" class="radar-legend-item">
              <span :class="item.type"></span>
              <strong>{{ item.label }}</strong>
            </div>
          </div>
          <div class="radar-telemetry">
            <span>MODE: {{ perceptionTelemetry.mode }}</span>
            <span>POS: {{ perceptionTelemetry.position }}</span>
            <span>ENTITY: {{ perceptionTelemetry.entities }}</span>
            <span>BLOCK: {{ perceptionTelemetry.blocks }}</span>
          </div>
        </div>
      </main>

      <!-- ---------- RIGHT · 控制面板 ---------- -->
      <aside class="play-control partner-inspector">

        <template v-if="selectedProfile">
        <!-- 伙伴主卡 -->
        <section class="partner-hero-card">
          <div class="inspector-header">
            <div class="inspector-avatar">
              <McHead :texture="selectedSkinTexture" :size="54" />
            </div>
            <div class="inspector-identity">
              <div class="inspector-name">{{ selectedProfile.name }}</div>
              <div class="inspector-presence">
                <span :style="{ background: statusDot(selectedProfile.id) }"></span>
                <small>{{ getStatusLabel(currentFullStatus?.status, currentFullStatus) }}</small>
              </div>
            </div>
            <div class="inspector-actions">
              <button
                class="inspector-button"
                :class="worldPreviewPresentation.action === 'disconnect' ? 'danger' : 'primary'"
                :disabled="!worldPreviewPresentation.canAct"
                @click="handleWorldConnectionAction"
              >
                {{ worldPreviewPresentation.actionLabel }}
              </button>
              <div class="partner-more-menu">
                <button class="inspector-button ghost" @click="partnerMenuOpen = !partnerMenuOpen" aria-label="更多伙伴操作" :aria-expanded="partnerMenuOpen"><McIcon name="more" :size="14" /></button>
                <div v-if="partnerMenuOpen" class="partner-action-popover">
                  <button @click="showSkinEditor = true; partnerMenuOpen = false"><McIcon name="pen" :size="12" />编辑皮肤</button>
                  <button class="danger" @click="deleteProfile(selectedProfile.id); partnerMenuOpen = false"><McIcon name="trash" :size="12" />删除伙伴</button>
                </div>
              </div>
            </div>
          </div>
          <div class="partner-current-state">
            <span>当前状态</span>
            <strong><i :style="{ background: statusDot(selectedProfile.id) }"></i>{{ getStatusLabel(currentFullStatus?.status, currentFullStatus) }}</strong>
          </div>
          <div class="inspector-world-preview">
            <div class="inspector-world-preview-heading">
              <span>世界预览</span>
              <strong>{{ worldPreviewPresentation.modeLabel }}</strong>
            </div>
            <div class="world-preview-tabs inspector-world-preview-tabs" role="group" aria-label="移动端世界预览模式">
              <button
                v-for="mode in worldPreviewModeOptions"
                :key="mode.id"
                :class="{ active: worldPreviewMode === mode.id }"
                :aria-pressed="worldPreviewMode === mode.id"
                @click="worldPreviewMode = mode.id"
              >
                <McIcon :name="mode.icon" :size="12" />{{ mode.label }}
              </button>
            </div>
            <p :class="`is-${worldPreviewPresentation.tone}`">{{ worldPreviewPresentation.title }}</p>
          </div>
        </section>

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

        <!-- problem -->
        <div v-if="inGame && !connOk && currentFullStatus?.serverAddress" class="inspector-problem">
          <McIcon name="warning" :size="12" />
          <span>问题 · 服务器</span>
          <strong>{{ currentFullStatus.serverAddress }}</strong>
        </div>

        <!-- tabs -->
        <nav class="control-tabs" aria-label="伙伴详情">
          <button v-for="t in tabs" :key="t.id" class="control-tab" :class="{ active: ctrlTab === t.id }" @click="ctrlTab = t.id">
            <McIcon :name="t.icon" :size="14" />{{ t.name }}
          </button>
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
                <div class="interaction-summary-title">{{ selectedProfile.name }}</div>
                <div class="interaction-summary-detail">
                  <span>当前状态</span>
                  <strong><i :style="{ background: statusDot(selectedProfile.id) }"></i>{{ getStatusLabel(currentFullStatus?.status, currentFullStatus) }}</strong>
                </div>
                <div class="interaction-summary-detail">
                  <span>位置</span>
                  <strong>{{ currentPositionLabel }}</strong>
                </div>
                <div class="interaction-summary-detail">
                  <span>活动</span>
                  <strong>{{ currentFullStatus?.lastActivity || '暂无最近活动' }}</strong>
                </div>
                <div class="interaction-summary-detail">
                  <span>动作</span>
                  <strong>{{ currentFullStatus?.currentBehavior || '空闲' }}</strong>
                </div>
                <div class="interaction-summary-detail">
                  <span>个性</span>
                  <strong>{{ personalityLabel }}</strong>
                </div>
              </div>
              <button class="interaction-focus-button" @click="showSkinEditor = true" title="查看并编辑角色" aria-label="查看并编辑角色"><McIcon name="focus" :size="13" /></button>
            </div>

            <div class="chat-panel interaction-chat">
              <div class="chat-panel-header">
                <span>聊天记录</span>
                <select v-model="chatFilter" aria-label="筛选聊天记录">
                  <option value="all">全部</option>
                  <option value="partner">伙伴</option>
                  <option value="self">我</option>
                  <option value="error">失败</option>
                </select>
              </div>
              <div ref="messagesEl" class="interaction-messages">
                <div v-if="chatHistoryLoading" class="chat-state">正在加载最近聊天记录…</div>
                <div v-else-if="filteredMessages.length === 0" class="chat-state chat-empty-state"><McIcon name="chat" :size="24" /><span>暂无聊天记录</span></div>
                <div v-for="(msg, i) in filteredMessages" :key="i" class="chat-message" :class="{ self: msg.side === 'viewer', error: msg.error }">
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
          <section v-else-if="ctrlTab === 'logs'" ref="logsEl" class="inspector-logs mc-panel" aria-labelledby="inspector-logs-title">
            <header class="inspector-tool-header">
              <span id="inspector-logs-title"><McIcon name="history" :size="14" />运行日志</span>
              <small>{{ logs.length }} 条</small>
            </header>
            <div v-if="logs.length === 0" class="inspector-logs-empty mc-empty-state">
              <McIcon name="history" :size="24" />
              <h3>暂无运行日志</h3>
              <p>伙伴启动或执行动作后，运行事件会显示在这里。</p>
            </div>
            <div v-else class="inspector-log-list">
              <div v-for="(log, i) in logs" :key="i" class="inspector-log-row">
                <span>{{ formatTime(log.timestamp) }}</span>
                <strong :class="`level-${log.level}`">{{ log.level }}</strong>
                <p>{{ log.message }}</p>
              </div>
            </div>
          </section>

        </div>
        </template>

        <!-- 未选中伙伴 -->
        <div v-else class="inspector-empty">
          <img
            class="inspector-empty-illustration"
            src="/assets/formal-console/partner-empty-illustration.webp"
            width="132"
            height="132"
            alt=""
            aria-hidden="true"
          />
          <strong>选择一个伙伴</strong>
          <span>在左侧挑一个伙伴，或点 + 创建</span>
        </div>
      </aside>
    </div>

    <!-- ===================== 创建表单 overlay ===================== -->
    <div v-if="showCreateForm" class="mc-dialog-backdrop" @click.self="showCreateForm = false" @keydown.esc="showCreateForm = false">
      <section ref="createDialog" class="mc-dialog create-partner-dialog" role="dialog" aria-modal="true" aria-labelledby="create-partner-title" tabindex="-1">
        <header class="mc-dialog-header">
          <div class="mc-dialog-title">
            <h2 id="create-partner-title">新建伙伴</h2>
            <p>取个名字、设定性格，连接到你的 Minecraft 世界。</p>
          </div>
          <button class="mc-button mc-dialog-close" type="button" title="关闭新建伙伴" aria-label="关闭新建伙伴" @click="showCreateForm = false"><McIcon name="close" :size="12" /></button>
        </header>
        <div class="mc-dialog-body">
          <div class="mc-form-grid">
            <label class="mc-field full"><span>名字</span><input v-model="form.name" class="mc-field-control" /></label>
            <label class="mc-field full"><span>性格描述</span><input v-model="form.personality" class="mc-field-control" /></label>
            <label class="mc-field"><span>MC 服务器地址</span><input v-model="form.host" class="mc-field-control" /></label>
            <label class="mc-field"><span>端口</span><input v-model.number="form.port" class="mc-field-control" type="number" /></label>
            <label class="mc-field"><span>验证方式</span><select v-model="form.auth" class="mc-field-control"><option value="offline">离线模式</option><option value="microsoft">微软登录</option></select></label>
          </div>
        </div>
        <footer class="mc-dialog-footer">
          <button class="mc-button" type="button" @click="showCreateForm = false">取消</button>
          <button class="mc-button primary" type="button" @click="createProfile">创建伙伴</button>
        </footer>
      </section>
    </div>

    <!-- ===================== 皮肤编辑器 overlay ===================== -->
    <div v-if="showSkinEditor && selectedProfile" class="mc-dialog-backdrop" @click.self="showSkinEditor = false" @keydown.esc="showSkinEditor = false">
      <section ref="skinDialog" class="mc-dialog wide" role="dialog" aria-modal="true" aria-labelledby="skin-editor-title" tabindex="-1">
        <header class="mc-dialog-header">
          <div class="mc-dialog-title">
            <h2 id="skin-editor-title">皮肤编辑器 · {{ selectedProfile.name }}</h2>
            <p>编辑 64×64 皮肤纹理并实时预览角色外观。</p>
          </div>
          <button class="mc-button mc-dialog-close" type="button" @click="showSkinEditor = false" title="关闭皮肤编辑器" aria-label="关闭皮肤编辑器"><McIcon name="close" :size="12" /></button>
        </header>
        <div class="mc-dialog-body">
          <SkinEditor :texture="selectedSkinTexture" :initModel="selectedSkinModel" @save="saveSkin" />
        </div>
      </section>
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
import { filterChatMessages, projectChatMessage } from './lib/chatPresentation.js';
import { useProfileTasks } from './lib/profileTasks.js';
import { VisualWorldStore } from './lib/authentic/visualWorldStore.js';
import {
  WORLD_PREVIEW_MODES,
  migrateWorldPreviewModes,
  normalizeWorldPreviewMode,
  projectWorldPreview,
} from './lib/worldPreviewPresentation.js';

// 无边框窗口控制（仅 Electron 下显示自定义标题栏按钮）
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;
const globalSettingsOpen = ref(false);
const globalSettingsSection = ref('llm-configs');
const hubMenuOpen = ref(false);
const sidebarCollapsed = ref(false);
const partnerMenuOpen = ref(false);

function openGlobalSettings(section = 'llm-configs') {
  globalSettingsSection.value = section;
  globalSettingsOpen.value = true;
}
const winMin = () => window.electronAPI?.minimize();
const winMax = () => window.electronAPI?.toggleMaximize?.();
const winClose = () => window.electronAPI?.close();

const workspaceTabs = [
  { id: 'play', name: '互动', icon: 'chat' },
  { id: 'brain', name: '大脑', icon: 'brain' },
  { id: 'trace', name: '轨迹', icon: 'route' },
  { id: 'settings', name: '设置', icon: 'settings' },
];
const tabs = [
  { id: 'status', name: '角色交流', icon: 'chat' },
  { id: 'tasks', name: '任务栏', icon: 'task' },
  { id: 'inventory', name: '背包', icon: 'backpack' },
  { id: 'logs', name: '日志', icon: 'history' },
];
const radarLegend = [
  { type: 'beacon', label: '伙伴信标' },
  { type: 'range', label: '感知范围' },
  { type: 'medium', label: '中等强度' },
  { type: 'edge', label: '边缘感知' },
];
const worldPreviewModeOptions = [
  { id: 'radar', label: '雷达', icon: 'compass' },
  { id: 'simple', label: '简略', icon: 'world' },
  { id: 'authentic', label: '真实', icon: 'eye' },
];

const wsConnected = ref(false);
const profiles = ref([]);
const selectedProfile = ref(null);
const workspaceViewsByProfile = ref({});
const brainTabsByProfile = ref({});
const controlTabsByProfile = ref({});
const worldModesByProfile = ref({});
const worldPreviewModesByProfile = ref({});
const noProfileWorkspaceView = ref('play');
const validWorkspaceViews = new Set(workspaceTabs.map((tab) => tab.id));
const legacyWorkspaceViews = new Set([...validWorkspaceViews, 'memory']);
const validBrainTabs = new Set(BRAIN_TAB_IDS);
const validControlTabs = new Set(CONTROL_TAB_IDS);
const validWorldModes = new Set(['simple', 'authentic']);
const validWorldPreviewModes = new Set(WORLD_PREVIEW_MODES);

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

const worldMode = computed({
  get() {
    const profileId = selectedProfile.value?.id;
    const value = profileId ? worldModesByProfile.value[profileId] : 'simple';
    return validWorldModes.has(value) ? value : 'simple';
  },
  set(value) {
    const profileId = selectedProfile.value?.id;
    if (!profileId || !validWorldModes.has(value)) return;
    worldModesByProfile.value = { ...worldModesByProfile.value, [profileId]: value };
    persistTabMap('mc.worldModes.v1', worldModesByProfile.value);
  },
});

const worldPreviewMode = computed({
  get() {
    const profileId = selectedProfile.value?.id;
    const value = profileId ? worldPreviewModesByProfile.value[profileId] : 'radar';
    return normalizeWorldPreviewMode(value);
  },
  set(value) {
    const profileId = selectedProfile.value?.id;
    const normalized = normalizeWorldPreviewMode(value);
    if (!profileId) return;
    worldPreviewModesByProfile.value = {
      ...worldPreviewModesByProfile.value,
      [profileId]: normalized,
    };
    persistTabMap('mc.worldPreviewModes.v1', worldPreviewModesByProfile.value);
    if (normalized !== 'radar') worldMode.value = normalized;
    try { localStorage.setItem('mc.show3D', normalized === 'radar' ? '0' : '1'); } catch {}
  },
});

const showCreateForm = ref(false);
const showSkinEditor = ref(false);
const createDialog = ref(null);
const skinDialog = ref(null);
watch(showCreateForm, async (open) => {
  if (!open) return;
  await nextTick();
  createDialog.value?.focus();
});
watch(showSkinEditor, async (open) => {
  if (!open) return;
  await nextTick();
  skinDialog.value?.focus();
});
const messages = ref([]);
const chatFilter = ref('all');
const chatHistoryLoading = ref(false);
const logs = ref([]);
// BUG-WEBUI-05/14 · 默认雷达不挂载 WebGL；用户显式选择简略/真实后才启动 3D。
const show3D = computed(() => worldPreviewMode.value !== 'radar');
const followBot = ref(true);
const scene3dRef = ref(null);
function resetSceneCamera() {
  scene3dRef.value?.resetCamera();
  followBot.value = true;
}
const messagesEl = ref(null);
const logsEl = ref(null);
const activeBots = reactive(new Set());
const botStatuses = reactive(new Map());
const worldStates = reactive(new Map());
const worldConnectionActions = reactive(new Map());
const worldConnectionErrors = reactive(new Map());
const visualWorldStore = ref(null);
const visualWorldRevision = ref(0);
const visualWorldStatus = ref({ state: 'idle', message: '' });
const visualWorldConfig = ref(null);
let subscribedVisualBotId = null;
let visualSubscriptionRequest = 0;
let visualResyncPending = false;
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

const perceptionTelemetry = computed(() => {
  const state = currentWorldState.value;
  const position = state?.self?.position;
  const positionText = position && [position.x, position.y, position.z].every(Number.isFinite)
    ? `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
    : '—';
  const modeText = worldPreviewMode.value === 'authentic'
    ? (state ? 'REAL' : 'REAL WAIT')
    : worldPreviewMode.value === 'simple'
      ? (state ? 'SIMPLE' : 'SIMPLE WAIT')
      : 'RADAR';
  return {
    mode: modeText,
    position: positionText,
    entities: Array.isArray(state?.entities) ? state.entities.length : '—',
    blocks: Array.isArray(state?.blocks) ? state.blocks.length : '—',
  };
});

const currentPositionLabel = computed(() => perceptionTelemetry.value.position);
const personalityLabel = computed(() => {
  const personality = selectedProfile.value?.personality;
  if (typeof personality === 'string' && personality.trim()) return personality;
  if (typeof personality?.description === 'string' && personality.description.trim()) return personality.description;
  const traits = personality?.traits;
  if (Array.isArray(traits) && traits.length) return traits.join('、');
  return '—';
});
const filteredMessages = computed(() => {
  return filterChatMessages(messages.value, chatFilter.value);
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

const connOk = computed(() => currentFullStatus.value?.connectionStatus === 'connected');
const companionPhase = computed(() => currentFullStatus.value?.companionPhase || (connOk.value ? 'playing' : (activeBots.has(selectedProfile.value?.id) ? 'awake' : 'offline')));
const brainReady = computed(() => companionPhase.value === 'awake' || companionPhase.value === 'playing');
const inGame = computed(() => companionPhase.value === 'playing' || currentFullStatus.value?.embodied === true || connOk.value);
const currentWorldConnectionAction = computed(() => {
  const profileId = selectedProfile.value?.id;
  return profileId ? (worldConnectionActions.get(profileId) || '') : '';
});
const currentWorldConnectionError = computed(() => {
  const profileId = selectedProfile.value?.id;
  return profileId ? (worldConnectionErrors.get(profileId) || '') : '';
});
const worldPreviewPresentation = computed(() => projectWorldPreview({
  mode: worldPreviewMode.value,
  hasProfile: Boolean(selectedProfile.value),
  hubConnected: wsConnected.value,
  brainReady: brainReady.value,
  inGame: inGame.value,
  connectionStatus: currentFullStatus.value?.connectionStatus,
  lastError: currentWorldConnectionError.value || currentFullStatus.value?.lastError,
  hasWorldState: Boolean(currentWorldState.value),
  pendingAction: currentWorldConnectionAction.value,
}));

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
  visualSubscriptionRequest += 1;
  pendingChatSettle?.({ accepted: false });
  pendingChatSettle = null;
  subscribedVisualBotId = null;
  visualWorldStore.value = null;
  visualWorldRevision.value += 1;
  visualWorldStatus.value = { state: 'idle', message: 'Hub 已断开' };
});

socket.on('bot:status', (data) => {
  if (['awake', 'online', 'busy', 'connecting', 'reconnecting', 'offline'].includes(data.status)) {
    activeBots.add(data.botId);
  }
});
socket.on('bot:fullStatus', (data) => {
  activeBots.add(data.botId);
  botStatuses.set(data.botId, data);
  if (data.connectionStatus === 'connected' && !data.lastError) worldConnectionErrors.delete(data.botId);
});
socket.on('bot:chat', (data) => {
  if (selectedProfile.value && data.botId === selectedProfile.value.id) {
    messages.value.push(projectChatMessage({
      role: data.role, sender: data.sender, message: data.message, timestamp: data.timestamp,
      thinking: data.thinking || '', turnId: data.turnId || '', thinkExpanded: false,
    }, selectedProfile.value));
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
socket.on('bot:v2:visualWorld:bootstrap', data => {
  if (data.botId !== subscribedVisualBotId || !visualWorldStore.value) return;
  const ok = visualWorldStore.value.applyBootstrap(data.bootstrap);
  visualWorldRevision.value += 1;
  visualResyncPending = false;
  visualWorldStatus.value = ok
    ? { state: 'ready', message: `真实世界 · ${data.bootstrap.gameVersion} · ${data.bootstrap.sections.length} 区段` }
    : { state: 'error', message: `视觉世界重建失败：${visualWorldStore.value.resyncReason}` };
});
socket.on('bot:v2:visualWorld:delta', data => {
  if (data.botId !== subscribedVisualBotId || !visualWorldStore.value) return;
  const ok = visualWorldStore.value.receiveBatch(data.batch);
  visualWorldRevision.value += 1;
  if (!ok) requestVisualResync();
});

async function ensureVisualWorldConfig() {
  if (visualWorldConfig.value) return visualWorldConfig.value;
  return refreshVisualWorldConfig();
}

async function refreshVisualWorldConfig() {
  const response = await fetch('/api/visual-world/config');
  if (!response.ok) throw new Error(`视觉配置加载失败 (${response.status})`);
  const next = await response.json();
  if (visualWorldConfig.value) Object.assign(visualWorldConfig.value, next);
  else visualWorldConfig.value = next;
  return visualWorldConfig.value;
}

function stopVisualSubscription({ clear = true } = {}) {
  visualSubscriptionRequest += 1;
  if (subscribedVisualBotId && socket.connected) {
    socket.emit('bot:v2:visualWorld:unsubscribe', { botId: subscribedVisualBotId });
  }
  subscribedVisualBotId = null;
  visualResyncPending = false;
  if (clear) {
    visualWorldStore.value = null;
    visualWorldRevision.value += 1;
  }
}

async function syncVisualSubscription() {
  const botId = selectedProfile.value?.id ?? '';
  const shouldSubscribe = Boolean(botId && wsConnected.value && inGame.value && show3D.value && worldMode.value === 'authentic');
  if (!shouldSubscribe) {
    if (subscribedVisualBotId) stopVisualSubscription();
    return;
  }
  if (subscribedVisualBotId === botId && visualWorldStore.value) return;
  stopVisualSubscription();
  const request = ++visualSubscriptionRequest;
  try {
    const config = await ensureVisualWorldConfig();
    if (request !== visualSubscriptionRequest) return;
    visualWorldStore.value = markRaw(new VisualWorldStore(config));
    subscribedVisualBotId = botId;
    visualWorldStatus.value = { state: 'loading', message: '正在构建真实世界首帧…' };
    socket.emit('bot:v2:visualWorld:subscribe', { botId }, result => {
      if (request !== visualSubscriptionRequest || result?.ok) return;
      subscribedVisualBotId = null;
      visualWorldStore.value = null;
      visualWorldStatus.value = {
        state: 'error',
        message: result?.reason === 'visual_world_unavailable' ? 'Bot 尚未进入可视世界' : '真实世界订阅失败',
      };
    });
  } catch (error) {
    if (request !== visualSubscriptionRequest) return;
    subscribedVisualBotId = null;
    visualWorldStore.value = null;
    visualWorldStatus.value = { state: 'error', message: error.message };
  }
}

function requestVisualResync() {
  if (!subscribedVisualBotId || visualResyncPending || !socket.connected) return;
  visualResyncPending = true;
  visualWorldStatus.value = { state: 'loading', message: '检测到序列缺口，正在重建世界…' };
  socket.emit('bot:v2:visualWorld:resync', { botId: subscribedVisualBotId }, result => {
    if (result?.ok) return;
    visualResyncPending = false;
    visualWorldStatus.value = { state: 'error', message: '真实世界重建失败' };
  });
}
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
const visualConfigPoll = setInterval(() => {
  if (show3D.value && worldMode.value === 'authentic' && wsConnected.value) void refreshVisualWorldConfig().catch(() => {});
}, 1000);

onUnmounted(() => {
  clearInterval(v2AlertPoll);
  clearInterval(v2TaskPoll);
  clearInterval(visualConfigPoll);
  stopVisualSubscription();
});

watch(
  [() => selectedProfile.value?.id, inGame, show3D, worldMode, wsConnected],
  () => { void syncVisualSubscription(); },
  { flush: 'post' },
);

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
    messages.value = (data.messages ?? []).map(message => projectChatMessage({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      thinking: '',
      turnId: '',
      thinkExpanded: false,
    }, profile));
    if (messages.value.length === 0 && profile.characterCard?.world?.greeting) {
      messages.value.push(projectChatMessage({
        id: `greeting-${profileId}`,
        role: 'bot',
        sender: profile.characterCard.character?.identity?.name || profile.name,
        message: profile.characterCard.world.greeting,
        timestamp: profile.createdAt || Date.now(),
        thinking: '', turnId: '', thinkExpanded: false,
      }, profile));
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
    worldModesByProfile.value = readTabMap('mc.worldModes.v1', validWorldModes);
    const previewMigration = migrateWorldPreviewModes({
      storedModes: readTabMap('mc.worldPreviewModes.v1', validWorldPreviewModes),
      profileIds: profiles.value.map((profile) => profile.id),
      legacyShow3D: localStorage.getItem('mc.show3D'),
      legacyWorldModes: worldModesByProfile.value,
    });
    worldPreviewModesByProfile.value = previewMigration.modes;
    if (previewMigration.changed) persistTabMap('mc.worldPreviewModes.v1', previewMigration.modes);
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

async function readActionResponse(response) {
  try { return await response.json(); }
  catch { return {}; }
}

async function joinGame() {
  if (!selectedProfile.value) return;
  const botId = selectedProfile.value.id;
  if (worldConnectionActions.has(botId)) return;
  worldConnectionActions.set(botId, 'connect');
  worldConnectionErrors.delete(botId);
  try {
    await ensureBrainStarted(botId);
    const response = await fetch(`/api/bots/${botId}/join-game`, { method: 'POST' });
    const data = await readActionResponse(response);
    if (!response.ok) {
      worldConnectionErrors.set(botId, data.error || `连接请求失败 (${response.status})`);
      return;
    }
    botStatuses.set(botId, data);
  } catch (error) {
    worldConnectionErrors.set(botId, error instanceof Error ? error.message : String(error));
  } finally {
    worldConnectionActions.delete(botId);
  }
}

async function leaveGame() {
  if (!selectedProfile.value) return;
  const botId = selectedProfile.value.id;
  if (worldConnectionActions.has(botId)) return;
  worldConnectionActions.set(botId, 'disconnect');
  worldConnectionErrors.delete(botId);
  try {
    const response = await fetch(`/api/bots/${botId}/leave-game`, { method: 'POST' });
    const data = await readActionResponse(response);
    if (!response.ok) {
      worldConnectionErrors.set(botId, data.error || `断开请求失败 (${response.status})`);
      return;
    }
    botStatuses.set(botId, data);
  } catch (error) {
    worldConnectionErrors.set(botId, error instanceof Error ? error.message : String(error));
  } finally {
    worldConnectionActions.delete(botId);
  }
}

function handleWorldConnectionAction() {
  if (!worldPreviewPresentation.value.canAct) return;
  if (worldPreviewPresentation.value.action === 'disconnect') void leaveGame();
  else void joinGame();
}

function appendChatSubmitError(message, botId) {
  if (!selectedProfile.value || selectedProfile.value.id !== botId) return;
  messages.value.push(projectChatMessage({
    role: 'system', sender: '发送失败', message, timestamp: Date.now(), error: true,
    thinking: '', turnId: '', thinkExpanded: false,
  }, selectedProfile.value));
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
.mineclaw-app { position:relative; display:flex; height:100vh; min-height:100vh; flex-direction:column; overflow:hidden; background-color:var(--mc-bg); background-image:radial-gradient(circle at 30% -20%,rgba(105,201,74,.08),transparent 34%),linear-gradient(rgba(9,13,11,.78),rgba(9,13,11,.78)),url('/assets/formal-console/console-ambient-bg.webp'); background-position:center; background-size:cover; color:var(--mc-text); font-family:var(--mc-font-body); }
.app-ambient { position:absolute; z-index:0; inset:0; pointer-events:none; background:radial-gradient(ellipse 80% 70% at 50% 48%,transparent 45%,rgba(0,0,0,.28)); }
.app-header { position:relative; z-index:5; flex:none; }
.app-topbar { display:flex; align-items:center; gap:12px; height:60px; padding:0 18px; background:rgba(13,19,15,.96); border-bottom:1px solid var(--mc-border-strong); box-shadow:0 8px 32px rgba(0,0,0,.12); -webkit-app-region:drag; }
.app-brand { display:flex; min-width:0; align-items:center; gap:10px; }
.app-brand-logo { width:34px; height:34px; flex:none; object-fit:contain; }
.app-brand-name { color:var(--mc-text); font-family:var(--mc-font-pixel); font-size:13px; letter-spacing:.02em; white-space:nowrap; }
.app-header-spacer { flex:1; }
.window-control,.icon-button { display:grid; place-items:center; cursor:pointer; background:transparent; border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); color:var(--mc-text-secondary); transition:color var(--mc-duration-fast),background var(--mc-duration-fast),border-color var(--mc-duration-fast); -webkit-app-region:no-drag; }
.window-control:hover,.icon-button:hover { background:var(--mc-surface-hover); border-color:var(--mc-border-strong); color:var(--mc-text); }
.app-hub-menu { position:relative; -webkit-app-region:no-drag; }
.app-hub-status { display:flex; align-items:center; gap:8px; height:34px; padding:0 12px; cursor:pointer; background:rgba(12,19,14,.82); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); color:var(--mc-accent-strong); font-size:var(--mc-type-secondary); font-weight:700; transition:background var(--mc-duration-fast),border-color var(--mc-duration-fast); }
.app-hub-status:hover,.app-hub-status.active { background:var(--mc-accent-soft); border-color:rgba(105,201,74,.28); }
.app-hub-status .status-indicator { width:7px; height:7px; background:currentColor; border-radius:50%; box-shadow:0 0 10px currentColor; }
.app-hub-status.offline { background:rgba(228,111,101,.1); border-color:rgba(228,111,101,.22); color:var(--mc-danger); }
.hub-popover { position:absolute; z-index:40; top:41px; right:0; width:214px; padding:8px; background:rgba(14,21,16,.98); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-sm); box-shadow:0 18px 40px rgba(0,0,0,.36); }
.hub-popover-status { display:flex; align-items:center; gap:10px; padding:9px 10px 10px; border-bottom:1px solid var(--mc-border); }
.hub-popover-status > span { width:8px; height:8px; flex:none; background:var(--mc-accent); border-radius:50%; box-shadow:0 0 9px rgba(105,201,74,.55); }
.hub-popover-status > span.offline { background:var(--mc-danger); box-shadow:0 0 9px rgba(228,111,101,.42); }
.hub-popover-status div { display:flex; min-width:0; flex-direction:column; gap:2px; }
.hub-popover-status small { color:var(--mc-text-muted); font-size:var(--mc-type-micro); }
.hub-popover-status strong { color:var(--mc-text); font-size:var(--mc-type-secondary); }
.hub-popover > button { display:flex; width:100%; align-items:center; gap:8px; margin-top:6px; padding:8px 10px; cursor:pointer; text-align:left; background:transparent; border:0; border-radius:var(--mc-radius-xs); color:var(--mc-text-secondary); font-size:var(--mc-type-body); }
.hub-popover > button:hover { background:var(--mc-surface-hover); color:var(--mc-text); }
.window-controls { display:flex; align-items:center; gap:4px; -webkit-app-region:no-drag; }
.window-control { width:30px; height:30px; }
.window-control.danger:hover { background:rgba(228,111,101,.12); border-color:rgba(228,111,101,.3); color:var(--mc-danger); }
.global-settings-layer { position:absolute; z-index:20; inset:60px 0 0; display:flex; min-width:0; min-height:0; background:var(--mc-bg); }
.partner-workspace-shell { position:relative; z-index:2; display:grid; grid-template-columns:clamp(220px,16.63vw,278px) minmax(0,1fr) clamp(340px,24.88vw,416px); grid-template-rows:50px minmax(0,1fr); column-gap:14px; flex:1; min-height:0; padding:14px 14px 14px 0; transition:grid-template-columns var(--mc-duration-normal); }
.partner-workspace-shell.sidebar-collapsed { grid-template-columns:72px minmax(0,1fr) clamp(340px,24.88vw,416px); }
.partner-sidebar { --partner-sidebar-inline-padding:14px; display:flex; grid-column:1; grid-row:1 / 3; min-height:0; flex-direction:column; margin-top:-14px; margin-bottom:-14px; padding:18px var(--partner-sidebar-inline-padding) 0; background:rgba(13,19,15,.98); border-right:1px solid var(--mc-border); }
.partner-sidebar-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; padding:0 4px; }
.partner-sidebar-heading { color:var(--mc-text-secondary); font-size:var(--mc-type-body); font-weight:800; }
.icon-button { width:30px; height:30px; }
.icon-button.primary { background:var(--mc-accent); border-color:transparent; color:#081007; }
.icon-button.primary:hover { background:var(--mc-accent-strong); color:#081007; }
.partner-list { display:flex; min-height:0; flex-direction:column; gap:6px; overflow-y:auto; padding-right:2px; }
.partner-list-item { position:relative; display:flex; width:100%; align-items:center; gap:11px; padding:9px; cursor:pointer; text-align:left; background:transparent; border:1px solid transparent; border-radius:var(--mc-radius-sm); transition:background var(--mc-duration-fast),border-color var(--mc-duration-fast); }
.partner-list-item:hover { background:rgba(255,255,255,.025); border-color:var(--mc-border); }
.partner-list-item.active { background:var(--mc-accent-soft); border-color:rgba(105,201,74,.26); }
.partner-avatar { position:relative; display:flex; width:42px; height:42px; flex:none; align-items:center; justify-content:center; background:var(--mc-bg); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-xs); }
.partner-presence-dot { position:absolute; right:-3px; bottom:-3px; width:10px; height:10px; border:2px solid var(--mc-surface); border-radius:50%; }
.partner-list-summary { display:flex; min-width:0; flex-direction:column; gap:3px; }
.partner-list-summary strong { overflow:hidden; color:var(--mc-text); font-size:var(--mc-type-body); text-overflow:ellipsis; white-space:nowrap; }
.partner-list-summary small { color:var(--mc-text-muted); font-size:var(--mc-type-meta); }
.partner-list-item.active .partner-list-summary small { color:#91b986; }
.partner-list-empty { padding:10px 5px; color:var(--mc-text-muted); font-size:var(--mc-type-secondary); line-height:1.6; }
.partner-sidebar-fill { flex:1; }
.partner-sidebar-footer { display:flex; flex:none; gap:6px; margin:0 calc(-1 * var(--partner-sidebar-inline-padding)); padding:10px 10px; border-top:1px solid var(--mc-border); }
.sidebar-tool { display:flex; min-height:36px; align-items:center; justify-content:center; gap:8px; cursor:pointer; background:transparent; border:1px solid transparent; border-radius:var(--mc-radius-xs); color:var(--mc-text-muted); font-size:var(--mc-type-body); font-weight:700; }
.sidebar-tool:hover,.sidebar-tool.active { background:var(--mc-surface-hover); border-color:var(--mc-border); color:var(--mc-text-secondary); }
.sidebar-tool.primary-tool { flex:1; justify-content:flex-start; padding:0 10px; }
.sidebar-tool.collapse-tool { width:36px; flex:none; }
.sidebar-tool.collapse-tool .mc-icon { transition:transform var(--mc-duration-normal); }
.sidebar-collapsed .collapse-tool .mc-icon { transform:rotate(180deg); }
.sidebar-collapsed .partner-sidebar-heading,.sidebar-collapsed .partner-list-summary,.sidebar-collapsed .sidebar-tool span { display:none; }
.sidebar-collapsed .partner-sidebar-header { justify-content:center; padding:0; }
.sidebar-collapsed .partner-list-item { justify-content:center; padding:7px 5px; }
.sidebar-collapsed .partner-sidebar-footer { justify-content:center; flex-direction:column; align-items:center; }
.sidebar-collapsed .sidebar-tool.primary-tool { width:36px; flex:none; padding:0; }
.partner-workspace-bar { display:flex; grid-column:2; grid-row:1; min-width:0; align-items:center; background:rgba(12,18,14,.88); border:1px solid var(--mc-border); border-bottom:0; border-radius:var(--mc-radius-sm) var(--mc-radius-sm) 0 0; }
.partner-workspace-tabs { display:flex; width:100%; min-width:0; height:100%; align-items:stretch; overflow-x:auto; scrollbar-width:none; }
.partner-workspace-tabs::-webkit-scrollbar { display:none; }
.partner-workspace-tab { position:relative; display:inline-flex; min-width:120px; min-height:49px; flex:0 0 auto; align-items:center; justify-content:center; gap:9px; padding:0 18px; cursor:pointer; background:transparent; border:0; border-right:1px solid var(--mc-border); color:var(--mc-text-muted); font-family:var(--mc-font-body); font-size:var(--mc-type-body); font-weight:700; white-space:nowrap; transition:color var(--mc-duration-fast),background var(--mc-duration-fast); }
.partner-workspace-tab:hover { background:rgba(255,255,255,.025); color:var(--mc-text-secondary); }
.partner-workspace-tab.active { background:linear-gradient(180deg,rgba(105,201,74,.1),rgba(105,201,74,.035)); color:var(--mc-accent-strong); }
.partner-workspace-tab.active::after { position:absolute; right:0; bottom:-1px; left:0; height:2px; background:var(--mc-accent); content:''; }
.partner-workspace-panel { grid-column:2; grid-row:2; min-width:0; min-height:0; overflow:hidden; border:1px solid var(--mc-border); }
.play-stage { grid-column:2; grid-row:2; }
.play-control { grid-column:3; grid-row:1 / 3; }
.perception-stage { position:relative; min-width:0; min-height:0; overflow:hidden; background-color:#080c09; background-image:linear-gradient(rgba(5,9,6,.34),rgba(5,9,6,.5)),url('/assets/formal-console/perception-field-bg.webp'); background-position:center; background-size:cover; border:1px solid var(--mc-border); border-top:0; border-radius:0 0 var(--mc-radius-sm) var(--mc-radius-sm); }
.perception-grid { position:absolute; inset:0; background-image:linear-gradient(rgba(151,184,151,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(151,184,151,.035) 1px,transparent 1px); background-size:32px 32px; }
.perception-grid::before { position:absolute; inset:0; background-image:linear-gradient(rgba(105,201,74,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(105,201,74,.04) 1px,transparent 1px); background-size:160px 160px; content:''; }
.perception-vignette { position:absolute; inset:0; pointer-events:none; background:radial-gradient(ellipse 62% 66% at 50% 48%,rgba(25,45,29,.14),transparent 65%),linear-gradient(180deg,rgba(4,8,5,.08),rgba(4,8,5,.3)); }
.perception-scene { position:absolute; z-index:1; inset:0; }
.perception-camera-controls { position:absolute; z-index:3; top:66px; left:50%; display:flex; gap:8px; transform:translateX(-50%); }
.stage-button { display:inline-flex; min-height:34px; align-items:center; gap:7px; padding:7px 12px; cursor:pointer; background:rgba(17,24,19,.9); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-sm); color:var(--mc-text-secondary); font-size:var(--mc-type-body); font-weight:700; white-space:nowrap; transition:background var(--mc-duration-fast),border-color var(--mc-duration-fast),color var(--mc-duration-fast); backdrop-filter:blur(10px); }
.stage-button:hover { background:var(--mc-surface-hover); color:var(--mc-text); }
.stage-button.active { background:var(--mc-accent-soft); border-color:rgba(105,201,74,.3); color:var(--mc-accent-strong); }
.stage-button-dot { width:6px; height:6px; background:currentColor; border-radius:50%; }
.perception-online-state,.perception-empty { position:absolute; z-index:1; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column; text-align:center; }
.online-compass { display:grid; width:64px; height:64px; place-items:center; margin-bottom:18px; background:var(--mc-accent-soft); border:1px solid rgba(105,201,74,.25); border-radius:50%; color:var(--mc-accent-strong); box-shadow:0 0 40px rgba(105,201,74,.08); }
.online-state-kicker { color:var(--mc-accent); font:var(--mc-type-micro)/1 var(--mc-font-mono); letter-spacing:.16em; }
.online-state-title { margin-top:12px; color:var(--mc-text); font-size:var(--mc-type-page-title); font-weight:700; }
.online-state-copy { max-width:360px; margin-top:8px; color:var(--mc-text-muted); font-size:var(--mc-type-secondary); line-height:1.65; }
.scan-field { position:relative; display:grid; width:300px; height:300px; place-items:center; margin-bottom:4px; }
.scan-crosshair { position:absolute; z-index:0; background:linear-gradient(90deg,transparent,rgba(105,201,74,.13),transparent); }
.scan-crosshair.horizontal { width:100%; height:1px; }
.scan-crosshair.vertical { width:1px; height:100%; background:linear-gradient(180deg,transparent,rgba(105,201,74,.13),transparent); }
.scan-ring { position:absolute; border:1px solid rgba(105,201,74,.55); border-radius:50%; }
.scan-core { position:relative; z-index:2; display:grid; width:74px; height:74px; place-items:center; background:rgba(13,23,15,.92); border:1px solid rgba(105,201,74,.56); border-radius:50%; box-shadow:0 0 36px rgba(105,201,74,.13),inset 0 0 22px rgba(105,201,74,.05); }
.scan-core::before,.scan-core::after { position:absolute; background:rgba(105,201,74,.35); content:''; }
.scan-core::before { width:96px; height:1px; }
.scan-core::after { width:1px; height:96px; }
.perception-legend { position:absolute; z-index:3; right:18px; bottom:18px; width:244px; padding:12px; background:rgba(13,19,15,.9); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); box-shadow:0 12px 32px rgba(0,0,0,.2); backdrop-filter:blur(12px); }
.partner-inspector { display:flex; min-height:0; flex-direction:column; overflow:hidden; padding:16px; background:var(--mc-surface); }
.inspector-header { display:flex; flex:none; align-items:center; gap:11px; }
.inspector-avatar { display:flex; width:50px; height:50px; flex:none; align-items:center; justify-content:center; overflow:hidden; background:var(--mc-bg); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-xs); }
.inspector-identity { min-width:0; flex:1; }
.inspector-name { overflow:hidden; color:var(--mc-text); font-size:var(--mc-type-page-title); font-weight:900; text-overflow:ellipsis; white-space:nowrap; }
.inspector-presence { display:flex; align-items:center; gap:7px; margin-top:4px; }
.inspector-presence > span { width:7px; height:7px; flex:none; border-radius:50%; box-shadow:0 0 8px currentColor; }
.inspector-presence small { overflow:hidden; color:var(--mc-text-muted); font-size:var(--mc-type-meta); text-overflow:ellipsis; white-space:nowrap; }
.inspector-actions { display:flex; flex:none; gap:6px; }
.inspector-button { min-height:34px; padding:7px 12px; appearance:none; cursor:pointer; background:transparent; border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-sm); color:var(--mc-text-secondary); font-size:var(--mc-type-body); font-weight:800; white-space:nowrap; transition:background var(--mc-duration-fast),border-color var(--mc-duration-fast),color var(--mc-duration-fast),opacity var(--mc-duration-fast); }
.inspector-button.primary { background:var(--mc-accent); border-color:transparent; color:#081007; }
.inspector-button.primary:hover:not(:disabled) { background:var(--mc-accent-strong); }
.inspector-button.ghost { display:grid; width:34px; padding:0; place-items:center; background:transparent; color:var(--mc-text-muted); }
.inspector-button.danger { background:rgba(228,111,101,.09); border-color:rgba(228,111,101,.28); color:var(--mc-danger); }
.inspector-button.danger:hover:not(:disabled) { background:rgba(228,111,101,.14); border-color:rgba(228,111,101,.4); }
.inspector-button.danger:active:not(:disabled) { background:rgba(228,111,101,.2); border-color:rgba(228,111,101,.52); }
.inspector-button:disabled { cursor:not-allowed; filter:saturate(.35); opacity:.35; }
.inspector-vitals { display:flex; flex:none; flex-direction:column; gap:9px; margin-top:12px; padding:11px 12px; background:var(--mc-bg); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); }
.vital-row { display:flex; align-items:center; gap:10px; }
.vital-label { width:28px; flex:none; color:var(--mc-danger); font:9px var(--mc-font-pixel); }
.vital-row.food .vital-label { color:var(--mc-warning); }
.vital-cells { display:flex; flex:1; gap:3px; }
.vital-value { flex:none; color:var(--mc-text-secondary); font:var(--mc-type-section-title) var(--mc-font-mono); }
.inspector-problem { display:flex; flex:none; align-items:center; gap:8px; margin-top:9px; padding:8px 10px; background:rgba(217,170,76,.07); border:1px solid rgba(217,170,76,.2); border-radius:var(--mc-radius-xs); color:var(--mc-warning); }
.inspector-problem span { flex:none; font-size:11px; }
.inspector-problem strong { overflow:hidden; font:13px var(--mc-font-mono); text-overflow:ellipsis; white-space:nowrap; }
.control-tabs { display:flex; flex:none; gap:3px; margin-top:14px; padding-bottom:8px; border-bottom:1px solid var(--mc-border); }
.control-tab { position:relative; min-height:32px; flex:1; padding:6px 8px; cursor:pointer; background:transparent; border:0; border-radius:var(--mc-radius-xs); color:var(--mc-text-muted); font-size:var(--mc-type-body); font-weight:700; white-space:nowrap; transition:background var(--mc-duration-fast),color var(--mc-duration-fast); }
.control-tab:hover { background:rgba(255,255,255,.025); color:var(--mc-text-secondary); }
.control-tab.active { background:var(--mc-accent-soft); color:var(--mc-accent-strong); }
.control-tab.active::after { position:absolute; right:12px; bottom:-9px; left:12px; height:2px; background:var(--mc-accent); content:''; }
.inspector-content { display:flex; min-height:0; flex:1; flex-direction:column; gap:12px; padding-top:12px; }
.interaction-panel { display:flex; min-height:0; flex:1; flex-direction:column; gap:10px; }
.interaction-summary { display:grid; grid-template-columns:130px minmax(0,1fr); flex:0 0 auto; gap:12px; padding:8px; background:var(--mc-bg-elevated); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); }
.interaction-avatar { position:relative; min-height:126px; overflow:hidden; background-color:#101611; background-image:linear-gradient(rgba(7,12,8,.18),rgba(7,12,8,.26)),url('/assets/formal-console/character-display-bg.webp'); background-position:center 58%; background-size:cover; border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); }
.interaction-status-badge { position:absolute; z-index:2; top:7px; right:7px; display:flex; align-items:center; gap:5px; padding:4px 6px; background:rgba(7,11,8,.84); border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); color:var(--mc-text-muted); font:10px var(--mc-font-mono); letter-spacing:.06em; }
.interaction-status-badge > span:first-child { border-radius:50%; }
.interaction-character { height:126px; }
.interaction-summary-copy { display:flex; min-width:0; flex-direction:column; justify-content:center; gap:7px; }
.interaction-summary-title { color:var(--mc-text); font-size:var(--mc-type-section-title); font-weight:800; }
.interaction-summary-detail { display:flex; min-width:0; gap:8px; font-size:11px; }
.interaction-summary-detail span { flex:0 0 auto; color:var(--mc-text-muted); }
.interaction-summary-detail strong { overflow:hidden; color:var(--mc-text-secondary); text-overflow:ellipsis; white-space:nowrap; }
.chat-panel { overflow:hidden; padding:10px; background:var(--mc-bg-elevated); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); }
.interaction-chat { display:flex; min-height:250px; flex:1; flex-direction:column; }
.interaction-messages { display:flex; min-height:0; flex:1; flex-direction:column; gap:10px; overflow-y:auto; padding:2px 3px 8px; }
.chat-state { padding:24px 0; color:var(--mc-text-muted); font-size:11px; text-align:center; }
.chat-message { display:flex; align-items:flex-start; flex-direction:column; }
.chat-message.self { align-items:flex-end; }
.message-bubble { max-width:88%; padding:8px 10px; background:var(--mc-surface-raised); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm) var(--mc-radius-sm) var(--mc-radius-sm) 2px; }
.chat-message.self .message-bubble { background:rgba(105,201,74,.12); border-color:rgba(105,201,74,.2); border-radius:var(--mc-radius-sm) var(--mc-radius-sm) 2px var(--mc-radius-sm); }
.chat-message.error .message-bubble { background:rgba(228,111,101,.09); border-color:rgba(228,111,101,.24); }
.message-sender { margin-bottom:3px; color:#91b986; font-size:var(--mc-type-micro); font-weight:800; }
.chat-message.self .message-sender { color:var(--mc-accent-strong); }
.chat-message.error .message-sender { color:var(--mc-danger); }
.message-copy { color:var(--mc-text); font-size:var(--mc-type-body); line-height:var(--mc-line-body); white-space:pre-wrap; word-break:break-word; }
.chat-message.error .message-copy { color:#e8b0aa; }
.message-time { margin-top:3px; color:#515c53; font:var(--mc-type-meta) var(--mc-font-mono); }
.thinking-card { max-width:88%; margin-bottom:4px; padding:7px 9px; cursor:pointer; background:rgba(126,105,165,.07); border:1px solid rgba(150,127,195,.16); border-radius:var(--mc-radius-xs); }
.thinking-card.live { max-width:none; margin:6px 0; }
.thinking-label { display:inline-flex; align-items:center; gap:5px; color:#9a88b7; font-size:var(--mc-type-micro); }
.thinking-copy { display:-webkit-box; margin-top:4px; overflow:hidden; color:#9087a1; font-size:var(--mc-type-meta); line-height:1.45; white-space:pre-wrap; word-break:break-word; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.thinking-copy.expanded { display:block; overflow:visible; }
.inspector-logs { min-height:260px; flex:1; display:flex; flex-direction:column; overflow:hidden; padding:0; background:var(--mc-bg); font-family:var(--mc-font-mono); }
.inspector-tool-header { flex:none; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px 13px; border-bottom:1px solid var(--mc-border); background:var(--mc-surface); font-family:var(--mc-font-body); }
.inspector-tool-header > span { display:inline-flex; align-items:center; gap:7px; color:var(--mc-text); font-size:13px; font-weight:700; }
.inspector-tool-header small { color:var(--mc-text-muted); font-size:10px; }
.inspector-logs-empty { flex:1; gap:5px; margin:12px; color:var(--mc-text-muted); }
.inspector-logs-empty h3 { margin:4px 0 0; color:var(--mc-text-secondary); font:700 14px var(--mc-font-body); }
.inspector-logs-empty p { max-width:280px; margin:0; font:11px/1.6 var(--mc-font-body); }
.inspector-log-list { flex:1; min-height:0; overflow-y:auto; padding:10px; }
.inspector-log-row { display:flex; gap:8px; padding:5px 0; border-bottom:1px solid var(--mc-border); color:var(--mc-text-muted); font-size:13px; line-height:1.45; }
.inspector-log-row > span,.inspector-log-row > strong { flex:none; }
.inspector-log-row strong { color:var(--mc-accent); font-weight:400; }
.inspector-log-row .level-error { color:var(--mc-danger); }
.inspector-log-row .level-warn { color:var(--mc-warning); }
.inspector-log-row p { margin:0; color:var(--mc-text-secondary); word-break:break-word; }
.inspector-empty { display:flex; min-height:0; flex:1; align-items:center; justify-content:center; flex-direction:column; gap:10px; color:var(--mc-text-muted); text-align:center; }
.inspector-empty-illustration { width:132px; height:132px; object-fit:contain; filter:drop-shadow(0 12px 28px rgba(39,104,30,.24)); }
.inspector-empty strong { color:var(--mc-text-secondary); font-size:14px; }
.inspector-empty span { font-size:11px; }

/* BUG-WEBUI-11/14 · 正式版感知舞台、始终可见的世界预览控制层 */
.perception-stage-toolbar { position:absolute; z-index:5; top:14px; right:18px; left:20px; display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:12px; pointer-events:none; }
.perception-stage-heading { display:flex; align-items:center; gap:9px; justify-self:start; color:var(--mc-text-secondary); font-size:13px; }
.perception-stage-heading > span { width:7px; height:7px; background:var(--mc-accent); border-radius:50%; box-shadow:0 0 10px rgba(105,201,74,.5); }
.world-preview-tabs { display:inline-flex; justify-self:center; padding:3px; pointer-events:auto; background:rgba(12,19,14,.9); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-sm); box-shadow:0 10px 26px rgba(0,0,0,.2); backdrop-filter:blur(10px); }
.world-preview-tabs button { display:inline-flex; min-height:30px; align-items:center; gap:6px; padding:5px 10px; cursor:pointer; background:transparent; border:0; border-radius:var(--mc-radius-xs); color:var(--mc-text-muted); font-size:var(--mc-type-body); font-weight:750; white-space:nowrap; }
.world-preview-tabs button:hover:not(:disabled) { background:var(--mc-surface-hover); color:var(--mc-text-secondary); }
.world-preview-tabs button.active { background:var(--mc-accent-soft); color:var(--mc-accent-strong); box-shadow:inset 0 0 0 1px rgba(105,201,74,.16); }
.world-preview-tabs button:disabled { cursor:not-allowed; opacity:.42; }
.perception-primary-action { position:static; display:inline-flex; min-height:38px; align-items:center; gap:8px; justify-self:end; padding:8px 16px; pointer-events:auto; cursor:pointer; background:linear-gradient(180deg,#336a35,#244f2b); border:1px solid rgba(105,201,74,.58); border-radius:var(--mc-radius-sm); box-shadow:inset 0 1px rgba(255,255,255,.08); color:#eefce8; font-size:var(--mc-type-body); font-weight:800; white-space:nowrap; }
.perception-primary-action:hover:not(:disabled) { background:linear-gradient(180deg,#3c7b3e,#2b5d31); }
.perception-primary-action.leave { background:rgba(228,111,101,.13); border-color:rgba(228,111,101,.34); color:#e8b0aa; }
.perception-primary-action:disabled { cursor:not-allowed; filter:saturate(.3); opacity:.42; }
.perception-empty { inset:54px 0 0; }
.world-preview-state { position:absolute; z-index:3; top:76px; left:50%; display:flex; width:min(430px,calc(100% - 44px)); align-items:center; flex-direction:column; gap:5px; padding:11px 16px; text-align:center; background:rgba(12,19,14,.88); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); box-shadow:0 14px 34px rgba(0,0,0,.24); transform:translateX(-50%); backdrop-filter:blur(12px); }
.world-preview-state > span { color:var(--mc-accent); font:9px/1.2 var(--mc-font-mono); letter-spacing:.14em; }
.world-preview-state > strong { color:var(--mc-text); font-size:13px; }
.world-preview-state > p { max-width:390px; margin:0; color:var(--mc-text-muted); font-size:11px; line-height:1.5; }
.world-preview-state.is-warning { border-color:rgba(224,165,47,.34); }
.world-preview-state.is-warning > span { color:var(--mc-warning); }
.world-preview-state.is-error { background:rgba(31,17,16,.9); border-color:rgba(228,111,101,.4); }
.world-preview-state.is-error > span,.world-preview-state.is-error > strong { color:var(--mc-danger); }
.world-preview-state.is-ready { border-color:rgba(105,201,74,.3); }
.scan-field { width:min(78%,680px); height:auto; aspect-ratio:1; margin:0; }
.scan-field::before { position:absolute; z-index:0; inset:6%; background:conic-gradient(from -92deg,rgba(105,201,74,.18),rgba(105,201,74,.035) 13deg,transparent 38deg); border-radius:50%; content:''; animation:radarSweep 7s linear infinite; transform-origin:center; }
.scan-field::after { position:absolute; z-index:1; width:16%; height:16%; border:1px solid rgba(105,201,74,.75); border-radius:50%; content:''; animation:radarPulse 3.6s ease-out infinite; }
.scan-ring { z-index:1; border-color:rgba(105,201,74,.48); opacity:1; animation:none; }
.scan-ring.ring-one { width:19%; height:19%; }
.scan-ring.ring-two { width:40%; height:40%; border-style:dashed; border-color:rgba(138,209,91,.48); }
.scan-ring.ring-three { width:64%; height:64%; border-color:rgba(105,201,74,.34); }
.scan-ring.ring-four { width:88%; height:88%; border-style:dashed; border-color:rgba(138,209,91,.3); }
.scan-core { width:58px; height:58px; overflow:hidden; background:rgba(13,23,15,.92); border-color:rgba(122,222,91,.72); box-shadow:0 0 34px rgba(105,201,74,.26),inset 0 0 22px rgba(105,201,74,.08); }
.scan-core::before { width:94px; }
.scan-core::after { height:94px; }
.scan-core .mc-head { position:relative; z-index:3; }
.perception-legend { right:auto; bottom:20px; left:20px; display:grid; width:260px; grid-template-columns:minmax(0,1fr) 1fr; gap:14px; padding:13px 14px; }
.radar-legend-list { display:flex; flex-direction:column; gap:9px; }
.radar-legend-item { display:flex; align-items:center; gap:9px; color:var(--mc-text-muted); font-size:10px; }
.radar-legend-item > span { width:12px; height:12px; flex:none; border:1px solid var(--mc-accent); border-radius:50%; }
.radar-legend-item > span.beacon { width:9px; height:9px; margin:1.5px; background:var(--mc-accent); box-shadow:0 0 8px rgba(105,201,74,.5); }
.radar-legend-item > span.medium,.radar-legend-item > span.edge { border-style:dashed; }
.radar-legend-item > span.edge { border-color:rgba(105,201,74,.42); }
.radar-legend-item strong { color:var(--mc-text-muted); font-size:10px; font-weight:600; }
.radar-telemetry { display:flex; min-width:0; flex-direction:column; justify-content:center; gap:7px; padding-left:13px; border-left:1px solid rgba(105,201,74,.28); color:#6da16a; font:9px/1.25 var(--mc-font-mono); }
@keyframes radarPulse { 0% { transform:scale(.6); opacity:0; } 14% { opacity:.75; } 100% { transform:scale(5.5); opacity:0; } }
@keyframes radarSweep { to { transform:rotate(360deg); } }

.partner-inspector { gap:12px; padding:0; background:transparent; }
.partner-hero-card { flex:none; padding:14px; background:rgba(14,21,16,.96); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); }
.inspector-header { gap:13px; }
.inspector-avatar { width:66px; height:66px; }
.inspector-name { font-size:var(--mc-type-page-title); }
.partner-more-menu { position:relative; }
.partner-action-popover { position:absolute; z-index:20; top:40px; right:0; width:132px; padding:6px; background:var(--mc-surface-raised); border:1px solid var(--mc-border-strong); border-radius:var(--mc-radius-sm); box-shadow:0 14px 32px rgba(0,0,0,.34); }
.partner-action-popover button { display:flex; width:100%; align-items:center; gap:7px; padding:8px; cursor:pointer; text-align:left; background:transparent; border:0; border-radius:var(--mc-radius-xs); color:var(--mc-text-secondary); font-size:var(--mc-type-body); }
.partner-action-popover button:hover { background:var(--mc-surface-hover); color:var(--mc-text); }
.partner-action-popover button.danger { color:var(--mc-danger); }
.partner-current-state { display:flex; align-items:center; justify-content:space-between; margin-top:13px; padding:10px 12px; background:rgba(255,255,255,.025); border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); }
.partner-current-state > span { color:var(--mc-text-muted); font-size:11px; font-weight:700; }
.partner-current-state strong { display:flex; align-items:center; gap:8px; color:var(--mc-text-secondary); font-size:11px; }
.partner-current-state i,.interaction-summary-detail i { width:7px; height:7px; flex:none; border-radius:50%; }
.inspector-world-preview { display:none; }
.inspector-vitals { margin-top:0; }
.control-tabs { height:48px; gap:0; margin-top:0; padding:0; overflow:hidden; background:rgba(14,21,16,.96); border:1px solid var(--mc-border); border-radius:var(--mc-radius-sm); }
.control-tab { display:inline-flex; min-width:0; min-height:46px; align-items:center; justify-content:center; gap:7px; padding:0 7px; border-right:1px solid var(--mc-border); border-radius:0; font-size:var(--mc-type-body); }
.control-tab:last-child { border-right:0; }
.control-tab.active { background:linear-gradient(180deg,rgba(105,201,74,.1),rgba(105,201,74,.035)); }
.control-tab.active::after { right:0; bottom:0; left:0; }
.inspector-content { gap:12px; padding-top:0; }
.interaction-panel { gap:12px; }
.interaction-summary { position:relative; grid-template-columns:130px minmax(0,1fr); gap:14px; padding:14px; background:rgba(14,21,16,.96); }
.interaction-avatar { min-height:164px; }
.interaction-character { height:164px; }
.interaction-summary-copy { justify-content:flex-start; gap:9px; padding-top:3px; }
.interaction-summary-title { margin-bottom:2px; font-size:var(--mc-type-section-title); }
.interaction-summary-detail { align-items:center; gap:8px; font-size:10px; }
.interaction-summary-detail span { width:46px; }
.interaction-summary-detail strong { display:flex; min-width:0; align-items:center; gap:6px; font-weight:650; }
.interaction-focus-button { position:absolute; right:9px; bottom:9px; display:grid; width:27px; height:27px; place-items:center; cursor:pointer; background:rgba(17,25,19,.86); border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); color:var(--mc-text-muted); }
.interaction-focus-button:hover { background:var(--mc-surface-hover); color:var(--mc-text); }
.chat-panel { padding:0; background:rgba(14,21,16,.96); }
.chat-panel-header { display:flex; height:42px; flex:none; align-items:center; justify-content:space-between; padding:0 12px; border-bottom:1px solid var(--mc-border); }
.chat-panel-header > span { color:var(--mc-text-secondary); font-size:11px; font-weight:700; }
.chat-panel-header select { min-height:26px; padding:3px 24px 3px 8px; background:var(--mc-bg); border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); color:var(--mc-text-muted); font-size:var(--mc-type-body); }
.interaction-messages { padding:10px 12px; }
.chat-empty-state { align-items:center; justify-content:center; flex:1; flex-direction:column; gap:10px; color:#667068; }
.chat-empty-state .mc-icon { opacity:.7; }
.chat-empty-state span { font-size:11px; }
.interaction-chat > .chat-composer { margin:0 12px 12px; }

@media (max-height:780px) and (min-width:861px) {
  .partner-inspector { gap:9px; }
  .partner-hero-card { padding:10px; }
  .inspector-avatar { width:54px; height:54px; }
  .partner-current-state { margin-top:8px; padding:7px 10px; }
  .control-tabs { height:44px; }
  .control-tab { min-height:42px; }
  .inspector-content,.interaction-panel { gap:9px; }
  .interaction-summary { grid-template-columns:104px minmax(0,1fr); gap:10px; padding:9px; }
  .interaction-avatar { min-height:116px; }
  .interaction-character { height:116px; }
  .interaction-summary-copy { gap:5px; padding-top:0; }
  .interaction-summary-title { font-size:var(--mc-type-section-title); }
  .interaction-summary-detail { font-size:9px; }
  .interaction-chat { min-height:190px; }
}

@media (max-width:1100px) {
  .partner-workspace-shell { grid-template-columns:200px minmax(0,1fr) 340px; }
  .partner-workspace-shell.sidebar-collapsed { grid-template-columns:72px minmax(0,1fr) 340px; }
  .partner-workspace-tab { min-width:104px; }
  .interaction-summary { grid-template-columns:110px minmax(0,1fr); }
  .perception-stage-toolbar { right:10px; left:12px; gap:7px; }
  .perception-stage-heading strong { display:none; }
  .world-preview-tabs button { gap:4px; padding:5px 7px; font-size:var(--mc-type-body); }
  .perception-primary-action { padding:8px 10px; font-size:10px; }
}

@media (max-width:860px) {
  .partner-workspace-shell,.partner-workspace-shell.sidebar-collapsed { grid-template-columns:74px minmax(0,1fr); grid-template-rows:54px minmax(0,1fr); column-gap:0; padding:0; }
  .partner-sidebar { --partner-sidebar-inline-padding:8px; padding:12px var(--partner-sidebar-inline-padding); }
  .partner-sidebar-header { justify-content:center; padding:0; }
  .partner-sidebar-heading,.partner-list-summary,.partner-sidebar-footer span { display:none; }
  .partner-list-item { justify-content:center; padding:7px 5px; }
  .partner-sidebar { margin:0; }
  .partner-sidebar-footer { flex-direction:column; align-items:center; }
  .sidebar-tool.primary-tool { width:36px; flex:none; padding:0; }
  .partner-workspace-bar { grid-column:2; grid-row:1; border-top:0; border-radius:0; }
  .partner-workspace-tab { min-width:0; min-height:53px; flex:1; padding:0 8px; font-size:var(--mc-type-body); }
  .partner-workspace-panel { grid-column:2; grid-row:2; }
  .play-stage { display:none; }
  .play-control { grid-column:2; grid-row:2; padding:12px; }
  .partner-workspace-shell:not(.is-play-workspace) .play-control { display:none; }
  .inspector-world-preview { display:flex; flex-direction:column; gap:8px; margin-top:9px; padding:9px; background:rgba(255,255,255,.025); border:1px solid var(--mc-border); border-radius:var(--mc-radius-xs); }
  .inspector-world-preview-heading { display:flex; align-items:center; justify-content:space-between; color:var(--mc-text-muted); font-size:10px; }
  .inspector-world-preview-heading strong { color:var(--mc-accent-strong); font-size:10px; }
  .inspector-world-preview-tabs { display:flex; width:100%; padding:2px; }
  .inspector-world-preview-tabs button { min-width:0; flex:1; justify-content:center; padding:5px 4px; }
  .inspector-world-preview > p { margin:0; color:var(--mc-text-muted); font-size:10px; line-height:1.4; }
  .inspector-world-preview > p.is-error { color:var(--mc-danger); }
}

@media (max-width:640px) {
  .app-topbar { height:54px; padding:0 12px; overflow:hidden; }
  .app-brand { flex:0 0 auto; gap:8px; }
  .app-brand-logo { width:32px; height:32px; }
  .app-brand-name { font-size:11px; }
  .app-hub-menu { display:none; }
  .global-settings-layer { inset:54px 0 0; }
  .partner-workspace-shell,.partner-workspace-shell.sidebar-collapsed { grid-template-columns:64px minmax(0,1fr); }
  .partner-sidebar { --partner-sidebar-inline-padding:6px; padding:10px var(--partner-sidebar-inline-padding); }
  .partner-avatar { width:40px; height:40px; }
  .partner-workspace-bar { min-height:54px; }
  .partner-workspace-tabs { width:100%; }
  .partner-workspace-tab { flex:1; padding:6px 7px; }
  .partner-inspector { padding:9px; }
  .inspector-header { gap:8px; }
  .inspector-avatar { width:46px; height:46px; }
  .inspector-name { font-size:var(--mc-type-page-title); }
  .inspector-button { padding:6px 9px; }
  .inspector-button.ghost { width:32px; }
  .control-tab { padding:5px 4px; font-size:var(--mc-type-body); }
  .interaction-summary { grid-template-columns:96px minmax(0,1fr); gap:8px; padding:7px; }
  .interaction-avatar,.interaction-character { min-height:106px; height:106px; }
  .interaction-summary-copy { gap:5px; }
  .interaction-summary-title { font-size:var(--mc-type-section-title); }
  .interaction-summary-detail { font-size:10px; }
  .interaction-chat { min-height:230px; }
}
</style>
