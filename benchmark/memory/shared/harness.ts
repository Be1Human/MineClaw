import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatMemoryService } from '../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import type { ConversationSummary, EmbeddingProvider, MemoryFact } from '../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';
import type { MemoryBenchCase, MemoryBenchMode, MemoryBenchResult, MemoryBenchSession } from './types.js';

const PROMPT_BUDGET_CHARS = 6000;
const failingEmbeddingProvider: EmbeddingProvider = {
  id: 'memory-benchmark-forced-failure',
  embed: () => { throw new Error('forced benchmark embedding failure'); },
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function intersection(left: string[], right: ReadonlySet<string>): string[] {
  return unique(left).filter(value => right.has(value));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function recordSessions(memory: ChatMemoryService, sessions: MemoryBenchSession[]): ConversationSummary[] {
  const summaries: ConversationSummary[] = [];
  for (const session of sessions) {
    for (const item of session.messages) memory.recordMessage({ ...item, sessionId: session.id });
    const summary = memory.maybeFlush(session.id);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

function sourceIdsForFacts(facts: MemoryFact[]): string[] {
  return unique(facts.flatMap(fact => fact.sourceMessageIds));
}

function operationIsCorrect(
  testCase: MemoryBenchCase,
  allFacts: MemoryFact[],
  rejected: Record<string, number>,
): boolean {
  const active = allFacts.filter(fact => fact.status === 'active');
  const superseded = allFacts.filter(fact => fact.status === 'superseded');
  const deleted = allFacts.filter(fact => fact.status === 'deleted');
  const expected = new Set(testCase.expectedCaptureMessageIds);
  const relevant = new Set(testCase.relevantMessageIds);
  const forbidden = new Set(testCase.forbiddenMessageIds ?? []);
  const activeSources = sourceIdsForFacts(active);
  const hasExpectedActive = activeSources.some(id => expected.has(id) || relevant.has(id));
  const hasForbiddenActive = activeSources.some(id => forbidden.has(id));

  switch (testCase.expectedOperation ?? 'none') {
    case 'add':
      return hasExpectedActive && !hasForbiddenActive;
    case 'replace':
      return hasExpectedActive
        && !hasForbiddenActive
        && superseded.some(fact => fact.sourceMessageIds.some(id => forbidden.has(id)));
    case 'remove':
      return !hasForbiddenActive
        && deleted.some(fact => fact.sourceMessageIds.some(id => expected.has(id) || forbidden.has(id)));
    case 'reject':
      return allFacts.length === 0
        && (testCase.expectedRejectionReason
          ? (rejected[testCase.expectedRejectionReason] ?? 0) > 0
          : Object.values(rejected).some(count => count > 0));
    case 'none':
      return allFacts.length === 0;
  }
}

export class MemoryBenchmarkHarness {
  runCase(testCase: MemoryBenchCase, mode: MemoryBenchMode = 'hybrid'): MemoryBenchResult {
    const startedAt = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'mineclaw-memory-bench-'));
    const dbPath = join(dir, 'memory.db');
    const profileId = `bench-${testCase.id}`;
    const usesRawContext = mode === 'recent_only' || mode === 'full_context';
    const captureEvaluated = !usesRawContext;
    const foreignMessageIds = new Set(
      (testCase.foreignProfiles ?? []).flatMap(profile => profile.sessions.flatMap(item => item.messages.map(message => message.id))),
    );

    for (const foreign of testCase.foreignProfiles ?? []) {
      const foreignMemory = new ChatMemoryService({
        dbPath,
        profileId: foreign.profileId,
        autoCapture: true,
        flushThresholdChars: 1,
        promptBudgetChars: PROMPT_BUDGET_CHARS,
      });
      try {
        recordSessions(foreignMemory, foreign.sessions);
      } finally {
        foreignMemory.close();
      }
    }

    const memory = new ChatMemoryService({
      dbPath,
      profileId,
      autoCapture: captureEvaluated,
      flushThresholdChars: usesRawContext ? 0 : 1,
      promptBudgetChars: PROMPT_BUDGET_CHARS,
      embeddingProvider: testCase.category === 'degraded' && mode === 'hybrid' ? failingEmbeddingProvider : null,
    });
    try {
      const summaries = recordSessions(memory, testCase.sessions);
      const allFacts = memory.getFacts();
      const activeFacts = allFacts.filter(fact => fact.status === 'active');
      const capturedFacts = allFacts.filter(fact => fact.status !== 'rejected' && fact.status !== 'expired');
      const capturedMessageIds = sourceIdsForFacts(capturedFacts);
      const activeSourceMessageIds = sourceIdsForFacts(activeFacts);

      const retrievalStartedAt = Date.now();
      const retrievedFacts = usesRawContext ? [] : memory.searchFacts(testCase.question, 5);
      const rawMessages = mode === 'recent_only'
        ? memory.recentMessages(20)
        : mode === 'full_context'
          ? memory.recentMessages(100_000)
          : [];
      const prompt = usesRawContext
        ? null
        : memory.buildPromptContext(testCase.question, mode === 'fts5_only' ? 'fts5' : 'hybrid');
      const retrievalElapsedMs = Date.now() - retrievalStartedAt;

      const retrievedSourceMessageIds = usesRawContext
        ? rawMessages.map(message => message.id)
        : sourceIdsForFacts(retrievedFacts);
      const promptFacts = prompt
        ? activeFacts.filter(fact => prompt.retrievedFactIds.includes(fact.id))
        : [];
      const injectedSourceMessageIds = usesRawContext
        ? unique(rawMessages.map(message => message.id))
        : unique([...sourceIdsForFacts(promptFacts), ...(prompt?.retrievedMessageIds ?? [])]);
      const injectedFactIds = prompt?.retrievedFactIds ?? [];
      const answerText = usesRawContext
        ? rawMessages.map(message => message.content).join('\n')
        : (prompt?.text ?? '');

      const relevant = new Set(testCase.relevantMessageIds);
      const forbidden = new Set(testCase.forbiddenMessageIds ?? []);
      const expectedCapture = new Set(testCase.expectedCaptureMessageIds);
      const captureCorrectCount = intersection(capturedMessageIds, expectedCapture).length;
      const retrievalCorrectCount = intersection(retrievedSourceMessageIds, relevant).length;
      const injectedRelevantCount = intersection(injectedSourceMessageIds, relevant).length;
      const forbiddenInjected = injectedSourceMessageIds.some(id => forbidden.has(id));
      const relevantInjected = injectedSourceMessageIds.some(id => relevant.has(id));
      const answerCorrect = testCase.answers.length === 0
        ? !forbiddenInjected && injectedRelevantCount === 0
        : testCase.answers.some(expected => answerText.includes(expected));
      const firstRelevantRank = retrievedSourceMessageIds.findIndex(id => relevant.has(id));
      const capturePrecision = captureEvaluated
        ? ratio(captureCorrectCount, capturedMessageIds.length)
        : 1;
      const captureRecall = captureEvaluated
        ? ratio(captureCorrectCount, expectedCapture.size)
        : 1;
      const retrievalRecall = ratio(retrievalCorrectCount, relevant.size);
      const retrievalPrecision = ratio(retrievalCorrectCount, retrievedSourceMessageIds.length);
      const sourceCoverage = ratio(injectedRelevantCount, relevant.size);
      const irrelevantInjected = injectedSourceMessageIds.filter(id => !relevant.has(id)).length;
      const irrelevantInjectionRate = injectedSourceMessageIds.length === 0
        ? 0
        : irrelevantInjected / injectedSourceMessageIds.length;
      const profileLeakMessageIds = unique([
        ...capturedMessageIds,
        ...activeSourceMessageIds,
        ...retrievedSourceMessageIds,
        ...injectedSourceMessageIds,
      ]).filter(id => foreignMessageIds.has(id));
      const summaryCoveredMessageIds = unique(summaries.flatMap(summary => summary.coveredMessageIds));
      const allMessagesById = new Map(testCase.sessions.flatMap(item => item.messages).map(item => [item.id, item]));
      const openLoopExpected = testCase.expectedOpenLoopMessageIds ?? [];
      const commitmentExpected = testCase.expectedCommitmentMessageIds ?? [];
      const openLoopRetained = openLoopExpected.filter(id => {
        const content = allMessagesById.get(id)?.content;
        return content ? summaries.some(summary => summary.openLoops.includes(content)) : false;
      }).length;
      const commitmentRetained = commitmentExpected.filter(id => {
        const content = allMessagesById.get(id)?.content;
        return content ? summaries.some(summary => summary.commitments.includes(content)) : false;
      }).length;
      const metrics = memory.inspectMetrics();
      const abstentionCorrect = testCase.shouldAbstain === undefined ? null : answerCorrect;
      const newFactAdopted = testCase.expectedOperation === 'replace' ? relevantInjected && answerCorrect : null;
      const oldFactPolluted = testCase.expectedOperation === 'replace' ? forbiddenInjected : null;
      const memorySuccess = testCase.relevantMessageIds.length === 0
        ? answerCorrect && !forbiddenInjected
        : answerCorrect && retrievalCorrectCount > 0 && injectedRelevantCount > 0 && !forbiddenInjected;
      const promptChars = answerText.length;
      const answer = testCase.category === 'security' && answerText
        ? '[REDACTED BENCHMARK SECURITY CONTEXT]'
        : answerText;

      return {
        caseId: testCase.id,
        category: testCase.category,
        split: testCase.split,
        mode,
        answer,
        answerCorrect,
        captureEvaluated,
        captureExpectedCount: captureEvaluated ? expectedCapture.size : 0,
        captureActualCount: captureEvaluated ? capturedMessageIds.length : 0,
        captureCorrectCount: captureEvaluated ? captureCorrectCount : 0,
        capturePrecision,
        captureRecall,
        operationCorrect: captureEvaluated ? operationIsCorrect(testCase, allFacts, metrics.rejected) : true,
        retrievalRecall,
        retrievalPrecision,
        reciprocalRank: relevant.size === 0 ? 1 : firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1),
        retrievalRelevantCount: relevant.size,
        retrievedSourceCount: unique(retrievedSourceMessageIds).length,
        retrievalCorrectCount,
        sourceCoverage,
        injectedSourceCount: injectedSourceMessageIds.length,
        injectedRelevantCount,
        irrelevantInjectionRate,
        forbiddenInjected,
        conflictCoInjected: forbiddenInjected && relevantInjected,
        profileLeak: profileLeakMessageIds.length > 0,
        promptBudgetRespected: promptChars <= PROMPT_BUDGET_CHARS,
        abstentionCorrect,
        newFactAdopted,
        oldFactPolluted,
        memorySuccess,
        flushExecuted: testCase.expectedFlush ? summaries.length > 0 : true,
        openLoopRetention: openLoopExpected.length === 0 ? null : ratio(openLoopRetained, openLoopExpected.length),
        commitmentRetention: commitmentExpected.length === 0 ? null : ratio(commitmentRetained, commitmentExpected.length),
        trace: {
          caseId: testCase.id,
          capturedFactIds: capturedFacts.map(fact => fact.id),
          capturedMessageIds,
          activeFactIds: activeFacts.map(fact => fact.id),
          activeSourceMessageIds,
          retrievedFactIds: retrievedFacts.map(fact => fact.id),
          retrievedSourceMessageIds,
          injectedFactIds,
          injectedSourceMessageIds,
          summaryCoveredMessageIds,
          foreignLeakMessageIds: profileLeakMessageIds,
          rejected: metrics.rejected,
          degradedMode: mode === 'recent_only'
            ? 'recent_only'
            : mode === 'full_context'
              ? 'full_context'
              : mode === 'fts5_only' || metrics.embeddingFallbacks > 0
                ? 'fts5_only'
                : null,
          promptChars,
          promptBudgetChars: PROMPT_BUDGET_CHARS,
          latencyMs: {
            retrieval: Math.max(retrievalElapsedMs, metrics.retrievalLatencyMs),
            total: Date.now() - startedAt,
          },
        },
      };
    } finally {
      memory.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
