/**
 * 🔧 StuckRecovery — 寻路卡墙自救梯度策略
 *
 * FEAT-L1-04
 *
 * 当 nav.goto 失败时，按梯度尝试：
 *   失败 1 → 等 2s 重试（chunk 可能还在加载）
 *   失败 2 → 后退 200ms 再试
 *   失败 3 → 跳跃 200ms 再试
 *   失败 4 → 左右各挪 200ms 再试
 *   失败 5 → nav.stop() reset 再试 → 如仍失败，放弃
 */

import type { Vec3, NavResult } from '../../adapter/types.js';
import type { NavigationAdapter } from '../../adapter/NavigationAdapter.js';
import type { GameAdapter } from '../../adapter/GameAdapter.js';

const DEFAULT_MAX_ATTEMPTS = 5;

type RecoveryAction = 'wait' | 'retreat' | 'jump' | 'sidestep' | 'reset';

const RECOVERY_SEQUENCE: RecoveryAction[] = [
  'wait',
  'retreat',
  'jump',
  'sidestep',
  'reset',
];

export class StuckRecovery {
  async executeWithRecovery(
    goal: Vec3,
    nav: NavigationAdapter,
    game: GameAdapter,
    options?: { maxAttempts?: number; range?: number },
  ): Promise<NavResult> {
    const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    // BUG-L1-04R: hybrid 路径 waypoint 容忍 range=2，最终 goal 仍 range=1
    const range = options?.range ?? 1;

    // First attempt without any recovery
    const first = await nav.goto({ type: 'block', position: goal, range });
    if (first.ok) return first;

    // Gradient recovery
    for (let i = 0; i < Math.min(maxAttempts, RECOVERY_SEQUENCE.length); i++) {
      const action = RECOVERY_SEQUENCE[i];
      await applyRecovery(action, nav, game);

      const result = await nav.goto({ type: 'block', position: goal, range });
      if (result.ok) return result;

      // If cancelled by user, stop recovery immediately
      if (result.reason === 'cancelled') return result;
    }

    return { ok: false, reason: 'stuck_max_retries' };
  }
}

async function applyRecovery(
  action: RecoveryAction,
  nav: NavigationAdapter,
  game: GameAdapter,
): Promise<void> {
  switch (action) {
    case 'wait':
      await sleep(2000);
      break;

    case 'retreat':
      game.setControlState('back', true);
      await sleep(200);
      game.setControlState('back', false);
      game.clearControlStates();
      await sleep(300);
      break;

    case 'jump':
      game.setControlState('jump', true);
      await sleep(200);
      game.setControlState('jump', false);
      game.clearControlStates();
      await sleep(300);
      break;

    case 'sidestep':
      game.setControlState('left', true);
      await sleep(200);
      game.setControlState('left', false);
      await sleep(100);
      game.setControlState('right', true);
      await sleep(200);
      game.setControlState('right', false);
      game.clearControlStates();
      await sleep(200);
      break;

    case 'reset':
      nav.stop();
      game.clearControlStates();
      await sleep(500);
      break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
