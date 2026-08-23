export interface BodyEvalEnvironment {
  host: string;
  port: string;
  childEnv: NodeJS.ProcessEnv;
}

/** BUG-CROSS-21 · Benchmark 默认只打本地夹具，不继承产品 MC_HOST。 */
export function resolveBodyEvalEnvironment(base: NodeJS.ProcessEnv): BodyEvalEnvironment {
  const host = base.EVAL_HOST?.trim() || '127.0.0.1';
  const port = base.EVAL_PORT?.trim() || '25565';
  return {
    host,
    port,
    childEnv: { ...base, EVAL_HOST: host, EVAL_PORT: port },
  };
}
