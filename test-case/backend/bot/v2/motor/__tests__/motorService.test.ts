/**
 * FEAT-CROSS-02 阶段一 · MotorService 抢占语义单测
 *
 * 覆盖 4 条规则：空闲执行 / 高优抢占(preempted) / 低优拒绝(motor_busy) / 同 owner 替换；
 * + pulse 被抢占时控制键全释放。
 * Framework: node:test + node:assert/strict
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MotorService } from '../../../../../../apps/minecraft-companion/src/bot/v2/motor/motorService.js';
import type { GameAdapter } from '../../../../../../apps/minecraft-companion/src/bot/adapter/GameAdapter.js';
import type { NavigationAdapter, NavGoal } from '../../../../../../apps/minecraft-companion/src/bot/adapter/NavigationAdapter.js';
import type { NavResult } from '../../../../../../apps/minecraft-companion/src/bot/adapter/types.js';

// ── mocks ──────────────────────────────────────────────────────────────────

interface Deferred { promise: Promise<NavResult>; resolve: (r: NavResult) => void }
function defer(): Deferred {
  let resolve!: (r: NavResult) => void;
  const promise = new Promise<NavResult>((res) => { resolve = res; });
  return { promise, resolve };
}

function makeMocks() {
  const ctrl: Record<string, boolean> = {};
  const events = { clearCount: 0, gotoCount: 0, stopCount: 0, followStart: 0, followStop: 0 };
  let pending: Deferred | null = null;

  const game = {
    setControlState: (k: string, v: boolean) => { ctrl[k] = v; },
    clearControlStates: () => { events.clearCount++; for (const k of Object.keys(ctrl)) ctrl[k] = false; },
    lookAt: async () => {},
  } as unknown as GameAdapter;

  const nav = {
    goto: (_goal: NavGoal) => {
      events.gotoCount++;
      pending = defer();
      return pending.promise;
    },
    stop: () => {
      events.stopCount++;
      // 模拟真实适配器：stop 让在途 goto 以 cancelled resolve
      pending?.resolve({ ok: false, reason: 'cancelled' });
      pending = null;
    },
    startFollow: () => { events.followStart++; return { ok: true }; },
    stopFollow: () => { events.followStop++; },
  } as unknown as NavigationAdapter;

  return { game, nav, ctrl, events, resolveGoto: (r: NavResult) => pending?.resolve(r) };
}

const GOTO = (budgetMs = 10000): { kind: 'goto'; goal: NavGoal; budgetMs: number } =>
  ({ kind: 'goto', goal: { type: 'block', position: { x: 0, y: 0, z: 0 } }, budgetMs });

// ── tests ────────────────────────────────────────────────────────────────────

describe('FEAT-CROSS-02 · MotorService 抢占语义', () => {
  test('规则1 · 空闲 → 直接执行并在 goto 完成时返回结果', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);
    const p = svc.run('a', 30, GOTO());
    assert.equal(svc.isBusy(), true);
    assert.equal(m.events.gotoCount, 1);
    m.resolveGoto({ ok: true });
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(svc.isBusy(), false);
  });

  test('规则2 · 高优抢占 → 旧程序 resolve preempted，新程序开跑', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);
    const pLow = svc.run('task', 30, GOTO());
    const pHigh = svc.run('recovery', 95, GOTO());
    const rLow = await pLow;
    assert.equal(rLow.preempted, true, '旧程序应被抢占');
    assert.equal(svc.current()?.owner, 'recovery', '当前应为高优 owner');
    assert.equal(m.events.gotoCount, 2, '新程序应发起第二次 goto');
    m.resolveGoto({ ok: true });
    assert.equal((await pHigh).ok, true);
  });

  test('规则3 · 低优 → 立即 motor_busy，不打断当前', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);
    const pHigh = svc.run('recovery', 95, GOTO());
    const rLow = await svc.run('task', 30, GOTO());
    assert.equal(rLow.ok, false);
    assert.equal(rLow.reason, 'motor_busy');
    assert.equal(svc.current()?.owner, 'recovery', '当前仍是高优');
    m.resolveGoto({ ok: true });
    assert.equal((await pHigh).ok, true);
  });

  test('规则4 · 同 owner 重复 → 替换（旧 preempted，新开跑）', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);
    const p1 = svc.run('x', 30, GOTO());
    const p2 = svc.run('x', 30, GOTO());
    assert.equal((await p1).preempted, true);
    assert.equal(m.events.gotoCount, 2);
    m.resolveGoto({ ok: true });
    assert.equal((await p2).ok, true);
  });

  test('pulse 被抢占 → 控制键全释放', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);
    const pPulse = svc.run('walk', 30, { kind: 'pulse', keys: ['forward', 'jump'], durationMs: 9999 });
    assert.equal(m.ctrl['forward'], true);
    assert.equal(m.ctrl['jump'], true);
    const pGoto = svc.run('recovery', 95, GOTO());
    const rPulse = await pPulse;
    assert.equal(rPulse.preempted, true);
    assert.equal(m.ctrl['forward'], false, 'forward 应被释放');
    assert.equal(m.ctrl['jump'], false, 'jump 应被释放');
    m.resolveGoto({ ok: true });
    await pGoto;
  });

  test('cancel(无 owner) → 全停 + clearControlStates', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);
    const p = svc.run('a', 30, GOTO());
    svc.cancel();
    const r = await p;
    assert.equal(r.reason, 'cancelled');
    assert.equal(svc.isBusy(), false);
    assert.ok(m.events.stopCount >= 1);
  });

  test('stop 程序 → 立即完成 + 触发 nav.stop', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);
    const r = await svc.run('x', 50, { kind: 'stop' });
    assert.equal(r.ok, true);
    assert.ok(m.events.stopCount >= 1);
    assert.equal(svc.isBusy(), false);
  });

  test('持续 follow 由 MotorService 启动，下一段运动和 cancel 都会撤销它', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);
    const follow = await svc.run('follow-task', 40, { kind: 'follow', entityId: 7, range: 3 });
    assert.equal(follow.ok, true);
    assert.equal(m.events.followStart, 1);
    svc.cancel('follow-task');
    assert.equal(m.events.followStop, 1);
    await svc.run('follow-task', 40, { kind: 'follow', entityId: 7, range: 3 });
    const moving = svc.run('move-task', 45, GOTO());
    assert.equal(m.events.followStop, 2);
    m.resolveGoto({ ok: true });
    assert.equal((await moving).ok, true);
  });

  test('同一稳定 owner 的 follow 重提交保持动态目标，不会 stopFollow/startFollow 抖动', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);
    await svc.run('atomic:follow_strategy:follow_entity', 40, { kind: 'follow', entityId: 7, range: 3 });
    await svc.run('atomic:follow_strategy:follow_entity', 40, { kind: 'follow', entityId: 7, range: 3 });

    assert.equal(m.events.followStart, 2, '允许重提交以更新 GoalFollow');
    assert.equal(m.events.followStop, 0, '同一 owner 不得在每 tick 先撤销动态跟随');
  });

  test('BUG-CROSS-03 · follow→goto 抢占、goto→follow 恢复、取消全程单一所有权', async () => {
    const m = makeMocks();
    const svc = new MotorService(m);

    assert.equal((await svc.run('follow-task', 40, { kind: 'follow', entityId: 7, range: 3 })).ok, true);
    assert.equal(m.events.followStart, 1);

    const moving = svc.run('goto-task', 45, GOTO());
    assert.equal(m.events.followStop, 1, 'goto 接管前必须撤销动态 follow');
    assert.equal(svc.current()?.owner, 'goto-task');
    m.resolveGoto({ ok: true });
    assert.equal((await moving).ok, true);
    assert.equal(svc.current(), null);

    assert.equal((await svc.run('follow-task', 40, { kind: 'follow', entityId: 7, range: 3 })).ok, true);
    assert.equal(m.events.followStart, 2, '恢复的 follow 任务应重新发出自己的意图');
    svc.cancel('follow-task');
    assert.equal(m.events.followStop, 2, '取消恢复后的 follow 必须释放动态 goal');
    assert.equal(svc.isBusy(), false);
  });
});
