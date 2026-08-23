/**
 * 📋 FarmStrategy · 任务驱动 · 种田
 *
 * kind = 'fsm'
 *
 * 两种模式（FEAT-L7-05）：
 *   - mode='oneshot'（默认 · 向后兼容）：
 *       plotsDone < plots → 输出 invoke_behavior farm_one_plot
 *       plotsDone >= plots → 返回 [] · Critic 报 success → 任务 complete
 *
 *   - mode='continuous'（FEAT-L7-05）：
 *       phase=planting        (plotsDone < plots)        → invoke_behavior farm_one_plot
 *       phase=waiting_growth  (plotsDone >= plots)       → 扫已撒种格中"已熟"的（撒种 >= growthEstimateSec）→ dig
 *       收割成功（atomic.dig.success source=farm_loop） → plotsDone-- · totalHarvest++ · 自然回 planting 补种
 *
 * 推进 progress 的事件链：
 *   atomic.place_block.success(source=farm_one_plot) → plotsDone++
 *   atomic.dig.success(source=farm_loop)             → plotsDone-- · totalHarvest++
 */

import type { IStrategy, StrategyContext, StrategyInspect } from './types.js';
import type { ActionRequest } from '../types.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { TaskRuntime, FarmTaskParams } from '../task/taskRuntime.js';

type FarmMode = 'oneshot' | 'continuous';
type FarmPhase = 'planting' | 'waiting_growth';

interface PlotMemo {
  pos: { x: number; y: number; z: number };
  plantedAt: number;
}

interface FarmTaskParamsExt extends FarmTaskParams {
  mode?: FarmMode;
  /** continuous 模式下，撒种后多少秒视为"已熟"（MVP 时间近似 · 真实 block age 待 perception 暴露） */
  growthEstimateSec?: number;
}

export class FarmStrategy implements IStrategy {
  readonly id = 'farm_strategy';
  readonly kind = 'fsm' as const;

  private reqSeq = 0;
  private sinceTick = 0;
  /** continuous 模式：每个 farm taskId → 已撒种格列表（用于扫成熟） */
  private knownPlotsByTaskId = new Map<string, PlotMemo[]>();

  constructor(
    private readonly bus: EventBusV2,
    private readonly tasks: TaskRuntime,
  ) {
    // 监听 place_block 成功事件（farm_one_plot 撒种完成）· 推进 plotsDone
    this.bus.on('atomic.place_block.success', ev => {
      const payload = ev.payload as { source: string; item?: string };
      if (payload.source !== 'farm_one_plot') return;
      const t = this.tasks.active();
      if (!t || t.kind !== 'farm') return;
      const done = ((t.progress?.plotsDone as number) ?? 0) + 1;
      t.progress = { ...(t.progress ?? {}), plotsDone: done };
      this.bus.publish('farm.progress', 'info', {
        taskId: t.id,
        plotsDone: done,
        plots: (t.params as unknown as FarmTaskParamsExt).plots,
      });
      // continuous：记下撒种位置（用 bot 当前位置估算，与 FarmBehavior 算法一致）
      const params = t.params as unknown as FarmTaskParamsExt;
      if (params.mode === 'continuous') {
        // pos 字段在 atomic 当前 payload 中没暴露 · 我们用上一次 farm_one_plot 的目标格估算
        // FarmBehavior 撒种的目标格 = bot pos + (0, -1, +1)（look_at target）
        // 这里走旁路：从 lastPlannedPos 拿（见下方 tick() 里缓存）
        const recall = this.lastPlannedPosByTaskId.get(t.id);
        if (recall) {
          const plots = this.knownPlotsByTaskId.get(t.id) ?? [];
          plots.push({ pos: recall, plantedAt: Date.now() });
          this.knownPlotsByTaskId.set(t.id, plots);
        }
      }
    });

    // FEAT-L7-05：收割成功（source=farm_loop） → plotsDone-- + totalHarvest++ + 移除该 plot
    this.bus.on('atomic.dig.success', ev => {
      const payload = ev.payload as { source: string; pos: { x: number; y: number; z: number } };
      if (payload.source !== 'farm_loop') return;
      const t = this.tasks.active();
      if (!t || t.kind !== 'farm') return;
      const params = t.params as unknown as FarmTaskParamsExt;
      if (params.mode !== 'continuous') return;
      const done = ((t.progress?.plotsDone as number) ?? 0) - 1;
      const harvest = ((t.progress?.totalHarvest as number) ?? 0) + 1;
      t.progress = {
        ...(t.progress ?? {}),
        plotsDone: Math.max(0, done),
        totalHarvest: harvest,
      };
      // 移除该 pos（避免重复扫成熟）
      const plots = this.knownPlotsByTaskId.get(t.id) ?? [];
      this.knownPlotsByTaskId.set(t.id, plots.filter(p =>
        p.pos.x !== payload.pos.x || p.pos.z !== payload.pos.z,
      ));
      this.bus.publish('farm.harvest', 'info', {
        taskId: t.id,
        pos: payload.pos,
        totalHarvest: harvest,
      });
    });
  }

  /** 上次 tick 派给 farm_one_plot 的目标格 · 用于 place_block.success 时回溯撒种位置 */
  private lastPlannedPosByTaskId = new Map<string, { x: number; y: number; z: number }>();

  isActive(ctx: StrategyContext): boolean {
    return ctx.activeTaskKind === 'farm';
  }

  tick(ctx: StrategyContext): ActionRequest[] {
    const t = this.tasks.active();
    if (!t || t.kind !== 'farm') return [];

    const params = t.params as unknown as FarmTaskParamsExt;
    const mode: FarmMode = params.mode === 'continuous' ? 'continuous' : 'oneshot';
    const done = (t.progress?.plotsDone as number) ?? 0;

    if (this.sinceTick === 0) this.sinceTick = ctx.tick;
    // FEAT-WEBUI-08 · 当前动作（NPC 行为）
    ctx.setPhase?.(`犁地播种 ${done}/${params.plots ?? '?'}`);

    // ── oneshot：保留原行为 ──
    if (mode === 'oneshot') {
      if (done >= params.plots) return [];
      return [this._makePlantRequest(ctx, t.id)];
    }

    // ── continuous (FEAT-L7-05) ──
    // 1) 还没种够 → 继续撒种
    if (done < params.plots) {
      return [this._makePlantRequest(ctx, t.id)];
    }
    // 2) 种够了 → 扫已撒种格中"已熟"的
    const growthSec = params.growthEstimateSec ?? 60;
    const now = Date.now();
    const plots = this.knownPlotsByTaskId.get(t.id) ?? [];
    const ripe = plots.find(p => (now - p.plantedAt) / 1000 >= growthSec);
    if (ripe) {
      return [this._makeHarvestRequest(ctx, ripe.pos)];
    }
    // 3) 全没熟 → 巡逻等待（返空 · 下 tick 再扫）
    return [];
  }

  private _makePlantRequest(ctx: StrategyContext, taskId: string): ActionRequest {
    const params = this.tasks.active()?.params as unknown as FarmTaskParamsExt;
    // FarmBehavior 算法：撒种目标格 = bot pos + (0, -1, +1)（这里复算一遍方便缓存）
    const pos = ctx.world.self.position;
    const targetPos = {
      x: Math.round(pos.x),
      y: Math.round(pos.y) - 1,
      z: Math.round(pos.z) + 1,
    };
    this.lastPlannedPosByTaskId.set(taskId, targetPos);
    return {
      id: `${this.id}-invoke-${ctx.tick}-${++this.reqSeq}`,
      source: this.id,
      type: 'invoke_behavior',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['movement', 'inventory'],
      target: {
        behavior: 'farm_one_plot',
        behaviorParams: {
          seedName: params.seedName,
          hoeName: params.hoeName,
        },
      },
      preconditions: [],
      expected_effect: ['plot_tilled'],
      timeout_ms: 15000,
    };
  }

  private _makeHarvestRequest(
    ctx: StrategyContext,
    pos: { x: number; y: number; z: number },
  ): ActionRequest {
    return {
      id: `${this.id}-harvest-${ctx.tick}-${++this.reqSeq}`,
      source: 'farm_loop',  // ⭐ 标记 source · 让 atomic.dig.success 监听器认得
      type: 'dig',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['movement', 'vision'],
      target: { position: pos },
      preconditions: [],
      expected_effect: ['crop_harvested'],
      timeout_ms: 8000,
    };
  }

  reset(): void {
    this.sinceTick = 0;
    this.reqSeq = 0;
    // 不清 knownPlotsByTaskId · 跨 reset 保留撒种记忆（任务 fail/complete 时由 GC 自然释放）
  }

  inspect(): StrategyInspect {
    const t = this.tasks.active();
    const done = (t?.progress?.plotsDone as number) ?? 0;
    const total = t ? ((t.params as unknown as FarmTaskParamsExt).plots ?? 0) : 0;
    const params = t?.params as unknown as FarmTaskParamsExt | undefined;
    const mode: FarmMode = params?.mode === 'continuous' ? 'continuous' : 'oneshot';
    const totalHarvest = (t?.progress?.totalHarvest as number) ?? 0;

    let phase: string;
    if (!t) phase = 'idle';
    else if (mode === 'oneshot') phase = done >= total ? 'complete' : 'farming';
    else phase = done < total ? 'planting' : 'waiting_growth';

    return {
      kind: 'fsm',
      view: {
        phase,
        mode,
        plotsDone: done,
        total,
        totalHarvest,
        knownPlots: t ? (this.knownPlotsByTaskId.get(t.id) ?? []).length : 0,
      },
      sinceTick: this.sinceTick,
    };
  }
}
