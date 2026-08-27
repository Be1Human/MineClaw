import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProfileStore, toPublicBotProfile, type BotProfile } from './profileStore.js';
import { LlmAgentConfigStore, type LlmAgentConfigInput, type LlmAgentConfigPatch } from './llmAgentConfigStore.js';
import { ServerPresetStore, resolveSkinSyncMode } from './serverPresetStore.js';
import { DesktopPetConfigStore, type DesktopPetConfigInput } from './desktopPetConfigStore.js';
import { BotManager } from './botManager.js';
import { listCharacterTemplates, createCharacterTemplate } from '../character/templates.js';
import { validateCharacterCard } from '../character/validateCharacterCard.js';
import { registerPlannerEvolutionRoutes } from './plannerEvolutionRoutes.js';
import { LlmTraceQueryError, type LlmTraceAgent } from '../bot/v2/infra/llmTrace/index.js';
import { acceptChatSubmit, rejectChatSubmit, type ChatSubmitAck } from './chatSubmit.js';

export interface HubConfig {
  port: number;
  host: string;
  dataDir: string;
}

export interface DefaultLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function createHubServer(config: HubConfig, defaultLlm?: DefaultLlmConfig) {
  const app = express();
  app.use(express.json());

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

  const profileStore = new ProfileStore(config.dataDir);
  const llmAgentConfigStore = new LlmAgentConfigStore(config.dataDir);
  llmAgentConfigStore.migrateLegacyProfiles(profileStore, defaultLlm);
  const serverPresetStore = new ServerPresetStore(config.dataDir);
  const desktopPetConfigStore = new DesktopPetConfigStore(config.dataDir);
  const botManager = new BotManager(config.dataDir, llmAgentConfigStore, serverPresetStore);
  botManager.defaultLlm = defaultLlm ?? null;

  // 文件日志：每日滚动，写到 <dataDir>/logs/runtime-YYYYMMDD.log
  // 让外部工具（包括 Claude）能直接 tail 而不需要终端 stdout。
  const logsDir = join(config.dataDir, 'logs');
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const logFilePath = (): string => {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return join(logsDir, `runtime-${ymd}.log`);
  };
  const writeLogLine = (botId: string, level: string, message: string): void => {
    try {
      const ts = new Date().toISOString();
      appendFileSync(logFilePath(), `${ts} [${level}] [${botId}] ${message}\n`);
    } catch {/* ignore disk errors */}
  };

  const runtimeConfigChanged = (patch: Partial<BotProfile>): boolean => (
    patch.llmConfigId !== undefined
    || patch.memory !== undefined
    || patch.personality !== undefined
    || patch.characterCard !== undefined
    || patch.name !== undefined
    || patch.skinTexture !== undefined
    || patch.skinModel !== undefined
    || patch.server !== undefined
  );

  app.get('/api/desktop-pet', (_req, res) => {
    const pet = desktopPetConfigStore.get();
    res.json({ ...pet, profileValid: !pet.profileId || Boolean(profileStore.get(pet.profileId)) });
  });

  app.put('/api/desktop-pet', (req, res) => {
    try {
      const input = req.body as DesktopPetConfigInput;
      if (input.profileId && !profileStore.get(input.profileId)) {
        res.status(400).json({ error: 'profile not found' });
        return;
      }
      res.json(desktopPetConfigStore.update(input));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  const applyUpdatedRuntimeConfig = async (
    profile: BotProfile,
    patch: Partial<BotProfile>,
  ): Promise<void> => {
    if (!runtimeConfigChanged(patch)) return;
    await botManager.restart(profile);
  };

  const testOpenAiCompatibleLlm = async (llm: DefaultLlmConfig): Promise<{
    ok: boolean;
    status?: number;
    baseUrl: string;
    model: string;
    preview?: string;
    error?: string;
  }> => {
    const apiKey = llm.apiKey?.trim() ?? '';
    const baseUrl = llm.baseUrl?.trim().replace(/\/$/, '') ?? '';
    const model = llm.model?.trim() ?? '';
    if (!apiKey) return { ok: false, status: 400, baseUrl, model, error: '缺少 API Key；请填写或配置服务端 LLM_API_KEY' };
    if (!baseUrl) return { ok: false, status: 400, baseUrl, model, error: '缺少 Base URL' };
    if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, status: 400, baseUrl, model, error: 'Base URL 必须以 http:// 或 https:// 开头' };
    if (/api\.anthropic\.com/i.test(baseUrl)) {
      return { ok: false, status: 400, baseUrl, model, error: '当前接口只支持 OpenAI-compatible；Claude 请使用 OpenRouter/LiteLLM/OneAPI 的 /v1 地址' };
    }
    if (!model) return { ok: false, status: 400, baseUrl, model, error: '缺少模型名' };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const url = `${baseUrl}/chat/completions`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a connection test endpoint. Reply exactly OK.' },
            { role: 'user', content: 'Reply OK' },
          ],
          temperature: 0,
          max_tokens: 16,
        }),
        signal: ctrl.signal,
      });

      if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).slice(0, 400); } catch { /* ignore */ }
        return {
          ok: false,
          status: response.status,
          baseUrl,
          model,
          error: detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status} ${response.statusText}`,
        };
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      const msg = data.choices?.[0]?.message;
      const preview = (msg?.content || msg?.reasoning_content || '').trim().slice(0, 80);
      return { ok: true, status: response.status, baseUrl, model, preview: preview || '(empty)' };
    } catch (e) {
      const err = e as Error;
      return {
        ok: false,
        baseUrl,
        model,
        error: err.name === 'AbortError' ? '请求超时（20s）' : (err.message || '请求失败'),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  botManager.onStatusChange = (botId, status) => {
    io.emit('bot:status', { botId, status });
  };
  botManager.onFullStatus = (botId, fullStatus) => {
    io.emit('bot:fullStatus', { botId, ...fullStatus });
  };
  botManager.onChat = (botId, sender, message, meta) => {
    // FEAT-WEBUI-09 · 透传 turnId + 该轮思考，供 UI 聊天面板分轨呈现
    io.emit('bot:chat', {
      botId, sender, message, timestamp: Date.now(),
      turnId: meta?.turnId, thinking: meta?.thinking,
    });
    writeLogLine(botId, 'chat', `${sender}: ${message}`);
  };
  botManager.onLog = (botId, level, message) => {
    io.emit('bot:log', { botId, level, message, timestamp: Date.now() });
    writeLogLine(botId, level, message);
  };
  botManager.onV2WorldUiView = (botId, view) => {
    io.emit('bot:v2:worldState', { botId, worldState: view });
  };
  botManager.onAgentLoop = (botId, step) => {
    io.emit('bot:agentLoop', { botId, ...step });
  };

  // --- REST API: Profiles ---

  const validateProfileMemoryConfig = (body: unknown): string | null => {
    if (body === null || typeof body !== 'object' || !Object.hasOwn(body, 'memory')) return null;
    const memory = (body as { memory?: unknown }).memory;
    if (memory === undefined) return null;
    if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) {
      return 'memory must be an object';
    }
    const semanticSearch = (memory as { semanticSearch?: unknown }).semanticSearch;
    return semanticSearch === undefined || typeof semanticSearch === 'boolean'
      ? null
      : 'memory.semanticSearch must be boolean';
  };

  const profilesUsingLlmConfig = (llmConfigId: string): BotProfile[] => (
    profileStore.list().filter(profile => profile.llmConfigId === llmConfigId)
  );

  const toPublicLlmConfig = (llmConfigId: string) => {
    const config = llmAgentConfigStore.get(llmConfigId);
    return config ? llmAgentConfigStore.toPublic(config, profilesUsingLlmConfig(llmConfigId).length) : undefined;
  };

  const validateLlmAgentConfigInput = (body: unknown, partial = false): string | null => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'LLM Agent configuration must be an object';
    const value = body as Record<string, unknown>;
    for (const field of ['name', 'baseUrl', 'model']) {
      if (!partial || value[field] !== undefined) {
        if (typeof value[field] !== 'string' || !value[field].trim()) return `${field} is required`;
      }
    }
    if (value.apiKey !== undefined && typeof value.apiKey !== 'string') return 'apiKey must be a string';
    if (value.clearApiKey !== undefined && typeof value.clearApiKey !== 'boolean') return 'clearApiKey must be boolean';
    const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return 'Base URL must start with http:// or https://';
    if (baseUrl && /api\.anthropic\.com/i.test(baseUrl)) return 'Anthropic native endpoint is not supported; use an OpenAI-compatible /v1 endpoint';
    return null;
  };

  const duplicateLlmConfigName = (name: string, exceptId?: string): boolean => {
    const normalized = name.trim().toLocaleLowerCase();
    return llmAgentConfigStore.list().some(config => (
      config.id !== exceptId && config.name.trim().toLocaleLowerCase() === normalized
    ));
  };

  const validateProfileLlmConfig = (body: unknown): string | null => {
    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'llmConfigId')) return null;
    const value = (body as { llmConfigId?: unknown }).llmConfigId;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') return 'llmConfigId must be a string';
    return llmAgentConfigStore.get(value) ? null : 'LLM Agent configuration not found';
  };

  const rejectLegacyProfileLlm = (body: unknown): string | null => (
    body && typeof body === 'object' && Object.hasOwn(body, 'llm')
      ? 'LLM configuration is global; select it with llmConfigId instead'
      : null
  );

  const validateProfileCharacterCard = (body: unknown): string | null => {
    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'characterCard')) return null;
    const errors = validateCharacterCard((body as { characterCard?: unknown }).characterCard);
    return errors.length ? `${errors[0]!.path}: ${errors[0]!.message}` : null;
  };

  app.get('/api/profiles', (_req, res) => {
    res.json(profileStore.list().map(toPublicBotProfile));
  });

  app.post('/api/profiles', async (req, res) => {
    const validationError = validateProfileMemoryConfig(req.body) ?? validateProfileLlmConfig(req.body) ?? validateProfileCharacterCard(req.body) ?? rejectLegacyProfileLlm(req.body);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    const profile = profileStore.create(req.body);
    try {
      await botManager.start(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLogLine(profile.id, 'error', `Profile 已创建，但纯聊天大脑启动失败：${message}`);
    }
    res.status(201).json(toPublicBotProfile(profile));
  });

  app.patch('/api/profiles/:id', async (req, res) => {
    const existing = profileStore.get(req.params.id);
    if (!existing) { res.status(404).json({ error: 'not found' }); return; }
    const validationError = validateProfileMemoryConfig(req.body) ?? validateProfileLlmConfig(req.body) ?? validateProfileCharacterCard(req.body) ?? rejectLegacyProfileLlm(req.body);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    const updated = profileStore.update(req.params.id, req.body);
    const profile = updated ?? existing;
    try {
      await applyUpdatedRuntimeConfig(profile, req.body);
      res.json(toPublicBotProfile(profile));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLogLine(profile.id, 'error', `配置已保存，但运行时自动应用失败：${message}`);
      res.status(503).json({ error: '配置已保存，但运行时自动应用失败；请重启应用后再试' });
    }
  });

  app.get('/api/profiles/:id', (req, res) => {
    const p = profileStore.get(req.params.id);
    p ? res.json(toPublicBotProfile(p)) : res.status(404).json({ error: 'not found' });
  });

  app.get('/api/character-card/templates', (_req, res) => {
    res.json(listCharacterTemplates());
  });

  app.post('/api/character-card/templates/:templateId', (req, res) => {
    if (!['real_world_friend', 'minecraft_native'].includes(req.params.templateId)) {
      res.status(404).json({ error: 'template not found' }); return;
    }
    res.json(createCharacterTemplate(
      req.params.templateId as 'real_world_friend' | 'minecraft_native',
      { characterName: req.body?.characterName, userName: req.body?.userName },
    ));
  });

  app.get('/api/profiles/:id/character-card', (req, res) => {
    const card = profileStore.getCharacterCard(req.params.id);
    card ? res.json(card) : res.status(404).json({ error: 'profile not found' });
  });

  app.post('/api/profiles/:id/character-card/validate', (req, res) => {
    if (!profileStore.get(req.params.id)) { res.status(404).json({ error: 'profile not found' }); return; }
    const errors = validateCharacterCard(req.body);
    res.status(errors.length ? 400 : 200).json({ valid: errors.length === 0, errors });
  });

  app.put('/api/profiles/:id/character-card', async (req, res) => {
    const existing = profileStore.get(req.params.id);
    if (!existing) { res.status(404).json({ error: 'profile not found' }); return; }
    const errors = validateCharacterCard(req.body);
    if (errors.length) { res.status(400).json({ error: 'invalid character card', errors }); return; }
    const updated = profileStore.update(req.params.id, { characterCard: req.body });
    if (!updated) { res.status(404).json({ error: 'profile not found' }); return; }
    try {
      await botManager.restart(updated);
      res.json(updated.characterCard);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLogLine(updated.id, 'error', `角色卡已保存，但运行时自动应用失败：${message}`);
      res.status(503).json({ error: '角色卡已保存，但运行时自动应用失败；请重启应用后再试' });
    }
  });

  app.put('/api/profiles/:id', async (req, res) => {
    const validationError = validateProfileMemoryConfig(req.body) ?? validateProfileLlmConfig(req.body) ?? validateProfileCharacterCard(req.body) ?? rejectLegacyProfileLlm(req.body);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    const p = profileStore.update(req.params.id, req.body);
    if (!p) { res.status(404).json({ error: 'not found' }); return; }
    try {
      await applyUpdatedRuntimeConfig(p, req.body);
      res.json(toPublicBotProfile(p));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLogLine(p.id, 'error', `配置已保存，但运行时自动应用失败：${message}`);
      res.status(503).json({ error: '配置已保存，但运行时自动应用失败；请重启应用后再试' });
    }
  });

  // --- REST API: Server Presets (FEAT-WEBUI-12 · 全局共享服务器预设) ---
  app.get('/api/server-presets', (_req, res) => {
    res.json(serverPresetStore.list());
  });

  app.post('/api/server-presets', (req, res) => {
    const { name, host, port, version, auth, skinSync } = req.body ?? {};
    if (!name || !host || typeof port !== 'number') {
      res.status(400).json({ error: 'name/host/port 必填，port 须为数字' });
      return;
    }
    const mode = resolveSkinSyncMode(skinSync?.mode);
    const preset = serverPresetStore.add({ name, host, port, version, auth, skinSync: { mode } });
    res.status(201).json(preset);
  });

  app.put('/api/server-presets/:id', async (req, res) => {
    const { name, host, port, version, auth, skinSync } = req.body ?? {};
    if (!name || !host || typeof port !== 'number') {
      res.status(400).json({ error: 'name/host/port 必填，port 须为数字' });
      return;
    }
    const mode = resolveSkinSyncMode(skinSync?.mode);
    const preset = serverPresetStore.update(req.params.id, { name, host, port, version, auth, skinSync: { mode } });
    if (!preset) { res.status(404).json({ error: 'server preset not found' }); return; }
    const affected = profileStore.list().filter(profile => profile.server.presetId === preset.id);
    try {
      const restartedProfileCount = await botManager.restartActiveProfiles(affected);
      res.json({ ...preset, restartedProfileCount });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLogLine('hub', 'error', `服务器配置已保存，但角色运行时重载失败：${message}`);
      res.status(503).json({ error: '服务器配置已保存，但关联角色无法自动重载' });
    }
  });

  app.delete('/api/server-presets/:id', (req, res) => {
    const profileCount = profileStore.list().filter(profile => profile.server.presetId === req.params.id).length;
    if (profileCount > 0) {
      res.status(409).json({ error: '服务器配置仍被角色使用', profileCount });
      return;
    }
    res.json({ ok: serverPresetStore.delete(req.params.id) });
  });

  // FEAT-WEBUI-11 · Mojang 皮肤代理（renderer 直连 sessionserver 有 CORS，故后端代理）
  // GET /api/skin/mojang?name=<用户名>  →  { skinUrl, model } | 404
  app.get('/api/skin/mojang', async (req, res) => {
    const name = String(req.query.name ?? '').trim();
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    try {
      const ur = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
      if (!ur.ok) { res.status(404).json({ error: 'player not found' }); return; }
      const { id } = await ur.json() as { id?: string };
      if (!id) { res.status(404).json({ error: 'no uuid' }); return; }
      const pr = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
      if (!pr.ok) { res.status(404).json({ error: 'no profile' }); return; }
      const prof = await pr.json() as { properties?: Array<{ name: string; value: string }> };
      const tx = prof.properties?.find(p => p.name === 'textures')?.value;
      if (!tx) { res.status(404).json({ error: 'no textures' }); return; }
      const decoded = JSON.parse(Buffer.from(tx, 'base64').toString('utf8')) as {
        textures?: { SKIN?: { url?: string; metadata?: { model?: string } } };
      };
      const skinUrl = decoded.textures?.SKIN?.url;
      if (!skinUrl) { res.status(404).json({ error: 'no skin' }); return; }
      const model = decoded.textures?.SKIN?.metadata?.model === 'slim' ? 'slim' : 'classic';
      // 连皮肤字节一起代理回来转 data-URL：前端同源拿、绕开跨域、保存后离线可用
      let skinDataUrl: string | undefined;
      try {
        const imgRes = await fetch(skinUrl);
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          skinDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
        }
      } catch { /* 拿不到字节就只回 url，前端再尝试直连 */ }
      res.json({ skinUrl, skinDataUrl, model });
    } catch (e) {
      res.status(502).json({ error: 'mojang fetch failed', detail: (e as Error).message });
    }
  });

  // FEAT-WEBUI-11 · 物品图标代理 + 磁盘缓存（客户端只访问 localhost·同源·缓存后离线可用）
  // 首次从 jsDelivr 镜像(Mojang 提取贴图)取 item→block，存本地复用；纯本地个人缓存，非对外再分发。
  const iconCacheDir = join(config.dataDir, 'icon-cache');
  if (!existsSync(iconCacheDir)) mkdirSync(iconCacheDir, { recursive: true });
  const ICON_SRC = 'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@1.20.1/assets/minecraft/textures';
  app.get('/api/icon/:name', async (req, res) => {
    const name = String(req.params.name || '').replace(/^minecraft:/, '').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(name)) { res.status(400).end(); return; }
    const file = join(iconCacheDir, `${name}.png`);
    res.type('png');
    if (existsSync(file)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(readFileSync(file)); return;
    }
    for (const kind of ['item', 'block']) {
      try {
        const r = await fetch(`${ICON_SRC}/${kind}/${name}.png`);
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          try { writeFileSync(file, buf); } catch { /* 缓存失败不影响返回 */ }
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.send(buf); return;
        }
      } catch { /* 换下一个 kind */ }
    }
    res.status(404).end();
  });

  app.delete('/api/profiles/:id', async (req, res) => {
    if (!profileStore.get(req.params.id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    await botManager.stop(req.params.id);
    profileStore.delete(req.params.id);
    res.json({ ok: true });
  });

  // --- REST API: Global LLM Agent configurations ---
  app.get('/api/llm-configs', (_req, res) => {
    res.json(llmAgentConfigStore.list().map(config => toPublicLlmConfig(config.id)));
  });

  app.post('/api/llm-configs', (req, res) => {
    const validationError = validateLlmAgentConfigInput(req.body);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    if (duplicateLlmConfigName((req.body as LlmAgentConfigInput).name)) {
      res.status(409).json({ error: 'LLM Agent configuration name already exists' }); return;
    }
    const config = llmAgentConfigStore.create(req.body as LlmAgentConfigInput);
    res.status(201).json(toPublicLlmConfig(config.id));
  });

  app.patch('/api/llm-configs/:id', async (req, res) => {
    const validationError = validateLlmAgentConfigInput(req.body, true);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    const name = (req.body as LlmAgentConfigPatch).name;
    if (name !== undefined && duplicateLlmConfigName(name, req.params.id)) {
      res.status(409).json({ error: 'LLM Agent configuration name already exists' }); return;
    }
    const updated = llmAgentConfigStore.update(req.params.id, req.body as LlmAgentConfigPatch);
    if (!updated) { res.status(404).json({ error: 'LLM Agent configuration not found' }); return; }
    try {
      const restartedProfileCount = await botManager.restartActiveProfiles(profilesUsingLlmConfig(updated.id));
      res.json({ ...toPublicLlmConfig(updated.id), restartedProfileCount });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLogLine('hub', 'error', `LLM Agent configuration saved but runtime reload failed: ${message}`);
      res.status(503).json({ error: 'LLM Agent configuration saved, but affected roles could not reload' });
    }
  });

  app.delete('/api/llm-configs/:id', (req, res) => {
    const profileCount = profilesUsingLlmConfig(req.params.id).length;
    if (profileCount > 0) {
      res.status(409).json({ error: 'LLM Agent configuration is still in use', profileCount });
      return;
    }
    if (!llmAgentConfigStore.delete(req.params.id)) { res.status(404).json({ error: 'LLM Agent configuration not found' }); return; }
    res.json({ ok: true });
  });

  app.post('/api/llm-configs/test', async (req, res) => {
    const validationError = validateLlmAgentConfigInput(req.body);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    const result = await testOpenAiCompatibleLlm(req.body as DefaultLlmConfig);
    res.status(result.ok ? 200 : (result.status && result.status < 500 ? result.status : 502)).json(result);
  });

  app.post('/api/llm-configs/:id/test', async (req, res) => {
    const config = llmAgentConfigStore.get(req.params.id);
    if (!config) { res.status(404).json({ error: 'LLM Agent configuration not found' }); return; }
    const validationError = validateLlmAgentConfigInput(req.body, true);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    const override = req.body as Partial<LlmAgentConfigInput>;
    const result = await testOpenAiCompatibleLlm({
      apiKey: override.apiKey?.trim() || config.apiKey || '',
      baseUrl: override.baseUrl?.trim() || config.baseUrl,
      model: override.model?.trim() || config.model,
    });
    res.status(result.ok ? 200 : (result.status && result.status < 500 ? result.status : 502)).json(result);
  });

  // --- REST API: Bots ---

  app.get('/api/bots', (_req, res) => {
    res.json(botManager.listAll());
  });

  app.post('/api/bots/:profileId/start', async (req, res) => {
    const profile = profileStore.get(req.params.profileId);
    if (!profile) { res.status(404).json({ error: 'profile not found' }); return; }
    const instance = await botManager.start(profile);
    res.json(instance);
  });

  app.post('/api/bots/:botId/stop', async (req, res) => {
    await botManager.stop(req.params.botId);
    res.json({ ok: true });
  });

  app.post('/api/bots/:botId/reconnect', async (req, res) => {
    // FEAT-WEBUI-12 · 重读最新 profile，使改服务器后重连即时生效
    const profile = profileStore.get(req.params.botId);
    const status = await botManager.reconnect(req.params.botId, profile);
    status ? res.json(status) : res.status(404).json({ error: 'bot not found' });
  });

  app.post('/api/bots/:botId/join-game', async (req, res) => {
    // FEAT-CROSS-08 · 日常陪聊态按需挂载游戏身体，复用最新 profile.server。
    const profile = profileStore.get(req.params.botId);
    try {
      const status = await botManager.joinGame(req.params.botId, profile);
      status ? res.json(status) : res.status(404).json({ error: 'bot not found' });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/bots/:botId/leave-game', async (req, res) => {
    const status = await botManager.leaveGame(req.params.botId);
    status ? res.json(status) : res.status(404).json({ error: 'bot not found' });
  });

  app.get('/api/bots/:botId/status', (req, res) => {
    const s = botManager.getFullStatus(req.params.botId);
    s ? res.json(s) : res.status(404).json({ error: 'not found' });
  });

  app.post('/api/bots/:botId/tasks/cancel-active', (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'cancelled_by_owner';
    const cancelled = botManager.cancelActiveTasks(req.params.botId, reason);
    cancelled === null
      ? res.status(404).json({ error: 'bot not found or v2 not active' })
      : res.json({ ok: true, cancelled });
  });

  // FEAT-CROSS-09 · 陪伴控制面。所有操作只作用于指定 bot/profile 的 CompanionCore。
  app.get('/api/bots/:botId/companion', (req, res) => {
    const state = botManager.getCompanionState(req.params.botId);
    state ? res.json(state) : res.status(404).json({ error: 'companion not active' });
  });

  app.patch('/api/bots/:botId/companion/initiative', (req, res) => {
    const body = req.body as { enabled?: boolean; quietHours?: { start?: number; end?: number }; cooldownMs?: number; dailyBudget?: number };
    const quietHours = body.quietHours && Number.isInteger(body.quietHours.start) && Number.isInteger(body.quietHours.end)
      ? { start: body.quietHours.start!, end: body.quietHours.end! }
      : undefined;
    const policy = botManager.setCompanionInitiativePolicy(req.params.botId, {
      enabled: body.enabled,
      quietHours,
      cooldownMs: body.cooldownMs,
      dailyBudget: body.dailyBudget,
    });
    policy ? res.json(policy) : res.status(404).json({ error: 'companion not active' });
  });

  app.post('/api/bots/:botId/companion/overlays/rollback', (req, res) => {
    const version = Number((req.body as { version?: unknown }).version);
    if (!Number.isInteger(version) || version < 0) { res.status(400).json({ error: 'valid version required' }); return; }
    const state = botManager.rollbackCompanionOverlaysAfter(req.params.botId, version);
    state ? res.json(state) : res.status(404).json({ error: 'companion not active' });
  });

  app.post('/api/bots/:botId/companion/emotions/:emotionId/correct', (req, res) => {
    const correction = String((req.body as { correction?: unknown }).correction ?? '').trim();
    if (!correction) { res.status(400).json({ error: 'correction required' }); return; }
    const state = botManager.correctCompanionEmotion(req.params.botId, req.params.emotionId, correction);
    state ? res.json(state) : res.status(404).json({ error: 'emotion or companion not found' });
  });

  // FEAT-MEM-09 · 纯聊天记忆控制面。所有读写均经 botId 绑定的 Profile 作用域，不接受外部 profileId。
  const factKinds = new Set(['preference', 'identity', 'relationship', 'commitment', 'boundary', 'project', 'agent_note']);
  const factStatuses = new Set(['candidate', 'active', 'superseded', 'deleted', 'rejected', 'expired']);

  app.get('/api/bots/:botId/chat-memory/facts', (req, res) => {
    const status = typeof req.query.status === 'string' && factStatuses.has(req.query.status) ? req.query.status as import('../bot/v2/infra/chatMemory.js').FactStatus : undefined;
    const query = typeof req.query.query === 'string' ? req.query.query.slice(0, 280) : undefined;
    const facts = botManager.getChatMemoryFacts(req.params.botId, { status, query });
    facts ? res.json({ facts }) : res.status(404).json({ error: 'chat memory not active' });
  });

  app.get('/api/bots/:botId/chat-memory/messages', (req, res) => {
    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(200, Math.max(1, requestedLimit))
      : 50;
    const messages = botManager.getRecentChatMessages(req.params.botId, limit);
    messages ? res.json({ messages }) : res.status(404).json({ error: 'chat memory not active' });
  });

  app.post('/api/bots/:botId/chat-memory/facts', (req, res) => {
    const body = req.body as { scope?: unknown; kind?: unknown; text?: unknown; confidence?: unknown; importance?: unknown; sourceMessageIds?: unknown };
    const kind = typeof body.kind === 'string' && factKinds.has(body.kind) ? body.kind as import('../bot/v2/infra/chatMemory.js').FactKind : null;
    const text = typeof body.text === 'string' ? body.text : '';
    if (!kind || !text.trim()) { res.status(400).json({ error: 'valid kind and text required' }); return; }
    if (body.scope !== undefined && body.scope !== 'user' && body.scope !== 'agent') { res.status(400).json({ error: 'scope must be user or agent' }); return; }
    const confidence = typeof body.confidence === 'number' ? body.confidence : undefined;
    const importance = typeof body.importance === 'number' ? body.importance : undefined;
    if ((confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) || (importance !== undefined && (!Number.isFinite(importance) || importance < 0 || importance > 1))) {
      res.status(400).json({ error: 'confidence and importance must be between 0 and 1' }); return;
    }
    const sourceMessageIds = Array.isArray(body.sourceMessageIds) ? body.sourceMessageIds.filter((id): id is string => typeof id === 'string').slice(0, 20) : undefined;
    const result = botManager.addChatMemoryFact(req.params.botId, { scope: body.scope as 'user' | 'agent' | undefined, kind, text, confidence, importance, sourceMessageIds });
    if (!result) { res.status(404).json({ error: 'chat memory not active' }); return; }
    'rejected' in result ? res.status(422).json(result) : res.status(201).json(result);
  });

  app.patch('/api/bots/:botId/chat-memory/facts/:factId', (req, res) => {
    const body = req.body as { text?: unknown; sourceMessageIds?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) { res.status(400).json({ error: 'text required' }); return; }
    const sourceMessageIds = Array.isArray(body.sourceMessageIds) ? body.sourceMessageIds.filter((id): id is string => typeof id === 'string').slice(0, 20) : [];
    const result = botManager.replaceChatMemoryFact(req.params.botId, req.params.factId, body.text, sourceMessageIds);
    if (!result) { res.status(404).json({ error: 'active fact or chat memory not found' }); return; }
    'rejected' in result ? res.status(422).json(result) : res.json(result);
  });

  app.delete('/api/bots/:botId/chat-memory/facts/:factId', (req, res) => {
    const removed = botManager.removeChatMemoryFact(req.params.botId, req.params.factId);
    removed === true ? res.json({ ok: true }) : res.status(404).json({ error: 'active fact or chat memory not found' });
  });

  app.post('/api/bots/:botId/chat-memory/facts/:factId/restore', (req, res) => {
    const restored = botManager.restoreChatMemoryFact(req.params.botId, req.params.factId);
    restored ? res.json(restored) : res.status(404).json({ error: 'restorable fact or chat memory not found' });
  });

  app.get('/api/bots/:botId/chat-memory/facts/:factId/sources', (req, res) => {
    const sources = botManager.getChatMemoryFactSources(req.params.botId, req.params.factId);
    sources ? res.json({ sources }) : res.status(404).json({ error: 'fact or chat memory not found' });
  });

  app.post('/api/bots/:botId/chat-memory/index/rebuild', (req, res) => {
    const result = botManager.rebuildChatMemoryIndex(req.params.botId);
    result ? res.json(result) : res.status(404).json({ error: 'chat memory not active' });
  });

  app.get('/api/bots/:botId/chat-memory/export', (req, res) => {
    const markdown = botManager.exportChatMemoryMarkdown(req.params.botId);
    if (markdown === null) { res.status(404).json({ error: 'chat memory not active' }); return; }
    res.type('text/markdown; charset=utf-8').send(markdown);
  });

  // FEAT-CROSS-12 · 经验进化控制面的只读查询接口。
  // 事实和图谱均按 botId/Profile 隔离；页面不能经这些接口控制当前 Goal。
  registerPlannerEvolutionRoutes(app, {
    dataDir: config.dataDir,
    hasProfile: botId => profileStore.get(botId) != null,
  });

  // --- v2 status ---

  app.get('/api/v2/status', (_req, res) => {
    // Find any running v2 bot
    const bots = botManager.listAll();
    const v2Bot = bots.find(b => {
      const snap = botManager.getV2Snapshot(b.id);
      return snap !== null;
    });
    if (!v2Bot) {
      res.status(503).json({ error: 'V2 runtime not active. Set V2_ENABLED=1.' });
      return;
    }
    const snap = botManager.getV2Snapshot(v2Bot.id);
    res.json({ botId: v2Bot.id, ...snap });
  });

  app.get('/api/v2/tasks', (_req, res) => {
    const bots = botManager.listAll();
    const v2Bot = bots.find(b => botManager.getV2Snapshot(b.id) !== null);
    if (!v2Bot) {
      res.status(503).json({ error: 'V2 runtime not active. Set V2_ENABLED=1.' });
      return;
    }
    const tasks = botManager.getV2Tasks(v2Bot.id);
    res.json({ tasks: tasks ?? [] });
  });

  app.get('/api/bots/:botId/v2/tasks', (req, res) => {
    const botId = req.params.botId;
    if (!profileStore.get(botId)) {
      res.status(404).json({ error: 'Bot not found.' });
      return;
    }
    const tasks = botManager.getV2Tasks(botId);
    if (tasks === null) {
      res.status(503).json({ error: 'V2 runtime not active for this bot.' });
      return;
    }
    res.json({ botId, tasks });
  });

  // --- FEAT-WEBUI-19 · MainBrain / GoalAgent LLM 调用轨迹（只读） ---

  const traceQueryString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized || undefined;
  };
  const traceQueryInteger = (
    value: unknown,
    name: string,
    bounds: { min?: number; max?: number } = {},
  ): number | undefined => {
    const normalized = traceQueryString(value);
    if (normalized === undefined) return undefined;
    if (!/^\d+$/.test(normalized)) {
      throw new LlmTraceQueryError('invalid_query', `${name} must be a non-negative integer`);
    }
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) {
      throw new LlmTraceQueryError('invalid_query', `${name} must be a safe integer`);
    }
    const min = bounds.min ?? 0;
    if (parsed < min || (bounds.max !== undefined && parsed > bounds.max)) {
      throw new LlmTraceQueryError(
        'invalid_query',
        `${name} must be an integer between ${min} and ${bounds.max ?? Number.MAX_SAFE_INTEGER}`,
      );
    }
    return parsed;
  };
  const traceAgent = (value: unknown): LlmTraceAgent | undefined => {
    const normalized = traceQueryString(value);
    if (normalized === undefined) return undefined;
    if (!['mainbrain', 'goalagent', 'system', 'unknown'].includes(normalized)) {
      throw new LlmTraceQueryError('invalid_query', 'agent is invalid');
    }
    return normalized as LlmTraceAgent;
  };
  const sendTraceError = (res: express.Response, error: unknown): void => {
    if (error instanceof LlmTraceQueryError) {
      const status = error.code === 'not_found' ? 404 : error.code === 'export_too_large' ? 413 : 400;
      res.status(status).json({ error: error.code, message: error.message });
      return;
    }
    res.status(500).json({ error: 'trace_query_failed', message: error instanceof Error ? error.message : String(error) });
  };
  const ensureTraceRuntime = (botId: string, res: express.Response): boolean => {
    if (!profileStore.get(botId)) {
      res.status(404).json({ error: 'bot_not_found' });
      return false;
    }
    if (!botManager.getV2Snapshot(botId)) {
      res.status(503).json({ error: 'trace_unavailable', message: 'Bot runtime is not active.' });
      return false;
    }
    return true;
  };

  app.get('/api/bots/:botId/v2/llm-traces/sessions', (req, res) => {
    const botId = req.params.botId;
    if (!ensureTraceRuntime(botId, res)) return;
    try {
      const page = botManager.getLlmTraceSessions(botId, {
        cursor: traceQueryString(req.query.cursor),
        limit: traceQueryInteger(req.query.limit, 'limit', { min: 1, max: 100 }),
        taskId: traceQueryString(req.query.taskId),
        q: traceQueryString(req.query.q),
      });
      if (!page) { res.status(503).json({ error: 'trace_unavailable' }); return; }
      res.json({ botId, ...page });
    } catch (error) {
      sendTraceError(res, error);
    }
  });

  app.get('/api/bots/:botId/v2/llm-traces/events', (req, res) => {
    const botId = req.params.botId;
    if (!ensureTraceRuntime(botId, res)) return;
    try {
      const page = botManager.getLlmTraceEvents(botId, {
        sessionId: traceQueryString(req.query.sessionId),
        interactionSessionId: traceQueryString(req.query.interactionSessionId),
        afterSeq: traceQueryInteger(req.query.afterSeq, 'afterSeq'),
        beforeSeq: traceQueryInteger(req.query.beforeSeq, 'beforeSeq'),
        limit: traceQueryInteger(req.query.limit, 'limit', { min: 1, max: 500 }),
        taskId: traceQueryString(req.query.taskId),
        agent: traceAgent(req.query.agent),
        node: traceQueryString(req.query.node),
        status: traceQueryString(req.query.status),
        q: traceQueryString(req.query.q),
      });
      if (!page) { res.status(503).json({ error: 'trace_unavailable' }); return; }
      res.json({ botId, ...page });
    } catch (error) {
      sendTraceError(res, error);
    }
  });

  app.get('/api/bots/:botId/v2/llm-traces/calls/:callId', (req, res) => {
    const botId = req.params.botId;
    if (!ensureTraceRuntime(botId, res)) return;
    try {
      const detail = botManager.getLlmTraceCall(botId, req.params.callId);
      if (!detail) { res.status(404).json({ error: 'trace_call_not_found' }); return; }
      res.json({ botId, call: detail });
    } catch (error) {
      sendTraceError(res, error);
    }
  });

  app.get('/api/bots/:botId/v2/llm-traces/export', (req, res) => {
    const botId = req.params.botId;
    if (!ensureTraceRuntime(botId, res)) return;
    try {
      const sessionId = traceQueryString(req.query.sessionId);
      if (!sessionId) throw new LlmTraceQueryError('invalid_query', 'sessionId is required');
      const format = traceQueryString(req.query.format);
      if (format && format !== 'jsonl') throw new LlmTraceQueryError('invalid_query', 'only jsonl export is supported');
      const jsonl = botManager.exportLlmTraceSession(botId, sessionId);
      if (jsonl === null) { res.status(503).json({ error: 'trace_unavailable' }); return; }
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`llm-trace-${sessionId}.jsonl`)}`);
      res.send(jsonl);
    } catch (error) {
      sendTraceError(res, error);
    }
  });

  app.get('/api/v2/critic', (_req, res) => {
    const bots = botManager.listAll();
    const v2Bot = bots.find(b => botManager.getV2Snapshot(b.id) !== null);
    if (!v2Bot) {
      res.status(503).json({ error: 'V2 runtime not active. Set V2_ENABLED=1.' });
      return;
    }
    const verdicts = botManager.getV2CriticVerdicts(v2Bot.id);
    res.json({ verdicts: verdicts ?? [] });
  });

  app.get('/api/v2/supervisor-alerts', (_req, res) => {
    const bots = botManager.listAll();
    const v2Bot = bots.find(b => botManager.getV2Snapshot(b.id) !== null);
    if (!v2Bot) {
      res.status(503).json({ error: 'V2 runtime not active. Set V2_ENABLED=1.' });
      return;
    }
    const alerts = botManager.getV2SupervisorAlerts(v2Bot.id);
    res.json(alerts ?? { suspendedByDanger: [], recentDiagnoses: [], narrationCooldowns: {} });
  });

  app.get('/api/bots/:botId/v2/status', (req, res) => {
    const snap = botManager.getV2Snapshot(req.params.botId);
    if (!snap) {
      res.status(503).json({ error: 'V2 runtime not active for this bot.' });
      return;
    }
    res.json(snap);
  });

  app.get('/api/bots/:botId/v2/supervisor-alerts', (req, res) => {
    const botId = req.params.botId;
    if (!profileStore.get(botId)) {
      res.status(404).json({ error: 'Bot not found.' });
      return;
    }
    const alerts = botManager.getV2SupervisorAlerts(botId);
    if (!alerts) {
      res.status(503).json({ error: 'V2 runtime not active for this bot.' });
      return;
    }
    res.json(alerts);
  });

  app.get('/api/bots/:botId/v2/runs', (req, res) => {
    const runs = botManager.getBenchRuns(req.params.botId);
    runs ? res.json({ runs }) : res.status(404).json({ error: 'V2 runtime not active' });
  });

  app.get('/api/bots/:botId/v2/runs/:runId', (req, res) => {
    const trace = botManager.getBenchRun(req.params.botId, req.params.runId);
    trace ? res.json({ trace }) : res.status(404).json({ error: 'V2 runtime not active' });
  });

  // 网页 UI 默认 sender：优先用真实 MC 用户名，否则使用中性聊天标签。
  const resolveDefaultSender = (botId: string): string => {
    const profile = profileStore.get(botId);
    return profile?.characterCard?.relationship.userPersona.name || profile?.ownerUsername || '我';
  };

  // REST chat endpoint (for testing and direct integration)
  app.post('/api/bots/:botId/chat', async (req, res) => {
    const { message, sender } = req.body as { message?: string; sender?: string };
    if (!message) { res.status(400).json({ error: 'message required' }); return; }
    const reply = await botManager.chat(req.params.botId, sender || resolveDefaultSender(req.params.botId), message);
    reply ? res.json({ reply }) : res.status(404).json({ error: 'bot not found' });
  });

  // --- REST API: Hermes Brain ---

  const hermesHome = join(homedir(), '.hermes');

  /** 解析 ~/.hermes/memories/MEMORY.md，按 § 分段返回 */
  app.get('/api/hermes/memories', (_req, res) => {
    try {
      const file = join(hermesHome, 'memories', 'MEMORY.md');
      if (!existsSync(file)) { res.json({ memories: [] }); return; }
      const raw = readFileSync(file, 'utf-8');
      const sections = raw.split(/\n§\n|\n§$/).map(s => s.trim()).filter(Boolean);
      const memories = sections.map((text, i) => ({
        id: `m-${i}`,
        text,
        type: text.startsWith('#') ? 'header' : 'fact',
      }));
      res.json({ memories });
    } catch { res.json({ memories: [] }); }
  });

  /** 扫描 ~/.hermes/skills/ 递归找 SKILL.md */
  app.get('/api/hermes/skills', (_req, res) => {
    try {
      const skillsDir = join(hermesHome, 'skills');
      if (!existsSync(skillsDir)) { res.json({ skills: [] }); return; }
      const skills: Array<{ name: string; category: string; description: string; path: string }> = [];
      const scanDir = (dir: string, category = '') => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            scanDir(full, category || entry);
          } else if (entry === 'SKILL.md') {
            const content = readFileSync(full, 'utf-8');
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*(.+)$/m);
            skills.push({
              name: nameMatch?.[1]?.trim() ?? entry,
              category,
              description: descMatch?.[1]?.trim() ?? '',
              path: full,
            });
          }
        }
      };
      scanDir(skillsDir);
      res.json({ skills });
    } catch { res.json({ skills: [] }); }
  });

  /** Hermes bridge 状态（通过 botManager 获取） */
  app.get('/api/hermes/status', (_req, res) => {
    const bots = botManager.listAll();
    const activeBotId = bots.find(b => b.status === 'online')?.id;
    res.json({
      alive: activeBotId != null,
      model: process.env.LLM_MODEL ?? 'unknown',
      baseUrl: process.env.LLM_BASE_URL ?? '',
    });
  });

  // --- Electron 生产模式：静态文件托管 ---
  // SERVE_STATIC 由 electron/main.ts 在打包运行时注入，指向 out/renderer/
  // 所有 /api 路由已在上方注册，static 作为兜底只处理前端路由
  if (process.env['SERVE_STATIC']) {
    const staticDir = process.env['SERVE_STATIC']
    app.use(express.static(staticDir))
    app.get('/{*splat}', (req, res) => {
      if (req.path === '/api' || req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'api route not found' })
        return
      }
      res.sendFile(join(staticDir, 'index.html'))
    })
  }

  // --- WebSocket ---

  io.on('connection', (socket) => {
    socket.on('bot:chat', async (
      data: { botId?: unknown; message?: unknown; sender?: unknown } | null,
      acknowledge?: (result: ChatSubmitAck) => void,
    ) => {
      const reply = (result: ChatSubmitAck): void => { acknowledge?.(result); };
      const botId = typeof data?.botId === 'string' ? data.botId.trim() : '';
      const message = typeof data?.message === 'string' ? data.message.trim() : '';
      if (!message) { reply(rejectChatSubmit('INVALID_MESSAGE')); return; }

      const profile = botId ? profileStore.get(botId) : undefined;
      if (!profile) { reply(rejectChatSubmit('PROFILE_NOT_FOUND')); return; }

      try {
        if (!botManager.getStatus(botId)) await botManager.start(profile);
        const accepted = await botManager.chat(
          botId,
          typeof data?.sender === 'string' && data.sender.trim() ? data.sender.trim() : resolveDefaultSender(botId),
          message,
        );
        reply(accepted === null ? rejectChatSubmit('RUNTIME_UNAVAILABLE') : acceptChatSubmit());
      } catch {
        writeLogLine(botId, 'error', '聊天提交失败：RUNTIME_UNAVAILABLE');
        reply(rejectChatSubmit('RUNTIME_UNAVAILABLE'));
      }
    });
  });

  // --- Start ---

  function listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.port, config.host, async () => {
        console.log(`\n  🎮 Minecraft Companion Hub`);
        console.log(`  📡 http://${config.host}:${config.port}`);
        console.log('');
        for (const profile of profileStore.list()) {
          try {
            await botManager.start(profile);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            writeLogLine(profile.id, 'error', `冷启动纯聊天大脑失败：${message}`);
          }
        }
        resolve();
      });
    });
  }

  httpServer.on('close', () => {
    void botManager.stopAll();
  });

  return { app, httpServer, io, profileStore, llmAgentConfigStore, botManager, listen };
}
