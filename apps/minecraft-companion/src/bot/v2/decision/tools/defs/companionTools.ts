import type { ToolDefinition } from '../types.js';

export const companionTools: ToolDefinition[] = [
  {
    name: 'join_game',
    description: '进入 Minecraft 游戏世界和朋友一起玩。只在日常聊天态可用。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute(_input, ctx) {
      if (!ctx.onJoinGame) return { ok: false, error: 'join_game_unavailable' };
      void Promise.resolve(ctx.onJoinGame()).catch((e) => {
        ctx.bus.publish('join_game.failed', 'recoverable', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
      return { ok: true, started: true };
    },
  },
];
