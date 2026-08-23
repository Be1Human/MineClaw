import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotProfile } from './profileStore.js';
import type { ServerPreset } from './serverPresetStore.js';

export type SkinModel = 'classic' | 'slim';

export interface PreparedSkin {
  state: 'ready';
  textureUrl: string;
  skinDigest: string;
  model: SkinModel;
}

export interface UnpreparedSkin {
  state: 'unsupported' | 'failed';
  reasonCode: string;
  message: string;
}

export type PrepareSkinResult = PreparedSkin | UnpreparedSkin;

interface SkinCacheEntry {
  textureUrl: string;
  model: SkinModel;
  generatedAt: number;
}

interface MineSkinResponse {
  job?: { id?: string; status?: string };
  skin?: { texture?: { url?: { skin?: string } } };
  errors?: Array<{ message?: string; code?: string }>;
  message?: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SKIN_BYTES = 1024 * 1024;

export class SkinSyncService {
  private readonly cacheFile: string;
  private cache: Record<string, SkinCacheEntry> = {};

  constructor(
    dataDir: string,
    private readonly request: typeof fetch = fetch,
    private readonly pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly apiKey = process.env.MINESKIN_API_KEY?.trim() || '',
  ) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.cacheFile = join(dataDir, 'skin-sync-cache.json');
    this.loadCache();
  }

  async prepare(profile: BotProfile, preset?: ServerPreset): Promise<PrepareSkinResult> {
    if (!preset || preset.skinSync?.mode !== 'skinsrestorer') {
      return {
        state: 'unsupported',
        reasonCode: preset ? 'skin_sync_disabled' : 'server_preset_missing',
        message: preset ? '该服务器没有启用游戏内皮肤同步' : '伙伴没有选择可管理的全局服务器配置',
      };
    }
    if (!profile.skinTexture) {
      return { state: 'unsupported', reasonCode: 'skin_missing', message: '伙伴尚未设置 MineClaw 皮肤' };
    }

    const model: SkinModel = profile.skinModel === 'slim' ? 'slim' : 'classic';
    try {
      const source = this.parseSource(profile.skinTexture);
      const skinDigest = createHash('sha256').update(source.digestInput).update(model).digest('hex');
      const cached = this.cache[skinDigest];
      if (cached?.model === model && this.isTextureUrl(cached.textureUrl)) {
        return { state: 'ready', textureUrl: cached.textureUrl, skinDigest, model };
      }

      const textureUrl = source.kind === 'texture-url'
        ? source.url
        : await this.generateSignedTexture(source, model, skinDigest);
      this.cache[skinDigest] = { textureUrl, model, generatedAt: Date.now() };
      this.saveCache();
      return { state: 'ready', textureUrl, skinDigest, model };
    } catch (error) {
      return {
        state: 'failed',
        reasonCode: this.reasonCode(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseSource(texture: string):
    | { kind: 'upload'; bytes: Buffer; digestInput: Buffer }
    | { kind: 'url'; url: string; digestInput: string }
    | { kind: 'texture-url'; url: string; digestInput: string } {
    if (texture.startsWith('data:')) {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(texture);
      if (!match) throw new Error('皮肤必须是 PNG data URL');
      const bytes = Buffer.from(match[1]!, 'base64');
      this.validatePng(bytes);
      return { kind: 'upload', bytes, digestInput: bytes };
    }

    let url: URL;
    try { url = new URL(texture); } catch { throw new Error('皮肤地址格式无效'); }
    if (url.protocol !== 'https:') throw new Error('皮肤地址必须使用 HTTPS');
    if (url.hostname === 'textures.minecraft.net' && /^\/texture\/[a-f0-9]+$/i.test(url.pathname)) {
      return { kind: 'texture-url', url: url.toString(), digestInput: url.toString() };
    }
    return { kind: 'url', url: url.toString(), digestInput: url.toString() };
  }

  private validatePng(bytes: Buffer): void {
    if (bytes.length > MAX_SKIN_BYTES) throw new Error('皮肤 PNG 不能超过 1MB');
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('皮肤不是有效 PNG');
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== 64 || height !== 64) throw new Error(`皮肤尺寸必须是 64×64，当前为 ${width}×${height}`);
  }

  private async generateSignedTexture(
    source: { kind: 'upload'; bytes: Buffer } | { kind: 'url'; url: string },
    model: SkinModel,
    digest: string,
  ): Promise<string> {
    const headers: Record<string, string> = { 'MineSkin-User-Agent': 'MineClaw/0.1.0' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let body: FormData | string;
    if (source.kind === 'upload') {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(source.bytes)], { type: 'image/png' }), `mineclaw-${digest.slice(0, 12)}.png`);
      form.append('variant', model);
      form.append('visibility', 'unlisted');
      form.append('name', `MineClaw ${digest.slice(0, 8)}`);
      body = form;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ url: source.url, variant: model, visibility: 'unlisted', name: `MineClaw ${digest.slice(0, 8)}` });
    }

    const response = await this.request('https://api.mineskin.org/v2/queue', { method: 'POST', headers, body });
    const initial = await this.readMineSkinResponse(response);
    const immediateUrl = this.textureUrl(initial);
    if (immediateUrl) return immediateUrl;
    const jobId = initial.job?.id;
    if (!jobId) throw new Error('MineSkin 没有返回任务编号');

    for (let attempt = 0; attempt < 30; attempt++) {
      await this.pause(1000);
      const polled = await this.request(`https://api.mineskin.org/v2/queue/${encodeURIComponent(jobId)}`, { headers });
      const result = await this.readMineSkinResponse(polled);
      const url = this.textureUrl(result);
      if (url) return url;
      if (result.job?.status === 'failed') throw new Error('MineSkin 生成签名纹理失败');
    }
    throw new Error('MineSkin 生成签名纹理超时');
  }

  private async readMineSkinResponse(response: Response): Promise<MineSkinResponse> {
    const data = await response.json().catch(() => ({})) as MineSkinResponse;
    if (!response.ok) {
      const detail = data.errors?.map(error => error.message || error.code).filter(Boolean).join('；') || data.message;
      if (response.status === 429) throw new Error(`MineSkin 请求过于频繁${detail ? `：${detail}` : ''}`);
      throw new Error(`MineSkin 请求失败 (${response.status})${detail ? `：${detail}` : ''}`);
    }
    return data;
  }

  private textureUrl(data: MineSkinResponse): string | null {
    const url = data.skin?.texture?.url?.skin;
    return url && this.isTextureUrl(url) ? url : null;
  }

  private isTextureUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'textures.minecraft.net' && /^\/texture\/[a-f0-9]+$/i.test(url.pathname);
    } catch { return false; }
  }

  private reasonCode(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('过于频繁')) return 'mineskin_rate_limited';
    if (message.includes('超时')) return 'mineskin_timeout';
    if (message.includes('MineSkin')) return 'mineskin_failed';
    return 'invalid_skin';
  }

  private loadCache(): void {
    if (!existsSync(this.cacheFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.cacheFile, 'utf-8')) as Record<string, SkinCacheEntry>;
      if (data && typeof data === 'object' && !Array.isArray(data)) this.cache = data;
    } catch { this.cache = {}; }
  }

  private saveCache(): void {
    writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2), 'utf-8');
  }
}
