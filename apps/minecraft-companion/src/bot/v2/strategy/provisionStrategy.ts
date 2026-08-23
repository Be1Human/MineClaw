/**
 * 📋 ProvisionStrategy · 任务驱动 · 创建道具（含就地取材）
 *
 * kind = 'craft_item'   params: { item, count }
 *
 * 每 tick 问 RecipeResolver："为了做出 item×count，下一步做什么？"
 *   - done    → complete + say
 *   - gather  → 派生 gather_material 子任务（采原料；完成后父任务自动恢复）
 *   - craft   → 确保工作台（找/放/造）→ invoke_behavior(craft_one)
 *   - blocked → fail + say
 *
 * 由于每 tick 重算，对中途进度幂等、可断点恢复（子任务完成后继续）。
 */

import type { IStrategy, StrategyContext, StrategyInspect } from './types.js';
import type { ActionRequest } from '../types.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { TaskRuntime } from '../task/taskRuntime.js';
import type { Vec3 } from '../../adapter/types.js';
import { RecipeResolver, invCount } from '../knowledge/recipeResolver.js';

const TABLE_SEARCH_DIST = 10;
const STALL_TICKS = 300;   // 库存无变化容忍 tick（~60s）→ 放弃
const MAX_GATHER_ATTEMPTS = 3; // 同一材料采集子任务重派上限 → 超过判定采不到

export class ProvisionStrategy implements IStrategy {
  readonly id = 'provision_strategy';
  readonly kind = 'fsm' as const;

  private readonly resolver: RecipeResolver;
  private seq = 0;
  private sinceTick = 0;
  private lastPhase = 'idle';
  private announced = new Set<string>();   // 已宣告开始的 taskId
  // BUG-L5-03（provision 版）：记录上次处理的 task.id · 任务切换时必须重置 per-task 看门狗状态，
  // 否则旧 lastProgressTick 残留 → 新 craft 任务一启动就被"长时间无进展"秒杀（真服实证：
  // 第二个起的造物任务都在 ~170ms 内即失败、永远做不出木镐）。
  private lastTaskId = '';
  // 无进展看门狗
  private lastSig = '';
  private lastProgressTick = 0;
  private lastStepSig = '';   // 上次播报的解析步骤（去重）
  // 记忆刚放下的工作台位置：被怪赶跑/挪开后仍能回到自己的台，不反复重造（真服实证：
  // 夜里苦力怕逼得 bot 远离刚放的台 → findTable 搜不到 → 不停造新台、石镐永远做不出）
  private placedTablePos: Vec3 | null = null;
  private placedFurnacePos: Vec3 | null = null; // 同理记忆放下的熔炉位置（FEAT-L3-06）
  // 子任务重试上限（key = taskId:material）· 只数"连续无进展"次数
  private gatherAttempts = new Map<string, number>();
  // 上次派采集子任务时该材料的库存数（key = taskId:material）· 涨了就重置 attempts
  // 修复：批量材料(熔炉需8圆石)分多轮慢采会误触上限、差1个就放弃 → 有进展即清零
  private gatherProgress = new Map<string, number>();

  constructor(
    private readonly game: GameAdapter,
    private readonly bus: EventBusV2,
    private readonly tasks: TaskRuntime,
  ) {
    this.resolver = new RecipeResolver({
      getCraftRecipes: (n, w) => this.game.getCraftRecipes(n, w),
      getItemSource: (n) => this.game.getItemSource(n),
      isMaterialNearby: (mat) => this.isMaterialNearby(mat),
    });
  }

  isActive(ctx: StrategyContext): boolean {
    return ctx.activeTaskKind === 'craft_item';
  }

  tick(ctx: StrategyContext): ActionRequest[] {
    const t = this.tasks.active();
    if (!t || t.kind !== 'craft_item') return [];

    const item = String(t.params.item ?? '');
    const count = Math.max(1, Number(t.params.count ?? 1));
    if (!item) { this.tasks.fail(t.id, { code: 'unknown', detail: '未指定合成目标' }); return []; }

    // 任务切换 → 重置 per-task 看门狗（否则继承上个任务的 lastProgressTick 被秒杀）
    if (t.id !== this.lastTaskId) {
      this.lastTaskId = t.id;
      this.sinceTick = ctx.tick;
      this.lastProgressTick = ctx.tick;
      this.lastSig = '';
      this.lastStepSig = '';
      this.placedTablePos = null;
      this.placedFurnacePos = null;
    }
    if (this.sinceTick === 0) { this.sinceTick = ctx.tick; this.lastProgressTick = ctx.tick; }

    // 无进展看门狗：库存签名长时间不变且没在等子任务 → 放弃（防合成反复失败死循环）
    const sig = ctx.world.inventory.items.map(i => `${i.name}:${i.count}`).sort().join('|');
    if (sig !== this.lastSig) { this.lastSig = sig; this.lastProgressTick = ctx.tick; }
    if (ctx.tick - this.lastProgressTick > STALL_TICKS && !this.hasActiveChild(t.id)) {
      this.tasks.fail(t.id, { code: 'stall_no_progress', detail: 'craft 长时间无进展' });
      return []; // FEAT-NARR-01: 卡住过程播报(🟡)已砍
    }

    const out: ActionRequest[] = [];
    if (!this.announced.has(t.id)) {
      this.announced.add(t.id);
      // FEAT-NARR-01: 开始播报(🟡)已砍 · 结果由 craft_done 通知
    }

    const step = this.resolver.nextStep(item, count, ctx.world.inventory);
    this.lastPhase = step.kind;

    // 决策可视化：解析出的"下一步"变化时，向 WebUI 播报（看得见它在想什么/选了什么）
    const stepSig =
      step.kind === 'gather' ? `采集 ${step.material}×${step.count}` :
      step.kind === 'craft' ? `合成 ${step.item}×${step.count}${step.needTable ? '(需工作台)' : ''}` :
      step.kind === 'smelt' ? `熔炼 ${step.input}→${step.item}×${step.count}` :
      step.kind === 'blocked' ? `卡住:${step.reason}` : '完成';
    if (stepSig !== this.lastStepSig) {
      this.lastStepSig = stepSig;
      this.bus.publish('provision.step', 'info', { target: item, step: stepSig });
    }
    t.progress = { ...(t.progress ?? {}), target: item, phase: step.kind, step: stepSig };
    // FEAT-WEBUI-08 · 当前动作（NPC 行为）· stepSig 已是人话步骤
    ctx.setPhase?.(stepSig);

    switch (step.kind) {
      case 'done': {
        this.bus.publish('provision.done', 'info', { item, count });
        this.tasks.complete(t.id);
        ctx.narrate?.({ source: 'provision', topic: 'craft_done', urgency: 40, data: { item: zhItem(item) } });
        return out;
      }

      case 'blocked': {
        this.tasks.fail(t.id, { code: 'unknown', detail: step.reason });
        ctx.narrate?.({ source: 'provision', topic: 'craft_blocked', urgency: 50, data: { item: zhItem(item) } });
        return out;
      }

      case 'gather': {
        // 派生采集子任务（若尚无子任务在跑）
        if (!this.hasActiveChild(t.id)) {
          const key = `${t.id}:${step.material}`;
          // 有进展（这一轮采到了更多）→ 清零尝试计数，只数"连续无进展"
          const haveMat = invCount(ctx.world.inventory, step.material);
          if (haveMat > (this.gatherProgress.get(key) ?? -1)) {
            this.gatherAttempts.set(key, 0);
          }
          this.gatherProgress.set(key, haveMat);
          const n = (this.gatherAttempts.get(key) ?? 0) + 1;
          this.gatherAttempts.set(key, n);
          if (n > MAX_GATHER_ATTEMPTS) {
            this.tasks.fail(t.id, { code: 'no_resource_found', detail: `采不到 ${step.material}` });
            ctx.narrate?.({ source: 'provision', topic: 'craft_blocked', urgency: 50, data: { item: zhItem(item) } });
            return out;
          }
          const sub = this.tasks.createSubtask(
            { kind: 'gather_material', params: { material: step.material, count: step.count }, priority: 55 },
            t.id,
          );
          this.tasks.pushToStack(sub.id);
          this.bus.publish('provision.subtask', 'info', { parent: t.id, kind: 'gather_material', material: step.material, count: step.count });
        }
        return out; // 等子任务完成 → TaskRuntime 自动恢复父任务
      }

      case 'craft': {
        let tablePos: Vec3 | undefined;
        if (step.needTable) {
          const table = this.findTable(ctx.world.self.position);
          if (table) {
            tablePos = table;
          } else if (invCount(ctx.world.inventory, 'crafting_table') > 0) {
            // 有工作台物品 → 放一个
            const place = this.findPlacement(ctx.world.self.position);
            if (place) {
              this.placedTablePos = place.placePos; // 记住放在哪，下次回来用
              out.push(this.placeTable(ctx, place));
              return out; // 下一 tick 工作台已存在
            }
            // 找不到放置点 → 真的挪一下（旧版只 return 不动 → 山地坡面永远卡 craft）
            out.push(this.relocate(ctx));
            return out;
          } else {
            // 既无工作台方块也无工作台物品 → 先造一个工作台
            if (!this.hasActiveChild(t.id)) {
              const sub = this.tasks.createSubtask(
                { kind: 'craft_item', params: { item: 'crafting_table', count: 1 }, priority: 56 },
                t.id,
              );
              this.tasks.pushToStack(sub.id);
              this.bus.publish('provision.subtask', 'info', { parent: t.id, kind: 'craft_item', item: 'crafting_table' });
            }
            return out;
          }
        }
        // 发起合成
        out.push({
          id: `${this.id}-craft-${ctx.tick}-${++this.seq}`,
          source: this.id,
          type: 'invoke_behavior',
          priority: 30,
          interrupt_level: 'soft',
          resource: ['movement', 'inventory'],
          target: {
            behavior: 'craft_one',
            behaviorParams: {
              item: step.item,
              count: step.count,
              inventoryTargetCount: step.inventoryTargetCount,
              tablePos,
            },
          },
          preconditions: [],
          expected_effect: ['crafted_item'],
          timeout_ms: 20000,
        });
        return out;
      }

      case 'smelt': {
        // 确保熔炉（找附近/记忆 → 有炉物品则放 → 无则造）· 复用工作台同款鲁棒逻辑
        let furnacePos = this.findFurnace(ctx.world.self.position);
        // 真服实证：bot 走远后 findFurnace 返回够不到的旧炉 → openFurnace windowOpen 20s 超时空转。
        //   太远(>6格)就当没炉，就地造新炉（cobblestone 一般富余）。
        if (furnacePos) {
          const self = ctx.world.self.position;
          const fd = Math.hypot(furnacePos.x - self.x, furnacePos.y - self.y, furnacePos.z - self.z);
          if (fd > 6) { furnacePos = undefined; this.placedFurnacePos = null; }
        }
        if (!furnacePos) {
          if (invCount(ctx.world.inventory, 'furnace') > 0) {
            const place = this.findPlacement(ctx.world.self.position);
            if (place) {
              this.placedFurnacePos = place.placePos;
              out.push(this.placeBlockReq(ctx, 'furnace', place));
              return out;
            }
            out.push(this.relocate(ctx));
            return out;
          }
          // 无熔炉方块也无熔炉物品 → 先造熔炉（8 cobblestone）
          if (!this.hasActiveChild(t.id)) {
            const sub = this.tasks.createSubtask(
              { kind: 'craft_item', params: { item: 'furnace', count: 1 }, priority: 56 },
              t.id,
            );
            this.tasks.pushToStack(sub.id);
            this.bus.publish('provision.subtask', 'info', { parent: t.id, kind: 'craft_item', item: 'furnace' });
          }
          return out;
        }
        // 熔炉就绪 → 发起熔炼（input/fuel 由 resolver 保证已在背包）
        out.push({
          id: `${this.id}-smelt-${ctx.tick}-${++this.seq}`,
          source: this.id,
          type: 'smelt',
          priority: 30,
          interrupt_level: 'soft',
          resource: ['movement', 'inventory'],
          target: { itemName: step.input, fuelName: step.fuel, count: step.count, tablePos: furnacePos },
          preconditions: [],
          expected_effect: ['smelted_item'],
          timeout_ms: Math.max(20000, step.count * 12000 + 8000),
        });
        return out;
      }
    }
  }

  /** 找附近熔炉（含记忆回退，类比 findTable） */
  private findFurnace(selfPos: Vec3): Vec3 | undefined {
    const found = this.game.findBlocks({ names: ['furnace', 'blast_furnace'], maxDistance: TABLE_SEARCH_DIST, count: 1 });
    if (found[0]) return found[0];
    if (this.placedFurnacePos) {
      const b = this.game.getBlockAt(this.placedFurnacePos);
      if (b && /furnace/.test(b.name)) return this.placedFurnacePos;
      this.placedFurnacePos = null;
    }
    return undefined;
  }

  /** 通用放置请求（工作台/熔炉共用） */
  private placeBlockReq(ctx: StrategyContext, itemName: string, place: { refPos: Vec3; faceVector: Vec3; placePos: Vec3 }): ActionRequest {
    return {
      id: `${this.id}-place-${itemName}-${ctx.tick}-${++this.seq}`,
      source: this.id,
      type: 'place_block',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['movement', 'inventory'],
      target: { itemName, referencePosition: place.refPos, faceVector: place.faceVector, position: place.placePos },
      preconditions: [],
      timeout_ms: 8000,
    };
  }

  /** 是否已有未完成的子任务（避免重复派生） */
  private hasActiveChild(parentId: string): boolean {
    return this.tasks.list().some(
      x => x.parentId === parentId && (x.state === 'running' || x.state === 'pending' || x.state === 'paused'),
    );
  }

  /** 某原料的源方块此刻是否在附近可挖（带短期缓存，避免每 tick 重复 findBlocks） */
  private nearbyCache = new Map<string, { ok: boolean; at: number }>();
  private isMaterialNearby(material: string): boolean {
    const now = Date.now();
    const cached = this.nearbyCache.get(material);
    if (cached && now - cached.at < 5000) return cached.ok;
    const src = this.game.getItemSource(material);
    const block = src?.block ?? material;
    const ok = this.game.findBlocks({ names: block, maxDistance: 64, count: 1 }).length > 0;
    this.nearbyCache.set(material, { ok, at: now });
    return ok;
  }

  private findTable(selfPos: Vec3): Vec3 | undefined {
    const found = this.game.findBlocks({ names: 'crafting_table', maxDistance: TABLE_SEARCH_DIST, count: 1 });
    if (found[0]) return found[0];
    // 回退：回到记忆中刚放下的工作台（craft_one 会自动走过去），避免被怪赶跑后反复重造
    if (this.placedTablePos) {
      const b = this.game.getBlockAt(this.placedTablePos);
      if (b && b.name === 'crafting_table') return this.placedTablePos;
      this.placedTablePos = null; // 台没了 → 清记忆
    }
    return undefined;
  }

  /**
   * 找一个可放置工作台的空格。鲁棒版（真服实证：旧版只查脚边4邻，山地坡面全失败→石镐永远做不出）：
   * 扫脚同层+上下层的 12 个候选格，对每个空格优先"放在下方块顶面"，否则"贴实心侧邻面"放。
   */
  private findPlacement(selfPos: Vec3): { refPos: Vec3; faceVector: Vec3; placePos: Vec3 } | null {
    const fx = Math.floor(selfPos.x);
    const fy = Math.floor(selfPos.y);
    const fz = Math.floor(selfPos.z);
    const dirs = [ { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 } ];
    const isEmpty = (p: Vec3) => { const b = this.game.getBlockAt(p); return !b || b.boundingBox === 'empty'; };
    const isSolid = (p: Vec3) => { const b = this.game.getBlockAt(p); return !!b && b.boundingBox === 'block'; };
    for (const dy of [0, 1, -1]) {
      for (const d of dirs) {
        const placePos = { x: fx + d.x, y: fy + dy, z: fz + d.z };
        if (!isEmpty(placePos)) continue;
        // 优先：下方实心 → 放在其顶面
        const belowPos = { x: placePos.x, y: placePos.y - 1, z: placePos.z };
        if (isSolid(belowPos)) {
          return { refPos: belowPos, faceVector: { x: 0, y: 1, z: 0 }, placePos };
        }
        // 否则：找一个实心的水平邻块当参考面，贴其侧面放
        for (const s of dirs) {
          const refPos = { x: placePos.x + s.x, y: placePos.y, z: placePos.z + s.z };
          if (isSolid(refPos)) {
            return { refPos, faceVector: { x: -s.x, y: 0, z: -s.z }, placePos };
          }
        }
      }
    }
    return null;
  }

  private placeTable(ctx: StrategyContext, place: { refPos: Vec3; faceVector: Vec3; placePos: Vec3 }): ActionRequest {
    return {
      id: `${this.id}-placetable-${ctx.tick}-${++this.seq}`,
      source: this.id,
      type: 'place_block',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['movement', 'inventory'],
      target: {
        itemName: 'crafting_table',
        referencePosition: place.refPos,
        faceVector: place.faceVector,
        position: place.placePos,
      },
      preconditions: [],
      timeout_ms: 8000,
    };
  }

  /** 放置点找不到时，朝轮换方向走一小段换地形再试（用 walk 原子，短距可靠位移） */
  private relocate(ctx: StrategyContext): ActionRequest {
    const p = ctx.world.self.position;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const d = dirs[this.seq % dirs.length];
    const wp = { x: Math.floor(p.x + d[0] * 3), y: p.y, z: Math.floor(p.z + d[1] * 3) };
    return {
      id: `${this.id}-relocate-${ctx.tick}-${++this.seq}`,
      source: this.id,
      type: 'walk',
      priority: 30,
      interrupt_level: 'soft',
      resource: ['movement'],
      target: { position: wp, durationMs: 1500 },
      preconditions: [],
      expected_effect: ['relocated'],
      timeout_ms: 4000,
    };
  }

  reset(): void {
    this.seq = 0;
    this.sinceTick = 0;
    this.lastPhase = 'idle';
    this.lastSig = '';
    this.lastProgressTick = 0;
    this.lastStepSig = '';
    this.lastTaskId = '';
    this.placedTablePos = null;
    this.placedFurnacePos = null;
  }

  inspect(): StrategyInspect {
    return { kind: 'fsm', view: { phase: this.lastPhase }, sinceTick: this.sinceTick };
  }
}

function zhItem(name: string): string {
  const map: Record<string, string> = {
    oak_planks: '橡木木板', stick: '木棍', crafting_table: '工作台', chest: '箱子',
    furnace: '熔炉', torch: '火把',
    wooden_pickaxe: '木镐', wooden_axe: '木斧', wooden_sword: '木剑', wooden_shovel: '木铲', wooden_hoe: '木锄',
    stone_pickaxe: '石镐', stone_axe: '石斧', stone_sword: '石剑', stone_shovel: '石铲', stone_hoe: '石锄',
  };
  return map[name] ?? name;
}
