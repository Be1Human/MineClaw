import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterChatMessages,
  normalizeChatRole,
  projectChatMessage,
} from '../../../../apps/minecraft-companion/web/src/lib/chatPresentation.js';

const profile = {
  name: 'LanYi',
  ownerUsername: '朋友',
  characterCard: {
    character: { identity: { name: 'LanYi' } },
    relationship: { userPersona: { name: '朋友' } },
  },
};

test('BUG-WEBUI-12 | owner is the only role projected to the viewer/right side', () => {
  assert.equal(projectChatMessage({ role: 'owner', message: '你好' }, profile).side, 'viewer');
  for (const role of ['bot', 'system', 'external']) {
    assert.equal(projectChatMessage({ role, message: role }, profile).side, 'counterpart');
  }
});

test('BUG-WEBUI-12 | sender display names never decide message identity', () => {
  const ownerWithBotName = projectChatMessage({ role: 'owner', sender: 'LanYi', message: '同名' }, profile);
  const botWithOwnerName = projectChatMessage({ role: 'bot', sender: '朋友', message: '同名' }, profile);
  const legacyWithoutRole = projectChatMessage({ sender: 'LanYi', message: '旧事件' }, profile);

  assert.deepEqual([ownerWithBotName.sender, ownerWithBotName.side], ['我', 'viewer']);
  assert.deepEqual([botWithOwnerName.sender, botWithOwnerName.side], ['LanYi', 'counterpart']);
  assert.deepEqual([legacyWithoutRole.role, legacyWithoutRole.side], ['external', 'counterpart']);
  assert.equal(normalizeChatRole('unknown'), 'external');
});

test('owner label is viewer-relative and never taken from persona, game account or wire sender', () => {
  for (const candidate of [profile, { ownerUsername: 'GameAccount' }, {
    characterCard: { relationship: { userPersona: { name: 'CustomNickname' } } },
  }, {}]) {
    const input = { role: 'owner', sender: 'OriginalSender', content: '正文仍有朋友二字', timestamp: 123 };
    const before = structuredClone({ candidate, input });
    const message = projectChatMessage(input, candidate);

    assert.equal(message.sender, '我');
    assert.equal(message.side, 'viewer');
    assert.equal(message.message, input.content);
    assert.equal(message.timestamp, 123);
    assert.deepEqual({ candidate, input }, before);
  }
});

test('external and missing-role senders are preserved even when named like the viewer persona', () => {
  for (const role of ['external', undefined, 'unknown']) {
    const message = projectChatMessage({ role, sender: '朋友', message: '外部消息' }, profile);
    assert.equal(message.role, 'external');
    assert.equal(message.side, 'counterpart');
    assert.equal(message.sender, '朋友');
  }
});

test('BUG-WEBUI-12 | self, partner and error filters follow explicit roles', () => {
  const messages = [
    projectChatMessage({ role: 'owner', message: 'owner' }, profile),
    projectChatMessage({ role: 'bot', message: 'bot' }, profile),
    projectChatMessage({ role: 'external', sender: 'Alex', message: 'external' }, profile),
    projectChatMessage({ role: 'system', sender: '发送失败', message: 'error', error: true }, profile),
  ];

  assert.deepEqual(filterChatMessages(messages, 'self').map(message => message.message), ['owner']);
  assert.deepEqual(filterChatMessages(messages, 'partner').map(message => message.message), ['bot']);
  assert.deepEqual(filterChatMessages(messages, 'error').map(message => message.message), ['error']);
  assert.equal(filterChatMessages(messages, 'all').length, 4);
});
