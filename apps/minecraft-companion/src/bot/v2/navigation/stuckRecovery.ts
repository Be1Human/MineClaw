import type { Vec3, NavResult } from '../../adapter/types.js';
import type { NavigationActions } from '../../adapter/NavigationExecution.js';
import type { GameActions, DeviceExecutionScope } from '../../adapter/GameActions.js';
import { tuning } from '../infra/tuning.js';

/** Bounded recovery within one operation. Cancellation never starts another attempt. */
export class StuckRecovery {
  async executeWithRecovery(
    goal: Vec3, nav: NavigationActions, actions: GameActions, scope: DeviceExecutionScope,
    options?: { maxAttempts?: number; range?: number },
  ): Promise<NavResult> {
    const cfg = tuning().navigationMaintenance;
    const max = Math.min(options?.maxAttempts ?? cfg.recoveryAttempts,5);
    const range = options?.range ?? 1;
    for (let attempt=0; attempt<=max; attempt++) {
      scope.assertCurrent('navigation-recovery');
      if (attempt) {
        if (attempt === 1) await scope.wait(cfg.recoveryWaitMs);
        else if (attempt === 5) {
          nav.replan(); await actions.clearControlStates(); await scope.wait(cfg.recoveryResetMs);
        } else {
          const keys: Array<'back'|'jump'|'left'|'right'> = attempt===2 ? ['back'] : attempt===3 ? ['jump'] : ['left','right'];
          try {
            for (const key of keys) {
              await actions.setControlState(key,true);
              await scope.wait(cfg.recoveryPulseMs);
              await actions.setControlState(key,false);
              if (keys.length>1) await scope.wait(cfg.recoverySideGapMs);
            }
          } finally {
            if (!scope.signal.aborted) await actions.clearControlStates();
          }
          await scope.wait(cfg.recoverySettleMs);
        }
      }
      const result = await nav.goto({type:'block',position:goal,range});
      if (result.ok || result.reason === 'cancelled') return result;
    }
    return {ok:false,reason:'stuck_max_retries'};
  }
}
