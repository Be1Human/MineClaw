import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type DesktopPetMode = 'fixed' | 'wander';

export interface DesktopPetPosition {
  displayId: string;
  xRatio: number;
  yRatio: number;
}

export interface DesktopPetConfig {
  enabled: boolean;
  profileId?: string;
  mode: DesktopPetMode;
  position?: DesktopPetPosition;
  updatedAt: number;
}

export type DesktopPetConfigInput = Partial<Omit<DesktopPetConfig, 'updatedAt'>>;

const DEFAULT_CONFIG: DesktopPetConfig = {
  enabled: false,
  mode: 'fixed',
  updatedAt: 0,
};

export class DesktopPetConfigStore {
  private readonly file: string;
  private config: DesktopPetConfig;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'desktop-pet.json');
    this.config = this.load();
  }

  get(): DesktopPetConfig {
    return structuredClone(this.config);
  }

  update(input: DesktopPetConfigInput): DesktopPetConfig {
    const next = validateDesktopPetConfig({ ...this.config, ...input, updatedAt: Date.now() });
    this.config = next;
    this.persist();
    return this.get();
  }

  private load(): DesktopPetConfig {
    if (!existsSync(this.file)) return { ...DEFAULT_CONFIG };
    try {
      return validateDesktopPetConfig(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.config, null, 2), 'utf8');
  }
}

export function validateDesktopPetConfig(value: unknown): DesktopPetConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop pet config must be an object');
  const item = value as Partial<DesktopPetConfig>;
  if (typeof item.enabled !== 'boolean') throw new Error('enabled must be boolean');
  if (item.profileId !== undefined && (typeof item.profileId !== 'string' || !item.profileId.trim())) throw new Error('profileId must be a non-empty string');
  if (item.mode !== 'fixed' && item.mode !== 'wander') throw new Error('mode must be fixed or wander');
  if (item.position !== undefined) {
    const p = item.position;
    if (!p || typeof p.displayId !== 'string' || !Number.isFinite(p.xRatio) || !Number.isFinite(p.yRatio)) throw new Error('invalid position');
    if (p.xRatio < 0 || p.xRatio > 1 || p.yRatio < 0 || p.yRatio > 1) throw new Error('position ratios must be between 0 and 1');
  }
  return {
    enabled: item.enabled,
    profileId: item.profileId?.trim() || undefined,
    mode: item.mode,
    position: item.position ? { ...item.position } : undefined,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
  };
}
