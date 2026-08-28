export const CHAT_PRESENTATION_ROLES = Object.freeze(['owner', 'bot', 'system', 'external']);

export function normalizeChatRole(role) {
  return CHAT_PRESENTATION_ROLES.includes(role) ? role : 'external';
}

export function chatNamesForProfile(profile = {}) {
  return {
    owner: profile.characterCard?.relationship?.userPersona?.name || profile.ownerUsername || '我',
    bot: profile.characterCard?.character?.identity?.name || profile.name || '伙伴',
  };
}

export function projectChatMessage(input = {}, profile = {}) {
  const role = normalizeChatRole(input.role);
  const names = chatNamesForProfile(profile);
  const sender = role === 'owner'
    ? names.owner
    : role === 'bot'
      ? names.bot
      : input.sender || (role === 'system' ? '系统' : '其他玩家');

  return {
    ...(input.id ? { id: input.id } : {}),
    role,
    side: role === 'owner' ? 'viewer' : 'counterpart',
    sender,
    message: input.message ?? input.content ?? '',
    timestamp: input.timestamp ?? Date.now(),
    thinking: input.thinking || '',
    turnId: input.turnId || '',
    thinkExpanded: Boolean(input.thinkExpanded),
    error: Boolean(input.error),
  };
}

export function filterChatMessages(messages, filter) {
  if (filter === 'self') return messages.filter(message => message.role === 'owner');
  if (filter === 'partner') return messages.filter(message => message.role === 'bot' && !message.error);
  if (filter === 'error') return messages.filter(message => message.error);
  return messages;
}
