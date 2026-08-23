/**
 * StrategyStore 单测（FEAT-CROSS-07 R2/R6/R7）· 持久化 + 置信度生命周期。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { StrategyStore } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/strategy/strategyStore.js';
import { newLifecycle, type Strategy } from '../../../../../../../apps/minecraft-companion/src/bot/v2/task/strategy/strategyTypes.js';

let seq = 0;
function tmpDir(): string {
  const d = join(tmpdir(), `mineclaw-strat-${process.pid}-${++seq}-${Date.now()}`);
  return d;
}
function mkStrategy(id: string): Strategy {
  return {
    id, name: id, description: 'test', params: ['target'],
    applicability: { appliesTo: ['hostile_entity'], excludes: ['owner'] },
    bt: { type: 'action', atomic: 'attack', args: { entity: '{target}' } },
    lifecycle: newLifecycle(1000),
  };
}

test('SS-T1 · upsert + get + list + 持久化重载', () => {
  const dir = tmpDir();
  try {
    const s1 = new StrategyStore(dir);
    s1.upsert(mkStrategy('教训某人'));
    assert.equal(s1.get('教训某人')?.name, '教训某人');
    assert.equal(s1.list().length, 1);
    // 新实例从磁盘重载
    const s2 = new StrategyStore(dir);
    assert.equal(s2.get('教训某人')?.bt.type, 'action');
  } finally { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }
});

test('SS-T2 · recordRun 累计无降级成功 ≥ promoteN(3) → candidate 晋升 trusted', () => {
  const dir = tmpDir();
  try {
    const st = new StrategyStore(dir);
    st.upsert(mkStrategy('s'));
    assert.equal(st.get('s')!.lifecycle.state, 'candidate');
    st.recordRun('s', { ok: true });
    st.recordRun('s', { ok: true });
    assert.equal(st.get('s')!.lifecycle.state, 'candidate', '2 次还不够');
    st.recordRun('s', { ok: true });
    assert.equal(st.get('s')!.lifecycle.state, 'trusted', '第3次无降级成功 → 晋升');
    assert.ok(st.get('s')!.lifecycle.confidence > 0.9);
  } finally { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }
});

test('SS-T3 · 安全违规一次 → 拉黑 + 置信度清零 + 不再 usable', () => {
  const dir = tmpDir();
  try {
    const st = new StrategyStore(dir);
    st.upsert(mkStrategy('s'));
    st.recordRun('s', { ok: true });
    st.recordRun('s', { ok: true, safetyViolation: true });
    const lc = st.get('s')!.lifecycle;
    assert.equal(lc.state, 'blacklisted');
    assert.equal(lc.confidence, 0);
    assert.equal(st.usable().length, 0, '拉黑的不出现在 usable');
  } finally { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }
});

test('SS-T4 · 主人否决 → disabled + 永不命中', () => {
  const dir = tmpDir();
  try {
    const st = new StrategyStore(dir);
    st.upsert(mkStrategy('s'));
    st.ownerVerdict('s', 'rejected');
    assert.equal(st.get('s')!.lifecycle.state, 'disabled');
    assert.equal(st.usable().length, 0);
  } finally { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }
});

test('SS-T5 · 降级不算 cleanSuccess，耗尽试用后禁用 + remove 删盘', () => {
  const dir = tmpDir();
  try {
    const st = new StrategyStore(dir);
    st.upsert(mkStrategy('s'));
    st.recordRun('s', { ok: true, downgraded: true });
    st.recordRun('s', { ok: true, downgraded: true });
    st.recordRun('s', { ok: true, downgraded: true });
    assert.equal(st.get('s')!.lifecycle.state, 'disabled', '连续降级说明 fast path 无有效成功，应停止试用');
    st.remove('s');
    assert.equal(st.get('s'), undefined);
    assert.ok(!existsSync(join(dir, 's.json')));
  } finally { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }
});

test('BUG-CROSS-20 · candidate 三次失败且零 clean success → disabled', () => {
  const dir = tmpDir();
  try {
    const st = new StrategyStore(dir);
    st.upsert(mkStrategy('s'));
    st.recordRun('s', { ok: false, downgraded: true });
    st.recordRun('s', { ok: false, downgraded: true });
    assert.equal(st.get('s')!.lifecycle.state, 'candidate', '前两次仍保留试用机会');
    st.recordRun('s', { ok: false, downgraded: true });
    assert.equal(st.get('s')!.lifecycle.state, 'disabled');
    assert.equal(st.usable().length, 0);
  } finally { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }
});

test('BUG-CROSS-20 · 升级前已落盘的久试无果 candidate 不再 usable', () => {
  const dir = tmpDir();
  try {
    const st = new StrategyStore(dir);
    const stale = mkStrategy('stale');
    stale.lifecycle.state = 'candidate';
    stale.lifecycle.trialRuns = 11;
    stale.lifecycle.cleanSuccess = 0;
    stale.lifecycle.confidence = 0.15;
    st.upsert(stale);
    assert.equal(st.get('stale')!.lifecycle.state, 'candidate', '读门禁不静默改写用户数据');
    assert.equal(st.usable().length, 0);
  } finally { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }
});

test('BUG-CROSS-20 · 有过 clean success 的 candidate 不按零成功规则淘汰', () => {
  const dir = tmpDir();
  try {
    const st = new StrategyStore(dir);
    st.upsert(mkStrategy('recoverable'));
    st.recordRun('recoverable', { ok: true });
    st.recordRun('recoverable', { ok: false, downgraded: true });
    st.recordRun('recoverable', { ok: false, downgraded: true });
    assert.equal(st.get('recoverable')!.lifecycle.state, 'candidate');
  } finally { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); }
});
