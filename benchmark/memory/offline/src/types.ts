import type { MemoryBenchCase } from '../../shared/types.js';

export type BenchmarkDomain = 'chat' | 'explicit_place' | 'auto_discovery' | 'episode_location';
export type BenchmarkProfile = 'quick' | 'full';
export type BenchmarkSplit = 'dev' | 'test';
export type CheckKind = 'capability' | 'profile_isolation' | 'restart' | 'evidence' | 'unified_recall';

export interface Position {
  x: number;
  y: number;
  z: number;
}

interface BaseCase {
  id: string;
  domain: BenchmarkDomain;
  split: BenchmarkSplit;
  critical: boolean;
  tags: string[];
}

export interface ChatBenchmarkCase extends BaseCase {
  domain: 'chat';
  legacyCase: MemoryBenchCase;
}

export interface ExplicitPlaceCase extends BaseCase {
  domain: 'explicit_place';
  input: {
    kind: 'home' | 'chest' | 'resource' | 'landmark';
    name: string;
    position: Position;
    query: string;
  };
  expected: {
    kind: ExplicitPlaceCase['input']['kind'];
    name: string;
    position: Position;
    coordinateTolerance: number;
  };
}

export interface AutoDiscoveryCase extends BaseCase {
  domain: 'auto_discovery';
  input: {
    producer: 'world_scan' | 'mineral_probe';
    blockName: string;
    positions: Position[];
    ticks: number;
  };
  expected: {
    kind: 'chest' | 'resource';
    semanticMeta: Record<string, string>;
    positions: Position[];
    coordinateTolerance: number;
    deduplicatedCount: number;
  };
}

export interface EpisodeObservationFixture {
  id: string;
  phase: 'started' | 'event' | 'snapshot' | 'terminal';
  timestamp: number;
  eventSummary: string;
  health: number;
  isRaining: boolean;
  hostiles: string[];
  hazards?: string[];
  emotionTags?: string[];
  outcome?: string;
  keyFrame?: boolean;
}

export interface EpisodeLocationCase extends BaseCase {
  domain: 'episode_location';
  input: {
    profileId: string;
    kind: 'combat' | 'danger' | 'task' | 'social' | 'exploration';
    locationRef: string;
    query: string;
    observations: EpisodeObservationFixture[];
  };
  expected: {
    state: 'finalized' | 'aborted';
    outcome: string;
    participants: string[];
    minimumSnapshots: number;
    minimumSourceRefs: number;
    minimumHealth: number;
    locationRef: string;
    isRaining: boolean;
  };
}

export type UnifiedBenchmarkCase = ChatBenchmarkCase | ExplicitPlaceCase | AutoDiscoveryCase | EpisodeLocationCase;

export interface BenchmarkCheck {
  id: string;
  kind: CheckKind;
  passed: boolean;
  weight: number;
  critical: boolean;
  expected: unknown;
  actual: unknown;
  evidence: string[];
}

export interface CaseExecution {
  caseId: string;
  domain: BenchmarkDomain;
  split: BenchmarkSplit;
  tags: string[];
  checks: BenchmarkCheck[];
  trace: Record<string, unknown>;
  durationMs: number;
}

export interface ScoredCase extends CaseExecution {
  score: number;
  passed: boolean;
  failedCriticalChecks: string[];
}

export interface BenchmarkAdapter<TCase extends UnifiedBenchmarkCase = UnifiedBenchmarkCase> {
  readonly domain: TCase['domain'];
  execute(testCase: TCase, context: CaseContext): Promise<CaseExecution> | CaseExecution;
}

export interface CaseContext {
  profile: BenchmarkProfile;
  workDir: string;
}

export interface BenchmarkConfig {
  schemaVersion: 'mineclaw-memory-benchmark-config/v1';
  benchmarkVersion: string;
  defaultProfile: BenchmarkProfile;
  profiles: Record<BenchmarkProfile, {
    chatCaseLimit: number | null;
    includeSplits: BenchmarkSplit[];
    includeDomains: BenchmarkDomain[];
  }>;
  domainWeights: Record<BenchmarkDomain, number>;
  gates: {
    minimumTotalScore: number;
    minimumDomainScore: number;
    maximumProfileLeakRate: number;
    minimumRestartPassRate: number;
    minimumEvidenceCoverage: number;
    requireAllDomains: boolean;
    failOnCriticalCheck: boolean;
  };
}

export interface BenchmarkManifest {
  schemaVersion: 'mineclaw-memory-benchmark-manifest/v1';
  datasetVersion: string;
  name: string;
  requiredDomains: BenchmarkDomain[];
  sources: Array<{
    id: string;
    domain: BenchmarkDomain;
    kind: 'legacy_adapter' | 'json';
    location: string;
    expectedCases: number;
  }>;
}

export interface DomainScore {
  domain: BenchmarkDomain;
  cases: number;
  passedCases: number;
  score: number;
}

export interface GateResult {
  id: string;
  passed: boolean;
  expected: string;
  actual: unknown;
}

export interface BenchmarkScore {
  totalScore: number;
  domains: DomainScore[];
  profileLeakRate: number;
  restartPassRate: number;
  evidenceCoverage: number;
  criticalFailures: number;
  gates: GateResult[];
  passed: boolean;
}

export interface BenchmarkReport {
  schemaVersion: 'mineclaw-memory-benchmark-report/v1';
  benchmarkVersion: string;
  datasetVersion: string;
  datasetSha256: string;
  configSha256: string;
  runId: string;
  profile: BenchmarkProfile;
  gitCommit: string;
  startedAt: string;
  completedAt: string;
  externalLlmRequests: 0;
  score: BenchmarkScore;
  cases: ScoredCase[];
}
