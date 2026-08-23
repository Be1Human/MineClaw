/**
 * 🪜 EscapeStrategy · 脱困自救（每 tick 监控，仅生存之下、任务之上）
 *
 * 解决"挖地材料后困在自己挖的坑里出不来 / 掉进洞里走不动"——像人一样自己爬出来。
 * 每 tick 检查：原地不动很久(3D 位移≈0) + 被墙围(头顶四向≥3 面实心) → 判定被困，
 * 发 escape_pit 抢占当前低优任务：
 *   ① 背包有方块 → 垫脚爬出
 *   ② 没方块 → 挖墙突围
 *   ③ 试多次仍出不去 → 求助主人（长冷却，不刷屏）
 *
 * 优先级 92：低于生存(flee 96 / fight 98，危险时先保命)，高于采集/合成(30)。
 * 被困优先脱困——困在坑里啥也干不了。脱困后位移恢复 → 本策略静默 → 任务自然继续。
 *
 * 注：用 3D 位移判定"卡住"，竖直下挖时 Y 在变 → 不误判为卡住、不打断正常采集。
 */

import type { IStrategy, StrategyContext, StrategyInspect } from './types.js';
import type { ActionRequest } from '../types.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { Vec3 } from '../../adapter/types.js';
import type { TaskRuntime } from '../task/taskRuntime.js';
import { tuning } from '../infra/tuning.js';
import { isTrappedInPit } from '../navigation/pitGeometry.js';


export class EscapeStrategy implements IStrategy {
  readonly id = 'escape_strategy';
  readonly kind = 'reflex' as const;

  private seq = 0;
  private lastPos: Vec3 | null = null;
  private stuckTicks = 0;
  private attempts = 0;
  private cooldownUntilTick = 0;
  private lastMode = 'idle';

  /** FEAT-CROSS-05 · 当前驱动中的紧急任务 id（escape_pit）· null=未在脱困 */
  private escapeTaskId: string | null = null;

  constructor(
    private readonly game: GameAdapter,
    /** FEAT-CROSS-05 · 反射必须先注册紧急任务再执行 */
    private readonly tasks: TaskRuntime,
  ) {}

  /** FEAT-CROSS-05 · 永远参与（既检测要不要起紧急任务，也驱动已起的紧急任务） */
  isActive(_ctx: StrategyContext): boolean {
    return true;
  }

  tick(ctx: StrategyContext): ActionRequest[] {
    const p = ctx.world.self.position;
    const cfg = tuning().escape;

    // 高优反射会暂时抢占 escape 任务。TaskRuntime 在抢占者结束后会恢复
    // 原任务；此时重新认领已恢复的任务，不能再创建一条同类 emergency。
    if (!this.escapeTaskId && ctx.activeTaskId && (ctx.activeTaskKind === 'escape_pit' || ctx.activeTaskKind === 'lava_escape')) {
      this.escapeTaskId = ctx.activeTaskId;
    }

    // ── A. 正在驱动紧急任务（escape_pit / lava_escape）─────────────────────────
    if (this.escapeTaskId) {
      // 任务已不是当前 active（被取消/抢占/已终态）→ 放手
      if (ctx.activeTaskId !== this.escapeTaskId) {
        this.escapeTaskId = null;
        // 被高优任务抢占时等待 TaskRuntime 恢复原任务，避免同 tick 重复注册。
        return [];
      }
      else return this.driveEscape(ctx, p, ctx.activeTaskId, ctx.activeTaskKind ?? '');
    }

    // ── B. 检测 · 位移累计"卡住"计数（含 Y：下挖时 Y 变 → 不算卡住）──────────────
    if (this.lastPos) {
      const moved = Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y, p.z - this.lastPos.z);
      if (moved < cfg.stuckDistance) this.stuckTicks++;
      else { this.stuckTicks = 0; this.attempts = 0; }
    }
    this.lastPos = { x: p.x, y: p.y, z: p.z };

    // ── C. 岩浆/火 → 注册 lava_escape 紧急任务（最高优先·无冷却）─────────────────
    if (this.lavaEscapeDir(p)) {
      this.attempts = 0;
      this.escapeTaskId = this.registerEmergency('lava_escape', {}, cfg.lavaPriority);
      this.lastMode = 'lava_detect';
      return [];   // 下一 tick 进 A 分支驱动
    }

    // ── D. 被困 → 注册 escape_pit 紧急任务 ────────────────────────────────────
    if (ctx.tick < this.cooldownUntilTick) { this.lastMode = 'cooldown'; return []; }
    if (this.stuckTicks < cfg.stuckTicks) { this.lastMode = 'idle'; return []; }
    if (!ctx.world.self.isOnGround) { this.lastMode = 'airborne'; return []; }
    // 真被困才脱困：四向都走不出去（关门/可走出口都算"能出去"）才算坑
    if (!this.inPit(p)) { this.stuckTicks = 0; this.lastMode = 'free'; return []; }

    this.stuckTicks = 0;
    this.attempts = 1;
    this.cooldownUntilTick = ctx.tick + cfg.retryCooldownTicks;
    this.escapeTaskId = this.registerEmergency('escape_pit', {}, cfg.pitPriority);
    this.lastMode = 'escape_register';
    return [];   // 下一 tick 进 A 分支驱动
  }

  /** 注册并启动一个紧急任务（抢占当前任务 + 入栈 active）· 返回 taskId */
  private registerEmergency(kind: string, params: Record<string, unknown>, priority: number): string {
    const t = this.tasks.createTask(kind, params, { priority });
    this.tasks.startEmergency(t.id);
    return t.id;
  }

  /** 驱动当前紧急任务：脱困成功 → complete；失败 → fail；否则发带 taskId 的执行请求 */
  private driveEscape(ctx: StrategyContext, p: Vec3, taskId: string, kind: string): ActionRequest[] {
    const cfg = tuning().escape;
    if (kind === 'lava_escape') {
      const dir = this.lavaEscapeDir(p);
      if (!dir) { this.tasks.complete(taskId); this.escapeTaskId = null; this.lastMode = 'lava_done'; return []; }
      return [{
        id: `${this.id}-lavaesc-${ctx.tick}-${++this.seq}`,
        source: `${this.id}.lava_escape`, taskId,
        type: 'walk', priority: cfg.lavaPriority, interrupt_level: 'hard', resource: ['movement'],
        target: { position: { x: dir.x, y: p.y, z: dir.z }, durationMs: cfg.lavaWalkMs },
        preconditions: [], expected_effect: ['escaped_lava'], timeout_ms: 3000,
      }];
    }
    // escape_pit
    if (!this.inPit(p)) { this.tasks.complete(taskId); this.escapeTaskId = null; this.lastMode = 'escaped'; return []; }
    if (this.attempts >= cfg.maxAttempts) {
      this.attempts = 0;
      this.cooldownUntilTick = ctx.tick + cfg.helpCooldownTicks;
      this.tasks.fail(taskId, { code: 'unreachable', detail: '多次脱困仍出不去' });
      this.escapeTaskId = null;
      ctx.narrate?.({ source: 'survival', topic: 'pit_help', urgency: 72, dedupeKey: 'pit_help' });
      this.lastMode = 'stuck_help';
      return [];
    }
    if (ctx.tick >= this.cooldownUntilTick) {
      this.attempts++;
      this.cooldownUntilTick = ctx.tick + cfg.retryCooldownTicks;
    }
    this.lastMode = `escaping(${this.attempts})`;
    return [this.escapeReq(ctx, taskId)];
  }

  reset(): void {
    this.seq = 0;
    this.lastPos = null;
    this.stuckTicks = 0;
    this.attempts = 0;
    this.cooldownUntilTick = 0;
    this.lastMode = 'idle';
  }

  inspect(): StrategyInspect {
    return { kind: 'reflex', view: { mode: this.lastMode, stuckTicks: this.stuckTicks, attempts: this.attempts } };
  }

  // ── 内部 ──────────────────────────────────────────

  /** 脚下/脚位是岩浆火 → 返回最近安全方向的逃离航点；否则 null */
  private lavaEscapeDir(pos: Vec3): { x: number; z: number } | null {
    const HAZARD = /lava|fire|magma/;
    const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
    const here = this.game.getBlockAt({ x: fx, y: fy, z: fz });
    const below = this.game.getBlockAt({ x: fx, y: fy - 1, z: fz });
    const inHazard = (!!here && HAZARD.test(here.name)) || (!!below && HAZARD.test(below.name));
    if (!inHazard) return null;
    // 优先：相邻脚位空 + 其下实心非岩浆（站得稳的安全地）
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const foot = this.game.getBlockAt({ x: fx + dx, y: fy, z: fz + dz });
      const fb = this.game.getBlockAt({ x: fx + dx, y: fy - 1, z: fz + dz });
      const footOk = !foot || (foot.boundingBox === 'empty' && !HAZARD.test(foot.name));
      const groundOk = !!fb && fb.boundingBox === 'block' && !HAZARD.test(fb.name);
      if (footOk && groundOk) return { x: pos.x + dx * 3, z: pos.z + dz * 3 };
    }
    // 退化：任意非岩浆方向冲出去
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const foot = this.game.getBlockAt({ x: fx + dx, y: fy, z: fz + dz });
      if (!foot || !HAZARD.test(foot.name)) return { x: pos.x + dx * 3, z: pos.z + dz * 3 };
    }
    return null;
  }

  /**
   * 被困判定（FEAT-CROSS-05 修正 v2）：四向**都走不出去**才算真坑。
   * 任一方向能出去 → 不是坑。一个方向「能出去」需满足脚位+头位都通畅，且：
   *   ① 同层脚下有实心地 → 平走出去；或
   *   ② 同层无地但安全落差内有地 → 跳下去出去（**独柱顶/台阶边不是坑**，根治 escape
   *      把自己越垫越高→站塔顶却判被困→无限垫高的自激发死循环）。
   * 关门 boundingBox=block 但可开(isDoorBlock) → 算通畅，迷宫走廊/关门不误判为坑。
   */
  private inPit(pos: Vec3): boolean {
    return isTrappedInPit(this.game, pos, { safeDrop: tuning().escape.safeDrop });
  }

  /** escape_pit 执行请求（带 taskId 背书 · FEAT-CROSS-05） */
  private escapeReq(ctx: StrategyContext, taskId: string): ActionRequest {
    const priority = tuning().escape.pitPriority;
    return {
      id: `${this.id}-escape-${ctx.tick}-${++this.seq}`,
      source: `${this.id}.escape`,
      taskId,
      type: 'escape_pit',
      priority,
      interrupt_level: 'hard',
      resource: ['movement', 'inventory'],
      target: {},
      preconditions: [],
      expected_effect: ['escaped_pit'],
      timeout_ms: 14000,
    };
  }

}
