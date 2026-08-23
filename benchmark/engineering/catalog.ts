import { selectScenarios } from './body/index.js';
import { TASKS } from './experience/tasks.js';
import type { BenchmarkCaseDefinition, BenchmarkProfile } from './types.js';

const fullBody: BenchmarkCaseDefinition[] = selectScenarios({ suite: 'full' }).map(factory => {
  const scenario = factory();
  return { id: scenario.id, title: scenario.title, layer: 'body', source: 'body-full' };
});

const matrixBody: BenchmarkCaseDefinition[] = selectScenarios({ suite: 'matrix' }).map(factory => {
  const scenario = factory();
  return { id: scenario.id, title: scenario.title, layer: 'body', source: 'body-matrix' };
});

const gymCases: BenchmarkCaseDefinition[] = TASKS.map(task => ({
  id: task.id,
  title: task.name,
  layer: task.layer ?? 'experience',
  source: 'gym',
}));

const allCases = [...fullBody, ...matrixBody, ...gymCases];
const byId = new Map<string, BenchmarkCaseDefinition>();
for (const item of allCases) {
  if (byId.has(item.id)) throw new Error(`Benchmark Case ID 重复：${item.id}`);
  byId.set(item.id, item);
}

const smokeIds = [
  'NAV-01', 'NAV-02', 'GATHER-01', 'CRAFT-01', 'SURV-01',
  'T01', 'T06', 'T07', 'T10', 'T12', 'T21', 'T22', 'T24',
];

function requireCases(ids: string[]): BenchmarkCaseDefinition[] {
  return ids.map(id => {
    const item = byId.get(id);
    if (!item) throw new Error(`Benchmark Profile 引用了不存在的 Case：${id}`);
    return item;
  });
}

export function casesForProfile(profile: BenchmarkProfile): BenchmarkCaseDefinition[] {
  if (profile === 'smoke') return requireCases(smokeIds);
  if (profile === 'release') return [...fullBody, ...gymCases];
  return [...fullBody, ...matrixBody, ...gymCases];
}

export function caseById(id: string): BenchmarkCaseDefinition | undefined {
  return byId.get(id);
}

export function allBenchmarkCases(): BenchmarkCaseDefinition[] {
  return [...allCases];
}
