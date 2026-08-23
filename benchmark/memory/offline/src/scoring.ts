import type { BenchmarkConfig, BenchmarkManifest, BenchmarkScore, DomainScore, GateResult, ScoredCase, CaseExecution, BenchmarkDomain } from './types.js';

export function scoreCase(execution: CaseExecution): ScoredCase {
  const totalWeight = execution.checks.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) throw new Error(`case has no positive check weight: ${execution.caseId}`);
  const passedWeight = execution.checks.filter(item => item.passed).reduce((sum, item) => sum + item.weight, 0);
  const failedCriticalChecks = execution.checks.filter(item => item.critical && !item.passed).map(item => item.id);
  const score = passedWeight / totalWeight;
  return { ...execution, score, passed: failedCriticalChecks.length === 0 && score >= 0.8, failedCriticalChecks };
}

export function scoreBenchmark(cases: ScoredCase[], config: BenchmarkConfig, manifest: BenchmarkManifest): BenchmarkScore {
  const domains = manifest.requiredDomains.map(domain => domainScore(domain, cases));
  const activeDomains = domains.filter(item => item.cases > 0);
  const activeWeight = activeDomains.reduce((sum, item) => sum + config.domainWeights[item.domain], 0);
  const totalScore = activeWeight === 0 ? 0 : activeDomains.reduce((sum, item) => sum + item.score * config.domainWeights[item.domain], 0) / activeWeight;
  const allChecks = cases.flatMap(item => item.checks);
  const isolation = allChecks.filter(item => item.kind === 'profile_isolation');
  const restart = allChecks.filter(item => item.kind === 'restart');
  const profileLeakRate = isolation.length === 0 ? 0 : isolation.filter(item => !item.passed).length / isolation.length;
  const restartPassRate = restart.length === 0 ? 0 : restart.filter(item => item.passed).length / restart.length;
  const evidenceCoverage = allChecks.length === 0 ? 0 : allChecks.filter(item => item.evidence.length > 0 && item.evidence.every(Boolean)).length / allChecks.length;
  const criticalFailures = allChecks.filter(item => item.critical && !item.passed).length;
  const gates: GateResult[] = [
    gate('total_score', totalScore >= config.gates.minimumTotalScore, `>= ${config.gates.minimumTotalScore}`, totalScore),
    gate('domain_score', activeDomains.every(item => item.score >= config.gates.minimumDomainScore), `every domain >= ${config.gates.minimumDomainScore}`, Object.fromEntries(activeDomains.map(item => [item.domain, item.score]))),
    gate('profile_isolation', profileLeakRate <= config.gates.maximumProfileLeakRate, `<= ${config.gates.maximumProfileLeakRate}`, profileLeakRate),
    gate('restart_durability', restartPassRate >= config.gates.minimumRestartPassRate, `>= ${config.gates.minimumRestartPassRate}`, restartPassRate),
    gate('evidence_coverage', evidenceCoverage >= config.gates.minimumEvidenceCoverage, `>= ${config.gates.minimumEvidenceCoverage}`, evidenceCoverage),
    gate('required_domains', !config.gates.requireAllDomains || domains.every(item => item.cases > 0), manifest.requiredDomains.join(', '), domains.filter(item => item.cases > 0).map(item => item.domain)),
    gate('critical_checks', !config.gates.failOnCriticalCheck || criticalFailures === 0, '= 0', criticalFailures),
  ];
  return { totalScore, domains, profileLeakRate, restartPassRate, evidenceCoverage, criticalFailures, gates, passed: gates.every(item => item.passed) };
}

function domainScore(domain: BenchmarkDomain, cases: ScoredCase[]): DomainScore {
  const selected = cases.filter(item => item.domain === domain);
  const score = selected.length === 0 ? 0 : selected.reduce((sum, item) => sum + item.score, 0) / selected.length;
  return { domain, cases: selected.length, passedCases: selected.filter(item => item.passed).length, score };
}

function gate(id: string, passed: boolean, expected: string, actual: unknown): GateResult {
  return { id, passed, expected, actual };
}
