import type {
  BenchmarkCaseDefinition,
  BenchmarkCaseResult,
  BenchmarkGates,
  BenchmarkLayer,
  BenchmarkScores,
} from './types.js';

const WEIGHTS: Record<BenchmarkLayer, number> = {
  body: 0.35,
  experience: 0.45,
  reliability: 0.20,
};

const round = (value: number): number => Math.round(value * 10) / 10;

function layerScore(results: BenchmarkCaseResult[], layer: BenchmarkLayer): number | null {
  const selected = results.filter(item => item.layer === layer);
  if (!selected.length) return null;
  return round(selected.reduce((sum, item) => sum + item.successRate * 100, 0) / selected.length);
}

export function calculateScores(
  results: BenchmarkCaseResult[],
  expected: BenchmarkCaseDefinition[],
): { scores: BenchmarkScores; gates: BenchmarkGates } {
  const resultIds = new Set(results.map(item => item.id));
  const incomplete = expected.filter(item => !resultIds.has(item.id)).length
    + results.filter(item => item.status === 'incomplete' || item.status === 'error').length;

  const gates: BenchmarkGates = {
    falseComplete: results.filter(item => item.failureKind === 'false_complete').length,
    crash: results.filter(item => item.status === 'crash' || item.failureKind === 'crash').length,
    hung: results.filter(item => item.failureKind === 'hung').length,
    terminalMismatch: results.filter(item => item.failureKind === 'terminal_mismatch').length,
    incomplete,
    watchdog: results.reduce((sum, item) => sum + (item.watchdogHits ?? 0), 0),
  };

  const body = layerScore(results, 'body');
  const experience = layerScore(results, 'experience');
  const reliability = layerScore(results, 'reliability');
  const selectedLayers = new Set(expected.map(item => item.layer));
  const weighted = ([
    ['body', body],
    ['experience', experience],
    ['reliability', reliability],
  ] as const).filter(([layer]) => selectedLayers.has(layer));
  const weightTotal = weighted.reduce((sum, [layer]) => sum + WEIGHTS[layer], 0);
  const overall = weightTotal > 0
    ? round(weighted.reduce((sum, [layer, value]) => sum + (value ?? 0) * WEIGHTS[layer], 0) / weightTotal)
    : 0;

  return { scores: { body, experience, reliability, overall }, gates };
}

export function passesBenchmark(scores: BenchmarkScores, gates: BenchmarkGates, threshold: number): boolean {
  return scores.overall >= threshold
    && gates.falseComplete === 0
    && gates.crash === 0
    && gates.hung === 0
    && gates.terminalMismatch === 0
    && gates.incomplete === 0
    && gates.watchdog === 0;
}
