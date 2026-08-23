import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AsyncTaskQueue, AsyncTaskQueueClosedError } from '../../../../../../apps/minecraft-companion/src/bot/v2/infra/asyncTaskQueue.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

describe('BUG-CROSS-32 · AsyncTaskQueue shutdown', () => {
  it('close 后丢弃 pending，active 完成也不再写结果或拉起下一项', async () => {
    const queue = new AsyncTaskQueue(1);
    let resolveActive!: (value: string) => void;
    const active = new Promise<string>(resolve => { resolveActive = resolve; });
    let pendingStarted = 0;

    queue.enqueue(() => active);
    queue.enqueue(async () => { pendingStarted += 1; return 'pending'; });
    assert.equal(queue.activeCount, 1);
    assert.equal(queue.pendingCount, 1);

    queue.close({ dropPending: true });
    assert.equal(queue.isClosed, true);
    assert.equal(queue.pendingCount, 0);
    assert.throws(
      () => queue.enqueue(async () => 'late'),
      (error: unknown) => error instanceof AsyncTaskQueueClosedError,
    );

    resolveActive('done');
    await flush();
    assert.equal(queue.activeCount, 0);
    assert.equal(pendingStarted, 0);
    assert.deepEqual(queue.drainResults(), []);
  });

  it('close 幂等', () => {
    const queue = new AsyncTaskQueue();
    queue.close();
    queue.close();
    assert.equal(queue.isClosed, true);
    assert.equal(queue.pendingCount, 0);
  });
});
