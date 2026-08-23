import path from 'node:path';

/**
 * Gym 的运行日志必须跟随被测 Hub 的数据目录，
 * 不能偷读同一仓库中 Beta 的默认 data/logs。
 */
export function resolveRuntimeLogDir(
  appDir: string,
  env: Partial<Record<'GYM_DATA_DIR' | 'DATA_DIR', string | undefined>> = process.env,
): string {
  const configuredDataDir = env.GYM_DATA_DIR ?? env.DATA_DIR ?? 'data';
  const dataDir = path.isAbsolute(configuredDataDir)
    ? configuredDataDir
    : path.resolve(appDir, configuredDataDir);
  return path.join(dataDir, 'logs');
}

/** 只保留被测 Profile 的 Hub 日志行，防止同 Hub 其他实例污染证据。 */
export function filterRuntimeLogForProfile(text: string, profileId: string): string {
  const marker = `[${profileId}]`;
  const lines = text.split(/\r?\n/).filter(line => line.includes(marker));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
