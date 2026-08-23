/**
 * BT Runner · 单元测试
 *
 * 测什么：
 *   1. seq   - 全成功/中途失败/running 记忆
 *   2. sel   - 第一个成功/全失败/running 记忆
 *   3. cond  - true/false
 *   4. action - emit ActionRequest / null=failure
 *   5. cooldown - 冷却期拒绝/冷却后放行
 *   6. inv   - 翻转
 *   7. timeLimit - 超时强制 failure
 *   8. parallel  - all_success / any_success
 *
 * 不需要 Minecraft 连接，完全内存测试。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { seq, sel, cond, action, cooldown, inv, timeLimit, parallel, repeat } from '../../../../../../../apps/minecraft-companion/src/bot/v2/strategy/bt/runner.js';
import type { BtContext } from '../../../../../../../apps/minecraft-companion/src/bot/v2/strategy/bt/nodes.js';
import type { ActionRequest, WorldStateView } from '../../../../../../../apps/minecraft-companion/src/bot/v2/types.js';

// ──────────────────────────────────────────────────────────────────
// 测试辅助
// ──────────────────────────────────────────────────────────────────

function makeCtx(tick = 1): BtContext {
  return {
    world: {} as WorldStateView,
    tick,
    requests: [],
    debug: { activeActions: [], lastFailure: null },
  };
}

function stubAR(id: string): ActionRequest {
  return {
    id,
    source: 'test',
    type: 'say',
    priority: 10,
    interrupt_level: 'soft',
    resource: [],
    preconditions: [],
    timeout_ms: 100,
  };
}

// ──────────────────────────────────────────────────────────────────
// seq
// ──────────────────────────────────────────────────────────────────

describe('seq', () => {
  it('全成功 → success', () => {
    const node = seq('s', [cond('t', () => true), cond('t2', () => true)]);
    assert.equal(node.tick(makeCtx()), 'success');
  });

  it('第一个 failure → failure，不执行后续', () => {
    let called = false;
    const node = seq('s', [
      cond('fail', () => false),
      cond('never', () => { called = true; return true; }),
    ]);
    assert.equal(node.tick(makeCtx()), 'failure');
    assert.equal(called, false, '第二个 cond 不应被调用');
  });

  it('中途 running → 记住索引，下次从该节点续跑', () => {
    let secondCalled = 0;
    const node = seq('s', [
      cond('ok', () => true),
      action('running_once', ctx => {
        secondCalled++;
        // 第一次 running，第二次 success（模拟异步完成）
        return secondCalled === 1 ? null : stubAR('done');
      }),
    ]);
    // 第一次：第二个节点 null → failure（action 返回 null = failure）
    // 修正：让 action 第一次返回一个 AR 使其 running，第二次不 emit
    // 重建：用计数控制
    let n = 0;
    const node2 = seq('s2', [
      cond('ok', () => true),
      { label: 'maybe_running', tick: () => { n++; return n === 1 ? 'running' : 'success'; }, reset() { n = 0; } },
    ]);
    assert.equal(node2.tick(makeCtx(1)), 'running');  // 第一次 running
    assert.equal(node2.tick(makeCtx(2)), 'success');  // 第二次成功（从 idx=1 续跑）
  });

  it('failure 后重置 running 索引', () => {
    let n = 0;
    const node = seq('s', [
      { label: 'toggle', tick: () => { n++; return n % 2 === 0 ? 'failure' : 'running'; }, reset() { n = 0; } },
    ]);
    assert.equal(node.tick(makeCtx(1)), 'running');
    assert.equal(node.tick(makeCtx(2)), 'failure');
    assert.equal(node.tick(makeCtx(3)), 'running'); // 重置后从头来
  });
});

// ──────────────────────────────────────────────────────────────────
// sel
// ──────────────────────────────────────────────────────────────────

describe('sel', () => {
  it('第一个 success → success，不执行后续', () => {
    let called = false;
    const node = sel('s', [
      cond('ok', () => true),
      cond('never', () => { called = true; return true; }),
    ]);
    assert.equal(node.tick(makeCtx()), 'success');
    assert.equal(called, false);
  });

  it('全 failure → failure', () => {
    const node = sel('s', [cond('f1', () => false), cond('f2', () => false)]);
    assert.equal(node.tick(makeCtx()), 'failure');
  });

  it('第一个 failure 后试第二个', () => {
    const node = sel('s', [cond('fail', () => false), cond('ok', () => true)]);
    assert.equal(node.tick(makeCtx()), 'success');
  });

  it('running 记忆：下次从 running 子节点续', () => {
    let n = 0;
    const node = sel('s', [
      cond('fail', () => false),
      { label: 'r', tick: () => { n++; return n === 1 ? 'running' : 'success'; }, reset() { n = 0; } },
    ]);
    assert.equal(node.tick(makeCtx(1)), 'running');
    assert.equal(node.tick(makeCtx(2)), 'success');
  });
});

// ──────────────────────────────────────────────────────────────────
// cond
// ──────────────────────────────────────────────────────────────────

describe('cond', () => {
  it('fn=true → success', () => {
    assert.equal(cond('c', () => true).tick(makeCtx()), 'success');
  });
  it('fn=false → failure', () => {
    assert.equal(cond('c', () => false).tick(makeCtx()), 'failure');
  });
  it('能读 ctx.world', () => {
    const ctx = makeCtx();
    (ctx.world as unknown as { hp: number }).hp = 5;
    const node = cond('hp', c => (c.world as unknown as { hp: number }).hp <= 6);
    assert.equal(node.tick(ctx), 'success');
  });
});

// ──────────────────────────────────────────────────────────────────
// action
// ──────────────────────────────────────────────────────────────────

describe('action', () => {
  it('emit AR → running，并压入 ctx.requests', () => {
    const ctx = makeCtx();
    const node = action('a', () => stubAR('r1'));
    const status = node.tick(ctx);
    assert.equal(status, 'running');
    assert.equal(ctx.requests.length, 1);
    assert.equal(ctx.requests[0].id, 'r1');
  });

  it('emit 多个 AR（数组）', () => {
    const ctx = makeCtx();
    const node = action('a', () => [stubAR('r1'), stubAR('r2')]);
    node.tick(ctx);
    assert.equal(ctx.requests.length, 2);
  });

  it('fn 返回 null → failure，不 emit', () => {
    const ctx = makeCtx();
    const node = action('a', () => null);
    assert.equal(node.tick(ctx), 'failure');
    assert.equal(ctx.requests.length, 0);
  });

  it('emit 后 debug.activeActions 记录节点标签', () => {
    const ctx = makeCtx();
    action('my_action', () => stubAR('x')).tick(ctx);
    assert.ok(ctx.debug.activeActions.includes('my_action'));
  });
});

// ──────────────────────────────────────────────────────────────────
// cooldown
// ──────────────────────────────────────────────────────────────────

describe('cooldown', () => {
  it('第一次放行', () => {
    const ctx = makeCtx();
    const node = cooldown(1000, action('a', () => stubAR('x')));
    assert.equal(node.tick(ctx), 'running');
  });

  it('冷却期内拒绝（不执行子节点）', () => {
    let called = 0;
    const child = { label: 'c', tick: () => { called++; return 'success' as const; }, reset() {} };
    const node = cooldown(60_000, child); // 1 分钟冷却
    node.tick(makeCtx(1));   // 第一次放行，called=1
    node.tick(makeCtx(2));   // 冷却中，called 不增
    assert.equal(called, 1);
  });

  it('reset() 清空冷却计时', () => {
    let called = 0;
    const child = { label: 'c', tick: () => { called++; return 'success' as const; }, reset() {} };
    const node = cooldown(60_000, child);
    node.tick(makeCtx(1));   // called=1
    node.reset();
    node.tick(makeCtx(2));   // 重置后再次放行，called=2
    assert.equal(called, 2);
  });
});

// ──────────────────────────────────────────────────────────────────
// inv
// ──────────────────────────────────────────────────────────────────

describe('inv', () => {
  it('success → failure', () => {
    assert.equal(inv(cond('t', () => true)).tick(makeCtx()), 'failure');
  });
  it('failure → success', () => {
    assert.equal(inv(cond('f', () => false)).tick(makeCtx()), 'success');
  });
  it('running → running', () => {
    const running = { label: 'r', tick: () => 'running' as const, reset() {} };
    assert.equal(inv(running).tick(makeCtx()), 'running');
  });
});

// ──────────────────────────────────────────────────────────────────
// timeLimit
// ──────────────────────────────────────────────────────────────────

describe('timeLimit', () => {
  it('子节点快速成功 → 透传 success', () => {
    const node = timeLimit(1000, cond('ok', () => true));
    assert.equal(node.tick(makeCtx()), 'success');
  });

  it('超时 → failure + 记录 lastFailure', async () => {
    const alwaysRunning = { label: 'r', tick: () => 'running' as const, reset() {} };
    const node = timeLimit(10, alwaysRunning); // 10ms 超时
    node.tick(makeCtx(1)); // 启动计时
    await new Promise(r => setTimeout(r, 20));  // 等超时
    const ctx = makeCtx(2);
    assert.equal(node.tick(ctx), 'failure');
    assert.ok(ctx.debug.lastFailure?.reason === 'time_limit');
  });
});

// ──────────────────────────────────────────────────────────────────
// parallel
// ──────────────────────────────────────────────────────────────────

describe('parallel', () => {
  it('all_success：全成功 → success', () => {
    const node = parallel('p', 'all_success', [cond('t', () => true), cond('t2', () => true)]);
    assert.equal(node.tick(makeCtx()), 'success');
  });
  it('all_success：一个失败 → failure', () => {
    const node = parallel('p', 'all_success', [cond('t', () => true), cond('f', () => false)]);
    assert.equal(node.tick(makeCtx()), 'failure');
  });
  it('any_success：一个成功 → success', () => {
    const node = parallel('p', 'any_success', [cond('f', () => false), cond('t', () => true)]);
    assert.equal(node.tick(makeCtx()), 'success');
  });
  it('any_success：全失败 → failure', () => {
    const node = parallel('p', 'any_success', [cond('f', () => false), cond('f2', () => false)]);
    assert.equal(node.tick(makeCtx()), 'failure');
  });
  it('有 running → 整体 running（仍执行全部子节点）', () => {
    let secondCalled = false;
    const r = { label: 'run', tick: () => 'running' as const, reset() {} };
    const s = { label: 'suc', tick: () => { secondCalled = true; return 'success' as const; }, reset() {} };
    const node = parallel('p', 'all_success', [r, s]);
    assert.equal(node.tick(makeCtx()), 'running');
    assert.equal(secondCalled, true, 'parallel 应执行所有子节点');
  });
});

// ──────────────────────────────────────────────────────────────────
// repeat
// ──────────────────────────────────────────────────────────────────

describe('repeat', () => {
  it('重复 N 次成功后返回 success', () => {
    let n = 0;
    const child = { label: 'c', tick: () => { n++; return 'success' as const; }, reset() { n = 0; } };
    const node = repeat(3, child);
    assert.equal(node.tick(makeCtx(1)), 'running'); // 1/3
    assert.equal(node.tick(makeCtx(2)), 'running'); // 2/3
    assert.equal(node.tick(makeCtx(3)), 'success'); // 3/3
    assert.equal(n, 3);
  });
  it('子节点 failure → 立即 failure', () => {
    const node = repeat(3, cond('f', () => false));
    assert.equal(node.tick(makeCtx()), 'failure');
  });
});
