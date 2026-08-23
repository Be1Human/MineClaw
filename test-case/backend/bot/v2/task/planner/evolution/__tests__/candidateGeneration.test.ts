import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlannerLearningStore } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/learningStore.js';
import { candidateIdentity } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/candidateIdentity.js';
import type { ExperienceCandidate } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerOptimizer.js';
import { PlannerPolicyStore } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import { PlannerExperienceProvider } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/experience/plannerExperienceProvider.js';
import type { ExperimentAuthorizationV1 } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/experience/experienceContracts.js';
import type { ContextSignature, GoalSignature } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/plannerContracts.js';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('FEAT-CROSS-14-006-011/012 · immutable candidate generations', () => {
  test('首个实验分配后同 ID 候选不可被后续提议覆盖，重启仍保持快照', () => {
    const db = database();
    let store = new PlannerLearningStore(db);
    const first = store.registerCandidateProposal(candidate());
    const identity = candidateIdentity(first);
    store.upsertValidationRun(validation(first, 'collecting'));
    store.allocateExperiment({
      planRunId: 'plan-selection-1', candidateId: first.id,
      candidateGeneration: identity.generation, candidateContentHash: identity.contentHash,
      experimentId: 'experiment-1', authorizationId: 'authorization-1', split: 'selection',
      contextSignatureHash: 'context-1', maxEstimatedActions: 120, state: 'allocated',
    });

    const changed = store.registerCandidateProposal(candidate({
      taskSchemas: [{ id: 'schema:iron', stages: ['wood', 'stone', 'iron', 'craft'] }],
    }, ['episode-1', 'episode-2']));
    assert.equal(changed.id, first.id);
    assert.equal(changed.contentHash, identity.contentHash);
    assert.deepEqual(changed.positiveEpisodeIds, ['episode-1']);
    store.close();

    store = new PlannerLearningStore(db);
    const restored = store.getCandidate(first.id)!;
    const allocation = store.getExperimentAllocation('plan-selection-1')!;
    assert.equal(restored.contentHash, identity.contentHash);
    assert.equal(restored.generation, 1);
    assert.equal(allocation.candidateContentHash, identity.contentHash);
    assert.equal(allocation.candidateGeneration, 1);
    store.close();
  });

  test('Provider 对候选 generation/contentHash 漂移 fail closed', () => {
    const learning = new PlannerLearningStore(':memory:');
    const stored = learning.registerCandidateProposal(candidate());
    const identity = candidateIdentity(stored);
    const policies = new PlannerPolicyStore(':memory:');
    const provider = new PlannerExperienceProvider(policies, learning);
    const auth = authorization(stored);
    const frozen = provider.freezeExperiment(request(), auth);
    assert.equal(frozen.status, 'frozen');
    if (frozen.status === 'frozen') assert.equal(frozen.bundle.policySnapshotId, `${stored.id}@1`);
    assert.deepEqual(provider.freezeExperiment(request(), { ...auth, candidateGeneration: 2 }), { status: 'rejected', reason: 'candidate_snapshot_mismatch' });
    assert.deepEqual(provider.freezeExperiment(request(), { ...auth, candidateContentHash: 'tampered' }), { status: 'rejected', reason: 'candidate_snapshot_mismatch' });
    assert.equal(identity.contentHash, auth.candidateContentHash);
    policies.close(); learning.close();
  });

  test('已裁决代际只有在新生产证据形成实质内容变化时创建 successor', () => {
    const db = database();
    let store = new PlannerLearningStore(db);
    const first = store.registerCandidateProposal(candidate());
    store.upsertValidationRun(validation(first, 'promoted'));

    const noChange = store.registerCandidateProposal(candidate(undefined, ['episode-1', 'episode-2']));
    assert.equal(noChange.id, first.id, '只增加证据、内容不变时不得制造假版本');
    assert.equal(store.listCandidatesForLineage(first.lineageId!).length, 1);

    const successor = store.registerCandidateProposal(candidate({
      taskSchemas: [{ id: 'schema:iron', stages: ['wood', 'stone', 'smelt', 'craft'] }],
    }, ['episode-1', 'episode-2']));
    assert.equal(successor.id, `${first.lineageId}:g2`);
    assert.equal(successor.generation, 2);
    assert.equal(successor.evolvedFromCandidateId, first.id);
    assert.deepEqual(successor.positiveEpisodeIds, ['episode-2']);
    assert.notEqual(successor.contentHash, first.contentHash);
    const attemptedOverwrite=store.registerCandidateProposal(candidate({
      taskSchemas:[{id:'schema:iron',stages:['tampered-after-successor']}],
    },['episode-1','episode-2','episode-3']));
    assert.equal(attemptedOverwrite.contentHash,successor.contentHash,'后继代建立后立即冻结，不等待首个 allocation');
    store.close();

    store = new PlannerLearningStore(db);
    const lineage = store.listCandidatesForLineage(first.lineageId!);
    assert.deepEqual(lineage.map(value => value.generation), [1, 2]);
    assert.equal(lineage[1]?.evolvedFromCandidateId, first.id);
    store.close();
  });

  test('内容哈希忽略嵌入证据 UUID，只有规划语义变化才换代', () => {
    const first=candidateIdentity(candidate({planFragments:[{id:'fragment:wood',stage:'wood',evidenceRefs:['event:a']}]}));
    const same=candidateIdentity(candidate({planFragments:[{id:'fragment:wood',stage:'wood',evidenceRefs:['event:b','event:c']}]}));
    const changed=candidateIdentity(candidate({planFragments:[{id:'fragment:wood',stage:'stone',evidenceRefs:['event:a']}]}));
    assert.equal(first.contentHash,same.contentHash);
    assert.notEqual(first.contentHash,changed.contentHash);
  });
});

function database(): string {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-generation-')); tempDirs.push(dir);
  return join(dir, 'evolution.db');
}

function candidate(contentPatch?: Partial<ExperienceCandidate['content']>, positiveEpisodeIds = ['episode-1']): ExperienceCandidate {
  return {
    id: 'candidate:iron-pickaxe', taskFamily: 'crafting', goalPattern: '制作一把铁镐',
    content: {
      taskSchemas: [{ id: 'schema:iron', stages: ['wood', 'stone', 'craft'] }],
      planFragments: [], planRecoveryPatterns: [], metaPolicies: [],
      applicability: [{ taskFamily: 'crafting', targetId: 'minecraft:iron_pickaxe', goalSignature: signature().key }],
      ...contentPatch,
    },
    evidenceIds: positiveEpisodeIds.map(value => `evidence:${value}`),
    positiveEpisodeIds, negativeEpisodeIds: [], confidenceLowerBound: .55, status: 'candidate',
    validationSpec: {
      id: 'validation:iron', validatorId: 'inventory', primaryMetric: 'success_rate',
      minimumSelectionSamples: 2, minimumHiddenSamples: 1, pairing: 'snapshot_pair', treatmentField: 'planner_policy',
    },
  };
}

function validation(value: ExperienceCandidate, status: 'collecting' | 'promoted') {
  const identity = candidateIdentity(value);
  return {
    candidateId: value.id, candidateGeneration: identity.generation, candidateContentHash: identity.contentHash,
    candidateEvidenceCutoffAt: '2026-08-03T00:00:00.000Z', baselineEpisodeIds: [...value.positiveEpisodeIds],
    baselineCutoffOccurredAt: '2026-08-03T00:00:00.000Z', selectionEpisodeIds: [], hiddenEpisodeIds: [],
    consumedTrialEpisodeIds: [], attempt: 1, status,
  };
}

function authorization(value: ExperienceCandidate): ExperimentAuthorizationV1 {
  const identity = candidateIdentity(value);
  return {
    schema: 'mineclaw.planner-experiment-authorization/v1', experimentId: 'experiment-1', candidateId: value.id,
    candidateGeneration: identity.generation, candidateContentHash: identity.contentHash,
    validationSpec: value.validationSpec!, split: 'selection',
    budget: { authorizationId: 'authorization-1', maxPlanRuns: 1, maxEstimatedActions: 120, authorized: true },
    contextComparable: true,
  };
}
function request() { return { planRunId: 'plan-1', goalSignature: signature(), context: context(), mode: 'experiment' as const }; }
function signature(): GoalSignature { return { key: 'obtain:item:minecraft:iron_pickaxe:1', outcome: 'obtain', targetKind: 'item', targetId: 'minecraft:iron_pickaxe', quantity: 1, constraintsHash: 'none', compatibleTaskFamilies: ['crafting'], schemaVersion: 1 }; }
function context(): ContextSignature { return { inventory: {}, capabilities: ['goal_agent'], nearbyFacilities: [], nearbyResources: [], timeBucket: 'day', dangerLevel: 0, positionRegion: 'region', worldRevision: 'tick:1' }; }
