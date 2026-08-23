/** Minecraft 出站聊天单包上限；给协议/服务端实现预留余量。 */
export const MINECRAFT_CHAT_MAX_CODE_POINTS = 240;

/**
 * 把面向富文本通道的回复转换为一条 Minecraft 聊天消息。
 * 这里只处理传输约束，不改变 WebUI/事件总线中的原始回复。
 */
export function toMinecraftChatLine(message: string): string {
  const singleLine = message.replace(/\s+/gu, ' ').trim();
  if (!singleLine) return '';

  const codePoints = Array.from(singleLine);
  if (codePoints.length <= MINECRAFT_CHAT_MAX_CODE_POINTS) return singleLine;
  return `${codePoints.slice(0, MINECRAFT_CHAT_MAX_CODE_POINTS - 1).join('')}…`;
}
