/**
 * 📋 GotoStrategy · 任务驱动 · 走到一个固定坐标后停下（终态任务）
 *
 * kind = 'goto_position'   params: { targetPosition: {x,y,z} (或别名 position) }
 *
 * 立项背景（FEAT-L7-12 / GYM-BUG-04）：
 *   原子层 moveTo（atomics.ts）一直支持走任意坐标，但任务层只有 follow_owner，
 *   而 follow_owner 仅在 owner 不可见的 seeking 态才认 targetPosition——owner 就在
 *   旁边时它只追主人。于是"走到金块那里"（locate_block 已能返回坐标）拿到坐标后
 *   没有任何任务能把 bot 带过去。本策略补这个洞：薄壳——收 targetPosition、每 tick
 *   发一条 goto_position 原子、到达 ≤arriveDist 即 complete。底层寻路不重写。
 *
 * 每 tick：
 *   1. 取 targetPosition；缺失 → fail(invalid_input)
 *   2. 水平距 ≤ tuning().goto.arriveDist → complete（终态 · 非持续）
 *   3. 长时间离目标不缩短（stall 看门狗）→ fail（防够不到/无路死循环）
 *   4. 否则发 goto_position 原子前往
 *
 * 参数全部走 tuning()（铁律：不硬编码 · 改 data/tuning.json 即时生效）。
 */

import type { IStrategy, StrategyContext, StrategyInspect } from './types.js';
import type { ActionRequest } from '../types.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { TaskRuntime } from '../task/taskRuntime.js';
import { tuning } from '../infra/tuning.js';

type Vec3Like = { x: number; y: number; z: number };

export class GotoStrategy implements IStrategy {
  readonly id = 'goto_strategy';
  readonly kind = 'fsm' as const;

  private seq = 0;
  private sinceTick = 0;
  private lastTaskId = '';
  private lastPhase = 'idle';

  // 无进展看门狗：记录历史最近距离 + 上次缩短的 tick
  private bestDist = Infinity;
  private lastProgressTick = 0;

  constructor(
    private readonly bus: EventBusV2,
    private readonly tasks: TaskRuntime,
  ) {}

  isActive(ctx: StrategyContext): boolean {
    return ctx.activeTaskKind === 'goto_position';
  }

  tick(ctx: StrategyContext): ActionRequest[] {
    const t = this.tasks.active();
    if (!t || t.kind !== 'goto_position') return [];

    // 新任务（task.id 变了）→ 重置 per-task 追踪
    if (t.id !== this.lastTaskId) {
      this.lastTaskId = t.id;
      this.sinceTick = ctx.tick;
      this.lastProgressTick = ctx.tick;
      this.bestDist = Infinity;
      this.lastPhase = 'idle';
    }

    const cfg = tuning().goto;
    const me = ctx.world.self.position;

    // 1) 取目标坐标（targetPosition 优先 · position 别名兜底）· 缺 y 用 bot 当前 y
    const tp = this.resolveTarget(t.params, me.y);
    if (!tp) {
      this.lastPhase = 'no_target';
      this.tasks.fail(t.id, { code: 'start_failed', detail: 'goto_position 缺 targetPosition' });
      return [];
    }

    const dx = tp.x - me.x;
    const dz = tp.z - me.z;
    const dist = Math.sqrt(dx * dx + dz * dz); // 水平距（y 由寻路自行处理）

    // 任务进度（WebUI 任务树展示 dist/arriveDist）
    t.progress = { ...(t.progress ?? {}), dist: Math.round(dist), arriveDist: cfg.arriveDist };
    // FEAT-WEBUI-08 · 当前动作（NPC 行为）
    ctx.setPhase?.(dist <= cfg.arriveDist ? '已抵达' : `寻路前往 · 剩 ${Math.round(dist)} 格`);

    // 2) 到达 → 完成（终态）
    if (dist <= cfg.arriveDist) {
      this.lastPhase = 'arrived';
      this.bus.publish('goto.arrived', 'info', { taskId: t.id, target: tp, dist: Math.round(dist) });
      this.tasks.complete(t.id);
      return [];
    }

    // 3) 无进展看门狗：距离持续不缩短（够不到/无路）→ fail，不死循环
    if (dist < this.bestDist - 0.5) {
      this.bestDist = dist;
      this.lastProgressTick = ctx.tick;
    } else if (ctx.tick - this.lastProgressTick > cfg.stallTicks) {
      this.lastPhase = 'stall';
      this.tasks.fail(t.id, { code: 'unreachable', detail: `走向坐标长时间无进展（仍差 ${Math.round(dist)} 格）` });
      return [];
    }

    // 4) 继续前往
    this.lastPhase = 'moving';
    return [{
      id: `${this.id}-${ctx.tick}-${++this.seq}`,
      source: this.id,
      type: 'goto_position',
      priority: 40, // owner_command 档（与 follow 同级）
      interrupt_level: 'soft',
      resource: ['movement'],
      target: { position: { x: tp.x, y: tp.y, z: tp.z } },
      preconditions: [],
      expected_effect: ['closer_to_target'],
      timeout_ms: cfg.moveTimeoutMs,
    }];
  }

  inspect(): StrategyInspect {
    return {
      kind: this.kind,
      view: { state: this.lastPhase, bestDist: isFinite(this.bestDist) ? Math.round(this.bestDist) : null },
      sinceTick: this.sinceTick,
    };
  }

  reset(): void {
    this.lastTaskId = '';
    this.sinceTick = 0;
    this.lastProgressTick = 0;
    this.bestDist = Infinity;
    this.lastPhase = 'idle';
  }

  /** targetPosition / position 别名归一 · 校验 x/z 齐全 · 缺 y 用 fallbackY（bot 当前 y） */
  private resolveTarget(params: Record<string, unknown> | undefined, fallbackY: number): Vec3Like | null {
    if (!params) return null;
    const raw = (params.targetPosition ?? params.position ?? params.target) as Partial<Vec3Like> | undefined;
    if (!raw || typeof raw.x !== 'number' || typeof raw.z !== 'number') return null;
    return { x: raw.x, y: typeof raw.y === 'number' ? raw.y : fallbackY, z: raw.z };
  }
}
