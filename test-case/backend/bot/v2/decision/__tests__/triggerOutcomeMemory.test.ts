/**
 * FEAT-L6-04 · TriggerOutcomeMemory 单元测试（回边③）
 *
 * 覆盖：
 *   1. 未登记的 task 终态 → 无副作用
 *   2. 连败退避时长：1→60s · 2→5min · ≥3→30min
 *   3. escalate 仅在连败 ≥3 时为 true
 *   4. 不同 code 分桶互不影响
 *   5. 任一次成功 → 清该 trigger 全部桶
 *   6. 退避到期后自动放行
 *   7. blockAll 战后全局冷却（R5）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TriggerOutcomeMemory } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/triggerOutcomeMemory.js';

/** 可控时钟 */
function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('TriggerOutcomeMemory · FEAT-L6-04', () => {
  it('1) 未登记 task 的终态 → 无副作用，consult 放行', () => {
    const m = new TriggerOutcomeMemory(makeClock().now);
    m.noteTerminal('task-x', { code: 'no_resource_found' });
    assert.equal(m.consult('T-GATHER-WOOD').allow, true);
  });

  it('2) 连败退避时长：1→60s · 2→5min · ≥3→30min', () => {
    const clk = makeClock();
    const m = new TriggerOutcomeMemory(clk.now);

    // 连败 1 → 60s
    m.record('T-GATHER-WOOD', 't1');
    m.noteTerminal('t1', { code: 'no_resource_found' });
    let c = m.consult('T-GATHER-WOOD');
    assert.equal(c.allow, false);
    assert.equal(c.untilMs, 60_000);
    assert.equal(c.escalate ?? false, false);

    // 连败 2 → 5min
    m.record('T-GATHER-WOOD', 't2');
    m.noteTerminal('t2', { code: 'no_resource_found' });
    c = m.consult('T-GATHER-WOOD');
    assert.equal(c.untilMs, 5 * 60_000);
    assert.equal(c.escalate ?? false, false);

    // 连败 3 → 30min + escalate
    m.record('T-GATHER-WOOD', 't3');
    m.noteTerminal('t3', { code: 'no_resource_found' });
    c = m.consult('T-GATHER-WOOD');
    assert.equal(c.untilMs, 30 * 60_000);
    assert.equal(c.escalate, true);
  });

  it('3) 不同 code 分桶互不影响', () => {
    const m = new TriggerOutcomeMemory(makeClock().now);
    m.record('T-GATHER-WOOD', 'a');
    m.noteTerminal('a', { code: 'no_resource_found' });
    m.record('T-GATHER-WOOD', 'b');
    m.noteTerminal('b', { code: 'nav_timeout' });
    // 两个 code 各连败 1 次 → 各自 60s，无 escalate
    const c = m.consult('T-GATHER-WOOD');
    assert.equal(c.allow, false);
    assert.equal(c.escalate ?? false, false);
  });

  it('4) 任一次成功 → 清该 trigger 全部退避桶', () => {
    const clk = makeClock();
    const m = new TriggerOutcomeMemory(clk.now);
    m.record('T-GATHER-WOOD', 'a'); m.noteTerminal('a', { code: 'no_resource_found' });
    m.record('T-GATHER-WOOD', 'b'); m.noteTerminal('b', { code: 'nav_timeout' });
    assert.equal(m.consult('T-GATHER-WOOD').allow, false);

    m.record('T-GATHER-WOOD', 'c'); m.noteTerminal('c', 'completed');
    assert.equal(m.consult('T-GATHER-WOOD').allow, true, '成功后应清零放行');
  });

  it('5) 退避到期后自动放行', () => {
    const clk = makeClock();
    const m = new TriggerOutcomeMemory(clk.now);
    m.record('T-GATHER-WOOD', 'a'); m.noteTerminal('a', { code: 'no_resource_found' }); // 60s
    assert.equal(m.consult('T-GATHER-WOOD').allow, false);
    clk.advance(60_001);
    assert.equal(m.consult('T-GATHER-WOOD').allow, true);
  });

  it('6) 退避不影响其他 trigger', () => {
    const m = new TriggerOutcomeMemory(makeClock().now);
    m.record('T-GATHER-WOOD', 'a'); m.noteTerminal('a', { code: 'no_resource_found' });
    assert.equal(m.consult('T-GATHER-WOOD').allow, false);
    assert.equal(m.consult('T-LOW-FOOD').allow, true);
  });

  it('7) blockAll 战后全局冷却阻断所有 trigger，到期解禁', () => {
    const clk = makeClock();
    const m = new TriggerOutcomeMemory(clk.now);
    m.blockAll(5 * 60_000, '战后冷却');
    assert.equal(m.consult('T-GATHER-WOOD').allow, false);
    assert.equal(m.consult('T-LOW-FOOD').allow, false);
    clk.advance(5 * 60_000 + 1);
    assert.equal(m.consult('T-GATHER-WOOD').allow, true);
  });
});
