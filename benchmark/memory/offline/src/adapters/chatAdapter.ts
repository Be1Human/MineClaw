import { MemoryBenchmarkHarness } from '../../../shared/harness.js';
import { check } from '../checks.js';
import type { BenchmarkAdapter, CaseExecution, ChatBenchmarkCase } from '../types.js';

export class ChatBenchmarkAdapter implements BenchmarkAdapter<ChatBenchmarkCase> {
  readonly domain = 'chat' as const;
  private readonly harness = new MemoryBenchmarkHarness();

  execute(testCase: ChatBenchmarkCase): CaseExecution {
    const started = Date.now();
    const result = this.harness.runCase(testCase.legacyCase, 'hybrid');
    return {
      caseId: testCase.id,
      domain: this.domain,
      split: testCase.split,
      tags: testCase.tags,
      durationMs: Date.now() - started,
      checks: [
        check({ id: 'capture', passed: result.capturePrecision === 1 && result.captureRecall === 1, expected: { precision: 1, recall: 1 }, actual: { precision: result.capturePrecision, recall: result.captureRecall }, weight: 20, evidence: `captured=${result.trace.capturedMessageIds.join(',')}` }),
        check({ id: 'operation', passed: result.operationCorrect, expected: testCase.legacyCase.expectedOperation ?? 'none', actual: result.operationCorrect, weight: 15, evidence: `activeSources=${result.trace.activeSourceMessageIds.join(',')}` }),
        check({ id: 'retrieval', passed: result.retrievalRecall === 1 && !result.forbiddenInjected, expected: { recall: 1, forbidden: false }, actual: { recall: result.retrievalRecall, forbidden: result.forbiddenInjected }, weight: 20, evidence: `retrieved=${result.trace.retrievedSourceMessageIds.join(',')}` }),
        check({ id: 'context_evidence', passed: result.answerCorrect && result.sourceCoverage === 1, expected: { contextContainsExpected: true, sourceCoverage: 1 }, actual: { contextContainsExpected: result.answerCorrect, sourceCoverage: result.sourceCoverage }, weight: 20, evidence: `injected=${result.trace.injectedSourceMessageIds.join(',')}`, kind: 'evidence' }),
        check({ id: 'profile_isolation', passed: !result.profileLeak, expected: false, actual: result.profileLeak, weight: 15, critical: true, evidence: `foreignLeaks=${result.trace.foreignLeakMessageIds.join(',') || 'none'}`, kind: 'profile_isolation' }),
        check({ id: 'prompt_budget', passed: result.promptBudgetRespected, expected: `<=${result.trace.promptBudgetChars}`, actual: result.trace.promptChars, weight: 10, critical: true, evidence: `promptChars=${result.trace.promptChars}` }),
      ],
      trace: {
        metricBoundary: 'context_evidence_only_not_llm_answer',
        legacyCategory: result.category,
        legacyMode: result.mode,
        memoryTrace: result.trace,
      },
    };
  }
}
