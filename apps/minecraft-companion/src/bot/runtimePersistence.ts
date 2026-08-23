import { join } from 'node:path';

export interface RuntimePersistencePaths {
  memoryDbPath: string;
  chatMemoryDbPath: string;
  worldMapDbPath: string;
  plannerEvolutionDbPath: string;
  plannerExecutionFactsPath: string;
  plannerRuntimeDbPath: string;
  runsDir: string;
  strategyDir: string;
}

/**
 * Profile Runtime 的全部持久化路径只能从 Hub dataDir 派生。
 * 统一放在这里，避免某个子系统重新写死到进程工作目录的 ./data。
 */
export function resolveRuntimePersistencePaths(
  dataDir: string,
  profileId: string,
): RuntimePersistencePaths {
  const safeId = (profileId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    memoryDbPath: join(dataDir, `v2-memory-${safeId}.db`),
    chatMemoryDbPath: join(dataDir, `chat-memory-${safeId}.db`),
    worldMapDbPath: join(dataDir, `world-map-${safeId}.db`),
    plannerEvolutionDbPath: join(dataDir, `planner-evolution-${safeId}.db`),
    plannerExecutionFactsPath: join(dataDir, `planner-execution-facts-${safeId}.jsonl`),
    plannerRuntimeDbPath: join(dataDir, `planner-runtime-${safeId}.db`),
    runsDir: join(dataDir, 'runs', safeId),
    strategyDir: join(dataDir, 'strategies', safeId),
  };
}
