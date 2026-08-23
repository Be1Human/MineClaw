/**
 * 🛑 NavStuckSentinel — 贪心卡死判定（FEAT-L1-07）
 *
 * pathfinder 的「摸黑贪心」对开阔地形够用，唯一会卡死的场景：
 * 直线方向有大障碍、绕路需先远离目标 → 贪心(h 最小)不肯后退 → 卡在障碍正面。
 *
 * 本哨兵判定一次 L0 直冲失败「是不是这种值得升级绕路的卡死」：
 *   - cancelled            → false（不是卡死，是被打断）
 *   - 失败但已贴近目标      → false（已尽力，绕也没用，直接放弃）
 *   - 失败且距目标仍远      → true （贪心撞墙，值得 L1 绕路）
 */

import type { Vec3, NavResult } from '../../adapter/types.js';
import { tuning } from '../infra/tuning.js';

export class NavStuckSentinel {
  /**
   * @param here       当前坐标
   * @param goal       目标坐标
   * @param lastResult L0 gotoWithRecovery 的结果
   */
  isGreedyStuck(here: Vec3, goal: Vec3, lastResult: NavResult): boolean {
    if (lastResult.ok) return false;
    if (lastResult.reason === 'cancelled') return false;

    const dx = goal.x - here.x;
    const dz = goal.z - here.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    // 失败时已贴近目标 → 视为已尽力（够不到的最后一格等），不绕路
    return horizDist > tuning().nav.stuckArriveDist;
  }
}
