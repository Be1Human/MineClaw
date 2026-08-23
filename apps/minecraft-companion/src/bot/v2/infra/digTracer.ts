/**
 * 🔍 digTracer — 砸墙根因诊断打点
 *
 * 临时诊断模块，用于抓「为什么 bot 会砸墙」的真凶。
 * 不修复任何 bug，只打点 + 拦截调用栈。
 *
 * 抓三件事：
 *   ① 谁在调 bot.dig（路径上每一次破坏方块）—— 含 block + pos + 调用栈
 *   ② bot.pathfinder.setMovements 被替换的所有时机 —— 含新 Movements 的 canDig + 调用栈
 *   ③ 每次 bot.pathfinder.goto 调用前的 canDig / openable 快照 —— 看寻路下发那一刻设置如何
 *
 * 顺带：spawn / respawn / death / login 事件触发时也打一次 canDig 快照。
 *
 * 卸载：installDigTracer 返回 uninstall()。
 */

import type { Bot } from 'mineflayer';

export interface DigTracerLog {
  (level: 'info' | 'warn' | 'error', msg: string): void;
}

interface PathfinderLike {
  movements?: {
    canDig?: boolean;
    canOpenDoors?: boolean;
    openable?: { size?: number; has?: (id: number) => boolean };
    blocksCantBreak?: { size?: number };
    allowParkour?: boolean;
    allowSprinting?: boolean;
  };
  setMovements?: (m: unknown) => void;
  goto?: (...args: unknown[]) => Promise<unknown>;
}

interface BotWithDig {
  dig: (...args: unknown[]) => Promise<void>;
  pathfinder?: PathfinderLike;
  on: (event: string, handler: (...args: unknown[]) => void) => unknown;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => unknown;
  registry?: { blocksByName?: Record<string, { id: number }> };
}

/** 取调用栈顶 N 帧，压成一行用 ⤷ 分隔，便于日志可读。 */
function topStack(skip = 2, take = 5): string {
  const lines = new Error().stack?.split('\n') ?? [];
  return lines
    .slice(1 + skip, 1 + skip + take)
    .map(l => l.trim().replace(/^at\s+/, ''))
    .join(' ⤷ ');
}

/** 拍当前 Movements 的关键开关快照。 */
function snapshotMovements(pf: PathfinderLike | undefined): string {
  const m = pf?.movements;
  if (!m) return 'movements=null';
  const openableSize = m.openable?.size ?? '?';
  return [
    `canDig=${m.canDig}`,
    `canOpenDoors=${m.canOpenDoors}`,
    `openable.size=${openableSize}`,
    `allowParkour=${m.allowParkour}`,
    `blocksCantBreak.size=${m.blocksCantBreak?.size ?? '?'}`,
  ].join(' ');
}

/** 检查常见门是否在 openable 集合里（用于一次性诊断「门为何当墙」）。 */
function checkDoors(bot: BotWithDig): string {
  const pf = bot.pathfinder;
  const openable = pf?.movements?.openable;
  if (!openable || typeof openable.has !== 'function') return 'openable 不可探测';
  const blocksByName = bot.registry?.blocksByName ?? {};
  const probe = [
    'oak_door', 'spruce_door', 'birch_door', 'iron_door',
    'oak_fence_gate', 'iron_trapdoor',
  ];
  const result = probe.map(name => {
    const id = blocksByName[name]?.id;
    if (id == null) return `${name}=未知方块`;
    return `${name}=${openable.has?.(id) ? '✓可开' : '✗当墙'}`;
  });
  return result.join(' | ');
}

export function installDigTracer(
  rawBot: unknown,
  log: DigTracerLog,
): () => void {
  const bot = rawBot as BotWithDig;
  const tag = '[digTracer]';

  // ── 0. 装点时的初始诊断 ──────────────────────────────────────────────
  log('info', `${tag} 安装 · 初始 ${snapshotMovements(bot.pathfinder)}`);
  log('info', `${tag} 初始 openable 探测：${checkDoors(bot)}`);

  // ── 1. patch bot.dig —— 抓真正破坏方块的调用 ─────────────────────────
  const originalDig = bot.dig.bind(bot);
  (bot as { dig: typeof bot.dig }).dig = async (...args: unknown[]) => {
    const block = args[0] as { name?: string; position?: { x: number; y: number; z: number } } | undefined;
    const name = block?.name ?? '?';
    const pos = block?.position ? `(${block.position.x},${block.position.y},${block.position.z})` : '?';
    const snap = snapshotMovements(bot.pathfinder);
    log('warn', `${tag} 🚨 bot.dig 被调用 · block=${name} pos=${pos} · ${snap}`);
    log('warn', `${tag}   调用栈：${topStack(1, 8)}`);
    return originalDig(...args);
  };

  // ── 2. patch bot.pathfinder.setMovements —— 抓 Movements 被替换的瞬间 ──
  const pf = bot.pathfinder;
  let uninstallSetMovements: (() => void) | null = null;
  if (pf && typeof pf.setMovements === 'function') {
    const originalSetMovements = pf.setMovements.bind(pf);
    pf.setMovements = (newMvs: unknown) => {
      const m = newMvs as PathfinderLike['movements'];
      log('warn', `${tag} ⚙ setMovements 被调用 · 新 canDig=${m?.canDig} openable.size=${m?.openable?.size ?? '?'}`);
      log('warn', `${tag}   调用栈：${topStack(1, 6)}`);
      return originalSetMovements(newMvs);
    };
    uninstallSetMovements = () => {
      pf.setMovements = originalSetMovements;
    };
  }

  // ── 3. wrap bot.pathfinder.goto —— 仅在 Movements 快照「变化」时打点，避免每 tick 刷屏 ──
  let uninstallGoto: (() => void) | null = null;
  if (pf && typeof pf.goto === 'function') {
    const originalGoto = pf.goto.bind(pf);
    let lastSnap = '';
    let silencedCount = 0;
    let lastGoalKey = '';
    pf.goto = (...args: unknown[]) => {
      const goal = args[0] as { x?: number; y?: number; z?: number; range?: number } | undefined;
      const goalDesc = goal ? `(${goal.x ?? '?'},${goal.y ?? '?'},${goal.z ?? '?'},r=${goal.range ?? '?'})` : '?';
      const snap = snapshotMovements(pf);
      const goalKey = `${goal?.x ?? '?'}:${goal?.y ?? '?'}:${goal?.z ?? '?'}`;
      // 快照变了 → 必打；目标变了 → 也打一次（新目标值得标记）；其它情况静默累计。
      if (snap !== lastSnap || goalKey !== lastGoalKey) {
        if (silencedCount > 0) {
          log('info', `${tag}   …（同状态省略 ${silencedCount} 次 goto）`);
          silencedCount = 0;
        }
        log('info', `${tag} ▶ pathfinder.goto · goal=${goalDesc} · ${snap}`);
        lastSnap = snap;
        lastGoalKey = goalKey;
      } else {
        silencedCount++;
      }
      return originalGoto(...args);
    };
    uninstallGoto = () => {
      pf.goto = originalGoto;
    };
  }

  // ── 4. 关键事件钩子 —— spawn / respawn / death / login ─────────────────
  const onSpawn = () => log('info', `${tag} 🌅 spawn 事件 · ${snapshotMovements(bot.pathfinder)}`);
  const onRespawn = () => log('info', `${tag} ♻ respawn 事件 · ${snapshotMovements(bot.pathfinder)}`);
  const onDeath = () => log('warn', `${tag} 💀 death 事件 · ${snapshotMovements(bot.pathfinder)}`);
  const onLogin = () => log('info', `${tag} 🔑 login 事件 · ${snapshotMovements(bot.pathfinder)}`);
  bot.on('spawn', onSpawn);
  bot.on('respawn', onRespawn);
  bot.on('death', onDeath);
  bot.on('login', onLogin);

  // ── 卸载 ───────────────────────────────────────────────────────────────
  return () => {
    (bot as { dig: typeof bot.dig }).dig = originalDig;
    uninstallSetMovements?.();
    uninstallGoto?.();
    bot.removeListener('spawn', onSpawn);
    bot.removeListener('respawn', onRespawn);
    bot.removeListener('death', onDeath);
    bot.removeListener('login', onLogin);
    log('info', `${tag} 已卸载`);
  };
}
