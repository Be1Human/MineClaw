import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/App.vue', import.meta.url), 'utf8');
const chatBoxSource = readFileSync(new URL('../../../../apps/minecraft-companion/web/src/components/ChatBox.vue', import.meta.url), 'utf8');

test('BUG-CROSS-79 | chat input stays editable and only clears an acknowledged draft', () => {
  assert.doesNotMatch(chatBoxSource, /<input[^>]+:disabled=/);
  assert.match(chatBoxSource, /:disabled="!text\.trim\(\) \|\| sending"/);
  assert.match(chatBoxSource, /result\.accepted === true && text\.value\.trim\(\) === t/);
  assert.doesNotMatch(chatBoxSource, /emit\('send', t\);\s*text\.value = ''/);
});

test('BUG-CROSS-79 | interaction page reports rejected and disconnected submissions in chat', () => {
  assert.match(appSource, /socket\.emit\('bot:chat',[\s\S]+\(result\) =>/);
  assert.match(appSource, /result\?\.accepted !== true/);
  assert.match(appSource, /Hub 未连接，消息尚未发送；草稿已保留/);
  assert.match(appSource, /sender: '发送失败'/);
});
