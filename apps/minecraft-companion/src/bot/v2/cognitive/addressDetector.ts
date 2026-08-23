export interface AddressContext {
  botName: string;
  botAliases?: string[];
  isDirectMessage: boolean;
  nearbyPlayers: string[];
}

export type AddressResult = 'addressed' | 'not_addressed' | 'uncertain';

export function detectAddress(message: string, ctx: AddressContext): AddressResult {
  const lower = message.toLowerCase().trim();
  const botLower = ctx.botName.toLowerCase();

  if (ctx.isDirectMessage) return 'addressed';

  if (lower.startsWith(botLower) || lower.startsWith(`@${botLower}`)) return 'addressed';
  if (lower.includes(botLower)) return 'addressed';

  if (ctx.botAliases) {
    for (const alias of ctx.botAliases) {
      if (lower.includes(alias.toLowerCase())) return 'addressed';
    }
  }

  const callPatterns = [
    '你', '帮我', '帮忙', '来', '给我', '去',
    '过来', '跟我', '等等', '快', '别', '不要',
    'hey', 'hi', 'hello', 'help',
  ];
  const isCommand = callPatterns.some(p => lower.startsWith(p));
  if (isCommand && ctx.nearbyPlayers.length <= 1) return 'addressed';

  if (ctx.nearbyPlayers.length <= 1) return 'addressed';

  if (isCommand) return 'uncertain';

  return 'not_addressed';
}
