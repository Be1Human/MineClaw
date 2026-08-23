/**
 * 🦿 MotorService · 唯一运动执行通道（FEAT-CROSS-02 · 阶段一）
 *
 * 抢占语义（核心规则 4 条）：
 *   1. 空闲 run()                  → 直接执行
 *   2. 忙 · 新 priority > 当前      → 抢占：旧程序 resolve {ok:false,preempted:true} → 停 → 跑新的
 *   3. 忙 · 新 priority ≤ 当前      → 立即返回 {ok:false,reason:'motor_busy'}（不排队，排队留给仲裁器）
 *   4. 同 owner 重复 run()         → 视为替换：先取消自己旧程序再执行新的
 *
 * 程序执行：
 *   - goto ：委托 NavigationAdapter.goto(goal,{thinkTimeout,totalTimeout:budgetMs})；结束强制 clearControlStates
 *   - pulse：可选 lookAt → 逐键按下 → setTimeout(durationMs) → 逐键释放 + clearControlStates；被抢占即释放
 *   - stop ：navRouter.cancel() + nav.stop() + clearControlStates()
 */

import type { GameAdapter } from '../../adapter/GameAdapter.js';
import type { NavigationAdapter } from '../../adapter/NavigationAdapter.js';
import type { IMotorService, MotorProgram, MotorResult, MotorTicket } from './types.js';

export interface MotorDeps {
  game: GameAdapter;
  nav: NavigationAdapter;
  /** 可选 · 全局粗规划路由（stop 时一并 cancel） */
  navRouter?: { cancel(): void } | null;
  onLog?: (msg: string) => void;
}

interface Active {
  ticket: MotorTicket;
  resolve: (r: MotorResult) => void;
  resolved: boolean;
  /** 抢占/取消时调用：停 nav / 清定时器 / 释放控制键 */
  cleanup: () => void;
}

export class MotorService implements IMotorService {
  private active: Active | null = null;
  /** 动态跟随由 nav 后台持续驱动；任何下一段运动开始前必须经这里撤销。 */
  private followOwner: string | null = null;
  private readonly game: GameAdapter;
  private readonly nav: NavigationAdapter;
  private readonly navRouter: { cancel(): void } | null;
  private readonly log: (msg: string) => void;

  constructor(deps: MotorDeps) {
    this.game = deps.game;
    this.nav = deps.nav;
    this.navRouter = deps.navRouter ?? null;
    this.log = deps.onLog ?? (() => {});
  }

  run(owner: string, priority: number, program: MotorProgram): Promise<MotorResult> {
    if (this.followOwner && (program.kind !== 'follow' || this.followOwner !== owner)) {
      this.nav.stopFollow();
      this.followOwner = null;
    }
    if (this.active && !this.active.resolved) {
      const cur = this.active.ticket;
      if (owner === cur.owner) {
        this.log(`[motor] ${owner} 替换自身程序`);
        this.preempt();                       // 规则 4
      } else if (priority > cur.priority) {
        this.log(`[motor] ${owner}(P${priority}) 抢占 ${cur.owner}(P${cur.priority})`);
        this.preempt();                       // 规则 2
      } else {
        return Promise.resolve({ ok: false, reason: 'motor_busy' });  // 规则 3
      }
    }
    return this.start(owner, priority, program);  // 规则 1
  }

  current(): MotorTicket | null {
    return this.active && !this.active.resolved ? this.active.ticket : null;
  }

  isBusy(): boolean {
    return !!this.active && !this.active.resolved;
  }

  cancel(owner?: string): void {
    if (!this.active || this.active.resolved) {
      if (this.followOwner && (!owner || this.followOwner === owner)) {
        try { this.nav.stopFollow(); } catch { /* ignore */ }
        this.followOwner = null;
      }
      if (!owner) this.doStop();  // 无条件全停（即使空闲也清键，作兜底）
      return;
    }
    if (owner && this.active.ticket.owner !== owner) return;  // 指定 owner 不匹配 → 不动
    const a = this.active;
    a.resolved = true;
    a.cleanup();
    if (this.active === a) this.active = null;
    a.resolve({ ok: false, reason: 'cancelled' });
    if (!owner) this.doStop();
  }

  // ─────────────── 内部 ───────────────

  /** 抢占当前程序：resolve preempted + cleanup（不停后续，由 start 接管） */
  private preempt(): void {
    const a = this.active;
    if (!a || a.resolved) return;
    a.resolved = true;
    a.cleanup();
    if (this.active === a) this.active = null;
    a.resolve({ ok: false, preempted: true, reason: 'preempted' });
  }

  private start(owner: string, priority: number, program: MotorProgram): Promise<MotorResult> {
    const ticket: MotorTicket = { owner, priority, program, startedAt: Date.now() };
    return new Promise<MotorResult>((resolve) => {
      const active: Active = { ticket, resolve, resolved: false, cleanup: () => {} };
      this.active = active;
      const done = (r: MotorResult) => {
        if (active.resolved) return;
        active.resolved = true;
        if (this.active === active) this.active = null;
        resolve(r);
      };

      if (program.kind === 'stop') {
        this.doStop();
        done({ ok: true });
        return;
      }

      if (program.kind === 'follow') {
        const result = this.nav.startFollow(program.entityId, program.range, program.force);
        if (result.ok) this.followOwner = owner;
        done({ ok: result.ok, reason: result.reason });
        return;
      }

      if (program.kind === 'goto') {
        active.cleanup = () => this.doStop();
        this.nav
          .goto(program.goal, { thinkTimeout: program.thinkTimeoutMs ?? 5000, totalTimeout: program.budgetMs })
          .then((rr) => {
            try { this.game.clearControlStates(); } catch { /* ignore */ }
            done({ ok: rr.ok, reason: rr.ok ? undefined : (rr.reason || 'nav_failed') });
          })
          .catch((e) => {
            try { this.game.clearControlStates(); } catch { /* ignore */ }
            done({ ok: false, reason: e instanceof Error ? e.message : String(e) });
          });
        return;
      }

      // pulse
      if (program.lookAt) {
        void Promise.resolve(this.game.lookAt(program.lookAt, true)).catch(() => {});
      }
      for (const k of program.keys) this.game.setControlState(k, true);
      const timer = setTimeout(() => {
        for (const k of program.keys) this.game.setControlState(k, false);
        try { this.game.clearControlStates(); } catch { /* ignore */ }
        done({ ok: true });
      }, program.durationMs);
      active.cleanup = () => {
        clearTimeout(timer);
        for (const k of program.keys) this.game.setControlState(k, false);
        try { this.game.clearControlStates(); } catch { /* ignore */ }
      };
    });
  }

  /** 全停：取消粗规划 + 停 nav + 清控制键 */
  private doStop(): void {
    try { this.nav.stopFollow(); } catch { /* ignore */ }
    this.followOwner = null;
    try { this.navRouter?.cancel(); } catch { /* ignore */ }
    try { this.nav.stop(); } catch { /* ignore */ }
    try { this.game.clearControlStates(); } catch { /* ignore */ }
  }
}
