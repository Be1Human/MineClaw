import type {
  BenchmarkCaseDefinition,
  BenchmarkCaseResult,
  BodyEvalReport,
  GymTaskResult,
} from './types.js';

export function normalizeBodyReport(
  report: BodyEvalReport,
  definitions: BenchmarkCaseDefinition[],
  evidencePath: string,
): BenchmarkCaseResult[] {
  const wanted = new Map(definitions.map(item => [item.id, item]));
  return report.scenarios
    .filter(item => wanted.has(item.id))
    .map(item => {
      const definition = wanted.get(item.id)!;
      const reason = item.topFailReasons.map(failure => `${failure.reason}×${failure.count}`).join(', ') || undefined;
      return {
        id: item.id,
        title: item.title,
        layer: definition.layer,
        status: item.successRate >= 0.8 && item.watchdogHits === 0 ? 'pass' : 'fail',
        successRate: item.successRate,
        durationMs: item.avgDurationMs,
        watchdogHits: item.watchdogHits,
        reason,
        evidence: [evidencePath],
        attempts: item.repeat,
        passedAttempts: item.passed,
      } satisfies BenchmarkCaseResult;
    });
}

export function normalizeGymAttempts(
  definition: BenchmarkCaseDefinition,
  attempts: Array<{ result: GymTaskResult; evidencePath: string }>,
): BenchmarkCaseResult {
  if (!attempts.length) {
    return {
      id: definition.id,
      title: definition.title,
      layer: definition.layer,
      status: 'incomplete',
      successRate: 0,
      durationMs: 0,
      failureKind: 'harness_error',
      reason: '未生成 result.json',
      evidence: [],
      attempts: 0,
      passedAttempts: 0,
    };
  }

  const passedAttempts = attempts.filter(item => item.result.verdict === 'PASS').length;
  const crashes = attempts.filter(item => item.result.verdict === 'CRASH');
  const failureKind = crashes.length
    ? 'crash'
    : attempts.map(item => item.result.failureKind).find(Boolean);
  const status = crashes.length ? 'crash' : passedAttempts === attempts.length ? 'pass' : 'fail';
  const responseValues = attempts
    .map(item => item.result.responseLatencyMs)
    .filter((value): value is number => typeof value === 'number');
  const durationValues = attempts.map(item => item.result.instructionDurationMs ?? item.result.durationMs);
  const failed = attempts.filter(item => item.result.verdict !== 'PASS');

  return {
    id: definition.id,
    title: definition.title,
    layer: definition.layer,
    status,
    successRate: passedAttempts / attempts.length,
    durationMs: Math.round(durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length),
    responseLatencyMs: responseValues.length
      ? Math.round(responseValues.reduce((sum, value) => sum + value, 0) / responseValues.length)
      : undefined,
    failureKind,
    reason: failed.flatMap(item => item.result.notes).slice(0, 3).join('; ') || undefined,
    evidence: attempts.map(item => item.evidencePath),
    attempts: attempts.length,
    passedAttempts,
  };
}
