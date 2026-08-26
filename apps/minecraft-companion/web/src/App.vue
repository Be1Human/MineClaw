<template>
  <div style="position:relative; min-height:100vh; height:100vh; display:flex; flex-direction:column; background-color:#15170f; background-image:radial-gradient(120% 90% at 50% 0%, rgba(60,80,40,0.18), transparent 55%), repeating-linear-gradient(0deg, rgba(0,0,0,0.10) 0 2px, transparent 2px 4px), repeating-linear-gradient(90deg, rgba(0,0,0,0.07) 0 2px, transparent 2px 4px); color:#e7e3d4; font-family:var(--mc-font-body); overflow:hidden;">
    <div style="position:absolute; inset:0; pointer-events:none; background:radial-gradient(130% 110% at 50% 40%, transparent 55%, rgba(0,0,0,0.55)); z-index:0;"></div>

    <!-- ===================== TOP BAR (grass block) ===================== -->
    <header style="position:relative; z-index:5; flex:none;">
      <div class="app-topbar" style="display:flex; align-items:center; gap:26px; height:60px; padding:0 22px; background:linear-gradient(180deg,#2c3422,#222a1a); border-bottom:3px solid #4f7d2e; -webkit-app-region:drag;">
        <!-- brand -->
        <div class="app-brand" style="display:flex; align-items:center; gap:12px;">
          <img class="app-brand-logo" src="/brand/mineclaw-mark.svg" alt="" aria-hidden="true" />
          <span class="app-brand-name" style="font-family:var(--mc-font-pixel); font-size:14px; color:#f4f1e4; text-shadow:2px 2px 0 #1c2113; letter-spacing:0.02em;">MineClaw</span>
        </div>

        <div class="app-header-spacer" style="flex:1;"></div>

        <button
          class="global-settings-button"
          :class="{ active: globalSettingsOpen }"
          title="全局设置"
          aria-label="全局设置"
          @click="globalSettingsOpen = !globalSettingsOpen"
        >⚙</button>

        <!-- hub status -->
        <div class="app-hub-status" style="display:flex; align-items:center; gap:9px; padding:8px 14px; background:#1c2414; border:2px solid #0d0f0a; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.05), inset -2px -2px 0 rgba(0,0,0,0.35); -webkit-app-region:no-drag;">
          <span :style="{ width:'9px', height:'9px', background: wsConnected ? '#5fd13a' : '#d8503c', boxShadow:'0 0 0 2px rgba(95,209,58,0.25), 1px 1px 0 rgba(0,0,0,0.4)' }"></span>
          <span :style="{ fontWeight:700, fontSize:'12.5px', color: wsConnected ? '#9fe27a' : '#ff8a8a' }">{{ wsConnected ? 'Hub 已连接' : 'Hub 断开' }}</span>
        </div>

        <!-- 无边框窗口控制（自定义标题栏）-->
        <div v-if="isElectron" style="display:flex; align-items:center; gap:6px; -webkit-app-region:no-drag;">
          <button @click="winMin" title="最小化" style="width:30px; height:30px; cursor:pointer; display:flex; align-items:center; justify-content:center; background:#272d1d; border:2px solid #0d0f0a; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.06), inset -2px -2px 0 rgba(0,0,0,0.35); color:#cdd2c0; font-family:var(--mc-font-pixel); font-size:11px; line-height:1;">_</button>
          <button @click="winClose" title="关闭到托盘" style="width:30px; height:30px; cursor:pointer; display:flex; align-items:center; justify-content:center; background:#3a2420; border:2px solid #1a0f0d; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.08), inset -2px -2px 0 rgba(0,0,0,0.35); color:#f0b4b4; font-family:var(--mc-font-pixel); font-size:11px; line-height:1;">✕</button>
        </div>
      </div>
      <!-- grass teeth -->
      <div style="height:6px; background:#4f7d2e; -webkit-mask-image:repeating-linear-gradient(90deg,#000 0 7px, transparent 7px 14px); mask-image:repeating-linear-gradient(90deg,#000 0 7px, transparent 7px 14px);"></div>
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
      <aside class="partner-sidebar" style="display:flex; flex-direction:column; min-height:0; padding:16px; border-right:3px solid #0c0e08; background:#1b1e14;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
          <span style="font-family:var(--mc-font-pixel); font-size:10px; color:#8aa86a; text-shadow:1px 1px 0 #0c0e08;">PARTNERS</span>
          <button @click="showCreateForm = true" style="width:30px; height:30px; cursor:pointer; background:#4c7a2a; border:2px solid #2b5e16; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.28), inset -2px -2px 0 rgba(0,0,0,0.3); color:#fff; font-family:var(--mc-font-pixel); font-size:12px; line-height:1;">+</button>
        </div>
        <div style="font-weight:700; font-size:13px; color:#cdd2c0; margin:0 2px 10px;">我的伙伴</div>

        <div style="display:flex; flex-direction:column; gap:8px; overflow-y:auto; min-height:0; padding-right:2px;">
          <div v-for="p in profiles" :key="p.id" class="partner-list-item" @click="selectProfile(p)"
            :style="partnerStyle(p)">
            <div style="position:relative; flex:none; width:40px; height:40px; background:#0f110a; border:2px solid #000; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center;">
              <McHead :texture="p.skinTexture || ''" :size="36" />
              <span :style="{ position:'absolute', right:'-3px', bottom:'-3px', width:'10px', height:'10px', background: statusDot(p.id), border:'2px solid #1b1e14' }"></span>
            </div>
            <div class="partner-list-summary" style="display:flex; flex-direction:column; gap:3px; min-width:0;">
              <span style="font-weight:700; font-size:14px; color:#eceadb; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ p.name }}</span>
              <span style="font-size:11.5px; color:#7e836e;">{{ getPresenceText(p.id) }}</span>
            </div>
          </div>
          <div v-if="profiles.length === 0" style="font-size:12.5px; color:#7e836e; padding:8px 4px;">还没有伙伴，点 + 创建一个</div>
        </div>

        <div style="flex:1;"></div>
        <div class="partner-count" style="margin-top:12px; padding-top:12px; border-top:2px solid #0c0e08; font-family:var(--mc-font-mono); font-size:15px; color:#7e836e; letter-spacing:0.04em;">{{ profiles.length }} PARTNERS · {{ onlineCount }} ONLINE</div>
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
      <BenchPanel
        v-else-if="workspaceView === 'bench'"
        :key="`bench:${selectedProfile?.id || 'empty'}`"
        :botId="selectedProfile?.id"
        class="partner-workspace-panel"
      />
      <MemoryPanel
        v-else-if="workspaceView === 'memory'"
        :key="`memory:${selectedProfile?.id || 'empty'}`"
        :botId="selectedProfile?.id"
        class="partner-workspace-panel"
      />
      <PlannerEvolutionPanel
        v-else-if="workspaceView === 'evolution'"
        :key="`evolution:${selectedProfile?.id || 'empty'}`"
        :botId="selectedProfile?.id"
        class="partner-workspace-panel"
      />

      <template v-else>

      <!-- ---------- CENTER · 感知空间 ---------- -->
      <main class="play-stage" style="position:relative; min-width:0; min-height:0; overflow:hidden; background:#0c0e08; border-right:3px solid #0c0e08;">
        <div style="position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px); background-size:32px 32px; -webkit-mask-image:radial-gradient(ellipse 65% 65% at 50% 46%, #000 35%, transparent 80%); mask-image:radial-gradient(ellipse 65% 65% at 50% 46%, #000 35%, transparent 80%);"></div>

        <!-- 真实 3D 感知（默认关闭·按需开启，避免重 WebGL 拖慢界面 BUG-WEBUI-05） -->
        <div v-if="currentWorldState && show3D" style="position:absolute; inset:0; z-index:1;">
          <PerceptionScene3D
            :worldState="currentWorldState"
            :skinTexture="selectedSkinTexture"
            :skinModel="selectedSkinModel"
          />
        </div>
        <!-- 3D 开关 -->
        <div style="position:absolute; top:18px; right:18px; z-index:4;">
          <button @click="toggle3D" :style="{ cursor:'pointer', padding:'8px 14px', fontWeight:700, fontSize:'12.5px', whiteSpace:'nowrap', border:'2px solid #0d0f0a', color: show3D ? '#fff' : '#cdd2c0', background: show3D ? '#4c7a2a' : '#272d1d', boxShadow:'inset 1px 1px 0 rgba(255,255,255,0.1), inset -2px -2px 0 rgba(0,0,0,0.35)' }">
            {{ show3D ? '⏹ 关闭 3D 感知' : '▶ 开启 3D 感知' }}
          </button>
        </div>
        <!-- 3D 关闭时的轻量占位（有 worldState 但未开 3D） -->
        <div v-if="currentWorldState && !show3D" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:#7e836e; z-index:1;">
          <div style="width:54px; height:54px; background:#2c3422; border:2px solid #0c0e08; box-shadow:inset -5px -5px 0 rgba(0,0,0,0.2); display:flex; align-items:center; justify-content:center; font-size:24px;">🧭</div>
          <div style="font-weight:700; font-size:14px; color:#cdd2c0;">{{ selectedProfile?.name }} 在线中</div>
          <div style="font-size:12.5px;">3D 感知较耗资源，已默认关闭 · 需要时点右上角开启</div>
        </div>

        <!-- empty state -->
        <div v-if="!currentWorldState" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;">
          <div style="position:relative; width:140px; height:140px; display:flex; align-items:center; justify-content:center;">
            <div style="position:absolute; width:140px; height:140px; border:3px solid rgba(95,158,57,0.25);"></div>
            <div style="position:relative; width:76px; height:52px; background:#11160c; border:3px solid #5fae3a; box-shadow:0 0 24px rgba(95,174,58,0.4), inset 2px 2px 0 rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center;">
              <div style="width:20px; height:20px; background:#7cc24e; box-shadow:0 0 14px #7cc24e, inset -3px -3px 0 rgba(0,0,0,0.25);"></div>
            </div>
          </div>
          <div style="margin-top:26px; font-family:var(--mc-font-pixel); font-size:13px; color:#cfeeb0; text-shadow:2px 2px 0 #0c0e08; letter-spacing:0.02em;">SCANNING…</div>
          <div style="margin-top:16px; font-weight:700; font-size:17px; color:#e7e3d4;">等待感知数据…</div>
          <div style="margin-top:8px; font-size:13px; color:#7e836e;">Bot 上线后将实时渲染三维感知空间</div>
          <div style="margin-top:16px; display:flex; align-items:center; gap:8px; padding:6px 13px; background:#15170f; border:2px solid #0d0f0a; box-shadow:inset 1px 1px 0 rgba(0,0,0,0.4);">
            <span style="width:8px; height:8px; background:#e0a52f; box-shadow:1px 1px 0 rgba(0,0,0,0.4);"></span>
            <span style="font-family:var(--mc-font-mono); font-size:15px; color:#c9a25a; letter-spacing:0.05em;">SENSOR · STANDBY</span>
          </div>
        </div>
      </main>

      <!-- ---------- RIGHT · 控制面板 ---------- -->
      <aside class="play-control" style="display:flex; flex-direction:column; min-height:0; overflow-y:auto; padding:16px; background:#1b1e14;">

        <template v-if="selectedProfile">
        <!-- header -->
        <div style="display:flex; align-items:flex-start; gap:12px;">
          <div style="position:relative; flex:none; width:50px; height:50px; background:#0f110a; border:2px solid #000; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center;">
            <McHead :texture="selectedSkinTexture" :size="44" />
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-weight:900; font-size:19px; color:#f0eddd; text-shadow:1px 1px 0 #0c0e08;">{{ selectedProfile.name }}</div>
            <div style="display:flex; align-items:center; gap:7px; margin-top:4px;">
              <span :style="{ width:'9px', height:'9px', background: statusDot(selectedProfile.id), boxShadow:'1px 1px 0 rgba(0,0,0,0.4)' }"></span>
              <span style="font-size:12.5px; color:#7e836e;">{{ getStatusLabel(currentFullStatus?.status, currentFullStatus) }}</span>
            </div>
          </div>
          <div style="display:flex; gap:8px;">
            <button v-if="!inGame" @click="joinGame" :disabled="!brainReady" style="padding:9px 16px; cursor:pointer; background:#4c9a2a; border:2px solid #2b5e16; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.28), inset -2px -2px 0 rgba(0,0,0,0.3), 0 3px 0 #214b13; color:#fff; font-weight:700; font-size:13.5px; text-shadow:1px 1px 0 rgba(0,0,0,0.4); white-space:nowrap;">进游戏</button>
            <button v-else @click="leaveGame" style="padding:9px 16px; cursor:pointer; background:#3a2420; border:2px solid #1a0f0d; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.08), inset -2px -2px 0 rgba(0,0,0,0.35); color:#f0b4b4; font-weight:700; font-size:13.5px; white-space:nowrap;">退游戏</button>
            <button @click="deleteProfile(selectedProfile.id)" style="padding:9px 14px; cursor:pointer; background:#3a2420; border:2px solid #1a0f0d; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.08), inset -2px -2px 0 rgba(0,0,0,0.35); color:#d99; font-weight:700; font-size:13.5px; white-space:nowrap;">删除</button>
          </div>
        </div>

        <!-- HUD vitals -->
        <div v-if="inGame" style="margin-top:14px; padding:13px 14px; background:#0f110a; border:2px solid #000; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); display:flex; flex-direction:column; gap:11px;">
          <div style="display:flex; align-items:center; gap:12px;">
            <span style="width:34px; flex:none; font-family:var(--mc-font-pixel); font-size:9px; color:#ff6b6b; text-shadow:1px 1px 0 #000;">HP</span>
            <div style="flex:1; display:flex; gap:3px;">
              <span v-for="(c, i) in hpCells" :key="i" :style="{ fontFamily:'var(--mc-font-body)', fontSize:'18px', lineHeight:1, color: c.on ? '#ff4d4d' : '#5a1f1c', textShadow:'1px 1px 0 #000, -1px 0 0 #000, 0 -1px 0 #000' }">♥</span>
            </div>
            <span style="flex:none; font-family:var(--mc-font-mono); font-size:17px; color:#cdd2c0;">{{ hpLabel }}</span>
          </div>
          <div style="display:flex; align-items:center; gap:12px;">
            <span style="width:34px; flex:none; font-family:var(--mc-font-pixel); font-size:9px; color:#e0a52f; text-shadow:1px 1px 0 #000;">FD</span>
            <div style="flex:1; display:flex; gap:3px;">
              <span v-for="(c, i) in fdCells" :key="i" style="position:relative; flex:none; width:16px; height:15px; display:inline-block;">
                <span :style="{ position:'absolute', right:0, bottom:0, width:'12px', height:'12px', borderRadius:'7px 7px 6px 3px', background: c.on ? '#a9772f' : '#3a2a1c', boxShadow:'inset -2px -2px 0 rgba(0,0,0,0.35), 0 0 0 1px #000' }"></span>
                <span :style="{ position:'absolute', left:0, top:'3px', width:'7px', height:'5px', borderRadius:'3px', background: c.on ? '#cdd2c0' : '#2a2018', boxShadow:'0 0 0 1px #000' }"></span>
              </span>
            </div>
            <span style="flex:none; font-family:var(--mc-font-mono); font-size:17px; color:#cdd2c0;">{{ fdLabel }}</span>
          </div>
        </div>

        <!-- chips -->
        <div style="margin-top:12px; display:flex; flex-wrap:wrap; gap:8px;">
          <div style="display:flex; align-items:center; gap:7px; padding:7px 11px; background:#20241a; border:2px solid #0d0f0a; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.05);">
            <span style="font-size:11px; color:#7e836e;">连接</span>
            <span :style="{ display:'flex', alignItems:'center', justifyContent:'center', width:'14px', height:'14px', background: connOk ? '#1d3a20' : '#3a201d', color: connOk ? '#8ee06a' : '#ff8a8a', fontSize:'9px', fontWeight:700 }">{{ connOk ? '✓' : '✕' }}</span>
            <span :style="{ fontSize:'12px', fontWeight:700, color: connOk ? '#8ee06a' : '#ff8a8a' }">{{ connOk ? '已接' : '未接' }}</span>
          </div>
          <div style="display:flex; align-items:center; gap:7px; padding:7px 11px; background:#20241a; border:2px solid #0d0f0a; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.05);">
            <span style="font-size:11px; color:#7e836e;">动作</span><span style="font-size:12px; font-weight:700; color:#c4c8b6;">{{ currentFullStatus?.currentBehavior || '空闲' }}</span>
          </div>
          <div style="display:flex; align-items:center; gap:7px; padding:7px 11px; background:#20241a; border:2px solid #0d0f0a; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.05);">
            <span style="font-size:11px; color:#7e836e;">活动</span><span style="font-size:12px; font-weight:700; color:#c4c8b6;">{{ currentFullStatus?.lastActivity || '—' }}</span>
          </div>
        </div>

        <!-- problem -->
        <div v-if="inGame && !connOk && currentFullStatus?.serverAddress" style="margin-top:10px; display:flex; align-items:center; gap:9px; padding:9px 12px; background:#2c2410; border:2px solid #5a4410; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.06);">
          <span style="display:flex; align-items:center; justify-content:center; flex:none; width:16px; height:16px; background:#e0a52f; color:#1c1606; font-family:var(--mc-font-pixel); font-size:9px;">!</span>
          <span style="font-size:11.5px; color:#e6c98a;">问题 · 服务器</span>
          <span style="font-family:var(--mc-font-mono); font-size:15px; color:#f0c259; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ currentFullStatus.serverAddress }}</span>
        </div>

        <!-- tabs -->
        <div style="margin-top:16px; display:flex; gap:5px; flex-wrap:wrap;">
          <div v-for="t in tabs" :key="t.id" class="control-tab" :class="{ active: ctrlTab === t.id }" @click="ctrlTab = t.id" :style="tabStyle(t.id)">{{ t.name }}</div>
        </div>

        <!-- content -->
        <div style="margin-top:16px; display:flex; flex-direction:column; gap:16px; flex:1; min-height:0;">

          <!-- 状态 -->
          <template v-if="ctrlTab === 'status'">
            <div>
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:11px;">
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="width:12px; height:16px; background:#5d9c3c; border:2px solid #0c0e08;"></span>
                  <span style="font-weight:900; font-size:14px; color:#e7e3d4;">角色形象</span>
                </div>
                <button @click="showSkinEditor = true" style="padding:6px 12px; cursor:pointer; background:#272d1d; border:2px solid #0d0f0a; box-shadow:inset 1px 1px 0 rgba(255,255,255,0.06); color:#cdd2c0; font-weight:700; font-size:12px;">编辑皮肤</button>
              </div>
              <div style="position:relative; background:repeating-conic-gradient(#16190f 0% 25%, #1c2013 0% 50%) 0 0 / 28px 28px, #1a1d12; border:2px solid #0c0e08; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); padding:28px 0 24px; overflow:hidden;">
                <div style="position:absolute; top:12px; right:12px; display:flex; align-items:center; gap:6px; padding:4px 9px; background:#11140c; border:2px solid #0c0e08;">
                  <span :style="{ width:'7px', height:'7px', background: statusDot(selectedProfile.id) }"></span>
                  <span style="font-family:var(--mc-font-pixel); font-size:7px; color:#7e836e;">{{ (currentFullStatus?.status || 'offline').toUpperCase() }}</span>
                </div>
                <div style="height:300px;">
                  <McCharacter :texture="selectedSkinTexture" :model="selectedSkinModel" animation="idle" :autoRotate="false" />
                </div>
              </div>
            </div>

          </template>

          <!-- 任务栏 -->
          <TaskBarPanel
            v-else-if="ctrlTab === 'tasks'"
            :botName="selectedProfile?.name || '未选择伙伴'"
            :tasks="v2Tasks"
            :state="v2TaskState"
            :error="v2TaskError"
            @retry="refreshV2Tasks({ showLoading: true })"
          />

          <!-- 运行时 -->
          <template v-else-if="ctrlTab === 'runtime'">
            <AlertBanner :alerts="v2Alerts" />
            <V2StatusPanel :status="v2Status" />
            <CriticPanel :verdicts="v2Verdicts" />
          </template>

          <!-- 背包 -->
          <div v-else-if="ctrlTab === 'inventory'">
            <InventoryPanel :worldState="currentWorldState" />
          </div>

          <!-- 聊天 -->
          <div v-else-if="ctrlTab === 'chat'" class="chat-panel" style="display:flex; flex-direction:column; flex:1; min-height:340px;">
            <div ref="messagesEl" style="flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding:4px;">
              <div v-if="chatHistoryLoading" style="text-align:center; color:#7e836e; font-size:12.5px; padding:24px 0;">正在加载最近聊天记录…</div>
              <div v-else-if="messages.length === 0" style="text-align:center; color:#7e836e; font-size:12.5px; padding:24px 0;">还没有聊天记录，直接和伙伴说句话吧</div>
              <div v-for="(msg, i) in messages" :key="i" :style="{ display:'flex', flexDirection:'column', alignItems: msg.self ? 'flex-end' : 'flex-start' }">
                <div v-if="msg.thinking" @click="msg.thinkExpanded = !msg.thinkExpanded"
                  style="max-width:88%; margin-bottom:3px; padding:5px 10px; background:#171a26; border:2px dashed #4a4060; opacity:0.7; cursor:pointer; font-style:italic;">
                  <span style="font-family:var(--mc-font-pixel); font-size:8px; color:#a78bd0; margin-right:6px;">💭</span>
                  <span style="font-size:9px; color:#6e7681;">{{ msg.thinkExpanded ? '收起 ▴' : '展开 ▾' }}</span>
                  <div :style="{ fontSize:'12px', color:'#b0a8c8', lineHeight:1.45, marginTop:'2px', whiteSpace:'pre-wrap', wordBreak:'break-word', display: msg.thinkExpanded ? 'block':'-webkit-box', WebkitLineClamp: msg.thinkExpanded ? 'unset':'2', WebkitBoxOrient:'vertical', overflow: msg.thinkExpanded ? 'visible':'hidden' }">{{ msg.thinking }}</div>
                </div>
                <div :style="{ maxWidth:'88%', padding:'7px 12px', background: msg.self ? '#243016' : '#20241a', border:'2px solid #0c0e08', boxShadow:'inset 1px 1px 0 rgba(255,255,255,0.05)' }">
                  <div :style="{ fontSize:'10px', marginBottom:'2px', color: msg.self ? '#9fe27a' : '#8aa86a', fontWeight:700 }">{{ msg.sender }}</div>
                  <div style="font-size:13px; color:#e7e3d4; line-height:1.5; white-space:pre-wrap; word-break:break-word;">{{ msg.message }}</div>
                </div>
                <div style="font-size:10px; color:#6b6f5e; margin-top:2px;">{{ formatTime(msg.timestamp) }}</div>
              </div>
            </div>
            <div v-if="liveThinking" @click="liveThinkExpanded = !liveThinkExpanded"
              style="margin:6px 0; padding:5px 10px; background:#14160f; border:2px solid #2f2a40; opacity:0.65; cursor:pointer; font-style:italic;">
              <span style="font-family:var(--mc-font-pixel); font-size:8px; color:#a78bd0; margin-right:6px;">💭 正在想</span>
              <span style="font-size:9px; color:#6e7681;">{{ liveThinkExpanded ? '收起 ▴' : '展开 ▾' }}</span>
              <div :style="{ fontSize:'12px', color:'#b0a8c8', lineHeight:1.45, marginTop:'2px', whiteSpace:'pre-wrap', wordBreak:'break-word', display: liveThinkExpanded ? 'block':'-webkit-box', WebkitLineClamp: liveThinkExpanded ? 'unset':'2', WebkitBoxOrient:'vertical', overflow: liveThinkExpanded ? 'visible':'hidden' }">{{ liveThinking }}</div>
            </div>
            <ChatBox :disabled="!brainReady" @send="sendChat" />
          </div>

          <!-- 日志 -->
          <div v-else-if="ctrlTab === 'logs'" ref="logsEl" style="flex:1; min-height:300px; overflow-y:auto; background:#0c0e08; border:2px solid #000; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); padding:8px; font-family:var(--mc-font-mono);">
            <div v-if="logs.length === 0" style="color:#6b6f5e; font-size:14px;">暂无运行日志</div>
            <div v-for="(log, i) in logs" :key="i" style="display:flex; gap:8px; font-size:14px; line-height:1.5; padding:1px 0;">
              <span style="color:#6b6f5e; flex:none;">{{ formatTime(log.timestamp) }}</span>
              <span :style="{ flex:'none', color: log.level === 'error' ? '#ff8a8a' : log.level === 'warn' ? '#e0a52f' : '#5d9c3c' }">{{ log.level }}</span>
              <span style="color:#bcc0ab; word-break:break-word;">{{ log.message }}</span>
            </div>
          </div>

        </div>
        </template>

        <!-- 未选中伙伴 -->
        <div v-else style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:#7e836e;">
          <div style="width:46px; height:46px; background:#5d9c3c; border:2px solid #0c0e08; box-shadow:inset -5px -5px 0 rgba(0,0,0,0.18);"></div>
          <div style="font-weight:700; font-size:15px; color:#cdd2c0;">选择一个伙伴</div>
          <div style="font-size:12.5px;">在左侧挑一个伙伴，或点 + 创建</div>
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
          <button @click="showSkinEditor = false" style="width:30px; height:30px; cursor:pointer; background:#3a2420; border:2px solid #1a0f0d; color:#f0b4b4; font-family:var(--mc-font-pixel); font-size:11px;">✕</button>
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
import V2StatusPanel from './components/V2StatusPanel.vue';
import TaskBarPanel from './components/TaskBarPanel.vue';
import CriticPanel from './components/CriticPanel.vue';
import AlertBanner from './components/AlertBanner.vue';
import InventoryPanel from './components/InventoryPanel.vue';
import ChatBox from './components/ChatBox.vue';
import BrainPanel from './components/BrainPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import BenchPanel from './components/BenchPanel.vue';
import MemoryPanel from './components/MemoryPanel.vue';
import PlannerEvolutionPanel from './components/PlannerEvolutionPanel.vue';
import LlmTracePanel from './components/LlmTracePanel.vue';
import McCharacter from './components/McCharacter.vue';
import McHead from './components/McHead.vue';
import SkinEditor from './components/SkinEditor.vue';
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
  { id: 'play', name: '游玩' },
  { id: 'brain', name: '大脑' },
  { id: 'trace', name: '轨迹' },
  { id: 'memory', name: '记忆' },
  { id: 'evolution', name: '进化' },
  { id: 'bench', name: '测试台' },
  { id: 'settings', name: '设置' },
];
const tabs = [
  { id: 'status', name: '状态' },
  { id: 'tasks', name: '任务栏' },
  { id: 'runtime', name: '运行时' },
  { id: 'inventory', name: '背包' },
  { id: 'chat', name: '聊天' },
  { id: 'logs', name: '日志' },
];
const inputStyle = 'padding:9px 11px; background:#0c0e08; border:2px solid #000; box-shadow:inset 2px 2px 0 rgba(0,0,0,0.5); color:#e7e3d4; font-family:var(--mc-font-body); font-size:13px;';

function partnerStyle(p) {
  const sel = selectedProfile.value?.id === p.id;
  return {
    display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 10px',
    cursor: 'pointer', position: 'relative',
    background: sel ? '#243016' : '#191c12',
    border: '2px solid ' + (sel ? '#cdd2c0' : '#0c0e08'),
    boxShadow: sel
      ? 'inset 2px 2px 0 rgba(93,156,60,0.4), inset -2px -2px 0 rgba(0,0,0,0.3)'
      : 'inset 2px 2px 0 rgba(0,0,0,0.4), inset -1px -1px 0 rgba(255,255,255,0.04)',
  };
}
function tabStyle(id) {
  const active = ctrlTab.value === id;
  return {
    padding: '7px 12px', cursor: 'pointer', whiteSpace: 'nowrap',
    fontFamily: "var(--mc-font-body)", fontWeight: 700, fontSize: '13px',
    color: active ? '#fff' : '#9aa08c',
    background: active ? '#4c7a2a' : '#20241a',
    border: '2px solid ' + (active ? '#2b5e16' : '#0d0f0a'),
    textShadow: active ? '1px 1px 0 rgba(0,0,0,0.4)' : 'none',
    boxShadow: active
      ? 'inset 1px 1px 0 rgba(255,255,255,0.25), inset -2px -2px 0 rgba(0,0,0,0.3)'
      : 'inset 1px 1px 0 rgba(255,255,255,0.05), inset -2px -2px 0 rgba(0,0,0,0.35)',
  };
}

const wsConnected = ref(false);
const profiles = ref([]);
const selectedProfile = ref(null);
const workspaceViewsByProfile = ref({});
const controlTabsByProfile = ref({});
const noProfileWorkspaceView = ref('play');
const validWorkspaceViews = new Set(workspaceTabs.map((tab) => tab.id));
const validControlTabs = new Set(tabs.map((tab) => tab.id));

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
function toggle3D() {
  show3D.value = !show3D.value;
  try { localStorage.setItem('mc.show3D', show3D.value ? '1' : '0'); } catch {}
}
const messagesEl = ref(null);
const logsEl = ref(null);
const unreadChat = ref(0);
const activeBots = reactive(new Set());
const botStatuses = reactive(new Map());
const worldStates = reactive(new Map());
const v2Status = ref({});
const v2Enabled = ref(false);
const {
  tasks: v2Tasks,
  state: v2TaskState,
  error: v2TaskError,
  selectBot: selectTaskBot,
  refresh: refreshV2Tasks,
} = useProfileTasks();
const v2Verdicts = ref([]);
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
socket.on('connect', () => { wsConnected.value = true; });
socket.on('disconnect', () => { wsConnected.value = false; });

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
    if (ctrlTab.value !== 'chat') unreadChat.value++;
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

const v2Poll = setInterval(async () => {
  try {
    const r = await fetch('/api/v2/status');
    if (r.ok) { v2Status.value = await r.json(); v2Enabled.value = true; }
    else v2Enabled.value = false;
  } catch {}
}, 1000);

const v2DetailPoll = setInterval(async () => {
  if (!v2Enabled.value) return;
  try {
    const [rCritic, rAlerts] = await Promise.all([
      fetch('/api/v2/critic'), fetch('/api/v2/supervisor-alerts'),
    ]);
    if (rCritic.ok) v2Verdicts.value = (await rCritic.json()).verdicts ?? [];
    if (rAlerts.ok) v2Alerts.value = await rAlerts.json();
  } catch {}
}, 2000);

const v2TaskPoll = setInterval(() => { void refreshV2Tasks(); }, 2000);

onUnmounted(() => {
  clearInterval(v2Poll);
  clearInterval(v2DetailPoll);
  clearInterval(v2TaskPoll);
});

watch(
  () => selectedProfile.value?.id,
  botId => { void selectTaskBot(botId); },
  { flush: 'sync' },
);

watch([workspaceView, ctrlTab], ([view, tab]) => {
  if (view !== 'play' || tab !== 'chat') return;
  unreadChat.value = 0;
  void scrollBottom(messagesEl);
});

function selectProfile(p) {
  selectedProfile.value = p;
  showCreateForm.value = false;
  messages.value = [];
  logs.value = [];
  liveThinking.value = '';
  agentLoopSteps.value = [];
  unreadChat.value = 0;
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
    workspaceViewsByProfile.value = readTabMap('mc.workspaceTabs.v1', validWorkspaceViews);
    controlTabsByProfile.value = readTabMap('mc.controlTabs.v1', validControlTabs);
    // FEAT-WEBUI-19：旧右侧“轨迹(agent)”迁移为伙伴一级工作区，避免保存值失效。
    const legacyControlMap = JSON.parse(localStorage.getItem('mc.controlTabs.v1') || '{}');
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
    } else if (selectedId && validControlTabs.has(legacyTab) && !controlTabsByProfile.value[selectedId]) {
      controlTabsByProfile.value = { ...controlTabsByProfile.value, [selectedId]: legacyTab };
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
  const { [id]: _control, ...remainingControlTabs } = controlTabsByProfile.value;
  workspaceViewsByProfile.value = remainingWorkspaceViews;
  controlTabsByProfile.value = remainingControlTabs;
  persistTabMap('mc.workspaceTabs.v1', remainingWorkspaceViews);
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

function sendChat(text) {
  const msg = (text ?? '').trim();
  if (!msg || !selectedProfile.value) return;
  socket.emit('bot:chat', { botId: selectedProfile.value.id, message: msg });
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
.app-brand-logo { flex:none; width:38px; height:38px; object-fit:contain; }
.global-settings-button { width:38px; height:34px; display:grid; place-items:center; border:2px solid #0d0f0a; background:#272d1d; color:#cdd2c0; box-shadow:inset 1px 1px 0 rgba(255,255,255,.06),inset -2px -2px 0 rgba(0,0,0,.35); cursor:pointer; font-size:18px; -webkit-app-region:no-drag; }
.global-settings-button:hover,.global-settings-button.active { color:#fff; background:#4c7a2a; }
.global-settings-layer { position:absolute; z-index:20; inset:66px 0 0; display:flex; min-width:0; min-height:0; background:#0c0e08; }
.partner-workspace-shell {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: 272px minmax(0, 1fr) 422px;
  grid-template-rows: auto minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.partner-sidebar { grid-column: 1; grid-row: 1 / 3; }
.partner-workspace-bar {
  grid-column: 2 / 4;
  grid-row: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 10px 16px;
  background: #1b1e14;
  border-bottom: 3px solid #0c0e08;
}
.workspace-partner {
  flex: 0 0 auto;
  min-width: 150px;
  display: flex;
  align-items: center;
  gap: 9px;
}
.workspace-partner-head {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0f110a;
  border: 2px solid #000;
}
.workspace-partner-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.workspace-partner-copy strong {
  max-width: 180px;
  overflow: hidden;
  color: #f0eddd;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-partner-copy span { color: #7e836e; font-size: 11px; white-space: nowrap; }
.partner-workspace-tabs {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}
.partner-workspace-tabs::-webkit-scrollbar { display: none; }
.partner-workspace-tab {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 7px 14px;
  cursor: pointer;
  background: #272d1d;
  border: 2px solid #0d0f0a;
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.06), inset -2px -2px 0 rgba(0,0,0,0.35);
  color: #b9bda8;
  font-family: var(--mc-font-body);
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}
.partner-workspace-tab.active {
  background: #4c7a2a;
  border-color: #2b5e16;
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.28), inset -2px -2px 0 rgba(0,0,0,0.3);
  color: #fff;
  text-shadow: 1px 1px 0 rgba(0,0,0,0.4);
}
.partner-workspace-panel {
  grid-column: 2 / 4;
  grid-row: 2;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.play-stage { grid-column: 2; grid-row: 2; }
.play-control { grid-column: 3; grid-row: 2; }
.chat-panel {
  overflow: hidden;
  padding: 8px;
  background: #11140c;
  border: 2px solid #0c0e08;
  box-shadow:
    inset 2px 2px 0 rgba(255,255,255,0.05),
    inset -2px -2px 0 rgba(0,0,0,0.45);
}

@media (max-width: 1000px) {
  .partner-workspace-shell { grid-template-columns: 220px minmax(0, 1fr) 360px; }
  .workspace-partner { min-width: 130px; }
}

@media (max-width: 760px) {
  .partner-workspace-shell { grid-template-columns: 86px minmax(0, 1fr); }
  .partner-sidebar { padding: 10px !important; }
  .partner-sidebar > div:first-child { justify-content: center !important; }
  .partner-sidebar > div:first-child > span,
  .partner-sidebar > div:nth-child(2),
  .partner-list-summary,
  .partner-count { display: none !important; }
  .partner-list-item { justify-content: center; padding: 8px 6px !important; }
  .partner-workspace-bar { grid-column: 2; gap: 10px; padding: 8px 10px; }
  .workspace-partner { min-width: 0; }
  .workspace-partner-copy span { display: none; }
  .workspace-partner-copy strong { max-width: 94px; font-size: 12px; }
  .partner-workspace-tab { min-height: 32px; padding: 6px 10px; font-size: 12px; }
  .partner-workspace-panel { grid-column: 2; }
  .play-stage { display: none; }
  .play-control { grid-column: 2; }
}

@media (max-width: 640px) {
  .app-topbar {
    gap: 12px !important;
    height: 54px !important;
    padding: 0 14px !important;
    overflow: hidden;
  }
  .app-brand { flex: 0 0 auto; gap: 8px !important; }
  .app-brand-logo { width: 34px; height: 34px; }
  .app-brand-name { font-size: 12px !important; white-space: nowrap; }
  .app-header-spacer, .app-hub-status { display: none !important; }
}
</style>
