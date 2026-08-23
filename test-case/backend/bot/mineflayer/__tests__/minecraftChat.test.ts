import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'mineflayer';
import { MineflayerGameAdapter } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/MineflayerGameAdapter.js';
import { MINECRAFT_CHAT_MAX_CODE_POINTS, toMinecraftChatLine } from '../../../../../apps/minecraft-companion/src/bot/mineflayer/minecraftChat.js';

test('BUG-CROSS-12 · Minecraft 出站文本压成单行', () => {
  assert.equal(toMinecraftChatLine('第一行\r\n  第二行\t第三段'), '第一行 第二行 第三段');
});

test('BUG-CROSS-12 · 超长 Unicode 回复按 code point 截断', () => {
  const output = toMinecraftChatLine('🙂'.repeat(MINECRAFT_CHAT_MAX_CODE_POINTS + 10));
  assert.equal(Array.from(output).length, MINECRAFT_CHAT_MAX_CODE_POINTS);
  assert.equal(output.endsWith('…'), true);
  assert.equal(output.includes('\n'), false);
});

test('BUG-CROSS-12 · Adapter 对一段回复最多发送一个聊天包', () => {
  const sent: string[] = [];
  const bot = { chat: (message: string) => sent.push(message) } as unknown as Bot;
  const adapter = new MineflayerGameAdapter(() => bot);

  adapter.chat('准备好了。\n- 我先观察\n- 然后行动');
  adapter.chat(' \r\n\t ');

  assert.deepEqual(sent, ['准备好了。 - 我先观察 - 然后行动']);
});
