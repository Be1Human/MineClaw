/**
 * L5 · StuckMonitor — 通用卡死恢复（tick 级监视器）
 *
 * 与 DoorMonitor 同类：每 tick 被 Heartbeat（TickRegistry FAST）调用。
 * 检测"导航中却连续无位移"，做阶梯式脱困：
 *   stage0 跳一下（爬 0.5/1 格台阶、跳出 1 格坑）
 *   stage1 跳 + 前冲（爬更高/出水）
 *   stage2 停止寻路（强制下次重算）+ 侧移微调（绕过窄道卡角）
 *   stage3 仍卡 → 发 supervisor.stuck 事件，交给上层
 *
 * 门口卡死优先让 DoorMonitor 处理：附近有门则本监视器让位。
 */

import type { NavigationAdapter } from '../../adapter/NavigationAdapter.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { TaskRuntime } from '../task/taskRuntime.js';
import type { Vec3 } from '../../adapter/types.js';
import { isDoorBlock } from '../atomic/openDoor.js';

const STUCK_TICK_THRESHOLD = 10;   // ~2s @200ms
const RECOVERY_COOLDOWN_MS = 2500;
const MOVE_EPS = 0.08;

export class StuckMonitor {
  private lastPos: Vec3 | null = null;
  private stuckTicks = 0;
  private lastRecoveryAt = 0;
  private stage = 0;
  /** 正在做恢复动作的剩余 tick（脉冲控制） */
  private pulseRemaining = 0;
  private pulseKeys: Array<'jump' | 'forward' | 'left' | 'right'> = [];
  /** FEAT-CROSS-05 · 脱困脉冲期间的可见紧急任务 id */
  private unstickTaskId: string | null = null;

  constructor(
    private readonly nav: NavigationAdapter,
    private readonly game: GameAdapter,
    private readonly bus: EventBusV2,
    /** FEAT-CROSS-05 · 直接控 bot 也要先注册任务（任务树可见） */
    private readonly tasks: TaskRuntime,
  ) {}

  tick(): void {
    // 正在执行恢复脉冲 → 维持控制键，倒计时结束清除
    if (this.pulseRemaining > 0) {
      this.pulseRemaining--;
      if (this.pulseRemaining === 0) {
        for (const k of this.pulseKeys) this.game.setControlState(k, false);
        this.pulseKeys = [];
        // FEAT-CROSS-05 · 释放控制 → 完成 unstick 任务（栈空自动恢复 goto/follow）
        if (this.unstickTaskId) { this.tasks.complete(this.unstickTaskId); this.unstickTaskId = null; }
      }
      return;
    }

    if (!this.nav.isMoving()) {
      this.reset();
      return;
    }

    const pos = this.game.getPosition();
    if (this.lastPos) {
      const dx = pos.x - this.lastPos.x;
      const dz = pos.z - this.lastPos.z;
      const dy = pos.y - this.lastPos.y;
      const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (moved < MOVE_EPS) this.stuckTicks++;
      else { this.stuckTicks = 0; this.stage = 0; }
    }
    this.lastPos = { ...pos };

    if (this.stuckTicks < STUCK_TICK_THRESHOLD) return;
    if (Date.now() - this.lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;

    // 门口卡死交给 DoorMonitor
    if (this.doorNearby(pos)) { this.stuckTicks = 0; return; }

    this.lastRecoveryAt = Date.now();
    this.stuckTicks = 0;
    this.runRecovery(pos);
  }

  private runRecovery(pos: Vec3): void {
    const stage = this.stage++;
    switch (stage) {
      case 0:
        this.pulse(['jump'], 2);
        this.bus.publish('stuck.recovery', 'info', { stage, action: 'jump', pos });
        break;
      case 1:
        this.pulse(['jump', 'forward'], 4);
        this.bus.publish('stuck.recovery', 'info', { stage, action: 'jump_forward', pos });
        break;
      case 2:
        // 强制重算：停掉当前寻路（下次 goto 会重新规划）+ 侧移
        try { this.nav.stop(); } catch { /* ignore */ }
        this.pulse([Math.random() < 0.5 ? 'left' : 'right', 'jump'], 4);
        this.bus.publish('stuck.recovery', 'recoverable', { stage, action: 'replan_sidestep', pos });
        break;
      default:
        this.stage = 0;
        this.bus.publish('navigation.stuck_unrecovered', 'recoverable', { pos });
        break;
    }
  }

  private pulse(keys: Array<'jump' | 'forward' | 'left' | 'right'>, ticks: number): void {
    this.pulseKeys = keys;
    this.pulseRemaining = ticks;
    for (const k of keys) this.game.setControlState(k, true);
    // FEAT-CROSS-05 · 接管 bot 控制前注册可见任务（抢占当前 nav 任务，脉冲结束自动恢复）
    if (!this.unstickTaskId) {
      const t = this.tasks.createTask('unstick', {}, { priority: 50 });
      this.tasks.startEmergency(t.id);
      this.unstickTaskId = t.id;
    }
  }

  private doorNearby(pos: Vec3): boolean {
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = 0; dy <= 1; dy++) {
          const b = this.game.getBlockAt({ x: bx + dx, y: by + dy, z: bz + dz });
          if (b && isDoorBlock(b.name)) return true;
        }
      }
    }
    return false;
  }

  private reset(): void {
    this.lastPos = null;
    this.stuckTicks = 0;
    this.stage = 0;
  }
}
