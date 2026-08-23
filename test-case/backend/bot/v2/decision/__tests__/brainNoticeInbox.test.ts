import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BrainNoticeInbox } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/brainNoticeInbox.js';

describe('BUG-CROSS-48 · BrainNoticeInbox', () => {
  it('同一语义键只收一次并保留是否唤醒', () => {
    const inbox = new BrainNoticeInbox();
    const first = inbox.submit({
      source: 'task', topic: 'completed', label: '挖铁', wake: true, dedupeKey: 'task:1:0:success',
    });
    const duplicate = inbox.submit({
      source: 'task', topic: 'completed', label: '挖铁', wake: true, dedupeKey: 'task:1:0:success',
    });
    assert.ok(first);
    assert.equal(duplicate, null);
    assert.equal(inbox.size(), 1);
    assert.equal(inbox.hasWakeNotice(), true);
  });

  it('取消 clear 后旧批次不能重新入队', () => {
    const inbox = new BrainNoticeInbox();
    inbox.submit({ source: 'task', topic: 'done', label: '旧任务', wake: true });
    const oldBatch = inbox.drain();
    inbox.clear();
    inbox.requeueFront(oldBatch);
    assert.equal(inbox.size(), 0);
  });
});
