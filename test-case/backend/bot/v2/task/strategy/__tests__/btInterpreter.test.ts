/**
 * BTInterpreter 单测（FEAT-CROSS-07 R3）。
 * node:test + node:assert/strict，全 mock 执行器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BTInterpreter, bindArgs } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/strategy/btInterpreter.js';
import type { BTExecutors } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/strategy/btInterpreter.js';
import type { BTNode, BTResult } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/strategy/strategyTypes.js';

/** 调用记录条目。 */
interface Call {
  kind: 'atomic' | 'behavior' | 'strategy' | 'condition';
  name: string;
  args: Record<string, unknown>;
}

/**
 * 构造 mock 执行器，calls 记录所有 dispatch，便于断言。
 * 结果可通过回调定制（记录始终保留，不被结果回调覆盖）。
 */
interface MakeExecOpts {
  atomicResult?: (name: string) => { ok: boolean; detail?: string };
  behaviorResult?: (name: string) => { ok: boolean; detail?: string };
  strategyResult?: (name: string) => BTResult;
  conditionResult?: (check: string) => boolean;
  isPreempted?: () => boolean;
}
function makeExec(opts: MakeExecOpts = {}): { exec: BTExecutors; calls: Call[] } {
  const calls: Call[] = [];
  const exec: BTExecutors = {
    runAtomic: async (atomic, args) => {
      calls.push({ kind: 'atomic', name: atomic, args });
      return opts.atomicResult ? opts.atomicResult(atomic) : { ok: true };
    },
    runBehavior: async (behavior, args) => {
      calls.push({ kind: 'behavior', name: behavior, args });
      return opts.behaviorResult ? opts.behaviorResult(behavior) : { ok: true };
    },
    runStrategy: async (strategyId, args) => {
      calls.push({ kind: 'strategy', name: strategyId, args });
      return opts.strategyResult ? opts.strategyResult(strategyId) : ({ status: 'success' } as BTResult);
    },
    checkCondition: (check, args) => {
      calls.push({ kind: 'condition', name: check, args });
      return opts.conditionResult ? opts.conditionResult(check) : true;
    },
    isPreempted: opts.isPreempted,
  };
  return { exec, calls };
}

const atomic = (name: string, args?: Record<string, unknown>): BTNode => ({ type: 'action', atomic: name, args });

test('sequence: 全成 → success', async () => {
  const { exec, calls } = makeExec();
  const bt: BTNode = { type: 'sequence', children: [atomic('a'), atomic('b'), atomic('c')] };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'success');
  assert.equal(r.steps, 3);
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b', 'c']);
});

test('sequence: 中途 action failure → sequence failure 且后续不执行', async () => {
  const { exec, calls } = makeExec({
    atomicResult: (name) => ({ ok: name !== 'b', detail: `ran ${name}` }),
  });
  const bt: BTNode = { type: 'sequence', children: [atomic('a'), atomic('b'), atomic('c')] };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'failure');
  // c 不应被执行
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b']);
});

test('fallback: 第一个失败第二个成功 → success', async () => {
  const { exec, calls } = makeExec({
    atomicResult: (name) => ({ ok: name === 'b' }),
  });
  const bt: BTNode = { type: 'fallback', children: [atomic('a'), atomic('b'), atomic('c')] };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'success');
  // a 失败 → 试 b 成功 → c 不执行
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b']);
});

test('condition: 真 → 走主干 (success)', async () => {
  const { exec } = makeExec({ conditionResult: () => true });
  const bt: BTNode = { type: 'condition', check: 'has_weapon' };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'success');
});

test('condition: 假 + 有 fallback → 走 fallback 子树', async () => {
  const { exec, calls } = makeExec({ conditionResult: () => false });
  const bt: BTNode = {
    type: 'condition',
    check: 'has_weapon',
    fallback: atomic('craft_sword'),
  };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'success');
  assert.ok(calls.some((c) => c.kind === 'atomic' && c.name === 'craft_sword'));
});

test('condition: 假 + 无 fallback → failure', async () => {
  const { exec } = makeExec({ conditionResult: () => false });
  const bt: BTNode = { type: 'condition', check: 'has_weapon' };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'failure');
});

test('action: 三种源分别 dispatch 到对应执行器', async () => {
  const { exec, calls } = makeExec();
  const seq: BTNode = {
    type: 'sequence',
    children: [
      { type: 'action', atomic: 'mine' },
      { type: 'action', behavior: 'flee' },
      { type: 'action', strategy: 'kill_zombie' },
    ],
  };
  const r = await new BTInterpreter(exec).run(seq);
  assert.equal(r.status, 'success');
  const dispatched = calls.filter((c) => c.kind !== 'condition');
  assert.deepEqual(
    dispatched.map((c) => `${c.kind}:${c.name}`),
    ['atomic:mine', 'behavior:flee', 'strategy:kill_zombie'],
  );
});

test('action: 无执行源 → failure', async () => {
  const { exec } = makeExec();
  const bt: BTNode = { type: 'action' };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'failure');
});

test('loop: until 第 N 次为真 → success 且 child 跑了 N 次', async () => {
  const N = 3;
  let untilCalls = 0;
  let childRuns = 0;
  const exec: BTExecutors = {
    runAtomic: async () => {
      childRuns += 1;
      return { ok: true };
    },
    runBehavior: async () => ({ ok: true }),
    runStrategy: async () => ({ status: 'success' }),
    // 第 1、2、3 次查询为 false，第 4 次（已跑 3 次 child 后）为 true
    checkCondition: () => {
      const done = untilCalls >= N;
      untilCalls += 1;
      return done;
    },
  };
  const bt: BTNode = { type: 'loop', until: 'done', child: atomic('step') };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'success');
  assert.equal(childRuns, N, 'child 应恰好跑 N 次');
  assert.equal(r.steps, N);
});

test('loop: until 一开始就真 → 0 次执行直接 success', async () => {
  let childRuns = 0;
  const exec: BTExecutors = {
    runAtomic: async () => {
      childRuns += 1;
      return { ok: true };
    },
    runBehavior: async () => ({ ok: true }),
    runStrategy: async () => ({ status: 'success' }),
    checkCondition: () => true,
  };
  const bt: BTNode = { type: 'loop', until: 'done', child: atomic('step') };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'success');
  assert.equal(childRuns, 0);
});

test('loop: 到 maxIterations 仍未满足 until → failure', async () => {
  const exec: BTExecutors = {
    runAtomic: async () => ({ ok: true }),
    runBehavior: async () => ({ ok: true }),
    runStrategy: async () => ({ status: 'success' }),
    checkCondition: () => false, // 永不满足
  };
  const bt: BTNode = { type: 'loop', until: 'never', child: atomic('step'), maxIterations: 5 };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'failure');
});

test('loop: child 失败 → 整个 loop failure', async () => {
  const exec: BTExecutors = {
    runAtomic: async () => ({ ok: false }),
    runBehavior: async () => ({ ok: true }),
    runStrategy: async () => ({ status: 'success' }),
    checkCondition: () => false,
  };
  const bt: BTNode = { type: 'loop', until: 'done', child: atomic('step'), maxIterations: 10 };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'failure');
  assert.match(r.detail ?? '', /child failed/);
});

test('参数绑定: {"entity":"{target}"} + bindings{target:123} → 执行器收到 {entity:123}', async () => {
  const { exec, calls } = makeExec();
  const bt: BTNode = { type: 'action', atomic: 'attack', args: { entity: '{target}' } };
  await new BTInterpreter(exec).run(bt, { target: 123 });
  const call = calls.find((c) => c.kind === 'atomic');
  assert.ok(call);
  assert.deepEqual(call!.args, { entity: 123 });
});

test('参数绑定: 兼容经验策略产出的 ${name} 语法', async () => {
  const { exec, calls } = makeExec();
  const bt: BTNode = {
    type: 'action',
    behavior: 'gather_block',
    args: { blockName: '${blockName}', pos: '${targetPos}', toolName: '${toolName}' },
  };
  await new BTInterpreter(exec).run(bt, {
    blockName: 'oak_log',
    targetPos: { x: 1, y: 64, z: 2 },
    toolName: 'hand',
  });
  const call = calls.find((c) => c.kind === 'behavior');
  assert.deepEqual(call?.args, {
    blockName: 'oak_log',
    pos: { x: 1, y: 64, z: 2 },
    toolName: 'hand',
  });
});

test('参数绑定: 兼容 $name 与 $positions[0] 语法', () => {
  const out = bindArgs(
    { block: '$targetBlock', pos: '$positions[0]', missing: '$positions[2]' },
    { targetBlock: 'iron_ore', positions: [{ x: 20, y: -60, z: 0 }] },
  );
  assert.deepEqual(out, {
    block: 'iron_ore',
    pos: { x: 20, y: -60, z: 0 },
    missing: '$positions[2]',
  });
});

test('参数绑定: 深度遍历 + 仅替换整串占位 + 缺失绑定原样保留', () => {
  const out = bindArgs(
    { a: '{target}', b: ['{x}', 'literal', { c: '{y}' }], d: 'prefix-{z}' },
    { target: 42, x: 'hi', y: true },
  );
  assert.deepEqual(out, {
    a: 42,
    b: ['hi', 'literal', { c: true }],
    d: 'prefix-{z}', // 非整串占位 → 原样
  });
});

test('抢占: isPreempted 返回 true → status preempted，执行器未被调用', async () => {
  const { exec, calls } = makeExec({ isPreempted: () => true });
  const bt: BTNode = { type: 'sequence', children: [atomic('a'), atomic('b')] };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'preempted');
  assert.equal(calls.length, 0, '抢占后不应调用任何执行器');
});

test('抢占: sequence 执行中途被抢占 → 立即冒泡 preempted', async () => {
  let preempt = false;
  const calls: string[] = [];
  const exec: BTExecutors = {
    runAtomic: async (name) => {
      calls.push(name);
      if (name === 'a') preempt = true; // 跑完 a 后触发抢占
      return { ok: true };
    },
    runBehavior: async () => ({ ok: true }),
    runStrategy: async () => ({ status: 'success' }),
    checkCondition: () => true,
    isPreempted: () => preempt,
  };
  const bt: BTNode = { type: 'sequence', children: [atomic('a'), atomic('b')] };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'preempted');
  assert.deepEqual(calls, ['a'], 'b 不应被执行');
});

test('递归: action.strategy → runStrategy 被调，其返回 status 透传', async () => {
  const { exec, calls } = makeExec({
    strategyResult: () => ({ status: 'failure', detail: 'sub failed' }),
  });
  const bt: BTNode = { type: 'action', strategy: 'sub_strategy', args: { foo: 'bar' } };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'failure'); // 透传子 strategy 的 failure
  const call = calls.find((c) => c.kind === 'strategy');
  assert.ok(call);
  assert.equal(call!.name, 'sub_strategy');
});

test('递归: 子 strategy preempted → 透传 preempted', async () => {
  const { exec } = makeExec({
    strategyResult: () => ({ status: 'preempted' }),
  });
  const bt: BTNode = { type: 'action', strategy: 'sub' };
  const r = await new BTInterpreter(exec).run(bt);
  assert.equal(r.status, 'preempted');
});
