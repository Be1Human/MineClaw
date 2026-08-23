import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';

/** FEAT-WEBUI-12 · 全局共享的服务器预设（带名字），所有角色可选 */
export interface ServerPreset {
  id: string;
  name: string;
  host: string;
  port: number;
  version?: string;
  auth?: 'offline' | 'microsoft';
  skinSync?: {
    mode: 'disabled' | 'skinsrestorer';
  };
  createdAt: number;
}

export type ServerPresetInput = Omit<ServerPreset, 'id' | 'createdAt'>;

/** 内置默认预设：首次启动种入，本地训练服 */
const DEFAULT_PRESET: Omit<ServerPreset, 'id' | 'createdAt'> = {
  name: '本地训练服',
  host: '127.0.0.1',
  port: 25565,
  version: '1.21',
  auth: 'offline',
  skinSync: { mode: 'disabled' },
};

export class ServerPresetStore {
  private file: string;
  private presets: ServerPreset[] = [];

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'server-presets.json');
    if (existsSync(this.file)) {
      this.load();
    } else {
      // 首启：种入内置默认本地服
      this.presets = [{ ...DEFAULT_PRESET, id: uuid(), createdAt: Date.now() }];
      this.save();
    }
  }

  list(): ServerPreset[] { return [...this.presets]; }

  get(id: string): ServerPreset | undefined { return this.presets.find(preset => preset.id === id); }

  add(data: ServerPresetInput): ServerPreset {
    const preset: ServerPreset = this.normalize({ ...data, id: uuid(), createdAt: Date.now() });
    this.presets.push(preset);
    this.save();
    return preset;
  }

  update(id: string, patch: Partial<ServerPresetInput>): ServerPreset | undefined {
    const index = this.presets.findIndex(preset => preset.id === id);
    if (index < 0) return undefined;
    const updated = this.normalize({ ...this.presets[index]!, ...patch, id, createdAt: this.presets[index]!.createdAt });
    this.presets[index] = updated;
    this.save();
    return updated;
  }

  delete(id: string): boolean {
    const before = this.presets.length;
    this.presets = this.presets.filter(p => p.id !== id);
    if (this.presets.length === before) return false;
    this.save();
    return true;
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf-8'));
      if (Array.isArray(data)) this.presets = data.map(preset => this.normalize(preset));
    } catch { /* 损坏则保持空，不种默认（避免覆盖用户意图） */ }
  }

  private normalize(data: ServerPreset): ServerPreset {
    return {
      ...data,
      skinSync: {
        mode: data.skinSync?.mode === 'skinsrestorer' ? 'skinsrestorer' : 'disabled',
      },
    };
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.presets, null, 2), 'utf-8');
  }
}
