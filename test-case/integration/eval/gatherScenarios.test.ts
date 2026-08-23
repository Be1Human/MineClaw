import test from 'node:test';
import assert from 'node:assert/strict';
import { gatherScenarios } from '../../../benchmark/engineering/body/gather.js';
import type { Director } from '../../../benchmark/engineering/core/director.js';
import type { Subject } from '../../../benchmark/engineering/core/subject.js';

interface FillCall {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  block: string;
}

function scenario(id: string) {
  const found = gatherScenarios.map(factory => factory()).find(item => item.id === id);
  assert.ok(found, `missing scenario ${id}`);
  return found;
}

function fixture() {
  const fills: FillCall[] = [];
  const director = {
    parkFar: async () => {},
    clearInv: async () => {},
    tp: async () => {},
    fill: async (from: FillCall['from'], to: FillCall['to'], block: string) => {
      fills.push({ from, to, block });
    },
  } as unknown as Director;
  const subject = { username: 'EvalSubject' } as Subject;
  return { director, subject, fills };
}

test('BUG-CROSS-29 · 全部 Gather Matrix 夹具容量覆盖目标数量', async () => {
  const matrix = gatherScenarios.map(factory => factory()).filter(item => item.suite === 'matrix');
  assert.equal(matrix.length, 12);

  for (const item of matrix) {
    const count = Number(/count=(\d+)/.exec(item.title)?.[1]);
    assert.ok(Number.isFinite(count), `${item.id} title missing count`);
    const { director, subject, fills } = fixture();
    await item.setup(director, subject);
    const capacity = fills
      .filter(call => call.block === 'oak_log')
      .reduce((total, call) => total + Math.abs(call.to.y - call.from.y) + 1, 0);
    assert.ok(capacity >= count, `${item.id}: capacity=${capacity}, count=${count}`);
  }
});

test('BUG-CROSS-29 · count=4/trees=1 仍生成一棵树但高度提升到 4', async () => {
  for (const id of ['GATHER-M03', 'GATHER-M07', 'GATHER-M11']) {
    const item = scenario(id);
    const { director, subject, fills } = fixture();
    await item.setup(director, subject);
    assert.equal(fills.length, 1, `${id} 必须保留 trees=1`);
    assert.equal(fills[0]?.to.y - fills[0]!.from.y + 1, 4, `${id} 树干必须提供 4 个原木`);
  }
});

test('BUG-CROSS-29 · 采集场景死亡立即 fail-fast，存活时不误判', () => {
  const item = scenario('GATHER-M03');
  assert.equal(item.failFast?.({ hasDiedSinceReset: () => true } as Subject), true);
  assert.equal(item.failFast?.({ hasDiedSinceReset: () => false } as Subject), false);
});
