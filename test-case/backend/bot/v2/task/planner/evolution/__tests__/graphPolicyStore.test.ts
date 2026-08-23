import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionGraphStore, type EvolutionNode } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/evolutionGraphStore.js';
import { PlannerPolicyStore, PolicyConflictError, type PlannerPolicyContent } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/policyStore.js';
import { PlannerExperienceProvider } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/experience/plannerExperienceProvider.js';
import type { ExperienceCandidate } from '../../../../../../../../apps/minecraft-companion/src/bot/v2/task/planner/evolution/plannerOptimizer.js';

describe('EvolutionGraphStore', () => {
  test('证据节点和边可按时间查询受限邻域', () => {
    const store = new EvolutionGraphStore(':memory:');
    store.upsertNode(node('goal:rail', 'goal_pattern', ['episode-1']));
    store.upsertNode(node('fragment:smelt', 'plan_fragment', ['episode-1']));
    store.upsertNode(node('failure:fuel', 'failure_pattern', ['episode-2'], '2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z'));
    store.upsertNode(node('episode:rail', 'episode', ['episode-1']));
    store.upsertEdge({
      id: 'edge-1', from: 'goal:rail', to: 'fragment:smelt', type: 'decomposes_to',
      evidenceIds: ['episode-1'], confidenceLowerBound: 0.8, validFrom: '2026-08-01T00:00:00.000Z',
    });
    store.upsertEdge({
      id: 'edge-2', from: 'fragment:smelt', to: 'failure:fuel', type: 'refutes',
      evidenceIds: ['episode-2'], validFrom: '2026-08-01T00:00:00.000Z', validTo: '2026-08-03T00:00:00.000Z',
    });
    store.upsertEdge({
      id:'edge-runtime',from:'goal:rail',to:'episode:rail',type:'observed',
      evidenceIds:['episode-1'],validFrom:'2026-08-01T00:00:00.000Z',
    });

    const historical = store.querySubgraph(['goal:rail'], { depth: 2, at: '2026-08-02T00:00:00.000Z' });
    assert.deepEqual(historical.nodes.map(item => item.id).sort(), ['episode:rail', 'failure:fuel', 'fragment:smelt', 'goal:rail']);
    assert.equal(historical.edges.length, 3);

    const knowledgeOnly=store.querySubgraph(['goal:rail'],{depth:2,at:'2026-08-02T00:00:00.000Z',types:['goal_pattern','plan_fragment','failure_pattern']});
    assert.deepEqual(knowledgeOnly.nodes.map(item=>item.id).sort(),['failure:fuel','fragment:smelt','goal:rail']);
    assert.equal(knowledgeOnly.edges.length,2,'运行 Episode 不得挤占知识子图节点预算');

    const current = store.querySubgraph(['goal:rail'], { depth: 2, at: '2026-08-04T00:00:00.000Z' });
    assert.deepEqual(current.nodes.map(item => item.id).sort(), ['episode:rail', 'fragment:smelt', 'goal:rail']);
    assert.equal(current.edges.length, 2);
    store.close();
  });

  test('非 Draft 结论和关系必须有证据，边不能悬空', () => {
    const store = new EvolutionGraphStore(':memory:');
    assert.throws(() => store.upsertNode(node('goal:x', 'goal_pattern', [])), /requires evidence/);
    store.upsertNode({ ...node('draft:x', 'candidate', []), state: 'draft' });
    assert.throws(() => store.upsertEdge({
      id: 'missing', from: 'draft:x', to: 'not-found', type: 'supports',
      evidenceIds: ['episode-1'], validFrom: '2026-08-01T00:00:00.000Z',
    }), /missing nodes/);
    store.close();
  });
});

describe('PlannerPolicyStore', () => {
  test('candidate 必须过严格 gate 才能 promote，版本切换和 rollback 原子完成', () => {
    const store = new PlannerPolicyStore(':memory:');
    const v1 = store.createCandidate({
      id: 'policy-v1', version: 1, content: content('check-furnace'),
      evidenceIds: ['episode-1', 'eval-1'], confidenceLowerBound: 0.7,
    });
    assert.throws(() => store.promote(v1.id, v1.revision, {
      decision: 'promote', selectionDelta: 0, hiddenRegression: false,
      safetyViolations: 0, evaluationId: 'eval-bad',
    }), /gate rejected/);

    const trustedV1 = store.promote(v1.id, v1.revision, {
      decision: 'promote', selectionDelta: 0.1, hiddenRegression: false,
      safetyViolations: 0, evaluationId: 'eval-1',
    });
    assert.equal(trustedV1.state, 'trusted');
    assert.equal(store.active()?.id, 'policy-v1');

    const v2 = store.createCandidate({
      id: 'policy-v2', version: 2, content: content('reuse-workbench'),
      evidenceIds: ['episode-2', 'eval-2'], evolvedFrom: 'policy-v1', confidenceLowerBound: 0.8,
    });
    const trustedV2 = store.promote(v2.id, v2.revision, {
      decision: 'promote', selectionDelta: 0.08, hiddenRegression: false,
      safetyViolations: 0, evaluationId: 'eval-2',
    });
    assert.equal(store.active()?.id, 'policy-v2');
    assert.equal(store.get('policy-v1')?.state, 'superseded');

    const disabledV2 = store.disable('policy-v2', trustedV2.revision, 'owner rejected regression');
    assert.equal(disabledV2.state, 'disabled');
    assert.equal(store.active(), null);

    const oldV1 = store.get('policy-v1')!;
    const rolledBack = store.rollback(oldV1.id, oldV1.revision, 'restore known good');
    assert.equal(rolledBack.state, 'trusted');
    assert.equal(store.active()?.id, 'policy-v1');
    assert.throws(
      () => store.disable('policy-v1', oldV1.revision, 'stale revision'),
      PolicyConflictError,
    );
    store.close();
  });

  test('PlannerExperienceBundle 是冻结快照，Policy 切换不改写旧 Bundle', () => {
    const store = new PlannerPolicyStore(':memory:');
    const provider = new PlannerExperienceProvider(store);
    const candidate = store.createCandidate({
      id: 'policy-v1', version: 1, content: content('first'),
      evidenceIds: ['episode-1'], confidenceLowerBound: 0.75,
    });
    store.promote(candidate.id, candidate.revision, {
      decision: 'promote', selectionDelta: 0.1, hiddenRegression: false,
      safetyViolations: 0, evaluationId: 'eval-1',
    });
    const snapshot = provider.retrieve()!;
    assert.equal(snapshot.policySnapshotId, 'policy-v1@2');
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.taskSchemas), true);

    const next = store.createCandidate({
      id: 'policy-v2', version: 2, content: content('second'),
      evidenceIds: ['episode-2'], evolvedFrom: 'policy-v1', confidenceLowerBound: 0.8,
    });
    store.promote(next.id, next.revision, {
      decision: 'promote', selectionDelta: 0.05, hiddenRegression: false,
      safetyViolations: 0, evaluationId: 'eval-2',
    });
    assert.equal(snapshot.policySnapshotId, 'policy-v1@2');
    assert.equal(provider.retrieve()?.policySnapshotId, 'policy-v2@2');
    assert.equal('preparedAction' in snapshot, false);
    store.close();
  });

  test('不同任务族的可信 Policy 可并存且只替换同族版本', () => {
    const store = new PlannerPolicyStore(':memory:');
    const gathering = store.createCandidate({ id:'g-v1', version:1, content:contentForFamily('gathering'), evidenceIds:['g-1'], confidenceLowerBound:.7 });
    store.promote(gathering.id,gathering.revision,{decision:'promote',selectionDelta:.2,hiddenRegression:false,safetyViolations:0,evaluationId:'eg1'});
    const crafting = store.createCandidate({ id:'c-v1', version:2, content:contentForFamily('crafting'), evidenceIds:['c-1'], confidenceLowerBound:.7 });
    store.promote(crafting.id,crafting.revision,{decision:'promote',selectionDelta:.2,hiddenRegression:false,safetyViolations:0,evaluationId:'ec1'});
    assert.equal(store.activeForTaskFamily('gathering')?.id,'g-v1');
    assert.equal(store.activeForTaskFamily('crafting')?.id,'c-v1');
    assert.equal(store.listActive().length,2);
    const gatheringV2 = store.createCandidate({ id:'g-v2', version:3, content:contentForFamily('gathering'), evidenceIds:['g-2'], confidenceLowerBound:.8 });
    store.promote(gatheringV2.id,gatheringV2.revision,{decision:'promote',selectionDelta:.1,hiddenRegression:false,safetyViolations:0,evaluationId:'eg2'});
    assert.equal(store.get('g-v1')?.state,'superseded');
    assert.equal(store.get('c-v1')?.state,'trusted');
    store.close();
  });

  test('同任务族不同 GoalSignature 独立版本、父链和 Active 槽', () => {
    const store = new PlannerPolicyStore(':memory:');
    const iron = scopedContent('crafting','obtain:item:minecraft:iron_pickaxe:1','minecraft:iron_pickaxe');
    const rail = scopedContent('crafting','obtain:item:minecraft:rail:16','minecraft:rail');
    const ironV1=store.createCandidate({id:'iron-v1',version:store.nextVersionForContent(iron),content:iron,evidenceIds:['iron-1'],confidenceLowerBound:.7});
    store.promote(ironV1.id,ironV1.revision,{decision:'promote',selectionDelta:.2,hiddenRegression:false,safetyViolations:0,evaluationId:'iron-e1'});
    const railV1=store.createCandidate({id:'rail-v1',version:store.nextVersionForContent(rail),content:rail,evidenceIds:['rail-1'],confidenceLowerBound:.7});
    store.promote(railV1.id,railV1.revision,{decision:'promote',selectionDelta:.2,hiddenRegression:false,safetyViolations:0,evaluationId:'rail-e1'});
    assert.equal(ironV1.version,1);assert.equal(railV1.version,1);
    assert.equal(store.activeForContent(iron)?.id,'iron-v1');assert.equal(store.activeForContent(rail)?.id,'rail-v1');
    const ironV2=store.createCandidate({id:'iron-v2',version:store.nextVersionForContent(iron),content:iron,evidenceIds:['iron-2'],evolvedFrom:store.activeForContent(iron)?.id,confidenceLowerBound:.8});
    store.promote(ironV2.id,ironV2.revision,{decision:'promote',selectionDelta:.1,hiddenRegression:false,safetyViolations:0,evaluationId:'iron-e2'});
    assert.equal(ironV2.version,2);assert.equal(store.get('iron-v1')?.state,'superseded');assert.equal(store.get('rail-v1')?.state,'trusted');assert.equal(store.get('iron-v2')?.evolvedFrom,'iron-v1');
    store.close();
  });

  test('普通生产检索无可信 Policy 时不泄漏候选试用快照', () => {
    const store = new PlannerPolicyStore(':memory:');
    const candidate: ExperienceCandidate = {
      id:'candidate:gather-oak',taskFamily:'gathering',goalPattern:'采集1个橡木原木',
      content:contentForFamily('gathering'),evidenceIds:['episode-1'],positiveEpisodeIds:[],negativeEpisodeIds:['episode-1'],
      confidenceLowerBound:0,status:'candidate',validationSpec:{id:'v',validatorId:'gathering-goal-verifier',primaryMetric:'success_rate',minimumSelectionSamples:2,minimumHiddenSamples:1,pairing:'snapshot_pair',treatmentField:'planner_policy'},
    };
    const provider = new PlannerExperienceProvider(store,{listCandidates:()=>[candidate]});
    const trial = provider.retrieve('采集1个橡木原木');
    assert.equal(trial,null);
    assert.equal(provider.retrieve('制作一个工作台'),null);
    assert.equal(Object.isFrozen(trial),true);
    store.close();
  });
});

function node(
  id: string,
  type: EvolutionNode['type'],
  evidenceIds: string[],
  validFrom = '2026-08-01T00:00:00.000Z',
  validTo?: string,
): EvolutionNode {
  return {
    id, type, label: id, summary: `summary:${id}`, evidenceIds, data: {}, validFrom,
    ...(validTo ? { validTo } : {}),
  };
}

function content(marker: string): PlannerPolicyContent {
  return {
    taskSchemas: [{ marker }],
    planFragments: [],
    planRecoveryPatterns: [],
    metaPolicies: [],
    applicability: [],
  };
}

function contentForFamily(taskFamily:string):PlannerPolicyContent{return {...content(taskFamily),applicability:[{taskFamily}]};}
function scopedContent(taskFamily:string,goalSignature:string,targetId:string):PlannerPolicyContent{return {...content(goalSignature),applicability:[{taskFamily,goalSignature,targetId}]};}
