import { BrowserWindow, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface DesktopPetPosition {
  displayId: string;
  xRatio: number;
  yRatio: number;
}

interface DesktopPetConfig {
  enabled: boolean;
  profileId?: string;
  mode: 'fixed' | 'wander';
  position?: DesktopPetPosition;
  updatedAt: number;
  profileValid?: boolean;
}

const PET_WIDTH = 220;
const PET_HEIGHT = 320;

export class DesktopPetController {
  private window: BrowserWindow | null = null;
  private config: DesktopPetConfig | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private motionTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private evidenceTimer: NodeJS.Timeout | null = null;
  private targetX: number | null = null;
  private facing: 'left' | 'right' = 'right';
  private savingPosition = false;

  constructor(
    private readonly hubUrl: string,
    private readonly preloadPath: string,
    private readonly rendererUrl?: string,
  ) {}

  start(): void {
    void this.sync();
    this.syncTimer = setInterval(() => void this.sync(), 1000);
    screen.on('display-added', this.recoverToVisibleArea);
    screen.on('display-removed', this.recoverToVisibleArea);
    screen.on('display-metrics-changed', this.recoverToVisibleArea);
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.stopMotion();
    this.window?.destroy();
    this.window = null;
    screen.off('display-added', this.recoverToVisibleArea);
    screen.off('display-removed', this.recoverToVisibleArea);
    screen.off('display-metrics-changed', this.recoverToVisibleArea);
  }

  toggleVisible(): void {
    if (!this.window) {
      void this.sync(true);
      return;
    }
    this.window.isVisible() ? this.window.hide() : this.window.showInactive();
  }

  resetPosition(): void {
    if (!this.window) return;
    const area = screen.getPrimaryDisplay().workArea;
    this.window.setPosition(area.x + area.width - PET_WIDTH - 24, area.y + area.height - PET_HEIGHT - 12);
    void this.savePosition();
  }

  private async sync(force = false): Promise<void> {
    try {
      const response = await fetch(`${this.hubUrl}/api/desktop-pet`);
      if (!response.ok) return;
      const next = await response.json() as DesktopPetConfig;
      if (!next.enabled || !next.profileId || next.profileValid === false) {
        this.destroyWindow();
        this.config = next;
        return;
      }
      const changed = force || !this.config || next.updatedAt !== this.config.updatedAt;
      this.config = next;
      if (!this.window) this.createWindow(next);
      else if (changed) this.applyConfig(next);
    } catch {
      // Hub can be briefly unavailable during startup or restart; next poll retries.
    }
  }

  private createWindow(config: DesktopPetConfig): void {
    const position = this.resolvePosition(config.position);
    this.window = new BrowserWindow({
      width: PET_WIDTH,
      height: PET_HEIGHT,
      x: position.x,
      y: position.y,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: false,
      },
    });
    this.window.setAlwaysOnTop(true, 'floating');
    const page = this.rendererUrl
      ? `${this.rendererUrl.replace(/\/$/, '')}/desktop-pet.html`
      : `${this.hubUrl}/desktop-pet.html`;
    void this.window.loadURL(page);
    this.window.webContents.once('did-finish-load', () => {
      this.pushRenderState();
      setTimeout(() => void this.logTransparencyEvidence(), 2000);
    });
    this.window.on('moved', () => {
      if (this.config?.mode === 'fixed' && !this.savingPosition) void this.savePosition();
    });
    this.window.on('closed', () => {
      this.window = null;
      this.stopMotion();
    });
    this.applyConfig(config);
  }

  private applyConfig(config: DesktopPetConfig): void {
    this.stopMotion();
    this.recoverToVisibleArea();
    this.pushRenderState();
    if (config.mode === 'wander') this.scheduleWalk();
  }

  private pushRenderState(animation?: 'idle' | 'walk'): void {
    this.window?.webContents.send('desktop-pet:state', {
      profileId: this.config?.profileId,
      mode: this.config?.mode ?? 'fixed',
      animation: animation ?? (this.config?.mode === 'wander' && this.targetX !== null ? 'walk' : 'idle'),
      facing: this.facing,
    });
    if (this.evidenceTimer) clearTimeout(this.evidenceTimer);
    this.evidenceTimer = setTimeout(() => void this.logTransparencyEvidence(), 700);
  }

  private scheduleWalk(): void {
    if (this.config?.mode !== 'wander' || !this.window) return;
    this.pushRenderState('idle');
    this.idleTimer = setTimeout(() => this.beginWalk(), 3000 + Math.random() * 7000);
  }

  private beginWalk(): void {
    if (this.config?.mode !== 'wander' || !this.window) return;
    const bounds = this.window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const minX = area.x;
    const maxX = area.x + area.width - PET_WIDTH;
    this.targetX = Math.round(minX + Math.random() * Math.max(0, maxX - minX));
    this.facing = this.targetX < bounds.x ? 'left' : 'right';
    this.pushRenderState('walk');
    this.motionTimer = setInterval(() => this.stepWalk(), 50);
  }

  private stepWalk(): void {
    if (!this.window || this.targetX === null) return;
    const [x, y] = this.window.getPosition();
    const delta = this.targetX - x;
    if (Math.abs(delta) <= 3) {
      this.window.setPosition(this.targetX, y);
      this.targetX = null;
      if (this.motionTimer) clearInterval(this.motionTimer);
      this.motionTimer = null;
      this.scheduleWalk();
      return;
    }
    this.window.setPosition(x + Math.sign(delta) * 3, y);
  }

  private stopMotion(): void {
    if (this.motionTimer) clearInterval(this.motionTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.motionTimer = null;
    this.idleTimer = null;
    if (this.evidenceTimer) clearTimeout(this.evidenceTimer);
    this.evidenceTimer = null;
    this.targetX = null;
  }

  private resolvePosition(position?: DesktopPetPosition): { x: number; y: number } {
    const displays = screen.getAllDisplays();
    const display = displays.find(item => String(item.id) === position?.displayId) ?? screen.getPrimaryDisplay();
    const area = display.workArea;
    const maxX = Math.max(0, area.width - PET_WIDTH);
    const maxY = Math.max(0, area.height - PET_HEIGHT);
    return {
      x: area.x + Math.round((position?.xRatio ?? 0.95) * maxX),
      y: area.y + Math.round((position?.yRatio ?? 1) * maxY),
    };
  }

  private recoverToVisibleArea = (): void => {
    if (!this.window) return;
    const bounds = this.window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width);
    const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height);
    if (x !== bounds.x || y !== bounds.y) this.window.setPosition(x, y);
  };

  private async savePosition(): Promise<void> {
    if (!this.window || this.config?.mode !== 'fixed') return;
    const bounds = this.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const area = display.workArea;
    const position: DesktopPetPosition = {
      displayId: String(display.id),
      xRatio: clampRatio((bounds.x - area.x) / Math.max(1, area.width - bounds.width)),
      yRatio: clampRatio((bounds.y - area.y) / Math.max(1, area.height - bounds.height)),
    };
    this.savingPosition = true;
    try {
      await fetch(`${this.hubUrl}/api/desktop-pet`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position }),
      });
    } finally {
      this.savingPosition = false;
    }
  }

  private async logTransparencyEvidence(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;
    try {
      const image = await this.window.webContents.capturePage();
      const bitmap = image.toBitmap();
      let transparent = 0;
      let visible = 0;
      for (let offset = 3; offset < bitmap.length; offset += 4) {
        const alpha = bitmap[offset] ?? 0;
        if (alpha === 0) transparent += 1;
        else visible += 1;
      }
      console.log(`[DesktopPet] render evidence transparent=${transparent} visible=${visible}`);
      const renderer = await this.window.webContents.executeJavaScript(`(() => {
        const debug = window.__desktopPetDebug?.() ?? null;
        const canvas = document.querySelector('canvas');
        if (!canvas) return { canvas: false, alphaPixels: 0, debug };
        const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!context) return { canvas: true, alphaPixels: -1, debug };
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
        let alphaPixels = 0;
        let coloredPixels = 0;
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if (pixels[offset] === 0) continue;
          alphaPixels += 1;
          const red = pixels[offset - 3], green = pixels[offset - 2], blue = pixels[offset - 1];
          if (Math.max(red, green, blue) - Math.min(red, green, blue) > 8) coloredPixels += 1;
        }
        const rect = canvas.getBoundingClientRect();
        return { canvas: true, width: canvas.width, height: canvas.height, alphaPixels, coloredPixels, debug, rect: { width: rect.width, height: rect.height, x: rect.x, y: rect.y }, display: getComputedStyle(canvas).display };
      })()`);
      console.log(`[DesktopPet] canvas evidence ${JSON.stringify(renderer)}`);
      const reportDir = join(process.cwd(), 'eval', 'reports');
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, 'desktop-pet-render.json'), JSON.stringify(renderer, null, 2));
    } catch (error) {
      console.warn('[DesktopPet] render evidence failed:', error);
    }
  }

  private destroyWindow(): void {
    this.stopMotion();
    this.window?.destroy();
    this.window = null;
  }
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}
