import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import type { CharacterCardV1 } from '../character/types.js';
import { resolveCharacterCard } from '../character/migrateCharacterCard.js';
import { validateCharacterCard } from '../character/validateCharacterCard.js';

export type CompanionPlayMode = 'survival' | 'creative';

export const DEFAULT_COMPANION_PLAY_MODE: CompanionPlayMode = 'survival';

export function validateCompanionPlayMode(value: unknown): string | null {
  if (value === undefined || value === DEFAULT_COMPANION_PLAY_MODE) return null;
  if (value === 'creative') return '创造模式暂未开放';
  return '游戏模式无效，仅支持 survival';
}

function requireSupportedPlayMode(value: unknown): CompanionPlayMode {
  const error = validateCompanionPlayMode(value);
  if (error) throw new Error(error);
  return DEFAULT_COMPANION_PLAY_MODE;
}

export interface BotProfile {
  id: string;
  name: string;
  /** 用户为伙伴选择的产品玩法模式；服务器实际模式仍以 GameAdapter.getGameMode() 为准。 */
  playMode?: CompanionPlayMode;
  skin?: string;
  /** FEAT-WEBUI-11 · 本地渲染用皮肤纹理（64×64 PNG 的 data-URL 或 URL）；无则前端走默认皮肤 */
  skinTexture?: string;
  /** FEAT-WEBUI-11 · 皮肤体型 */
  skinModel?: 'classic' | 'slim';
  /** 主人在 MC 里的真实用户名。网页 UI 发送聊天时作为默认 sender，避免把字面"主人"塞进 BT masterName。 */
  ownerUsername?: string;
  personality: { description: string; style: string; prompt?: string };
  /** FEAT-CROSS-12 · 通用四部分角色卡。 */
  characterCard?: CharacterCardV1;
  server: { presetId?: string; host: string; port: number; version?: string; auth: 'offline' | 'microsoft' };
  /** The selected global LLM Agent configuration. */
  llmConfigId?: string;
  /** @deprecated Read only for one-time migration from the previous schema. */
  llm?: { apiKey?: string; baseUrl: string; model: string };
  /** FEAT-MEM-09 · 纯聊天记忆能力开关；缺省字段保持全部能力开启。 */
  memory?: { semanticSearch?: boolean; consolidationEnabled?: boolean };
  createdAt: number;
  updatedAt: number;
}

/**
 * Profile 的 HTTP 边界视图。持久化实体可以保留 LLM 凭据，
 * 但任何返回给浏览器的对象都不得包含该字段。
 */
export type PublicBotProfile = Omit<BotProfile, 'llm' | 'playMode'> & { playMode: CompanionPlayMode };

export function toPublicBotProfile(profile: BotProfile): PublicBotProfile {
  const { llm, ...publicFields } = profile;
  return { ...publicFields, playMode: requireSupportedPlayMode(profile.playMode) };
}

export class ProfileStore {
  private dir: string;
  private profiles = new Map<string, BotProfile>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'profiles');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.loadAll();
  }

  list(): BotProfile[] { return Array.from(this.profiles.values()); }

  get(id: string): BotProfile | undefined { return this.profiles.get(id); }

  create(data: Omit<BotProfile, 'id' | 'createdAt' | 'updatedAt'>): BotProfile {
    const playMode = requireSupportedPlayMode(data.playMode);
    const characterCard = resolveCharacterCard(data);
    const errors = validateCharacterCard(characterCard);
    if (errors.length) throw new Error(`invalid character card: ${errors[0]!.path} ${errors[0]!.message}`);
    const profile: BotProfile = { ...data, playMode, characterCard, id: uuid(), createdAt: Date.now(), updatedAt: Date.now() };
    this.profiles.set(profile.id, profile);
    this.saveOne(profile);
    return profile;
  }

  update(id: string, patch: Partial<BotProfile>): BotProfile | undefined {
    const existing = this.profiles.get(id);
    if (!existing) return undefined;
    const playMode = Object.hasOwn(patch, 'playMode')
      ? requireSupportedPlayMode(patch.playMode)
      : requireSupportedPlayMode(existing.playMode);
    const characterCard = patch.characterCard ?? existing.characterCard ?? resolveCharacterCard(existing);
    const errors = validateCharacterCard(characterCard);
    if (errors.length) throw new Error(`invalid character card: ${errors[0]!.path} ${errors[0]!.message}`);
    const updated: BotProfile = {
      ...existing,
      ...patch,
      playMode,
      personality: patch.personality ? { ...existing.personality, ...patch.personality } : existing.personality,
      server: patch.server ? { ...existing.server, ...patch.server } : existing.server,
      llm: patch.llm ? { ...existing.llm, ...patch.llm } : existing.llm,
      llmConfigId: Object.hasOwn(patch, 'llmConfigId') ? patch.llmConfigId || undefined : existing.llmConfigId,
      memory: patch.memory ? { ...existing.memory, ...patch.memory } : existing.memory,
      characterCard: structuredClone(characterCard),
      id,
      updatedAt: Date.now(),
    };
    this.profiles.set(id, updated);
    this.saveOne(updated);
    return updated;
  }

  delete(id: string): boolean {
    if (!this.profiles.has(id)) return false;
    this.profiles.delete(id);
    const file = join(this.dir, `${id}.json`);
    if (existsSync(file)) unlinkSync(file);
    return true;
  }

  /** Replace a legacy embedded LLM object with a stable global config ID. */
  migrateLlmConfig(id: string, llmConfigId: string): BotProfile | undefined {
    const existing = this.profiles.get(id);
    if (!existing) return undefined;
    const { llm: _legacyLlm, ...withoutLegacyLlm } = existing;
    const updated: BotProfile = {
      ...withoutLegacyLlm,
      llmConfigId,
      updatedAt: Date.now(),
    };
    this.profiles.set(id, updated);
    this.saveOne(updated);
    return updated;
  }

  getCharacterCard(id: string): CharacterCardV1 | undefined {
    const profile = this.profiles.get(id);
    return profile ? resolveCharacterCard(profile) : undefined;
  }

  private loadAll(): void {
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(this.dir, file), 'utf-8')) as BotProfile;
        data.playMode = requireSupportedPlayMode(data.playMode);
        if (!data.characterCard) {
          data.characterCard = resolveCharacterCard(data);
          writeFileSync(join(this.dir, file), JSON.stringify(data, null, 2), 'utf-8');
        }
        this.profiles.set(data.id, data);
      } catch { /* skip corrupt files */ }
    }
  }

  private saveOne(profile: BotProfile): void {
    writeFileSync(join(this.dir, `${profile.id}.json`), JSON.stringify(profile, null, 2), 'utf-8');
  }
}
