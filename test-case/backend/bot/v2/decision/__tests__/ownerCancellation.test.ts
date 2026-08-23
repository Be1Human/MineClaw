import test from 'node:test';
import assert from 'node:assert/strict';
import { isTaskCancellationRequest, stripTaskCancellationPrefix } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/mainBrain.js';

test('BUG-CROSS-16 · 明确停止和改派触发确定性取消', () => {
  assert.equal(isTaskCancellationRequest('停下刚才的任务，改成去钻石块'), true);
  assert.equal(isTaskCancellationRequest('先停下手头所有事，原地待命'), true);
  assert.equal(isTaskCancellationRequest('请取消当前任务'), true);
  assert.equal(isTaskCancellationRequest('不要做这个了'), true);
  assert.equal(isTaskCancellationRequest('别跟了'), true);
  assert.equal(isTaskCancellationRequest('别挖了'), true);
  assert.equal(isTaskCancellationRequest('不用跟了'), true);
  assert.equal(stripTaskCancellationPrefix('别跟了'), null);
  assert.equal(stripTaskCancellationPrefix('别跟了，然后过来下'), '过来下');
});

test('BUG-CROSS-16 · 咨询与条件句不提前取消', () => {
  assert.equal(isTaskCancellationRequest('要不要停下来想想？'), false);
  assert.equal(isTaskCancellationRequest('如果失败就停下'), false);
  assert.equal(isTaskCancellationRequest('为什么停止了？'), false);
  assert.equal(isTaskCancellationRequest('我想聊聊取消任务的设计'), false);
  assert.equal(isTaskCancellationRequest('如果失败就别挖了'), false);
  assert.equal(isTaskCancellationRequest('为什么别跟了？'), false);
  assert.equal(isTaskCancellationRequest('聊聊别跟了的设计'), false);
  assert.equal(isTaskCancellationRequest('别生气了'), false);
  assert.equal(isTaskCancellationRequest('别跟我讲故事'), false);
});
