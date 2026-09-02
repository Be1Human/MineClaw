/**
 * L5 · DoorMonitor — 路径门单执行器
 *
 * FEAT-CROSS-01 v2
 *
 * BUG-CROSS-08：Pathfinder 不生成 useOne；DoorMonitor 是唯一物理开门执行器。
 * 普通门打开后的亚方块穿越交给 NavigationAdapter，避免在策略层直接抢控制键。
 *
 * 由所属 NavigationSession 顺序 await；不开独立后台任务，不持有跨任务忙锁。
 */

import type { NavigationActions } from '../../adapter/NavigationExecution.js';
import type { DeviceExecutionScope, GameActions } from '../../adapter/GameActions.js';
import { tuning } from '../infra/tuning.js';
import type { GameView } from '../../adapter/GameAdapter.js';
import type { Vec3 } from '../../adapter/types.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import { isDoorBlock, openDoor } from '../atomic/openDoor.js';

/** BUG-CROSS-08 · 双格普通门统一以 lower 方块作为逻辑身份；单方块门结构保持原坐标。 */
export function canonicalDoorPosition(
  pos: Vec3,
  blockName: string,
  props: Record<string, string> | null,
): Vec3 {
  if (blockName.endsWith('_door') && props?.half === 'upper') {
    return { x: pos.x, y: pos.y - 1, z: pos.z };
  }
  return pos;
}

export class DoorMonitor {
  /** 最近观测的门坐标 key → 时间戳（防诊断事件刷屏） */
  private recentlyOpened = new Map<string, number>();
  /** 冷却时间 ms（同一门 5 秒内不重复开） */
  private get cooldownMs() { return tuning().navigationMaintenance.doorCooldownMs; }

  constructor(
    private readonly game: GameView,
    private readonly actions: GameActions,
    private readonly scope: DeviceExecutionScope,
    private readonly bus: EventBusV2,
  ) {}

  /**
   * 每 tick 调用。导航中检测前方关闭门并打开一次。
   * 不接管移动、不 nav.stop；A* 已负责把 bot 对正门中央。
   */
  async tick(nav: NavigationActions): Promise<void> {
    // 只在导航中才观测。
    if (!nav.isMoving()) return;
    await this.checkAndOpenDoors(nav);
  }

  // ── 门检测 + 开门 ─────────────────────────────────

  private async checkAndOpenDoors(nav: NavigationActions): Promise<void> {
    const path = nav.getCurrentPath();
    if (path.length === 0) return;

    const botPos = this.game.getPosition();
    // 门通行包含短时微操，只能在接近门洞后触发，不能从 4 格外盲走。
    const upcoming = this.getUpcomingNodes(path, botPos, tuning().navigationMaintenance.doorApproachRange);

    for (const node of upcoming) {
      // 路径节点在 bot 脚部高度，门是 2 格高 → 检查 node 和 node+1
      for (const checkY of [node.y, node.y + 1]) {
        const checkPos = { x: node.x, y: checkY, z: node.z };
        const block = this.game.getBlockAt(checkPos);
        if (!block) continue;
        if (!isDoorBlock(block.name)) continue;

        // 铁门不处理
        if (block.name === 'iron_door' || block.name === 'iron_trapdoor') {
          this.bus.publish('door.blocked', 'recoverable', {
            pos: checkPos, type: block.name, reason: 'iron_door',
          });
          continue;
        }

        // BUG-CROSS-08 · lower/upper 是同一扇门，后续状态/冷却/交互必须使用同一规范坐标。
        // 路径节点可能带小数；逻辑身份必须取真实方块的整数 position，否则移动时会绕过冷却。
        const hitPos = block.position ?? checkPos;
        const hitProps = this.game.getBlockProperties(hitPos);
        const doorPos = canonicalDoorPosition(hitPos, block.name, hitProps);
        const props = doorPos.y === hitPos.y ? hitProps : this.game.getBlockProperties(doorPos);

        // 已开则跳过
        if (props?.open === 'true') continue;

        // 冷却检查
        const key = `${doorPos.x}:${doorPos.y}:${doorPos.z}`;
        const last = this.recentlyOpened.get(key);
        if (last && Date.now() - last < this.cooldownMs) continue;

        // 发现关闭的门 → 由唯一执行器 DoorMonitor 异步打开。
        this.recentlyOpened.set(key, Date.now());
        this.bus.publish('door.detected', 'info', { pos: doorPos, block: block.name, state: 'closed' });
        await this.doOpen(nav, doorPos, block.name, { ...(props ?? {}) });
        return; // 一个 tick 只处理一扇门
      }
    }

    // 清理过期冷却
    this.cleanCooldown();
  }

  private async doOpen(
    nav: NavigationActions,
    pos: Vec3,
    blockName: string,
    properties: Record<string, string>,
  ): Promise<void> {
    const result = await openDoor(this.game, this.actions, this.scope, pos);
    if (result.ok) {
      this.bus.publish('door.opened', 'info', { pos, block: blockName, reason: result.reason });
      if (blockName.endsWith('_door') && !blockName.includes('iron')) {
        const passage = await nav.guideThroughDoor({ position: pos, blockName, properties });
        if (passage.ok) {
          this.bus.publish('door.passed', 'info', { pos, block: blockName });
        } else {
          this.bus.publish('door.open_failed', 'recoverable', {
            pos,
            block: blockName,
            reason: passage.reason ?? 'door_passage_failed',
          });
        }
      }
    } else {
      this.bus.publish('door.open_failed', 'recoverable', { pos, block: blockName, reason: result.reason });
    }
  }

  // ── 路径节点过滤 ──────────────────────────────────

  /**
   * 从 path 中取距离 botPos 在 maxDist 以内的前方节点。
   * path 从 pathfinder 的 path_update 事件获取，按路径顺序排列。
   */
  private getUpcomingNodes(path: Vec3[], botPos: Vec3, maxDist: number): Vec3[] {
    const result: Vec3[] = [];
    for (const node of path) {
      const d = Math.sqrt(
        (node.x - botPos.x) ** 2 +
        (node.y - botPos.y) ** 2 +
        (node.z - botPos.z) ** 2,
      );
      if (d <= maxDist) {
        result.push(node);
      }
      if (result.length >= tuning().navigationMaintenance.doorLookaheadNodes) break; // 检查更多节点覆盖门
    }
    return result;
  }

  private cleanCooldown(): void {
    const now = Date.now();
    for (const [key, ts] of this.recentlyOpened) {
      if (now - ts > this.cooldownMs * 2) {
        this.recentlyOpened.delete(key);
      }
    }
  }
}
