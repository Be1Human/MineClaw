export type MemoryBenchMode = 'recent_only' | 'full_context' | 'fts5_only' | 'hybrid';

export interface MemoryBenchMessage {
  id: string;
  role: 'owner' | 'bot';
  content: string;
  timestamp: number;
}

export interface MemoryBenchSession {
  id: string;
  messages: MemoryBenchMessage[];
}

export interface MemoryBenchForeignProfile {
  profileId: string;
  sessions: MemoryBenchSession[];
}

export interface MemoryBenchCase {
  id: string;
  category: 'preference' | 'crud' | 'conflict' | 'do_not_store' | 'semantic' | 'isolation' | 'security' | 'flush' | 'degraded';
  split: 'dev' | 'test';
  sessions: MemoryBenchSession[];
  foreignProfiles?: MemoryBenchForeignProfile[];
  question: string;
  answers: string[];
  expectedCaptureMessageIds: string[];
  relevantMessageIds: string[];
  alternativeMessageIds?: string[];
  forbiddenMessageIds?: string[];
  expectedOperation?: 'add' | 'replace' | 'remove' | 'reject' | 'none';
  expectedRejectionReason?: string;
  shouldAbstain?: boolean;
  questionType?: 'general' | 'temporal';
  expectedFlush?: boolean;
  expectedOpenLoopMessageIds?: string[];
  expectedCommitmentMessageIds?: string[];
}

export interface MemoryTrace {
  caseId: string;
  capturedFactIds: string[];
  capturedMessageIds: string[];
  activeFactIds: string[];
  activeSourceMessageIds: string[];
  retrievedFactIds: string[];
  retrievedSourceMessageIds: string[];
  injectedFactIds: string[];
  injectedSourceMessageIds: string[];
  summaryCoveredMessageIds: string[];
  foreignLeakMessageIds: string[];
  rejected: Record<string, number>;
  degradedMode: 'full_context' | 'fts5_only' | 'recent_only' | null;
  promptChars: number;
  promptBudgetChars: number;
  latencyMs: { retrieval: number; total: number };
}

export interface MemoryBenchResult {
  caseId: string;
  category: MemoryBenchCase['category'];
  split: MemoryBenchCase['split'];
  mode: MemoryBenchMode;
  answer: string;
  trace: MemoryTrace;
  answerCorrect: boolean;
  captureEvaluated: boolean;
  captureExpectedCount: number;
  captureActualCount: number;
  captureCorrectCount: number;
  capturePrecision: number;
  captureRecall: number;
  operationCorrect: boolean;
  retrievalRecall: number;
  retrievalPrecision: number;
  reciprocalRank: number;
  retrievalRelevantCount: number;
  retrievedSourceCount: number;
  retrievalCorrectCount: number;
  sourceCoverage: number;
  injectedSourceCount: number;
  injectedRelevantCount: number;
  irrelevantInjectionRate: number;
  forbiddenInjected: boolean;
  conflictCoInjected: boolean;
  profileLeak: boolean;
  promptBudgetRespected: boolean;
  abstentionCorrect: boolean | null;
  newFactAdopted: boolean | null;
  oldFactPolluted: boolean | null;
  memorySuccess: boolean;
  flushExecuted: boolean;
  openLoopRetention: number | null;
  commitmentRetention: number | null;
}
