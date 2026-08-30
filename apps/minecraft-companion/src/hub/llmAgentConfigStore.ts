import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import { DEFAULT_LLM_API, isLlmApi, type LlmApi } from '../llm/api.js';
import { resolveProfileLlmConfig, type LlmConfig } from './llmConfig.js';
import type { ProfileStore } from './profileStore.js';

export interface LlmAgentConfig {
  id: string;
  name: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  api: LlmApi;
  createdAt: number;
  updatedAt: number;
}

export interface LlmAgentConfigInput {
  name: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  api?: LlmApi;
}

export interface LlmAgentConfigPatch {
  name?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl?: string;
  model?: string;
  api?: LlmApi;
}

export interface PublicLlmAgentConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  api: LlmApi;
  apiKeyConfigured: boolean;
  profileCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Global LLM connection definitions. Credentials stay in this server-only
 * store; callers receive the redacted PublicLlmAgentConfig representation.
 */
export class LlmAgentConfigStore {
  private readonly file: string;
  private configs = new Map<string, LlmAgentConfig>();

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'llm-agent-configs.json');
    this.load();
  }

  list(): LlmAgentConfig[] {
    return Array.from(this.configs.values());
  }

  get(id: string | undefined): LlmAgentConfig | undefined {
    return id ? this.configs.get(id) : undefined;
  }

  create(input: LlmAgentConfigInput): LlmAgentConfig {
    const now = Date.now();
    const config: LlmAgentConfig = {
      id: uuid(),
      name: input.name.trim(),
      apiKey: clean(input.apiKey),
      baseUrl: input.baseUrl.trim(),
      model: input.model.trim(),
      api: input.api ?? DEFAULT_LLM_API,
      createdAt: now,
      updatedAt: now,
    };
    this.configs.set(config.id, config);
    this.save();
    return config;
  }

  update(id: string, patch: LlmAgentConfigPatch): LlmAgentConfig | undefined {
    const existing = this.configs.get(id);
    if (!existing) return undefined;

    const updated: LlmAgentConfig = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl.trim() } : {}),
      ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
      ...(patch.api !== undefined ? { api: patch.api } : {}),
      ...(patch.clearApiKey ? { apiKey: undefined } : patch.apiKey !== undefined ? { apiKey: clean(patch.apiKey) } : {}),
      updatedAt: Date.now(),
    };
    this.configs.set(id, updated);
    this.save();
    return updated;
  }

  delete(id: string): boolean {
    if (!this.configs.delete(id)) return false;
    this.save();
    return true;
  }

  toPublic(config: LlmAgentConfig, profileCount: number): PublicLlmAgentConfig {
    return {
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      model: config.model,
      api: config.api,
      apiKeyConfigured: Boolean(config.apiKey?.trim()),
      profileCount,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  /**
   * Each legacy profile receives its own config record before its embedded
   * LLM fields are removed. That preserves existing role isolation exactly.
   */
  migrateLegacyProfiles(profileStore: ProfileStore, fallback?: LlmConfig | null): void {
    for (const profile of profileStore.list()) {
      if (profile.llmConfigId || !profile.llm) continue;
      const resolved = resolveProfileLlmConfig(profile.llm, fallback);
      const config = this.create({
        name: this.nextMigrationName(profile.name),
        ...resolved,
      });
      profileStore.migrateLlmConfig(profile.id, config.id);
    }
  }

  private nextMigrationName(profileName: string): string {
    const base = `迁移 - ${profileName.trim() || '未命名角色'}`;
    const names = new Set(this.list().map(config => config.name));
    if (!names.has(base)) return base;
    let suffix = 2;
    while (names.has(`${base} ${suffix}`)) suffix += 1;
    return `${base} ${suffix}`;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown;
      if (!Array.isArray(data)) return;
      for (const candidate of data) {
        if (!isStoredConfig(candidate)) continue;
        this.configs.set(candidate.id, {
          ...candidate,
          api: candidate.api ?? DEFAULT_LLM_API,
        });
      }
    } catch {
      // Keep an empty in-memory store rather than overwriting unreadable data.
    }
  }

  private save(): void {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.list(), null, 2), 'utf-8');
    renameSync(temp, this.file);
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isStoredConfig(value: unknown): value is Omit<LlmAgentConfig, 'api'> & { api?: LlmApi } {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<LlmAgentConfig>;
  return typeof config.id === 'string'
    && typeof config.name === 'string'
    && typeof config.baseUrl === 'string'
    && typeof config.model === 'string'
    && (config.api === undefined || isLlmApi(config.api))
    && typeof config.createdAt === 'number'
    && typeof config.updatedAt === 'number';
}
