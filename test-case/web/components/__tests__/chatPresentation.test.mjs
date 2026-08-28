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

  assert.deepEqual([ownerWithBotName.sender, ownerWithBotName.side], ['朋友', 'viewer']);
  assert.deepEqual([botWithOwnerName.sender, botWithOwnerName.side], ['LanYi', 'counterpart']);
  assert.deepEqual([legacyWithoutRole.role, legacyWithoutRole.side], ['external', 'counterpart']);
  assert.equal(normalizeChatRole('unknown'), 'external');
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
