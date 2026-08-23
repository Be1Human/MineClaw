export type BenchmarkProfile = 'smoke' | 'release' | 'full';
export type BenchmarkLayer = 'body' | 'experience' | 'reliability';
export type BenchmarkStatus = 'pass' | 'fail' | 'crash' | 'error' | 'incomplete';
export type BenchmarkSource = 'body-full' | 'body-matrix' | 'gym';

export interface BenchmarkCaseDefinition {
  id: string;
  title: string;
  layer: BenchmarkLayer;
  source: BenchmarkSource;
}

export interface BenchmarkCaseResult {
  id: string;
  title: string;
  layer: BenchmarkLayer;
  status: BenchmarkStatus;
  successRate: number;
  durationMs: number;
  responseLatencyMs?: number;
  watchdogHits?: number;
  failureKind?: 'task_failure' | 'false_complete' | 'hung' | 'terminal_mismatch' | 'crash' | 'harness_error';
  reason?: string;
  evidence: string[];
  attempts: number;
  passedAttempts: number;
}

export interface BenchmarkGates {
  falseComplete: number;
  crash: number;
  hung: number;
  terminalMismatch: number;
  incomplete: number;
  watchdog: number;
}

export interface BenchmarkScores {
  body: number | null;
  experience: number | null;
  reliability: number | null;
  overall: number;
}

export interface BenchmarkEnvironment {
  commit: string;
  dirty: boolean;
  server: string;
  backend: string;
  profile: BenchmarkProfile;
  targetedCase?: string;
}

export interface BenchmarkReport {
  schemaVersion: 'mineclaw-benchmark/v1';
  runId: string;
  startedAt: string;
  finishedAt: string;
  environment: BenchmarkEnvironment;
  expectedCaseIds: string[];
  results: BenchmarkCaseResult[];
  scores: BenchmarkScores;
  gates: BenchmarkGates;
  threshold: number;
  passed: boolean;
  baselineDiff?: Array<{ id: string; before: number; after: number; delta: number }>;
}

export interface BodyEvalScenarioResult {
  id: string;
  title: string;
  repeat: number;
  passed: number;
  successRate: number;
  avgDurationMs: number;
  watchdogHits: number;
  topFailReasons: Array<{ reason: string; count: number }>;
}

export interface BodyEvalReport {
  scenarios: BodyEvalScenarioResult[];
}

export interface GymTaskResult {
  task: string;
  name: string;
  verdict: 'PASS' | 'FAIL' | 'CRASH';
  durationMs: number;
  instructionDurationMs?: number;
  responseLatencyMs?: number;
  failureKind?: BenchmarkCaseResult['failureKind'];
  checks: Array<{ name: string; expect: string; actual: string; ok: boolean }>;
  notes: string[];
}
