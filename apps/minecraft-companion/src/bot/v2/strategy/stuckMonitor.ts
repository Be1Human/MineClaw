/** Operation-local navigation recovery; every pulse is awaited under the body lease. */
import type { NavigationActions } from '../../adapter/NavigationExecution.js';
import type { GameView } from '../../adapter/GameAdapter.js';
import type { GameActions, DeviceExecutionScope } from '../../adapter/GameActions.js';
import type { EventBusV2 } from '../infra/eventBus.js';
import type { Vec3 } from '../../adapter/types.js';
import { isDoorBlock } from '../atomic/openDoor.js';
import { tuning } from '../infra/tuning.js';

export class StuckMonitor {
  private lastPos: Vec3 | null = null;
  private stuckSince = 0;
  private lastRecoveryAt = 0;
  private stage = 0;
  constructor(
    private readonly game: GameView,
    private readonly actions: GameActions,
    private readonly scope: DeviceExecutionScope,
    private readonly bus: EventBusV2,
  ) {}
  async tick(nav: NavigationActions): Promise<void> {
    this.scope.assertCurrent('stuck-monitor');
    if (!nav.isMoving() || nav.isMining() || nav.isBuilding()) {
      this.lastPos = null; this.stuckSince = 0; this.stage = 0; return;
    }
    const pos = this.game.getPosition();
    const now = Date.now();
    const cfg = tuning().navigationMaintenance;
    if (!this.lastPos || Math.hypot(pos.x-this.lastPos.x,pos.y-this.lastPos.y,pos.z-this.lastPos.z) >= cfg.movedEpsilon) {
      this.lastPos = { ...pos }; this.stuckSince = now; this.stage = 0; return;
    }
    if (now-this.stuckSince < cfg.stuckAfterMs || now-this.lastRecoveryAt < cfg.stuckCooldownMs) return;
    if (this.doorNearby(pos)) { this.stuckSince = now; return; }
    this.lastRecoveryAt = now;
    this.stuckSince = now;
    const stage = this.stage++;
    if (stage > 2) {
      this.stage = 0;
      this.bus.publish('navigation.stuck_unrecovered','recoverable',{pos});
      return;
    }
    if (stage === 2) nav.replan();
    const keys: Array<'jump'|'forward'|'left'> = stage === 0 ? ['jump'] : stage === 1 ? ['jump','forward'] : ['left','jump'];
    this.bus.publish('stuck.recovery','info',{stage,pos});
    try {
      for (const key of keys) await this.actions.setControlState(key,true);
      await this.scope.wait(stage === 0 ? cfg.jumpPulseMs : cfg.escapePulseMs);
    } finally {
      if (!this.scope.signal.aborted) await this.actions.clearControlStates();
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

}
