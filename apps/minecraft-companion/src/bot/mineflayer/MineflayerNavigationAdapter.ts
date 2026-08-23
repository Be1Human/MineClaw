/**
 * MineflayerNavigationAdapter —— NavigationAdapter 的 mineflayer-pathfinder 实现
 *
 * 封装了：
 * - Goal 类型构造（GoalNear / GoalFollow）
 * - Movements 配置
 * - pathfinder 事件（'goal_reached' / 'path_update' / 'goal_updated' / 'path_stop'）
 *
 * 上层的 smartGoto / smartFollow / navigationRouter 应该重构为依赖此 adapter，
 * 不再直接 import mineflayer-pathfinder。
 */

import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
type PathfinderGoal = InstanceType<typeof goals.GoalNear>;
import type { Vec3 as MFVec3 } from 'vec3';
import vec3pkg from 'vec3';
const Vec3Ctor = (vec3pkg as unknown as { Vec3: new (x: number, y: number, z: number) => MFVec3 }).Vec3
  ?? (vec3pkg as unknown as new (x: number, y: number, z: number) => MFVec3);

import type {
  NavigationAdapter,
  NavGoal,
  GotoOptions,
  DoorPassageRequest,
} from '../adapter/NavigationAdapter.js';
import type {
  Vec3,
  MovementOptions,
  NavResult,
  Unsubscribe,
} from '../adapter/types.js';
import { DoorTransparentMovements } from './doorTransparentMovements.js';
import { BotSubscriptionRegistry } from './botSubscriptionRegistry.js';
import {
  computeDoorAlignmentTarget,
  computeDoorPassageTarget,
  hasCrossedDoorPlane,
  isOrdinaryDoor,
} from './doorPassageGeometry.js';

type BotGetter = () => Bot | null;
type LogFn = (msg: string) => void;

interface DoorPassageTransaction {
  gotoRunId: number | null;
  promise: Promise<NavResult>;
  settle: (result: NavResult) => void;
  cancelled: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  wake: (() => void) | null;
}

export class MineflayerNavigationAdapter implements NavigationAdapter {
  private readonly subscriptions = new BotSubscriptionRegistry<Bot>();
  private currentGoal: NavGoal | null = null;
  /** BUG-L5-01 · 当前持续跟随的实体 id（null=未在跟随）· startFollow/stopFollow 维护 */
  private followingEntityId: number | null = null;
  private readonly log: LogFn;

  /**
   * 路径缓存 —— 通过监听 path_update / path_reset / path_stop 事件维护。
   * mineflayer-pathfinder 的 path 是闭包变量，不暴露到 bot.pathfinder 上，
   * 所以 getCurrentPath() 必须从事件缓存中读取。
   */
  private cachedPath: Vec3[] = [];
  private pathListenersAttached = false;
  /** 每个 goto 的身份；外部 stop/新 goto 递增后，旧门通行不得恢复旧目标。 */
  private gotoRunId = 0;
  private activeGotoRunId: number | null = null;
  /** 当前内部门通行事务。必须先登记再 pf.stop，供 goto 区分内部暂停与外部取消。 */
  private pendingPassage: DoorPassageTransaction | null = null;

  constructor(
    private readonly getBot: BotGetter,
    onLog?: LogFn,
    private readonly doorControlTickMs = 50,
  ) {
    this.log = onLog ?? ((msg) => console.log(msg));
  }

  /** Called by MineflayerConnection whenever the concrete Bot generation changes. */
  rebindSubscriptions(bot: Bot | null): void {
    this.subscriptions.rebind(bot);
  }

  /**
   * 挂载 path 事件监听（首次调用 goto / setMovementOptions 时触发）。
   * 重复调用安全（幂等）。
   */
  private attachPathListeners(): void {
    if (this.pathListenersAttached) return;
    const bot = this.getBot();
    if (!bot) return;
    this.pathListenersAttached = true;

    // path_update: 新路径产生
    this.subscriptions.subscribe(bot, 'path_update', (r: unknown) => {
      const result = r as { path?: Array<{ x: number; y: number; z: number }> };
      this.cachedPath = (result?.path ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    });
    // path_reset: pathfinder 重置路径（但目标仍在，会重算）
    this.subscriptions.subscribe(bot, 'path_reset', () => { this.cachedPath = []; });
    // path_stop: 导航结束
    this.subscriptions.subscribe(bot, 'path_stop', () => { this.cachedPath = []; });
  }

  async goto(goal: NavGoal, opts?: GotoOptions): Promise<NavResult> {
    this.attachPathListeners();
    const bot = this.getBot();
    if (!bot) return { ok: false, reason: 'disconnected' };
    const pf = bot.pathfinder;
    if (!pf) return { ok: false, reason: 'pathfinder_not_loaded' };

    if (opts?.thinkTimeout != null) (pf as unknown as { thinkTimeout: number }).thinkTimeout = opts.thinkTimeout;
    if (opts?.tickTimeout != null) (pf as unknown as { tickTimeout: number }).tickTimeout = opts.tickTimeout;

    const mfGoal = this.buildGoal(bot, goal);
    if (!mfGoal) return { ok: false, reason: 'invalid_goal' };

    this.cancelPendingPassage();
    const runId = ++this.gotoRunId;
    this.activeGotoRunId = runId;
    this.currentGoal = goal;
    // 一次性 goto 会覆盖跟随的动态目标 → 同步清跟随态，避免 isFollowing 误报
    this.followingEntityId = null;

    const totalTimeout = opts?.totalTimeout ?? 30_000;
    const deadline = Date.now() + totalTimeout;

    try {
      while (runId === this.gotoRunId) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          try { pf.stop(); } catch { /* ignore */ }
          this.log(`[nav] goto timeout after ${totalTimeout}ms · goal=${JSON.stringify(goal)}`);
          return { ok: false, reason: 'nav_timeout' };
        }

        this.currentGoal = goal;
        try {
          await this.runPathfinderGoto(pf, mfGoal as PathfinderGoal, remaining);
          return { ok: true };
        } catch (err) {
          const passage = this.pendingPassage;
          if (passage?.gotoRunId === runId) {
            const result = await passage.promise;
            if (this.pendingPassage === passage) this.pendingPassage = null;
            if (!result.ok) return result;
            if (runId !== this.gotoRunId) return { ok: false, reason: 'cancelled' };
            this.log(`[nav] door passage completed · resume goal=${JSON.stringify(goal)}`);
            continue;
          }

          const msg = (err as Error)?.message ?? 'unknown';
          if (msg === 'nav_timeout') {
            try { pf.stop(); } catch { /* ignore */ }
            this.log(`[nav] goto timeout after ${totalTimeout}ms · goal=${JSON.stringify(goal)}`);
            return { ok: false, reason: 'nav_timeout' };
          }
          if (msg.includes('GoalChanged') || msg.includes('PathStopped')) {
            return { ok: false, reason: 'cancelled' };
          }
          return { ok: false, reason: msg };
        }
      }
      return { ok: false, reason: 'cancelled' };
    } finally {
      if (this.activeGotoRunId === runId) this.activeGotoRunId = null;
      if (runId === this.gotoRunId) this.currentGoal = null;
    }
  }

  async guideThroughDoor(request: DoorPassageRequest): Promise<NavResult> {
    if (!isOrdinaryDoor(request.blockName)) {
      return { ok: false, reason: 'unsupported_door_geometry' };
    }
    if (this.pendingPassage) return this.pendingPassage.promise;

    const bot = this.getBot();
    const pf = bot?.pathfinder;
    if (!bot || !pf) return { ok: false, reason: bot ? 'pathfinder_not_loaded' : 'disconnected' };

    const followEntityId = this.followingEntityId;
    const followGoal = this.currentGoal?.type === 'follow_entity' ? this.currentGoal : null;
    if (this.activeGotoRunId == null && followEntityId == null) {
      return { ok: false, reason: 'no_active_navigation' };
    }

    const from = toNeutralVec(bot.entity.position);
    const alignmentTarget = computeDoorAlignmentTarget(request, from);
    const target = computeDoorPassageTarget(request, from);
    if (!alignmentTarget || !target) return { ok: false, reason: 'invalid_door_geometry' };

    let resolvePromise!: (result: NavResult) => void;
    const promise = new Promise<NavResult>((resolve) => { resolvePromise = resolve; });
    const transaction: DoorPassageTransaction = {
      gotoRunId: this.activeGotoRunId,
      promise,
      settle: () => {},
      cancelled: false,
      settled: false,
      timer: null,
      wake: null,
    };
    transaction.settle = (result) => {
      if (transaction.settled) return;
      transaction.settled = true;
      resolvePromise(result);
    };
    this.pendingPassage = transaction;

    void this.performDoorPassage(transaction, request, from, alignmentTarget, target, followEntityId, followGoal)
      .then(result => transaction.settle(result))
      .catch(err => transaction.settle({ ok: false, reason: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        // 阻塞式 goto 需要自己消费事务后再清；动态 follow 没有等待者，由这里释放。
        if (transaction.gotoRunId == null && this.pendingPassage === transaction) {
          this.pendingPassage = null;
        }
      });

    return promise;
  }

  stop(): void {
    const hadActiveGoto = this.activeGotoRunId != null;
    const hadFollow = this.followingEntityId != null || this.currentGoal?.type === 'follow_entity';
    const hadStaticGoal = this.currentGoal != null && this.currentGoal.type !== 'follow_entity';
    ++this.gotoRunId;
    this.activeGotoRunId = null;
    this.cancelPendingPassage();
    const pf = this.getBot()?.pathfinder;
    if (pf) {
      if (hadFollow) {
        try { (pf as unknown as { setGoal(goal: unknown | null): void }).setGoal(null); } catch { /* ignore */ }
      } else if (hadActiveGoto || hadStaticGoal || (pf.isMoving?.() ?? false)) {
        try { pf.stop(); } catch { /* ignore */ }
      }
    }
    this.currentGoal = null;
    this.followingEntityId = null;
  }

  // ── BUG-L5-01 · 持续跟随（动态目标）─────────────────────────────
  // 核心修复：跟随不再走 goto() 的一次性阻塞 + 30s 超时模型，而是 setGoal(GoalFollow, dynamic=true)
  // 设一次、pathfinder 后台持续驱动。进 range 自停、entity 动自追、永不假超时。

  startFollow(entityId: number, range: number, force = false): { ok: boolean; reason?: string } {
    this.attachPathListeners();
    const bot = this.getBot();
    if (!bot) return { ok: false, reason: 'disconnected' };
    const pf = bot.pathfinder;
    if (!pf) return { ok: false, reason: 'pathfinder_not_loaded' };
    // 幂等：已在跟同一实体 → 不重设（避免每 tick setGoal 抖动 pathfinder）。
    // BUG-L5-02：force=true（主人挪动够多）时重设 GoalFollow，打断 pathfinder 懒重算立即朝新位置规划。
    if (!force && this.followingEntityId === entityId && this.isMoving()) return { ok: true };
    const e = bot.entities[entityId];
    if (!e) return { ok: false, reason: 'entity_not_found' };
    // 第二参 dynamic=true：pathfinder 监控 entity 移动、持续增量重算
    (pf as unknown as { setGoal(goal: unknown, dynamic?: boolean): void })
      .setGoal(new goals.GoalFollow(e, range), true);
    this.followingEntityId = entityId;
    this.currentGoal = { type: 'follow_entity', entityId, range };
    return { ok: true };
  }

  stopFollow(): void {
    if (this.followingEntityId == null && this.currentGoal?.type !== 'follow_entity') return;
    this.followingEntityId = null;
    const pf = this.getBot()?.pathfinder;
    if (!pf) return;
    try { (pf as unknown as { setGoal(goal: unknown | null): void }).setGoal(null); } catch { /* ignore */ }
    if (this.currentGoal?.type === 'follow_entity') this.currentGoal = null;
  }

  isFollowing(entityId?: number): boolean {
    if (this.followingEntityId == null) return false;
    return entityId == null || entityId === this.followingEntityId;
  }

  isMoving(): boolean {
    return this.getBot()?.pathfinder?.isMoving?.() ?? false;
  }
  isMining(): boolean {
    const pf = this.getBot()?.pathfinder as unknown as { isMining?: () => boolean } | undefined;
    return pf?.isMining?.() ?? false;
  }
  isBuilding(): boolean {
    const pf = this.getBot()?.pathfinder as unknown as { isBuilding?: () => boolean } | undefined;
    return pf?.isBuilding?.() ?? false;
  }

  setMovementOptions(opts: MovementOptions): void {
    this.attachPathListeners();
    const bot = this.getBot();
    if (!bot) return;
    // DoorTransparentMovements 只让 A* 把木门视为可通行；物理开门由 DoorMonitor 独占，
    // 避免 pathfinder 与 DoorMonitor 重复点击。调用方仍负责显式设置 canDig 安全默认值。
    const mvs = new DoorTransparentMovements(bot);
    if (opts.canDig != null) mvs.canDig = opts.canDig;
    if (opts.canOpenDoors != null) {
      (mvs as unknown as { canOpenDoors: boolean }).canOpenDoors = opts.canOpenDoors;
    }

    if (opts.allowParkour != null) mvs.allowParkour = opts.allowParkour;
    if (opts.allowSprinting != null) mvs.allowSprinting = opts.allowSprinting;
    // canPlace 在 mineflayer-pathfinder 里没有顶层开关，靠 scafoldingBlocks 是否空
    if (opts.canPlace === false) mvs.scafoldingBlocks = [];
    if (opts.scafoldingBlocks) {
      const ids = nameListToIds(bot, opts.scafoldingBlocks);
      mvs.scafoldingBlocks = ids;
    }
    if (opts.allowedDigBlocks) {
      const set = new Set(nameListToIds(bot, opts.allowedDigBlocks));
      // pathfinder Movements 没有"白名单"开关，转换为 blocksCantBreak 的反向：保留默认 blocksCantBreak 不动
      // 用户若给白名单，只把不在白名单的常见方块塞进 blocksCantBreak
      // 这里只做一个保守实现：忽略，避免改变 pathfinder 默认行为
      void set;
    }
    if (opts.blocksToAvoid) {
      const ids = nameListToIds(bot, opts.blocksToAvoid);
      ids.forEach((id) => mvs.blocksToAvoid.add(id));
    }
    const mvsAny2 = mvs as unknown as { openable?: Set<number> };
    this.log(`[setMovements] openable.size=${mvsAny2.openable?.size ?? '?'} canDig=${mvs.canDig} canOpenDoors=${(mvs as unknown as { canOpenDoors?: boolean }).canOpenDoors ?? '?'}`);
    bot.pathfinder.setMovements(mvs);
  }

  getCurrentGoal(): NavGoal | null {
    return this.currentGoal;
  }
  getCurrentPath(): Vec3[] {
    return this.cachedPath;
  }

  // ── 事件 ──────────────────────────────────────────────
  onGoalReached(handler: () => void): Unsubscribe {
    return this.subscriptions.subscribe(this.getBot(), 'goal_reached', () => {
      this.currentGoal = null;
      handler();
    });
  }
  onPathUpdate(handler: (path: Vec3[]) => void): Unsubscribe {
    return this.subscriptions.subscribe(this.getBot(), 'path_update', (r: unknown) => {
      const result = r as { path?: Array<{ x: number; y: number; z: number }> };
      const path = (result?.path ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z }));
      handler(path);
    });
  }
  onPathStop(handler: (reason: string) => void): Unsubscribe {
    return this.subscriptions.subscribe(this.getBot(), 'path_stop', (reason: unknown) => {
      // 门通行的内部暂停不会终止外层目标。
      if (!this.pendingPassage) this.currentGoal = null;
      handler(String(reason ?? 'unknown'));
    });
  }
  onGoalUpdated(handler: (goal: NavGoal | null) => void): Unsubscribe {
    return this.subscriptions.subscribe(this.getBot(), 'goal_updated', () => {
      handler(this.currentGoal);
    });
  }

  // ── 内部 ──────────────────────────────────────────────
  private buildGoal(bot: Bot, goal: NavGoal): object | null {
    switch (goal.type) {
      case 'block': {
        const range = goal.range ?? 1;
        return new goals.GoalNear(goal.position.x, goal.position.y, goal.position.z, range);
      }
      case 'entity': {
        const e = bot.entities[goal.entityId];
        if (!e) return null;
        const range = goal.range ?? 2;
        const p = e.position;
        return new goals.GoalNear(p.x, p.y, p.z, range);
      }
      case 'player': {
        const p = (bot.players[goal.username] as { entity?: { position: MFVec3 } } | undefined)?.entity;
        if (!p) return null;
        const range = goal.range ?? 2;
        return new goals.GoalNear(p.position.x, p.position.y, p.position.z, range);
      }
      case 'follow_entity': {
        const e = bot.entities[goal.entityId];
        if (!e) return null;
        return new goals.GoalFollow(e, goal.range);
      }
      case 'xz': {
        // GoalXZ：到达该 X/Z 列（任意 Y）· 长距离地表转移，pathfinder 真实穿越地形
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const G = (goals as any).GoalXZ;
        if (G) return new G(goal.x, goal.z);
        // 退化：老版 pathfinder 无 GoalXZ → 用大 range 的 GoalNear 近似
        return new goals.GoalNear(goal.x, bot.entity?.position?.y ?? 64, goal.z, 2);
      }
      default:
        return null;
    }
  }

  private runPathfinderGoto(
    pf: Bot['pathfinder'],
    goal: PathfinderGoal,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('nav_timeout')), timeoutMs);
      pf.goto(goal)
        .then(() => { clearTimeout(timer); resolve(); })
        .catch((err: unknown) => { clearTimeout(timer); reject(err); });
    });
  }

  private async performDoorPassage(
    transaction: DoorPassageTransaction,
    request: DoorPassageRequest,
    from: Vec3,
    alignmentTarget: Vec3,
    target: Vec3,
    followEntityId: number | null,
    followGoal: Extract<NavGoal, { type: 'follow_entity' }> | null,
  ): Promise<NavResult> {
    const bot = this.getBot();
    const pf = bot?.pathfinder;
    if (!bot || !pf) return { ok: false, reason: 'disconnected' };

    this.log(`[nav] door passage start · door=${request.blockName}@${request.position.x}:${request.position.y}:${request.position.z} align=${alignmentTarget.x.toFixed(2)},${alignmentTarget.z.toFixed(2)} exit=${target.x.toFixed(2)},${target.z.toFixed(2)}`);
    try {
      // pf.stop() 只是设置 stopPathing 标志；真正 path_stop/fullStop 在下一次 physicsTick。
      // 必须等 fullStop 清键完成后再按 forward，否则下一 tick 会立刻吃掉门通行控制键。
      await this.stopPathfinderForPassage(bot, pf);
      if (transaction.cancelled) return { ok: false, reason: 'cancelled' };

      const aligned = await this.driveToward(
        transaction,
        bot,
        alignmentTarget,
        900,
        () => horizontalDistance(toNeutralVec(bot.entity.position), alignmentTarget) <= 0.10,
        true,
      );
      if (!aligned) return { ok: false, reason: transaction.cancelled ? 'cancelled' : 'door_passage_alignment_failed' };

      const crossed = await this.driveToward(
        transaction,
        bot,
        target,
        1_800,
        () => hasCrossedDoorPlane(request, from, toNeutralVec(bot.entity.position)),
        false,
      );
      if (!crossed) return { ok: false, reason: transaction.cancelled ? 'cancelled' : 'door_passage_not_crossed' };

      const after = toNeutralVec(bot.entity.position);
      if (!hasCrossedDoorPlane(request, from, after)) {
        this.log(`[nav] door passage failed · from=${from.x.toFixed(2)},${from.z.toFixed(2)} after=${after.x.toFixed(2)},${after.z.toFixed(2)}`);
        return { ok: false, reason: 'door_passage_not_crossed' };
      }

      // 动态 follow 没有阻塞式 goto 循环，穿门后在适配器内部恢复动态目标。
      if (transaction.gotoRunId == null && followEntityId != null && followGoal) {
        const resumed = this.startFollow(followEntityId, followGoal.range, true);
        if (!resumed.ok) return { ok: false, reason: resumed.reason ?? 'follow_resume_failed' };
      }
      return { ok: true };
    } finally {
      try { bot.setControlState('forward', false); } catch { /* ignore */ }
      try { bot.setControlState('sneak', false); } catch { /* ignore */ }
      try { bot.clearControlStates(); } catch { /* ignore */ }
    }
  }

  private async driveToward(
    transaction: DoorPassageTransaction,
    bot: Bot,
    target: Vec3,
    timeoutMs: number,
    reached: () => boolean,
    precise: boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!transaction.cancelled && Date.now() < deadline) {
      if (reached()) return true;
      await bot.lookAt(new Vec3Ctor(target.x, target.y, target.z), true);
      bot.setControlState('sneak', precise);
      bot.setControlState('forward', true);
      await this.waitForPassage(transaction, this.doorControlTickMs);
    }
    return !transaction.cancelled && reached();
  }

  private waitForPassage(transaction: DoorPassageTransaction, ms: number): Promise<void> {
    return new Promise(resolve => {
      const wake = () => {
        if (transaction.timer) clearTimeout(transaction.timer);
        transaction.timer = null;
        transaction.wake = null;
        resolve();
      };
      transaction.wake = wake;
      transaction.timer = setTimeout(wake, ms);
    });
  }

  private stopPathfinderForPassage(bot: Bot, pf: Bot['pathfinder']): Promise<void> {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { bot.removeListener('path_stop', finish); } catch { /* ignore */ }
        resolve();
      };
      const timer = setTimeout(finish, 500);
      bot.once('path_stop', finish);
      pf.stop();
      // mineflayer-pathfinder 只在到达 nextPoint 时消费 stopPathing；卡在门板前永远到不了。
      // setGoal(null) 会立即进入 resetPath，因 stopPathing=true 再同步执行 stop/fullStop。
      try { pf.setGoal(null); } catch { /* 500ms 超时兜底 */ }
    });
  }

  private cancelPendingPassage(): void {
    const transaction = this.pendingPassage;
    if (!transaction) return;
    transaction.cancelled = true;
    transaction.wake?.();
    try { this.getBot()?.clearControlStates(); } catch { /* ignore */ }
    transaction.settle({ ok: false, reason: 'cancelled' });
    this.pendingPassage = null;
  }
}

// ─── 内部工具 ─────────────────────────────────────────────

function nameListToIds(bot: Bot, names: string[]): number[] {
  const out: number[] = [];
  for (const n of names) {
    const def = bot.registry.blocksByName[n];
    if (def) out.push(def.id);
  }
  return out;
}

function toNeutralVec(pos: { x: number; y: number; z: number }): Vec3 {
  return { x: pos.x, y: pos.y, z: pos.z };
}

function horizontalDistance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

// 让"未使用导入"通过
void Vec3Ctor;
