<template>
  <div class="settings-view mc-subsystem">
    <!-- 左侧分类导航 -->
    <nav class="settings-nav">
      <div class="settings-nav-header">
        <div class="snav-title">{{ scope === 'global' ? '全局设置' : '伙伴设置' }}</div>
        <button v-if="scope === 'global'" class="settings-close mc-button" type="button" aria-label="返回控制台" @click="emit('close')">
          <McIcon name="close" :size="12" />
          <span>返回控制台</span>
        </button>
      </div>
      <button
        v-for="item in navItems" :key="item.id"
        class="snav-item"
        :class="{ active: activeSection === item.id }"
        @click="activeSection = item.id"
      >
        <McIcon class="snav-icon" :name="item.iconName" :size="14" />
        {{ item.label }}
      </button>
    </nav>

    <!-- 右侧内容 -->
    <div class="settings-content mc-page">

      <!-- 伙伴配置 -->
      <div v-if="activeSection === 'bot'" class="settings-section">
        <h3 class="icon-heading"><McIcon name="bot" :size="16" />伙伴基本信息</h3>
        <p class="desc">Bot 的身份与性格设定，影响 AI 大脑的决策风格</p>
        <div class="form-grid">
          <div class="form-field">
            <label>名字</label>
            <input v-model="form.name" />
          </div>
          <div class="form-field">
            <label>皮肤（MC 用户名）</label>
            <input v-model="form.skinName" />
          </div>
          <div class="form-field full">
            <label>性格描述</label>
            <input v-model="form.personality" />
            <span class="hint">影响 AI 的说话风格和行为偏好</span>
          </div>
          <div class="form-field">
            <label>你的 Minecraft 玩家名</label>
            <input v-model="form.ownerName" />
          </div>
        </div>
        <div class="separator"></div>
        <div class="form-field">
          <label>AI Agent</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <select v-model="form.llmConfigId" :disabled="!selectedProfile" style="flex:1;">
              <option value="">-- 请选择全局 Agent 配置 --</option>
              <option v-for="config in llmConfigs" :key="config.id" :value="config.id">{{ config.name }} · {{ config.model }}</option>
            </select>
            <button class="btn btn-ghost" @click="emit('request-global-settings')">管理配置</button>
          </div>
          <span v-if="selectedRoleLlmConfig()" class="hint">{{ selectedRoleLlmConfig().baseUrl }} · {{ selectedRoleLlmConfig().model }} · {{ selectedRoleLlmConfig().apiKeyConfigured ? 'Key 已配置' : '使用服务端默认 Key' }}</span>
          <span v-else class="hint">请选择用于此角色的全局 LLM Agent 配置。</span>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" @click="saveBot">保存更改</button>
          <button class="btn btn-ghost" @click="loadForm">重置</button>
        </div>
        <div v-if="savedMsg" class="save-ok"><McIcon name="success" :size="13" />{{ savedMsg }}</div>
        <div v-if="errorMsg" class="save-error"><McIcon name="error" :size="13" />{{ errorMsg }}</div>
      </div>

      <!-- FEAT-CROSS-12 · 四部分角色卡 -->
      <div v-if="activeSection === 'character-card'" class="settings-section">
        <h3>角色卡</h3>
        <p class="desc">角色是谁、与你的关系、所处世界，以及如何表达和行动。</p>

        <div class="form-field" style="margin-bottom:14px;">
          <label>从模板开始</label>
          <div class="quick-actions">
            <button class="qa-btn" @click="applyCharacterTemplate('real_world_friend')">现实游戏好友</button>
            <button class="qa-btn" @click="applyCharacterTemplate('minecraft_native')">Minecraft 原住民</button>
          </div>
        </div>

        <div class="character-tabs" role="tablist" aria-label="角色卡部分">
          <button v-for="tab in characterTabs" :key="tab.id" class="character-tab" :class="{ active: characterTab === tab.id }" @click="characterTab = tab.id">{{ tab.label }}</button>
        </div>

        <template v-if="characterCard && characterTab === 'character'">
          <div class="form-grid">
            <div class="form-field"><label>姓名</label><input v-model="characterCard.character.identity.name" /></div>
            <div class="form-field"><label>物种</label><input v-model="characterCard.character.identity.species" /></div>
            <div class="form-field"><label>年龄</label><input v-model="characterCard.character.identity.age" /></div>
            <div class="form-field"><label>职业</label><input v-model="characterCard.character.identity.occupation" /></div>
            <div class="form-field full"><label>自我认知</label><textarea v-model="characterCard.character.identity.selfConcept" rows="2"></textarea></div>
            <div class="form-field full"><label>背景故事</label><textarea v-model="characterCard.character.identity.background" rows="3"></textarea></div>
            <div class="form-field full"><label>外貌</label><textarea v-model="characterCard.character.identity.appearance" rows="2"></textarea></div>
            <div class="form-field full"><label>人格概述</label><textarea v-model="characterCard.character.personality.summary" rows="3"></textarea></div>
            <div class="form-field full"><label>说话风格</label><textarea v-model="characterCard.character.personality.speechStyle" rows="2"></textarea></div>
            <div v-for="field in personalityListFields" :key="field.key" class="form-field">
              <label>{{ field.label }}</label>
              <input :value="characterCard.character.personality[field.key].join('，')" @input="setCardList(characterCard.character.personality, field.key, $event.target.value)" />
            </div>
          </div>
        </template>

        <template v-if="characterCard && characterTab === 'relationship'">
          <div class="form-grid">
            <div class="form-field"><label>关系类型</label><input v-model="characterCard.relationship.type" /></div>
            <div class="form-field"><label>对你的称呼</label><input v-model="characterCard.relationship.addressUserAs" /></div>
            <div class="form-field full"><label>共同经历</label><textarea v-model="characterCard.relationship.history" rows="3"></textarea></div>
            <div class="form-field full"><label>相处方式</label><textarea v-model="characterCard.relationship.interactionStyle" rows="2"></textarea></div>
            <div class="form-field"><label>你的名字</label><input v-model="characterCard.relationship.userPersona.name" /></div>
            <div class="form-field"><label>你的世界内身份</label><input v-model="characterCard.relationship.userPersona.identity" /></div>
            <div class="form-field full"><label>你的背景</label><textarea v-model="characterCard.relationship.userPersona.background" rows="3"></textarea></div>
          </div>
        </template>

        <template v-if="characterCard && characterTab === 'world'">
          <div class="form-field"><label>世界观</label><textarea v-model="characterCard.world.worldview" rows="5"></textarea></div>
          <div class="form-field"><label>当前场景</label><textarea v-model="characterCard.world.currentScene" rows="3"></textarea></div>
          <div class="form-field"><label>首次开场</label><textarea v-model="characterCard.world.greeting" rows="3"></textarea></div>
          <label class="check-row"><input v-model="characterCard.world.stayInCharacter" type="checkbox" /> 保持角色视角，不主动跳出角色解释系统</label>
          <div class="separator"></div>
          <div class="section-title-row"><strong>世界书</strong><button class="qa-btn" @click="addWorldBookEntry">添加条目</button></div>
          <div v-for="(entry, index) in characterCard.world.worldBook" :key="entry.id" class="repeat-editor">
            <div class="form-grid">
              <div class="form-field"><label>标题</label><input v-model="entry.title" /></div>
              <div class="form-field"><label>关键词</label><input :value="entry.keywords.join('，')" @input="entry.keywords = parseCardList($event.target.value)" /></div>
              <div class="form-field full"><label>内容</label><textarea v-model="entry.content" rows="3"></textarea></div>
              <div class="form-field"><label>优先级</label><input v-model.number="entry.priority" type="number" /></div>
              <div class="inline-checks"><label><input v-model="entry.enabled" type="checkbox" /> 启用</label><label><input v-model="entry.constant" type="checkbox" /> 常驻</label></div>
            </div>
            <button class="qa-btn danger" @click="characterCard.world.worldBook.splice(index, 1)">删除条目</button>
          </div>
        </template>

        <template v-if="characterCard && characterTab === 'performance'">
          <div class="form-field"><label>回复表现</label><textarea v-model="characterCard.performance.responseStyle" rows="3"></textarea></div>
          <div class="form-grid">
            <div class="form-field"><label>主动程度</label><select v-model="characterCard.performance.initiative"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div>
            <div class="form-field"><label>动作与旁白</label><select v-model="characterCard.performance.narration"><option value="none">无</option><option value="light">少量</option><option value="rich">丰富</option></select></div>
            <div class="form-field full">
              <label>任务进展汇报</label>
              <select v-model="characterCard.performance.progressReportLevel">
                <option value="quiet">安静 · 只说困难询问和最终结果</option>
                <option value="balanced">适中 · 遇到稳定困难或改计划时汇报</option>
                <option value="talkative">详细 · 额外汇报阶段里程碑和恢复进展</option>
              </select>
              <small class="hint">不会汇报每次扫描、原子重试或模型思考；安全事件和最终结果不受此档位影响。</small>
            </div>
          </div>
          <div class="separator"></div>
          <strong>能力</strong>
          <div class="capability-grid">
            <label><input v-model="characterCard.performance.capabilities.chat" type="checkbox" /> 聊天</label>
            <label><input v-model="characterCard.performance.capabilities.memory" type="checkbox" /> 长期记忆</label>
            <label><input v-model="characterCard.performance.capabilities.minecraft" type="checkbox" /> Minecraft</label>
            <label><input v-model="characterCard.performance.capabilities.voice" type="checkbox" /> 语音</label>
          </div>
          <div class="separator"></div>
          <div class="section-title-row"><strong>示例对白</strong><button class="qa-btn" @click="addExampleDialog">添加对白</button></div>
          <div v-for="(dialog, index) in characterCard.performance.exampleDialogs" :key="index" class="repeat-editor">
            <div class="form-field"><label>你说</label><textarea v-model="dialog.user" rows="2"></textarea></div>
            <div class="form-field"><label>角色说</label><textarea v-model="dialog.character" rows="2"></textarea></div>
            <button class="qa-btn danger" @click="characterCard.performance.exampleDialogs.splice(index, 1)">删除对白</button>
          </div>
        </template>

        <div class="form-actions">
          <button class="btn btn-primary" :disabled="!characterCard || savingCharacterCard" @click="saveCharacterCard">{{ savingCharacterCard ? '保存中…' : '保存并立即应用' }}</button>
          <button class="btn btn-ghost" @click="loadCharacterCard">重置</button>
        </div>
        <div v-if="savedMsg" class="save-ok">{{ savedMsg }}</div>
        <div v-if="errorMsg" class="save-error">{{ errorMsg }}</div>
      </div>

      <!-- 服务器连接 -->
      <div v-if="activeSection === 'server'" class="settings-section">
        <h3>Minecraft 服务器</h3>
        <p class="desc">为当前伙伴选择一个全局服务器配置。</p>
        <div class="form-field" style="margin-bottom:12px;">
          <label>服务器配置</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <select v-model="selectedPresetId" @change="applyServerPreset(selectedPresetId)" style="flex:1;">
              <option value="">-- 请选择全局服务器配置 --</option>
              <option v-for="p in serverPresets" :key="p.id" :value="p.id">{{ p.name }} （{{ p.host }}:{{ p.port }}）</option>
            </select>
            <button class="btn btn-ghost" @click="emit('request-global-settings', 'servers')">管理服务器</button>
          </div>
          <span v-if="!selectedPresetId && selectedProfile?.server?.host" class="hint">当前仍使用旧的自定义地址 {{ selectedProfile.server.host }}:{{ selectedProfile.server.port }}；选择全局配置后将完成迁移。</span>
        </div>
        <div v-if="selectedServerPreset" class="provider-box">
          <div class="provider-title">{{ selectedServerPreset.name }}</div>
          <div>{{ selectedServerPreset.host }}:{{ selectedServerPreset.port }} · {{ selectedServerPreset.version || '自动版本' }} · {{ selectedServerPreset.auth === 'microsoft' ? '微软登录' : '离线模式' }}</div>
          <div>游戏内皮肤：{{ selectedServerPreset.skinSync?.mode === 'disabled' ? '未启用' : 'SkinsRestorer 同步' }}</div>
        </div>
        <div class="skin-sync-status" :class="skinSyncState">
          <div class="provider-title">游戏内皮肤</div>
          <div>{{ skinSyncLabel }}</div>
          <div v-if="botStatus?.skinSync?.reasonCode" class="hint">{{ botStatus.skinSync.reasonCode }}</div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" :disabled="!selectedPresetId" @click="saveServer">应用到当前伙伴</button>
        </div>
        <div v-if="savedMsg" class="save-ok">{{ savedMsg }}</div>
        <div v-if="errorMsg" class="save-error">{{ errorMsg }}</div>
      </div>

      <!-- 全局服务器配置 -->
      <div v-if="activeSection === 'servers'" class="settings-section">
        <h3>服务器配置</h3>
        <p class="desc">全局维护服务器连接和皮肤同步能力；伙伴只负责选择使用哪一个。</p>
        <div v-if="serverPresets.length === 0" class="warn-box">还没有服务器配置。</div>
        <div v-for="preset in serverPresets" :key="preset.id" class="provider-box">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <div class="provider-title" style="margin-bottom:0;">{{ preset.name }}</div>
            <span class="hint">{{ preset.host }}:{{ preset.port }}</span>
            <div style="margin-left:auto; display:flex; gap:6px;">
              <button class="qa-btn" @click="editServerPreset(preset)">编辑</button>
              <button class="qa-btn danger" @click="deleteServerPreset(preset)">删除</button>
            </div>
          </div>
          <div>{{ preset.version || '自动版本' }} · {{ preset.auth === 'microsoft' ? '微软登录' : '离线模式' }} · {{ preset.skinSync?.mode === 'disabled' ? '皮肤同步关闭' : '皮肤同步已启用' }}</div>
        </div>
        <div class="separator"></div>
        <div class="provider-title">{{ serverPresetForm.id ? '编辑服务器配置' : '新建服务器配置' }}</div>
        <div class="form-grid">
          <div class="form-field"><label>名称</label><input v-model="serverPresetForm.name" placeholder="例如：生存服" /></div>
          <div class="form-field"><label>地址</label><input v-model="serverPresetForm.host" placeholder="127.0.0.1" spellcheck="false" /></div>
          <div class="form-field"><label>端口</label><input v-model.number="serverPresetForm.port" type="number" min="1" max="65535" /></div>
          <div class="form-field"><label>游戏版本</label><input v-model="serverPresetForm.version" placeholder="1.21" /></div>
          <div class="form-field">
            <label>验证方式</label>
            <select v-model="serverPresetForm.auth"><option value="offline">离线模式</option><option value="microsoft">微软登录</option></select>
          </div>
          <div class="form-field">
            <label>游戏内皮肤同步</label>
            <select v-model="serverPresetForm.skinSyncMode"><option value="skinsrestorer">SkinsRestorer</option><option value="disabled">关闭</option></select>
          </div>
        </div>
        <div v-if="serverPresetForm.skinSyncMode === 'skinsrestorer'" class="warn-box" style="margin-top:12px;">服务器必须安装 SkinsRestorer。同步时会把伙伴皮肤提交给 MineSkin，生成 Minecraft 客户端可验证的签名纹理。</div>
        <div class="form-actions">
          <button class="btn btn-ghost" @click="startNewServerPreset">新建</button>
          <button class="btn btn-primary" @click="saveServerPreset">保存配置</button>
        </div>
        <div v-if="savedMsg" class="save-ok">{{ savedMsg }}</div>
        <div v-if="errorMsg" class="save-error">{{ errorMsg }}</div>
      </div>

      <!-- Global LLM Agent configurations -->
      <div v-if="activeSection === 'llm-configs'" class="settings-section">
        <h3 class="icon-heading"><McIcon name="key" :size="16" />LLM Agent 配置</h3>
        <p class="desc">全局管理模型连接；角色只选择使用哪一个 Agent。</p>
        <div v-if="llmConfigs.length === 0" class="warn-box">还没有可选 Agent 配置。新建一个配置后即可分配给任意角色。</div>
        <div v-for="config in llmConfigs" :key="config.id" class="provider-box">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <div class="provider-title" style="margin-bottom:0;">{{ config.name }}</div>
            <span class="hint">{{ config.profileCount }} 个角色使用</span>
            <div style="margin-left:auto; display:flex; gap:6px;">
              <button class="qa-btn" @click="editLlmConfig(config)">编辑</button>
              <button class="qa-btn" @click="testSavedLlmConfig(config)">测试</button>
              <button class="qa-btn danger" :disabled="config.profileCount > 0" :title="config.profileCount > 0 ? `仍有 ${config.profileCount} 个角色使用此配置` : '删除配置'" @click="deleteLlmConfig(config)">删除</button>
            </div>
          </div>
          <div>{{ config.baseUrl }} · {{ config.model }} · {{ config.apiKeyConfigured ? 'Key 已配置' : '使用服务端默认 Key' }}</div>
        </div>
        <div class="separator"></div>
        <div class="provider-title">{{ llmConfigForm.id ? '编辑 Agent 配置' : '新建 Agent 配置' }}</div>
        <div class="form-grid">
          <div class="form-field">
            <label>名称</label>
            <input v-model="llmConfigForm.name" placeholder="例如：DeepSeek Chat" spellcheck="false" />
          </div>
          <div class="form-field full">
            <label>Base URL</label>
            <input v-model="llmConfigForm.baseUrl" placeholder="https://api.openai.com/v1" spellcheck="false" autocomplete="off" autocapitalize="off" />
          </div>
          <div class="form-field">
            <label>模型</label>
            <input v-model="llmConfigForm.model" placeholder="deepseek-chat / gpt-4o-mini / anthropic/claude-3.5-sonnet" spellcheck="false" autocomplete="off" autocapitalize="off" />
          </div>
          <div class="form-field full">
            <label>API Key</label>
            <input type="password" v-model="llmConfigForm.apiKey" :placeholder="selectedLlmConfig()?.apiKeyConfigured ? '已保存；留空保持不变' : '留空使用服务端默认 LLM_API_KEY'" spellcheck="false" autocomplete="new-password" autocapitalize="off" />
            <button v-if="selectedLlmConfig()?.apiKeyConfigured" class="qa-btn" style="margin-top:8px; align-self:flex-start" @click="clearLlmConfigApiKey = true">清除已保存 Key</button>
          </div>
        </div>
        <div class="separator"></div>
        <div class="quick-actions">
          <button
            v-for="preset in modelPresets" :key="preset.label"
            class="qa-btn"
            :class="{ active: llmConfigForm.baseUrl === preset.baseUrl && llmConfigForm.model === preset.model }"
            @click="applyPreset(preset)"
          >{{ preset.label }}</button>
        </div>
        <div class="form-actions" style="margin-top:16px">
          <button class="btn btn-ghost" @click="startNewLlmConfig">新建</button>
          <button class="btn btn-ghost" @click="testLlmConfig" :disabled="testingLlm">{{ testingLlm ? '测试中…' : '测试连接' }}</button>
          <button class="btn btn-primary" @click="saveLlmConfig" :disabled="savingLlm">保存配置</button>
        </div>
        <div v-if="llmTestMsg" class="test-result" :class="{ ok: llmTestOk, fail: !llmTestOk }">{{ llmTestMsg }}</div>
        <div v-if="savedMsg" class="save-ok"><McIcon name="success" :size="13" />{{ savedMsg }}</div>
        <div v-if="errorMsg" class="save-error"><McIcon name="error" :size="13" />{{ errorMsg }}</div>
      </div>

      <!-- FEAT-WEBUI-15 · Minecraft 桌面角色 -->
      <div v-if="activeSection === 'desktop-pet'" class="settings-section">
        <h3>桌面角色</h3>
        <p class="desc">让一个伙伴以 Minecraft 形象常驻桌面。首版同时只显示一个角色。</p>
        <div v-if="!isElectron" class="warn-box">设置可以保存，但桌面角色只会在 MineClaw Electron 桌面版中显示。</div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">启用桌面角色</div>
            <div class="toggle-desc">主窗口隐藏到托盘后，角色仍会留在桌面</div>
          </div>
          <button class="toggle" :class="{ off: !desktopPet.enabled }" @click="desktopPet.enabled = !desktopPet.enabled"></button>
        </div>
        <div class="form-grid">
          <div class="form-field">
            <label>显示角色</label>
            <select v-model="desktopPet.profileId">
              <option value="">-- 选择一个伙伴 --</option>
              <option v-for="profile in desktopPetProfiles" :key="profile.id" :value="profile.id">{{ profile.characterCard?.character?.identity?.name || profile.name }}</option>
            </select>
          </div>
          <div class="form-field">
            <label>行为模式</label>
            <select v-model="desktopPet.mode">
              <option value="fixed">固定，可拖拽</option>
              <option value="wander">在桌面走来走去</option>
            </select>
          </div>
        </div>
        <div class="provider-box">
          <strong>{{ desktopPet.mode === 'fixed' ? '固定模式' : '漫游模式' }}</strong>
          <div>{{ desktopPet.mode === 'fixed' ? '直接拖动角色即可调整位置，松手后自动记住。' : '角色会在当前显示器底部随机走动，并自动避开屏幕边界和任务栏。' }}</div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" :disabled="savingDesktopPet || (desktopPet.enabled && !desktopPet.profileId)" @click="saveDesktopPet">{{ savingDesktopPet ? '保存中…' : '保存并立即应用' }}</button>
          <button class="btn btn-ghost" @click="loadDesktopPet">重置</button>
        </div>
        <div v-if="savedMsg" class="save-ok"><McIcon name="success" :size="13" />{{ savedMsg }}</div>
        <div v-if="errorMsg" class="save-error"><McIcon name="error" :size="13" />{{ errorMsg }}</div>
      </div>

      <!-- 高级 -->
      <div v-if="activeSection === 'advanced'" class="settings-section">
        <h3 class="icon-heading"><McIcon name="tool" :size="16" />高级 / 调试</h3>
        <p class="desc">开发者选项，谨慎修改</p>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">纯聊天语义检索（本地 Embedding）</div>
            <div class="toggle-desc">关闭后保留 FTS5 精确检索和原始记忆；运行中的伙伴需重启后生效</div>
          </div>
          <button class="toggle" :class="{ off: !form.semanticSearch }" :disabled="!selectedProfile" @click="form.semanticSearch = !form.semanticSearch"></button>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" :disabled="!selectedProfile" @click="saveMemorySettings">保存记忆设置</button>
        </div>
        <div v-if="savedMsg" class="save-ok"><McIcon name="success" :size="13" />{{ savedMsg }}</div>
        <div v-if="errorMsg" class="save-error"><McIcon name="error" :size="13" />{{ errorMsg }}</div>
        <div class="separator"></div>
        <div class="toggle-row">
          <div><div class="toggle-label">详细日志</div><div class="toggle-desc">输出工具调用详情</div></div>
          <button class="toggle off"></button>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Heartbeat Debug</div><div class="toggle-desc">每 tick 打印执行锁状态</div></div>
          <button class="toggle off"></button>
        </div>
        <div class="separator"></div>
        <div class="form-grid">
          <div class="form-field">
            <label>Tick 间隔（ms）</label>
            <input value="200" />
            <span class="hint">默认 200ms</span>
          </div>
          <div class="form-field">
            <label>数据目录</label>
            <input value="./data" readonly />
          </div>
        </div>
        <div class="separator"></div>
        <div class="quick-actions">
          <button class="qa-btn danger icon-button-label"><McIcon name="warning" :size="14" />强制停止所有 Bot</button>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import McIcon from './icons/McIcon.vue';

const props = defineProps({
  selectedProfile: { type: Object, default: null },
  botStatus: { type: Object, default: null },
  initialSection: { type: String, default: 'bot' },
  scope: { type: String, default: 'profile' },
});

const emit = defineEmits(['profile-updated', 'request-global-settings', 'close']);

const activeSection = ref(props.initialSection);
const characterTab = ref('character');
const characterCard = ref(null);
const savingCharacterCard = ref(false);
const savedMsg = ref('');
const errorMsg = ref('');
const savingLlm = ref(false);
const testingLlm = ref(false);
const llmTestMsg = ref('');
const llmTestOk = ref(false);
const llmConfigs = ref([]);
const clearLlmConfigApiKey = ref(false);
const llmConfigForm = reactive({ id: '', name: '', apiKey: '', baseUrl: '', model: '' });
const isElectron = typeof window !== 'undefined' && Boolean(window.electronAPI);
const desktopPetProfiles = ref([]);
const savingDesktopPet = ref(false);
const desktopPet = reactive({ enabled: false, profileId: '', mode: 'fixed' });

// FEAT-WEBUI-12 · 全局共享服务器预设
const serverPresets = ref([]);
const selectedPresetId = ref('');
const serverPresetForm = reactive({ id: '', name: '', host: '', port: 25565, version: '1.21', auth: 'offline', skinSyncMode: 'skinsrestorer' });

const profileNavItems = [
  { id: 'bot', iconName: 'bot', label: '伙伴配置' },
  { id: 'character-card', iconName: 'id-card', label: '角色卡' },
  { id: 'server', iconName: 'server', label: '服务器连接' },
];
const globalNavItems = [
  { id: 'llm-configs', iconName: 'key', label: 'LLM Agent 配置' },
  { id: 'servers', iconName: 'server', label: '服务器配置' },
  { id: 'desktop-pet', iconName: 'character', label: '桌面角色' },
  { id: 'advanced', iconName: 'tool', label: '高级 / 调试' },
];
const navItems = props.scope === 'global' ? globalNavItems : profileNavItems;

async function loadDesktopPet() {
  try {
    const [configResponse, profilesResponse] = await Promise.all([
      fetch('/api/desktop-pet'),
      fetch('/api/profiles'),
    ]);
    if (!configResponse.ok || !profilesResponse.ok) throw new Error('加载桌面角色设置失败');
    const config = await configResponse.json();
    desktopPetProfiles.value = await profilesResponse.json();
    desktopPet.enabled = Boolean(config.enabled);
    desktopPet.profileId = config.profileId || '';
    desktopPet.mode = config.mode || 'fixed';
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function saveDesktopPet() {
  savingDesktopPet.value = true;
  try {
    const response = await fetch('/api/desktop-pet', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: desktopPet.enabled,
        profileId: desktopPet.profileId || undefined,
        mode: desktopPet.mode,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存桌面角色设置失败');
    showSaved(isElectron ? '桌面角色设置已应用' : '设置已保存；启动桌面版后生效');
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    savingDesktopPet.value = false;
  }
}

const characterTabs = [
  { id: 'character', label: '角色本身' },
  { id: 'relationship', label: '关系与用户' },
  { id: 'world', label: '世界与场景' },
  { id: 'performance', label: '表演与能力' },
];
const personalityListFields = [
  { key: 'traits', label: '性格特质' }, { key: 'values', label: '价值观' },
  { key: 'likes', label: '喜欢' }, { key: 'dislikes', label: '不喜欢' },
  { key: 'boundaries', label: '角色边界' },
];

const modelPresets = [
  { label: 'DeepSeek Chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { label: 'DeepSeek Reasoner', baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner' },
  { label: 'GPT-4o Mini', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Claude via OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-sonnet' },
  { label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b' },
];

const form = reactive({
  name: '', skinName: '', personality: '', ownerName: '',
  host: '', port: 25565, auth: 'offline', version: '1.21', autoReconnect: true,
  llmConfigId: '',
  semanticSearch: true,
});

const selectedServerPreset = computed(() => serverPresets.value.find(preset => preset.id === selectedPresetId.value) || null);
const skinSyncState = computed(() => props.botStatus?.skinSync?.state || 'idle');
const skinSyncLabel = computed(() => props.botStatus?.skinSync?.message || '尚未进入游戏');

function loadForm() {
  const p = props.selectedProfile;
  if (!p) {
    form.name = '';
    form.skinName = '';
    form.personality = '';
    form.ownerName = '';
    form.host = '';
    form.port = 25565;
    form.auth = 'offline';
    form.version = '1.21';
    form.llmConfigId = '';
    form.semanticSearch = true;
    selectedPresetId.value = '';
    characterCard.value = null;
    return;
  }
  form.name = p.name ?? '';
  form.skinName = p.name ?? '';
  form.personality = p.personality?.description ?? '';
  form.ownerName = p.ownerUsername ?? '';
  form.host = p.server?.host ?? '';
  form.port = p.server?.port ?? 25565;
  form.auth = p.server?.auth ?? 'offline';
  form.version = p.server?.version ?? '1.21';
  form.llmConfigId = p.llmConfigId ?? '';
  form.semanticSearch = p.memory?.semanticSearch ?? true;
  reconcileSelectedServerPreset();
  void loadCharacterCard();
}

function parseCardList(value) {
  return String(value || '').split(/[，,\n]/).map(item => item.trim()).filter(Boolean);
}

function setCardList(target, key, value) {
  target[key] = parseCardList(value);
}

async function loadCharacterCard() {
  if (!props.selectedProfile) { characterCard.value = null; return; }
  try {
    const res = await fetch(`/api/profiles/${props.selectedProfile.id}/character-card`);
    if (!res.ok) throw new Error(`角色卡加载失败 (${res.status})`);
    const card = await res.json();
    card.performance.progressReportLevel ??= 'balanced';
    characterCard.value = card;
  } catch (e) { showError(e instanceof Error ? e.message : '角色卡加载失败'); }
}

async function applyCharacterTemplate(templateId) {
  const res = await fetch(`/api/character-card/templates/${templateId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterName: form.name || props.selectedProfile?.name, userName: form.ownerName || props.selectedProfile?.ownerUsername }),
  });
  if (!res.ok) { showError('模板加载失败'); return; }
  characterCard.value = await res.json();
  showSaved('模板已载入，保存后生效');
}

function addWorldBookEntry() {
  if (!characterCard.value) return;
  characterCard.value.world.worldBook.push({ id: `lore-${Date.now()}`, title: '新条目', content: '', enabled: true, constant: false, keywords: [], priority: 0 });
}

function addExampleDialog() {
  characterCard.value?.performance.exampleDialogs.push({ user: '', character: '' });
}

async function saveCharacterCard() {
  if (!props.selectedProfile || !characterCard.value) return;
  savingCharacterCard.value = true;
  try {
    const res = await fetch(`/api/profiles/${props.selectedProfile.id}/character-card`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(characterCard.value),
    });
    const data = await res.json();
    if (!res.ok) {
      const first = data.errors?.[0];
      throw new Error(first ? `${first.path}：${first.message}` : data.error || `HTTP ${res.status}`);
    }
    characterCard.value = data;
    const profileRes = await fetch(`/api/profiles/${props.selectedProfile.id}`);
    if (profileRes.ok) emit('profile-updated', await profileRes.json());
    showSaved('角色卡已保存并应用');
  } catch (e) { showError(e instanceof Error ? e.message : '角色卡保存失败'); }
  finally { savingCharacterCard.value = false; }
}

function showSaved(msg = '已保存') {
  errorMsg.value = '';
  savedMsg.value = msg;
  setTimeout(() => savedMsg.value = '', 2500);
}

function showError(msg = '保存失败') {
  savedMsg.value = '';
  errorMsg.value = msg;
  setTimeout(() => errorMsg.value = '', 4500);
}

function validateLlmBaseUrl(baseUrl) {
  const normalized = baseUrl.trim();
  if (normalized && !/^https?:\/\//i.test(normalized)) {
    showError('Base URL 必须以 http:// 或 https:// 开头');
    return null;
  }
  if (normalized && /api\.anthropic\.com/i.test(normalized)) {
    showError('暂不支持 Anthropic 原生接口；Claude 请用 OpenRouter/LiteLLM/OneAPI 的 /v1 兼容地址');
    return null;
  }
  return normalized;
}

async function patchProfile(body) {
  const res = await fetch(`/api/profiles/${props.selectedProfile.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return await res.json();
}

async function saveBot() {
  if (!props.selectedProfile) return;
  try {
    const body = {
      name: form.name,
      personality: { description: form.personality, style: props.selectedProfile?.personality?.style ?? 'lively' },
      llmConfigId: form.llmConfigId || null,
    };
    const updated = await patchProfile(body);
    await loadLlmConfigs();
    showSaved();
    emit('profile-updated', updated);
  } catch (e) { showError((e instanceof Error ? e.message : '') || '保存失败'); }
}

async function saveServer() {
  if (!props.selectedProfile) return;
  const preset = selectedServerPreset.value;
  if (!preset) { showError('请先选择全局服务器配置'); return; }
  try {
    const body = {
      server: {
        presetId: preset.id,
        host: preset.host,
        port: preset.port,
        auth: preset.auth || 'offline',
        version: preset.version,
      },
    };
    const updated = await patchProfile(body);
    showSaved('服务器配置已应用');
    emit('profile-updated', updated);
  } catch (e) { showError((e instanceof Error ? e.message : '') || '保存失败'); }
}

async function saveMemorySettings() {
  if (!props.selectedProfile) return;
  try {
    const updated = await patchProfile({ memory: { semanticSearch: form.semanticSearch } });
    showSaved('记忆设置已保存并自动应用');
    emit('profile-updated', updated);
  } catch (e) { showError((e instanceof Error ? e.message : '') || '保存失败'); }
}

function selectedLlmConfig() {
  return llmConfigs.value.find(config => config.id === llmConfigForm.id);
}

function selectedRoleLlmConfig() {
  return llmConfigs.value.find(config => config.id === form.llmConfigId);
}

function startNewLlmConfig() {
  llmConfigForm.id = '';
  llmConfigForm.name = '';
  llmConfigForm.apiKey = '';
  llmConfigForm.baseUrl = '';
  llmConfigForm.model = '';
  clearLlmConfigApiKey.value = false;
  llmTestMsg.value = '';
}

function editLlmConfig(config) {
  llmConfigForm.id = config.id;
  llmConfigForm.name = config.name;
  llmConfigForm.apiKey = '';
  llmConfigForm.baseUrl = config.baseUrl;
  llmConfigForm.model = config.model;
  clearLlmConfigApiKey.value = false;
  llmTestMsg.value = '';
}

async function loadLlmConfigs() {
  try {
    const response = await fetch('/api/llm-configs');
    if (response.ok) llmConfigs.value = await response.json();
  } catch { /* keep the last successful list */ }
}

async function saveLlmConfig() {
  const baseUrl = validateLlmBaseUrl(llmConfigForm.baseUrl);
  if (baseUrl == null) return;
  if (!llmConfigForm.name.trim() || !baseUrl || !llmConfigForm.model.trim()) {
    showError('请填写名称、Base URL 和模型');
    return;
  }
  savingLlm.value = true;
  try {
    const body = {
      name: llmConfigForm.name.trim(),
      baseUrl,
      model: llmConfigForm.model.trim(),
    };
    const newApiKey = llmConfigForm.apiKey.trim();
    if (newApiKey) body.apiKey = newApiKey;
    else if (clearLlmConfigApiKey.value) body.clearApiKey = true;
    const endpoint = llmConfigForm.id ? `/api/llm-configs/${llmConfigForm.id}` : '/api/llm-configs';
    const method = llmConfigForm.id ? 'PATCH' : 'POST';
    const response = await fetch(endpoint, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    llmConfigForm.id = data.id;
    llmConfigForm.apiKey = '';
    clearLlmConfigApiKey.value = false;
    await loadLlmConfigs();
    showSaved(data.restartedProfileCount ? `配置已保存，已重载 ${data.restartedProfileCount} 个角色` : 'Agent 配置已保存');
  } catch (e) {
    showError((e instanceof Error ? e.message : '') || '保存失败');
  } finally {
    savingLlm.value = false;
  }
}

async function testLlmConfig() {
  const baseUrl = validateLlmBaseUrl(llmConfigForm.baseUrl);
  if (baseUrl == null) return;
  if (!llmConfigForm.name.trim() || !baseUrl || !llmConfigForm.model.trim()) {
    showError('请填写名称、Base URL 和模型');
    return;
  }
  testingLlm.value = true;
  llmTestOk.value = false;
  llmTestMsg.value = '正在测试连接…';
  try {
    const endpoint = llmConfigForm.id ? `/api/llm-configs/${llmConfigForm.id}/test` : '/api/llm-configs/test';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: llmConfigForm.name.trim(),
        ...(llmConfigForm.apiKey.trim() ? { apiKey: llmConfigForm.apiKey.trim() } : {}),
        baseUrl,
        model: llmConfigForm.model.trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      llmTestOk.value = true;
      llmTestMsg.value = `测试通过：${data.model} @ ${data.baseUrl}${data.preview ? ` · ${data.preview}` : ''}`;
      return;
    }
    llmTestMsg.value = data.error || `测试失败：HTTP ${res.status}`;
  } catch (e) {
    llmTestMsg.value = `测试失败：${e instanceof Error ? e.message : '请求失败'}`;
  } finally {
    testingLlm.value = false;
  }
}

async function testSavedLlmConfig(config) {
  try {
    editLlmConfig(config);
    await testLlmConfig();
  } catch { showError('测试失败'); }
}

async function deleteLlmConfig(config) {
  if (config.profileCount > 0) {
    showError(`还有 ${config.profileCount} 个角色使用此配置`);
    return;
  }
  if (!confirm(`删除 Agent 配置「${config.name}」？`)) return;
  try {
    const response = await fetch(`/api/llm-configs/${config.id}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (llmConfigForm.id === config.id) startNewLlmConfig();
    await loadLlmConfigs();
    showSaved('Agent 配置已删除');
  } catch (e) {
    showError((e instanceof Error ? e.message : '') || '删除失败');
  }
}

function applyPreset(p) {
  llmConfigForm.baseUrl = p.baseUrl;
  llmConfigForm.model = p.model;
}

// FEAT-WEBUI-12 · 服务器预设
async function loadPresets() {
  try {
    const r = await fetch('/api/server-presets');
    if (r.ok) {
      serverPresets.value = await r.json();
      reconcileSelectedServerPreset();
    }
  } catch {}
}

function reconcileSelectedServerPreset() {
  const server = props.selectedProfile?.server;
  if (!server) { selectedPresetId.value = ''; return; }
  const direct = server.presetId && serverPresets.value.find(preset => preset.id === server.presetId);
  const matching = serverPresets.value.find(preset => preset.host === server.host
    && Number(preset.port) === Number(server.port)
    && (preset.auth || 'offline') === (server.auth || 'offline'));
  selectedPresetId.value = direct?.id || matching?.id || '';
  if (selectedPresetId.value) applyServerPreset(selectedPresetId.value);
}

function applyServerPreset(id) {
  const p = serverPresets.value.find(x => x.id === id);
  if (!p) return;
  form.host = p.host;
  form.port = p.port;
  if (p.version) form.version = p.version;
  if (p.auth) form.auth = p.auth;
}

function startNewServerPreset() {
  Object.assign(serverPresetForm, { id: '', name: '', host: '', port: 25565, version: '1.21', auth: 'offline', skinSyncMode: 'skinsrestorer' });
}

function editServerPreset(preset) {
  Object.assign(serverPresetForm, {
    id: preset.id,
    name: preset.name,
    host: preset.host,
    port: preset.port,
    version: preset.version || '',
    auth: preset.auth || 'offline',
    skinSyncMode: preset.skinSync?.mode === 'disabled' ? 'disabled' : 'skinsrestorer',
  });
}

async function saveServerPreset() {
  if (!serverPresetForm.name.trim() || !serverPresetForm.host.trim() || !Number.isInteger(Number(serverPresetForm.port))) {
    showError('名称、地址和有效端口必填');
    return;
  }
  try {
    const endpoint = serverPresetForm.id ? `/api/server-presets/${serverPresetForm.id}` : '/api/server-presets';
    const res = await fetch(endpoint, {
      method: serverPresetForm.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: serverPresetForm.name.trim(),
        host: serverPresetForm.host.trim(),
        port: Number(serverPresetForm.port),
        version: serverPresetForm.version.trim() || undefined,
        auth: serverPresetForm.auth,
        skinSync: { mode: serverPresetForm.skinSyncMode },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadPresets();
    editServerPreset(data);
    showSaved('服务器配置已保存');
  } catch (error) { showError(error instanceof Error ? error.message : '服务器配置保存失败'); }
}

async function deleteServerPreset(preset) {
  if (!confirm(`删除服务器配置「${preset.name}」？`)) return;
  try {
    const response = await fetch(`/api/server-presets/${preset.id}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (serverPresetForm.id === preset.id) startNewServerPreset();
    await loadPresets();
    showSaved('服务器配置已删除');
  } catch (error) { showError(error instanceof Error ? error.message : '删除失败'); }
}

onMounted(() => {
  loadForm();
  loadPresets();
  loadLlmConfigs();
  loadDesktopPet();
});

watch(() => props.selectedProfile?.id, () => {
  loadForm();
}, { immediate: true });

watch(() => props.initialSection, section => {
  if (navItems.some(item => item.id === section)) activeSection.value = section;
});
</script>

<style scoped>
.settings-view { flex: 1; display: flex; flex-direction: row; overflow: hidden; }

/* Left nav */
.settings-nav {
  width: 168px; flex-shrink: 0;
  background: var(--mc-bg-elevated); border-right: 1px solid var(--mc-border);
  padding: 14px 8px;
}
.settings-nav-header { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.snav-title {
  font-size: var(--mc-type-meta); font-weight: 700; color: var(--mc-text-muted);
  text-transform: uppercase; letter-spacing: 0.5px;
  padding: 0 8px;
}
.settings-close { width: 100%; justify-content: flex-start; }
.snav-item {
  display: flex; align-items: center; gap: 7px;
  width: 100%; padding: 8px 10px; border-radius: var(--mc-radius-sm);
  font-size: var(--mc-type-body); color: var(--mc-text-muted); cursor: pointer;
  transition: all .15s; margin-bottom: 2px;
  background: transparent; border: 1px solid transparent; text-align: left;
}
.snav-item:hover { color: var(--mc-text-secondary); background: var(--mc-surface-hover); border-color: var(--mc-border); }
.snav-item.active { color: var(--mc-accent-strong); background: var(--mc-accent-soft); border-color: rgba(105,201,74,.24); }
.snav-icon { flex-shrink: 0; }

/* Content */
.settings-content { flex: 1; overflow-y: auto; padding: 24px 28px; }
.settings-section { max-width: 1080px; }
.settings-section h3 { font-size: var(--mc-type-section-title); color: var(--mc-text); margin: 0 0 4px; }
.icon-heading { display: flex; align-items: center; gap: 7px; }
.desc { font-size: var(--mc-type-secondary); color: var(--mc-text-muted); margin: 0 0 18px; }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-field.full { grid-column: span 2; }
.form-field label { font-size: var(--mc-type-secondary); font-weight: 600; color: var(--mc-text-secondary); }
.form-field input, .form-field select, .form-field textarea {
  min-height: 38px; padding: 8px 10px; border-radius: var(--mc-radius-sm);
  border: 1px solid var(--mc-border-strong); background: var(--mc-bg);
  color: var(--mc-text); box-shadow: none; font-size: var(--mc-type-body); line-height: var(--mc-line-control); outline: none; font-family: inherit;
}
.form-field textarea { min-height: 84px; line-height: 1.55; resize: vertical; }
.form-field input:focus, .form-field select:focus, .form-field textarea:focus { border-color: var(--mc-accent); }
.hint { font-size: var(--mc-type-meta); color: var(--mc-text-muted); }

.character-tabs {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid var(--mc-border); margin-bottom: 16px;
}
.character-tab {
  min-height: 38px; padding: 7px 8px; border: 0; border-bottom: 2px solid transparent;
  background: transparent; color: var(--mc-text-muted); cursor: pointer; font-size: var(--mc-type-body);
}
.character-tab:hover { color: var(--mc-text-secondary); }
.character-tab.active { color: var(--mc-accent-strong); border-bottom-color: var(--mc-accent); background: var(--mc-accent-soft); }
.check-row, .inline-checks, .capability-grid label {
  color: var(--mc-text-secondary); font-size: var(--mc-type-secondary); display: flex; align-items: center; gap: 7px;
}
.section-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; color: var(--mc-text); }
.repeat-editor { margin-top: 10px; padding: 12px; border: 1px solid var(--mc-border); border-radius: var(--mc-radius-sm); background: var(--mc-surface); }
.repeat-editor:last-of-type { border-bottom: 0; }
.repeat-editor > .qa-btn { margin-top: 8px; }
.inline-checks { align-items: end; gap: 14px; padding-bottom: 8px; }
.capability-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }

.separator { height: 1px; background: var(--mc-border); margin: 18px 0; }

.toggle-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 11px 12px; border-radius: var(--mc-radius-sm);
  background: var(--mc-surface); border: 1px solid var(--mc-border); margin-bottom: 8px;
}
.toggle-label { font-size: var(--mc-type-body); color: var(--mc-text); }
.toggle-desc { font-size: var(--mc-type-meta); color: var(--mc-text-muted); margin-top: 1px; }
.toggle {
  width: 32px; height: 18px; border-radius: 9px;
  background: #3f8d3d; cursor: pointer; position: relative; flex-shrink: 0;
  border: 1px solid rgba(105,201,74,.38); transition: background .2s;
}
.toggle::after {
  content: ''; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; position: absolute; top: 2px; right: 2px; transition: right .2s;
}
.toggle.off { background: var(--mc-surface-raised); border-color: var(--mc-border-strong); }
.toggle.off::after { right: 14px; }

.quick-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.qa-btn {
  min-height: 34px; padding: 6px 12px; border-radius: var(--mc-radius-sm); font-size: var(--mc-type-body); cursor: pointer;
  background: var(--mc-surface-raised); border: 1px solid var(--mc-border-strong); color: var(--mc-text-secondary); box-shadow: none; transition: all .15s;
}
.qa-btn:hover { color: var(--mc-text); border-color: rgba(105,201,74,.3); background: var(--mc-surface-hover); }
.qa-btn.active { color: var(--mc-accent-strong); border-color: rgba(105,201,74,.28); background: var(--mc-accent-soft); }
.qa-btn.danger { color: var(--mc-danger); border-color: rgba(228,111,101,.24); }
.icon-button-label { display: inline-flex; align-items: center; gap: 6px; }

.form-actions { display: flex; gap: 8px; margin-top: 16px; }
.btn { min-height: 36px; padding: 7px 14px; border-radius: var(--mc-radius-sm); border: 1px solid var(--mc-border-strong); box-shadow: none; font-size: var(--mc-type-body); cursor: pointer; font-weight: 700; }
.btn-primary { background: #2f6d30; border-color: #488e42; color: #fff; }
.btn-ghost { background: var(--mc-surface-raised); color: var(--mc-text-secondary); }
.btn:hover { border-color: rgba(105,201,74,.3); background: var(--mc-surface-hover); color: var(--mc-text); }
.save-ok, .save-error { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: var(--mc-type-meta); }
.save-ok { color: var(--mc-accent); }
.save-error { color: var(--mc-danger); }
.warn-box {
  margin-bottom: 12px; padding: 10px 12px; border: 1px solid rgba(217,170,76,.28); border-radius: var(--mc-radius-sm);
  background: rgba(217,170,76,.1); color: #e4bd6d; font-size: 12px;
}
.provider-box {
  margin-bottom: 12px; padding: 12px; border: 1px solid var(--mc-border); border-radius: var(--mc-radius-sm);
  background: var(--mc-surface); color: var(--mc-text-secondary); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere;
}
.provider-box > div:first-child { min-width: 0; }
.provider-box > div:first-child .provider-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-title { color: var(--mc-text); font-weight: 700; margin-bottom: 2px; }
.provider-box code { color: var(--mc-accent-strong); }
.skin-sync-status {
  margin-top: 12px; padding: 10px 12px; border: 1px solid var(--mc-border); border-radius: var(--mc-radius-sm);
  background: var(--mc-surface); color: var(--mc-text-secondary); font-size: 12px;
}
.skin-sync-status.synced { border-color: rgba(105,201,74,.28); color: var(--mc-accent-strong); }
.skin-sync-status.pending { border-color: rgba(217,170,76,.28); color: #e4bd6d; }
.skin-sync-status.unsupported { color: var(--mc-text-muted); }
.skin-sync-status.failed { border-color: rgba(228,111,101,.28); color: #f1a9a2; background: rgba(228,111,101,.1); }
.test-result {
  margin-top: 10px; padding: 8px 10px; border: 1px solid var(--mc-border); border-radius: var(--mc-radius-sm);
  background: var(--mc-surface); font-size: 12px; word-break: break-word;
}
.test-result.ok { color: var(--mc-accent-strong); border-color: rgba(105,201,74,.28); }
.test-result.fail { color: #f1a9a2; border-color: rgba(228,111,101,.28); background: rgba(228,111,101,.1); }

@media (max-width: 640px) {
  .settings-view { flex-direction: column; }
  .settings-nav {
    box-sizing: border-box;
    width: 100%; min-height: 48px;
    display: flex; align-items: center; gap: 6px;
    overflow-x: auto; overflow-y: hidden;
    padding: 8px; border-right: 0; border-bottom: 1px solid var(--mc-border);
    scrollbar-width: none;
  }
  .settings-nav::-webkit-scrollbar { display: none; }
  .settings-nav-header { flex-direction: row; margin: 0; }
  .snav-title { display: none; }
  .settings-close { width: auto; flex: 0 0 auto; }
  .snav-item {
    width: auto; flex: 0 0 auto; margin: 0;
    padding: 7px 9px; white-space: nowrap;
  }
  .settings-content { min-width: 0; padding: 18px; }
  .form-grid { grid-template-columns: minmax(0, 1fr); }
  .form-field.full { grid-column: auto; }
  .character-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .capability-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

</style>
