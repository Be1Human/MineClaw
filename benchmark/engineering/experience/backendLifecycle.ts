export type BackendBotStatus = 'online' | 'unknown' | 'backend-down' | string;

export interface EnsureEmbodiedOnlineOptions {
  profileId: string;
  getStatus: () => Promise<BackendBotStatus>;
  post: (path: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

/**
 * Gym 是 embodied 消费者：Companion 存在并不等于已经进入 Minecraft。
 * 首次启动和 Crash 自愈必须走同一个 start/join/wait 契约。
 */
export async function ensureEmbodiedOnline(options: EnsureEmbodiedOnlineOptions): Promise<void> {
  const attempts = options.attempts ?? 30;
  const intervalMs = options.intervalMs ?? 3_000;
  const initial = await options.getStatus();
  if (initial === 'online') return;

  if (initial === 'unknown' || initial === 'backend-down') {
    await options.post(`/api/bots/${options.profileId}/start`);
  }
  await options.post(`/api/bots/${options.profileId}/join-game`);

  for (let index = 0; index < attempts; index++) {
    await options.sleep(intervalMs);
    if ((await options.getStatus()) === 'online') return;
  }

  throw new Error(`被测 Bot 在 ${attempts * intervalMs}ms 内未上线，当前状态=${await options.getStatus()}`);
}
