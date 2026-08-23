/**
 * 评测体系 · 导演 bot（FEAT-CROSS-02 · 阶段〇）
 *
 * 定位：拥有 op 权限的"场记"。负责
 *   - 摆场：/fill 清场 + 铺地板，/setblock 建结构，/give 发物资，/time /gamerule 控环境，/summon 刷怪
 *   - 当跟随场景的"主人"：用 pathfinder 走折线，让被测 bot 跟
 *   - 坐标系：所有场景用【局部坐标】(lx,ly,lz)，由 anchor 平移到世界坐标，保证可复现
 *
 * 设计约束：导演是独立 mineflayer bot，不走 V2Runtime（它不是被测对象）。
 * op 命令一律走 bot.chat('/...')，每条命令后给服务器一点生效时间。
 */

import mineflayer, { type Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pkg;

export interface Loc { x: number; y: number; z: number }

export interface DirectorConfig {
  host: string;
  port: number;
  username: string;
  auth?: 'offline' | 'microsoft';
  version?: string;
  /** 局部坐标原点（世界坐标）· 场地以此为基准搭建 */
  anchor: Loc;
  onLog?: (msg: string) => void;
}

/** 小睡（评测内部用，非 Bash sleep） */
export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** BUG-CROSS-05 · 将命令别名收敛为 Paper 1.21 接受的 namespaced 规范命令。 */
export function normalizeMinecraftCommand(command: string): string {
  const raw = command.trim().replace(/^\//, '');
  if (!raw) return '/';
  const splitAt = raw.search(/\s/);
  const head = splitAt < 0 ? raw : raw.slice(0, splitAt);
  const tail = splitAt < 0 ? '' : raw.slice(splitAt);
  if (head.includes(':')) return `/${head}${tail}`;
  const canonical = head.toLowerCase() === 'tp' ? 'teleport' : head;
  return `/minecraft:${canonical}${tail}`;
}

/** 权限不足在部分 Paper 版本会伪装成“未知/不完整命令”，必须按拒绝处理。 */
export function isPermissionDeniedMessage(text: string): boolean {
  return /permission|权限|allowed|不允许|unknown or incomplete command|未知或不完整/i.test(text);
}

export class Director {
  private bot: Bot | null = null;
  readonly anchor: Loc;
  readonly username: string;
  private log: (msg: string) => void;
  /** 最近服务器消息环形缓冲（含时间戳）· 用于确诊命令是否被接受 */
  private msgs: Array<{ at: number; text: string }> = [];

  constructor(private readonly cfg: DirectorConfig) {
    this.anchor = cfg.anchor;
    this.username = cfg.username;
    this.log = cfg.onLog ?? (() => {});
  }

  /** 返回 sinceMs 之后收到的服务器消息文本 */
  messagesSince(sinceMs: number): string[] {
    return this.msgs.filter(m => m.at >= sinceMs).map(m => m.text);
  }

  /** 局部坐标 → 世界坐标 */
  world(lx: number, ly: number, lz: number): Loc {
    return { x: this.anchor.x + lx, y: this.anchor.y + ly, z: this.anchor.z + lz };
  }

  getBot(): Bot {
    if (!this.bot) throw new Error('Director not connected');
    return this.bot;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const bot = mineflayer.createBot({
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.username,
        version: this.cfg.version,
        auth: this.cfg.auth ?? 'offline',
      });
      this.bot = bot;
      bot.loadPlugin(pathfinder);
      const timeout = setTimeout(() => reject(new Error('Director 连接超时 (30s)')), 30000);
      bot.once('spawn', () => {
        clearTimeout(timeout);
        this.log(`[director] 已上线 username=${this.cfg.username}`);
        resolve();
      });
      bot.once('error', (e) => { clearTimeout(timeout); reject(e); });
      // 掉线 / 被踢可见化（命令刷屏可能触发 kick）
      bot.on('kicked', (reason) => this.log(`[director] ⚠️ KICKED: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
      bot.on('end', (reason) => this.log(`[director] ⚠️ END: ${reason}`));
      bot.on('error', (e) => this.log(`[director] socket error: ${(e as Error).message}`));
      // 收集服务器消息（命令反馈 / 报错）· 用于确诊
      bot.on('message', (m) => {
        try {
          const text = m.toString();
          this.msgs.push({ at: Date.now(), text });
          if (this.msgs.length > 100) this.msgs.shift();
        } catch { /* ignore */ }
      });
    });
  }

  async disconnect(): Promise<void> {
    try { this.bot?.end(); } catch { /* ignore */ }
    this.bot = null;
  }

  // ─────────────── op 命令 ───────────────

  /**
   * 发一条服务器命令并等生效。
   * 自动把 `/<cmd>` 改写为 `/minecraft:<cmd>`，强制走原版命令——
   * 绕过 Bukkit/Essentials 等插件对 /tp /give 等的别名拦截（确诊根因）。
   */
  async cmd(command: string, settleMs = 120): Promise<void> {
    this.getBot().chat(normalizeMinecraftCommand(command));
    await sleep(settleMs);
  }

  /** op 权限自检：尝试一条无害 op 命令，监听是否被拒 */
  async checkOp(): Promise<boolean> {
    let denied = false;
    const onMsg = (msg: { toString(): string }) => {
      const t = msg.toString();
      if (isPermissionDeniedMessage(t)) denied = true;
    };
    this.getBot().on('message', onMsg);
    await this.cmd('/time query daytime', 300);
    this.getBot().removeListener('message', onMsg);
    return !denied;
  }

  /** 统一日间 + 关刷怪 + 晴天（评测环境隔离，设计 §5 风险缓解） */
  async stabilizeEnv(): Promise<void> {
    await this.cmd('/time set day');
    await this.cmd('/gamerule doMobSpawning false');
    await this.cmd('/gamerule doDaylightCycle false');
    await this.cmd('/gamerule doWeatherCycle false');
    await this.cmd('/weather clear');
  }

  /**
   * 准备一块干净竞技场：清空 + 铺石地板。
   * 局部范围 x∈[0,len) z∈[0,len)，清空 y∈[0,height)，地板在 y=-1。
   * /fill 单次上限 32768 方块，超限分层清。
   */
  async prepareArena(len = 96, height = 6): Promise<void> {
    const a = this.anchor;
    const x0 = a.x, z0 = a.z, x1 = a.x + len - 1, z1 = a.z + len - 1;
    // Director 通常仍在出生点；远端 anchor 的区块未加载时，Paper 会拒绝 /fill。
    // 临时强制加载完整竞技场，摆场完成后立即释放，避免给服务器留下常驻区块。
    await this.cmd(`/forceload add ${x0} ${z0} ${x1} ${z1}`, 300);
    try {
      // 地板（1 层）
      await this.cmd(`/fill ${x0} ${a.y - 1} ${z0} ${x1} ${a.y - 1} ${z1} minecraft:stone`, 200);
      // 清空上方（每 2 层一刀，避免超 32768：len=96 → 96*96*2=18432 < 32768）
      for (let dy = 0; dy < height; dy += 2) {
        const yA = a.y + dy, yB = a.y + Math.min(dy + 1, height - 1);
        await this.cmd(`/fill ${x0} ${yA} ${z0} ${x1} ${yB} ${z1} minecraft:air`, 150);
      }
    } finally {
      await this.cmd(`/forceload remove ${x0} ${z0} ${x1} ${z1}`, 150);
    }
  }

  /** 在局部坐标放单块 */
  async setblock(lx: number, ly: number, lz: number, block: string): Promise<void> {
    const w = this.world(lx, ly, lz);
    await this.cmd(`/setblock ${w.x} ${w.y} ${w.z} minecraft:${block}`, 60);
  }

  /** 在局部坐标区间填充 */
  async fill(l0: Loc, l1: Loc, block: string): Promise<void> {
    const a = this.world(l0.x, l0.y, l0.z);
    const b = this.world(l1.x, l1.y, l1.z);
    await this.cmd(`/fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} minecraft:${block}`, 120);
  }

  /** tp 任意玩家到局部坐标（含被测 bot） */
  async tp(player: string, lx: number, ly: number, lz: number): Promise<void> {
    const w = this.world(lx, ly, lz);
    await this.cmd(`/tp ${player} ${w.x} ${w.y} ${w.z}`, 200);
  }

  /** 给玩家发物品 */
  async give(player: string, item: string, count = 1): Promise<void> {
    await this.cmd(`/give ${player} minecraft:${item} ${count}`, 120);
  }

  /** 清空玩家背包 */
  async clearInv(player: string): Promise<void> {
    await this.cmd(`/clear ${player}`, 120);
  }

  /** 召唤实体到局部坐标 */
  async summon(entity: string, lx: number, ly: number, lz: number): Promise<void> {
    const w = this.world(lx, ly, lz);
    await this.cmd(`/summon minecraft:${entity} ${w.x} ${w.y} ${w.z}`, 150);
  }

  /** 设置难度（SURV/COMB 需 normal 让怪有攻击性；默认服可能 peaceful 会清怪） */
  async setDifficulty(level: 'peaceful' | 'easy' | 'normal' | 'hard'): Promise<void> {
    await this.cmd(`/difficulty ${level}`, 150);
  }

  /** 清掉某类实体（场景清场用，如 /kill @e[type=zombie]） */
  async killEntities(type: string): Promise<void> {
    await this.cmd(`/kill @e[type=minecraft:${type}]`, 150);
  }

  /**
   * 本地统计某类实体数量（FEAT-CROSS-03 · 用 bot.entities 本地缓存，不依赖 op 命令回显）。
   * @param type   实体名子串（如 'zombie'）
   * @param center 世界坐标中心
   * @param range  半径（格）
   */
  countEntities(type: string, center: Loc, range: number): number {
    const bot = this.getBot();
    let n = 0;
    for (const e of Object.values(bot.entities ?? {})) {
      const ent = e as { name?: string; displayName?: string; position?: Loc } | null;
      if (!ent || !ent.position) continue;
      const name = (ent.name ?? ent.displayName ?? '').toLowerCase();
      if (!name.includes(type.toLowerCase())) continue;
      const dx = ent.position.x - center.x, dy = ent.position.y - center.y, dz = ent.position.z - center.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= range) n++;
    }
    return n;
  }

  /** 把导演自己 tp 到局部坐标（跟随场景"主人就位"用） */
  async tpSelf(lx: number, ly: number, lz: number): Promise<void> {
    await this.tp(this.cfg.username, lx, ly, lz);
  }

  /** 把导演 tp 到远处（非跟随场景，使 owner 不可见，避免污染） */
  async parkFar(): Promise<void> {
    const w = this.world(0, 0, 0);
    await this.cmd(`/tp ${this.cfg.username} ${w.x + 600} ${w.y + 40} ${w.z + 600}`, 200);
  }

  // ─────────────── 行走（FOLLOW 场景） ───────────────

  /** 用 pathfinder 走到局部坐标（阻塞到到达或超时） */
  async walkTo(lx: number, ly: number, lz: number, timeoutMs = 20000): Promise<void> {
    const bot = this.getBot();
    const moves = new Movements(bot);
    moves.canDig = false;
    bot.pathfinder.setMovements(moves);
    const w = this.world(lx, ly, lz);
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalBlock(w.x, w.y, w.z)).catch(() => {}),
      sleep(timeoutMs),
    ]);
    try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
  }

  /** 依次走过一串局部坐标航点 */
  async walkPath(points: Array<[number, number, number]>, perHopTimeoutMs = 20000): Promise<void> {
    for (const [lx, ly, lz] of points) {
      await this.walkTo(lx, ly, lz, perHopTimeoutMs);
    }
  }

  /** 导演当前世界坐标 */
  pos(): Loc {
    const p = this.getBot().entity?.position;
    return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };
  }
}
