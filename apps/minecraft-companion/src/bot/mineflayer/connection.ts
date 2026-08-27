import mineflayer, { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { pathfinder } = pkg;
import { EventBus } from './eventBus.js';
import { ConnectionConfig, ConnectionStatus, GameEvent } from './types.js';
import { MineflayerGameAdapter } from './MineflayerGameAdapter.js';
import { MineflayerNavigationAdapter } from './MineflayerNavigationAdapter.js';
import type { GameAdapter } from '../adapter/GameAdapter.js';
import type { NavigationAdapter } from '../adapter/NavigationAdapter.js';
import { GameConnectionLease } from './gameConnectionLease.js';
import { MineflayerVisualWorldSource } from './MineflayerVisualWorldSource.js';
import type { VisualWorldSource } from '../adapter/VisualWorldSource.js';

export class MineflayerConnection {
  private bot: Bot | null = null;
  private status: ConnectionStatus = 'disconnected';
  private config: ConnectionConfig | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private readonly connectionLease = new GameConnectionLease();

  readonly events = new EventBus();
  onSpawn?: () => void;

  /**
   * 适配器实例（构造时即创建，内部通过 `() => bot` 工厂获取当前实例，
   * 重连后无需重建适配器）
   */
  /**
   * 适配器 BotGetter 返回 Bot | null（非抛错版本）。
   * 重要：服务器掉线 / 重连过程中 `this.bot === null`，适配器方法必须容忍 null
   * 并 silently no-op，否则 ReflexLayer 等异步循环会把 process 拖死。
   */
  private _navLogFn: (msg: string) => void = (msg) => console.log(msg);
  private _lastHealth = 20; // 掉血诊断用：上次血量，比它更低才记一笔
  private readonly liveGameAdapter = new MineflayerGameAdapter(() => this.bot);
  private readonly liveNavAdapter = new MineflayerNavigationAdapter(
    () => this.bot,
    (msg) => this._navLogFn(msg),
  );
  readonly gameAdapter: GameAdapter = this.liveGameAdapter;
  readonly navAdapter: NavigationAdapter = this.liveNavAdapter;
  private readonly liveVisualWorldSource = new MineflayerVisualWorldSource();
  readonly visualWorldSource: VisualWorldSource = this.liveVisualWorldSource;

  /** 让外部（runtime.ts）注入日志函数，使 NavAdapter 的诊断日志写入文件 */
  setNavLogger(fn: (msg: string) => void): void {
    this._navLogFn = fn;
  }

  /**
   * @deprecated 上层应使用 `gameAdapter` / `navAdapter`，不要直接访问 Bot。
   * 仅保留给迁移期间的旧代码使用，Phase D 结束后将删除。
   */
  getBot(): Bot {
    if (!this.bot) throw new Error('Not connected');
    return this.bot;
  }

  getStatus(): ConnectionStatus { return this.status; }
  isConnected(): boolean { return this.status === 'connected'; }

  /**
   * 彻底拆掉当前 bot：摘掉所有 listener（防幽灵 end/kicked 触发重连）+ end socket + 清引用。
   * 任何"开新连接 / 断开 / 断线"前都必须先调它，保证同一时刻只有一个活连接。
   */
  private _teardownBot(): void {
    if (!this.bot) return;
    this.liveGameAdapter.rebindSubscriptions(null);
    this.liveNavAdapter.rebindSubscriptions(null);
    this.liveVisualWorldSource.rebind(null);
    try { this.bot.removeAllListeners(); } catch { /* ignore */ }
    try { this.bot.end(); } catch { /* ignore */ }
    this.bot = null;
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.intentionalDisconnect = false;
    // Cross-process guard: the same server identity must never reach createBot twice.
    this.connectionLease.acquire(config);
    // Commit the reconnect target only after its identity lease is secured. If acquisition
    // fails, the still-live old Bot keeps both its original config and its original lease.
    this.config = config;
    // ★ 单连接守卫（根治"反复重连 / 连接泄漏"）：开新连接前彻底拆掉旧 bot。
    //   没这步，多次 connect()/重连会累积多个同名 mineflayer 连接同时挂在服务器上 → 同名互踢死循环。
    this._teardownBot();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.setStatus('connecting');

    return new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({
        host: config.host,
        port: config.port,
        username: config.username,
        version: config.version,
        auth: config.auth as 'offline' | 'microsoft',
      });

      this.bot = bot;
      bot.loadPlugin(pathfinder);
      // Bind before spawn so existing onSpawn subscribers observe the new generation.
      this.liveGameAdapter.rebindSubscriptions(bot);
      this.liveNavAdapter.rebindSubscriptions(bot);
      this.liveVisualWorldSource.rebind(bot);

      const timeout = setTimeout(() => {
        bot.removeListener('spawn', spawnHandler);
        bot.removeListener('error', errorHandler);
        this.setStatus('disconnected');
        this._teardownBot();
        this.connectionLease.release();
        reject(new Error(`连接超时 (30s) - ${config.host}:${config.port}`));
      }, 30000);

      const spawnHandler = () => {
        clearTimeout(timeout);
        bot.removeListener('spawn', spawnHandler);
        bot.removeListener('error', errorHandler);
        this.setStatus('connected');
        this.reconnectAttempts = 0;
        this.attachListeners(bot);
        this.emitEvent('spawn', { position: bot.entity?.position });
        this.onSpawn?.();
        resolve();
      };

      const errorHandler = (err: Error) => {
        clearTimeout(timeout);
        bot.removeListener('spawn', spawnHandler);
        bot.removeListener('error', errorHandler);
        this.setStatus('disconnected');
        this._teardownBot();
        this.connectionLease.release();
        reject(err);
      };

      bot.once('spawn', spawnHandler);
      bot.once('error', errorHandler);
    });
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._teardownBot();
    this.connectionLease.release();
    this.setStatus('disconnected');
  }

  private attachListeners(bot: Bot): void {
    bot.on('chat', (username: string, message: string) => {
      if (username === bot.username) return;
      this.emitEvent('chat', { sender: username, message });
    });

    bot.on('whisper', (username: string, message: string) => {
      this.emitEvent('whisper', { sender: username, message });
    });

    bot.on('health', () => {
      // 掉血诊断：血量骤降到危险线时记一笔（节流：只在 ≤6 且比上次更低时），看清死前被什么打
      if (bot.health <= 6 && bot.health < this._lastHealth) {
        const p = bot.entity?.position;
        const pos = p ? `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})` : '?';
        this._navLogFn(`⚠ 血量危险 ${Math.round(bot.health)}/20 @ ${pos} food=${Math.round(bot.food)}`);
      }
      this._lastHealth = bot.health;
      this.emitEvent('health_change', {
        health: bot.health,
        food: bot.food,
        saturation: bot.foodSaturation,
      });
    });

    bot.on('death', () => {
      // 记录死亡位置 → 之前死亡完全不进日志，没法诊断生存问题（真服观测盲区）
      const p = bot.entity?.position;
      const pos = p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null;
      this._navLogFn(`💀 死亡 @ ${pos ? `(${pos.x},${pos.y},${pos.z})` : '未知'} · 物品掉落、即将重生`);
      this.emitEvent('death', { position: pos });
    });

    bot.on('kicked', (reason: string) => {
      this.emitEvent('kicked', { reason });
      this.handleDisconnect(reason);
    });

    bot.on('end', (reason: string) => {
      if (!this.intentionalDisconnect) {
        this.handleDisconnect(reason);
      }
    });

    bot.on('error', (err: Error) => {
      this.emitEvent('error', { error: err.message });
    });
  }

  private handleDisconnect(reason: string): void {
    // 断线后彻底拆旧 bot（摘 listener + end），防残留 socket/幽灵 listener 触发二次重连
    this._teardownBot();
    if (this.intentionalDisconnect) {
      this.setStatus('disconnected');
      return;
    }

    const cfg = this.config?.reconnect;
    if (!cfg?.enabled) {
      this.connectionLease.release();
      this.setStatus('disconnected');
      return;
    }

    if (String(reason ?? '').toLowerCase().includes('banned')) {
      this.connectionLease.release();
      this.setStatus('failed');
      return;
    }

    if (this.reconnectAttempts >= cfg.maxRetries) {
      this.connectionLease.release();
      this.setStatus('failed');
      return;
    }

    this.setStatus('reconnecting');
    const delay = Math.min(
      cfg.baseDelay * Math.pow(2, this.reconnectAttempts),
      cfg.maxDelay
    );
    this.reconnectAttempts++;

    console.log(`[connection] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${cfg.maxRetries})`);
    this.reconnectTimer = setTimeout(() => this.attemptReconnect(), delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.config || this.intentionalDisconnect) return;
    try {
      await this.connect(this.config);
    } catch {
      this.handleDisconnect('reconnect_failed');
    }
  }

  async applyServerSkin(textureUrl: string, model: 'classic' | 'slim', timeoutMs = 20_000): Promise<void> {
    const bot = this.bot;
    if (!bot || !this.isConnected()) throw new Error('skin_sync_not_connected');
    if (!isMinecraftTextureUrl(textureUrl)) throw new Error('skin_sync_invalid_texture_url');
    if (skinDataMatches(bot.players[bot.username]?.skinData, textureUrl, model)) return;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('skin_sync_not_confirmed')), timeoutMs);
      const onPlayer = (player: { username: string; skinData?: { url: string; model: string | null } }) => {
        if (player.username === bot.username && skinDataMatches(player.skinData, textureUrl, model)) finish();
      };
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        bot.removeListener('playerUpdated', onPlayer);
        bot.removeListener('playerJoined', onPlayer);
        error ? reject(error) : resolve();
      };

      bot.on('playerUpdated', onPlayer);
      bot.on('playerJoined', onPlayer);
      bot.chat(buildSkinCommand(textureUrl, model));
    });
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emitEvent('connection_change', { status });
  }

  private emitEvent(type: GameEvent['type'], data: Record<string, unknown>): void {
    this.events.emit({ type, timestamp: Date.now(), data });
  }
}

export function buildSkinCommand(textureUrl: string, model: 'classic' | 'slim'): string {
  if (!isMinecraftTextureUrl(textureUrl)) throw new Error('skin_sync_invalid_texture_url');
  return `/skin url ${textureUrl} ${model}`;
}

export function skinDataMatches(
  actual: { url: string; model: string | null } | undefined,
  expectedUrl: string,
  expectedModel: 'classic' | 'slim',
): boolean {
  if (!actual || textureHash(actual.url) !== textureHash(expectedUrl)) return false;
  const actualModel = actual.model === 'slim' ? 'slim' : 'classic';
  return actualModel === expectedModel;
}

function isMinecraftTextureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'textures.minecraft.net' && /^\/texture\/[a-f0-9]+$/i.test(url.pathname);
  } catch { return false; }
}

function textureHash(value: string): string | null {
  try {
    const url = new URL(value);
    const match = /^\/texture\/([a-f0-9]+)$/i.exec(url.pathname);
    return match?.[1]?.toLowerCase() ?? null;
  } catch { return null; }
}
