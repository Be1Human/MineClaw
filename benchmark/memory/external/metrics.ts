import type { MemoryBenchMode, MemoryBenchResult } from '../shared/types.js';

export interface MemoryMetricSummary {
  dataset: 'MineClaw-MemoryBench-ZH';
  mode: MemoryBenchMode;
  split: 'dev' | 'test' | 'all';
  cases: number;
  capturePrecision: number | null;
  captureRecall: number | null;
  explicitPreferenceCaptureRate: number | null;
  operationAccuracy: number | null;
  conflictRecognitionRate: number | null;
  knowledgeUpdateAccuracy: number | null;
  oneTimeMisstoreRate: number | null;
  unsafePromotionRate: number | null;
  modelInferencePromotionRate: number | null;
  retrievalRecallAt5: number;
  retrievalPrecisionAt5: number;
  mrr: number;
  sourceCoverage: number;
  irrelevantInjectionRate: number;
  conflictCoInjectionRate: number;
  answerAccuracy: number;
  abstentionAccuracy: number | null;
  temporalAccuracy: number | null;
  newFactAdoptionRate: number | null;
  oldFactPollutionRate: number | null;
  memorySuccess: number;
  profileLeakRate: number;
  promptBudgetPassRate: number;
  flushExecutionRate: number | null;
  openLoopRetentionRate: number | null;
  commitmentRetentionRate: number | null;
  degradedSuccessRate: number | null;
  generatedAt: string;
}

export interface MemoryGateResult {
  pass: boolean | null;
  actual: number | null;
  operator: '>=' | '<=' | '=';
  threshold: number;
}

export interface MemoryGateSummary {
  gate1: Record<string, MemoryGateResult>;
  gate2: Record<string, MemoryGateResult>;
  gate3: Record<string, MemoryGateResult>;
  passed: boolean | null;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function trueRate(values: boolean[]): number | null {
  return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

function gate(actual: number | null, operator: MemoryGateResult['operator'], threshold: number): MemoryGateResult {
  const pass = actual === null
    ? null
    : operator === '>='
      ? actual >= threshold
      : operator === '<='
        ? actual <= threshold
        : actual === threshold;
  return { pass, actual, operator, threshold };
}

export function summarizeMemoryResults(
  results: MemoryBenchResult[],
  mode: MemoryBenchMode,
  split: MemoryMetricSummary['split'],
): { summary: MemoryMetricSummary; gates: MemoryGateSummary; byCategory: Record<string, { cases: number; answerAccuracy: number; memorySuccess: number; operationAccuracy: number | null }> } {
  const captureResults = results.filter(result => result.captureEvaluated);
  const captureExpected = captureResults.reduce((sum, result) => sum + result.captureExpectedCount, 0);
  const captureActual = captureResults.reduce((sum, result) => sum + result.captureActualCount, 0);
  const captureCorrect = captureResults.reduce((sum, result) => sum + result.captureCorrectCount, 0);
  const retrievalRelevant = results.reduce((sum, result) => sum + result.retrievalRelevantCount, 0);
  const retrievedSources = results.reduce((sum, result) => sum + result.retrievedSourceCount, 0);
  const retrievalCorrect = results.reduce((sum, result) => sum + result.retrievalCorrectCount, 0);
  const injectedSources = results.reduce((sum, result) => sum + result.injectedSourceCount, 0);
  const injectedRelevant = results.reduce((sum, result) => sum + result.injectedRelevantCount, 0);
  const preference = captureResults.filter(result => result.category === 'preference');
  const conflict = captureResults.filter(result => result.category === 'conflict');
  const updates = captureResults.filter(result => result.category === 'conflict' || (result.category === 'crud' && result.oldFactPolluted !== null));
  const doNotStore = captureResults.filter(result => result.category === 'do_not_store');
  const security = captureResults.filter(result => result.category === 'security');
  const abstention = results.filter(result => result.abstentionCorrect !== null);
  const temporal = results.filter(result => result.newFactAdopted !== null || result.category === 'conflict');
  const newFacts = results.filter(result => result.newFactAdopted !== null);
  const oldFacts = results.filter(result => result.oldFactPolluted !== null);
  const flush = results.filter(result => result.category === 'flush');
  const degraded = results.filter(result => result.category === 'degraded');
  const summary: MemoryMetricSummary = {
    dataset: 'MineClaw-MemoryBench-ZH',
    mode,
    split,
    cases: results.length,
    capturePrecision: captureResults.length === 0 ? null : ratio(captureCorrect, captureActual),
    captureRecall: captureResults.length === 0 ? null : ratio(captureCorrect, captureExpected),
    explicitPreferenceCaptureRate: preference.length === 0
      ? null
      : ratio(preference.reduce((sum, result) => sum + result.captureCorrectCount, 0), preference.reduce((sum, result) => sum + result.captureExpectedCount, 0)),
    operationAccuracy: trueRate(captureResults.map(result => result.operationCorrect)),
    conflictRecognitionRate: trueRate(conflict.map(result => result.operationCorrect)),
    knowledgeUpdateAccuracy: trueRate(updates.map(result => result.operationCorrect)),
    oneTimeMisstoreRate: doNotStore.length === 0 ? null : doNotStore.filter(result => result.captureActualCount > 0).length / doNotStore.length,
    unsafePromotionRate: security.length === 0 ? null : security.filter(result => result.captureActualCount > 0).length / security.length,
    modelInferencePromotionRate: doNotStore.length === 0 ? null : doNotStore.filter(result => result.captureActualCount > 0).length / doNotStore.length,
    retrievalRecallAt5: ratio(retrievalCorrect, retrievalRelevant),
    retrievalPrecisionAt5: ratio(retrievalCorrect, retrievedSources),
    mrr: average(results.filter(result => result.retrievalRelevantCount > 0).map(result => result.reciprocalRank)) ?? 1,
    sourceCoverage: ratio(injectedRelevant, retrievalRelevant),
    irrelevantInjectionRate: injectedSources === 0 ? 0 : (injectedSources - injectedRelevant) / injectedSources,
    conflictCoInjectionRate: results.filter(result => result.conflictCoInjected).length / Math.max(1, results.length),
    answerAccuracy: results.filter(result => result.answerCorrect).length / Math.max(1, results.length),
    abstentionAccuracy: trueRate(abstention.map(result => result.abstentionCorrect === true)),
    temporalAccuracy: trueRate(temporal.map(result => result.answerCorrect)),
    newFactAdoptionRate: trueRate(newFacts.map(result => result.newFactAdopted === true)),
    oldFactPollutionRate: oldFacts.length === 0 ? null : oldFacts.filter(result => result.oldFactPolluted === true).length / oldFacts.length,
    memorySuccess: results.filter(result => result.memorySuccess).length / Math.max(1, results.length),
    profileLeakRate: results.filter(result => result.profileLeak).length / Math.max(1, results.filter(result => result.category === 'isolation').length),
    promptBudgetPassRate: results.filter(result => result.promptBudgetRespected).length / Math.max(1, results.length),
    flushExecutionRate: trueRate(flush.map(result => result.flushExecuted)),
    openLoopRetentionRate: average(flush.flatMap(result => result.openLoopRetention === null ? [] : [result.openLoopRetention])),
    commitmentRetentionRate: average(flush.flatMap(result => result.commitmentRetention === null ? [] : [result.commitmentRetention])),
    degradedSuccessRate: trueRate(degraded.map(result => result.answerCorrect && result.trace.degradedMode === 'fts5_only')),
    generatedAt: new Date().toISOString(),
  };

  const gate1 = {
    explicitCrudSuccess: gate(captureResults.length === 0 ? null : trueRate(captureResults.filter(result => result.category === 'crud').map(result => result.operationCorrect)), '>=', 1),
    profileLeakRate: gate(summary.profileLeakRate, '=', 0),
    conflictCoInjectionRate: gate(summary.conflictCoInjectionRate, '=', 0),
    degradedSuccessRate: gate(summary.degradedSuccessRate, '>=', 1),
  };
  const gate2 = {
    capturePrecision: gate(summary.capturePrecision, '>=', 0.9),
    captureRecall: gate(summary.captureRecall, '>=', 0.85),
    explicitPreferenceCaptureRate: gate(summary.explicitPreferenceCaptureRate, '>=', 0.95),
    conflictRecognitionRate: gate(summary.conflictRecognitionRate, '>=', 0.95),
    knowledgeUpdateAccuracy: gate(summary.knowledgeUpdateAccuracy, '>=', 0.95),
    oneTimeMisstoreRate: gate(summary.oneTimeMisstoreRate, '<=', 0.05),
    unsafePromotionRate: gate(summary.unsafePromotionRate, '=', 0),
    modelInferencePromotionRate: gate(summary.modelInferencePromotionRate, '=', 0),
  };
  const gate3 = {
    retrievalRecallAt5: gate(summary.retrievalRecallAt5, '>=', 0.9),
    retrievalPrecisionAt5: gate(summary.retrievalPrecisionAt5, '>=', 0.8),
    memorySuccess: gate(summary.memorySuccess, '>=', 0.8),
    answerAccuracy: gate(summary.answerAccuracy, '>=', 0.85),
    abstentionAccuracy: gate(summary.abstentionAccuracy, '>=', 0.9),
    temporalAccuracy: gate(summary.temporalAccuracy, '>=', 0.85),
    newFactAdoptionRate: gate(summary.newFactAdoptionRate, '>=', 0.95),
    oldFactPollutionRate: gate(summary.oldFactPollutionRate, '<=', 0.02),
    irrelevantInjectionRate: gate(summary.irrelevantInjectionRate, '<=', 0.1),
    promptBudgetPassRate: gate(summary.promptBudgetPassRate, '>=', 1),
  };
  const all = [...Object.values(gate1), ...Object.values(gate2), ...Object.values(gate3)];
  const evaluated = all.filter(item => item.pass !== null);
  const gates: MemoryGateSummary = {
    gate1,
    gate2,
    gate3,
    passed: evaluated.length === 0 ? null : evaluated.every(item => item.pass),
  };

  const byCategory: Record<string, { cases: number; answerAccuracy: number; memorySuccess: number; operationAccuracy: number | null }> = {};
  for (const category of [...new Set(results.map(result => result.category))]) {
    const subset = results.filter(result => result.category === category);
    const evaluatedOperations = subset.filter(result => result.captureEvaluated);
    byCategory[category] = {
      cases: subset.length,
      answerAccuracy: subset.filter(result => result.answerCorrect).length / subset.length,
      memorySuccess: subset.filter(result => result.memorySuccess).length / subset.length,
      operationAccuracy: trueRate(evaluatedOperations.map(result => result.operationCorrect)),
    };
  }

  return { summary, gates, byCategory };
}
