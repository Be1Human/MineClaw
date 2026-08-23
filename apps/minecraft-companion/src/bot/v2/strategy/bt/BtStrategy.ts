/**
 * 🌳 BtStrategy · BT 策略抽象基类
 *
 * 子类职责：
 *   1. 实现 readonly id
 *   2. 实现 isActive(ctx)
 *   3. 在构造函数里调 this.initTree(buildTree()) 完成树的延迟初始化
 *      （或直接赋值 protected tree）
 *
 * 基类负责：
 *   - tick()：创建 BtContext，调树，收割 requests，记 sinceTick
 *   - inspect()：返回 { kind:'bt', view:{ activeActions, lastFailure } }
 *   - reset()：重置树 + debug 状态
 */

import type { IStrategy, StrategyContext, StrategyInspect } from '../types.js';
import type { ActionRequest } from '../../types.js';
import type { BtNode, BtDebug } from './nodes.js';

export abstract class BtStrategy implements IStrategy {
  abstract readonly id: string;
  readonly kind = 'bt' as const;

  /** 子类在构造函数里赋值（或通过 initTree()） */
  protected tree!: BtNode;

  protected sinceTick = 0;
  private lastDebug: BtDebug = { activeActions: [], lastFailure: null };

  /**
   * 延迟初始化辅助：在子类构造函数里用
   *   this.initTree(seq('root', [...]))
   * 确保 this.config 等字段已就绪再建树。
   */
  protected initTree(tree: BtNode): void {
    this.tree = tree;
  }

  // ── IStrategy ────────────────────────────────────────────────

  abstract isActive(ctx: StrategyContext): boolean;

  tick(ctx: StrategyContext): ActionRequest[] {
    if (!this.tree) return [];

    const requests: ActionRequest[] = [];
    const debug: BtDebug = {
      activeActions: [],
      lastFailure: this.lastDebug.lastFailure, // 保留跨 tick 的上次失败记录
    };

    this.tree.tick({ world: ctx.world, tick: ctx.tick, requests, debug });
    this.lastDebug = debug;

    // 首次产出请求时记录 sinceTick
    if (requests.length > 0 && this.sinceTick === 0) {
      this.sinceTick = ctx.tick;
    }

    return requests;
  }

  reset(): void {
    if (this.tree) this.tree.reset();
    this.sinceTick = 0;
    this.lastDebug = { activeActions: [], lastFailure: null };
  }

  inspect(): StrategyInspect {
    return {
      kind: 'bt',
      view: {
        activeActions: this.lastDebug.activeActions,
        lastFailure: this.lastDebug.lastFailure,
      },
      sinceTick: this.sinceTick,
    };
  }
}
