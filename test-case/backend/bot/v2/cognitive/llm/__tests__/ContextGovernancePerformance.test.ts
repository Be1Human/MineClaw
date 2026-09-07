import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { ChatCompletionsCodec } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/chatCompletionsCodec.js';
import { ContextBudgetPlanner, ContextBudgetPolicySnapshotter } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/contextBudget.js';
import {
  GovernedLlmPort,
  type AgentContextReducer,
  type ContextCandidateV1,
  type ContextSegmentV1,
  type GovernedLlmTransport,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/contextGovernance.js';
import { RequestTokenMeter, type WireRequestTokenizer } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/requestTokenMeter.js';
import { __setTuningOverride, tuning } from '../../../../../../../apps/minecraft-companion/src/bot/v2/infra/tuning.js';

afterEach(() => __setTuningOverride(null));

const exactProfile = {
  schema: 'mineclaw.model-context-profile/v1' as const, profileId: 'perf-profile', routeId: 'perf-route',
  model: 'perf-model', api: 'openai-completions' as const, contextWindowTokens: 200_000, maxOutputTokens: 20_000,
  windowAccounting: 'input_plus_output' as const, tokenizerRef: 'wire-json-utf8-upper-bound/v1',
  source: { kind: 'explicit_config' as const, version: 'v1', verifiedAt: '2026-09-06T00:00:00.000Z' },
};

describe('FEAT-CROSS-29 · context governance performance and stability', () => {
  it('PF-01 keeps 128K prepare + measure + plan P95 below 50ms locally', t => {
    const codec = new ChatCompletionsCodec();
    const meter = new RequestTokenMeter();
    const planner = new ContextBudgetPlanner();
    const policyResult = new ContextBudgetPolicySnapshotter().snapshot(tuning().agentContext, 'goalAgent');
    assert.equal(policyResult.kind, 'resolved');
    if (policyResult.kind !== 'resolved') return;
    const call = {
      messages: [{ role: 'user' as const, content: [{ kind: 'text' as const, text: 'x'.repeat(128 * 1024) }] }],
      tools: [],
      maxTokens: 4_096,
    };
    const durations: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      const request = codec.buildRequest(call, { routeId: 'perf-route', model: 'perf-model', baseUrl: 'https://perf.example/v1' });
      const measured = meter.measure({ profile: exactProfile, request });
      assert.equal(measured.kind, 'measured');
      if (measured.kind === 'measured') {
        planner.plan({ profile: exactProfile, measure: measured.measure, policy: policyResult.policy, requestedOutputTokens: 4_096 });
      }
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    t.diagnostic(`128K prepare+measure+plan P95=${p95.toFixed(2)}ms over ${durations.length} samples`);
    assert.ok(p95 <= 50, `prepare+measure+plan P95 ${p95.toFixed(2)}ms exceeded 50ms`);
  });

  it('PF-02 does not retrigger after reduction until the trigger is crossed again', () => {
    const planner = new ContextBudgetPlanner();
    const policyResult = new ContextBudgetPolicySnapshotter().snapshot(tuning().agentContext, 'mainBrain');
    assert.equal(policyResult.kind, 'resolved');
    if (policyResult.kind !== 'resolved') return;
    const measure = (tokens: number) => ({
      schema: 'mineclaw.token-measure/v1' as const, tokens, upperBoundTokens: tokens,
      precision: 'exact' as const, tokenizerRef: 'exact', sectionTokens: [],
    });
    const first = planner.plan({ profile: exactProfile, measure: measure(27_000), policy: policyResult.policy, requestedOutputTokens: 2_000 });
    assert.equal(first.action, 'reduce');
    const after = planner.plan({
      profile: exactProfile, measure: measure(27_000), measureAfter: measure(20_000),
      policy: policyResult.policy, requestedOutputTokens: 2_000,
    });
    assert.equal(after.action, 'keep');
    assert.equal(planner.plan({ profile: exactProfile, measure: measure(20_500), policy: policyResult.policy, requestedOutputTokens: 2_000 }).action, 'keep');
    assert.equal(planner.plan({ profile: exactProfile, measure: measure(27_000), policy: policyResult.policy, requestedOutputTokens: 2_000 }).action, 'reduce');
  });

  it('PF-03 keeps exact wire JSON stable for identical ordered tools', () => {
    const codec = new ChatCompletionsCodec();
    const call = {
      messages: [{ role: 'user' as const, content: [{ kind: 'text' as const, text: 'test' }] }],
      tools: [
        { name: 'a', description: 'first', parameters: { type: 'object' } },
        { name: 'b', description: 'second', parameters: { type: 'object' } },
      ],
    };
    const route = { routeId: 'stable', model: 'stable', baseUrl: 'https://stable.example/v1' };
    assert.equal(JSON.stringify(codec.buildRequest(call, route).body), JSON.stringify(codec.buildRequest(call, route).body));
  });

  it('PF-04 applies a valid hot policy to the next snapshot without mutating the current one', () => {
    const snapshotter = new ContextBudgetPolicySnapshotter();
    const current = snapshotter.snapshot(tuning().agentContext, 'goalAgent');
    assert.equal(current.kind, 'resolved');
    if (current.kind !== 'resolved') return;
    __setTuningOverride({ agentContext: { revision: 'agent-context-policy/test-hot', purposes: { goalAgent: { softInputLimitTokens: 65_536 } } } });
    const next = snapshotter.snapshot(tuning().agentContext, 'goalAgent');
    assert.equal(next.kind, 'resolved');
    if (next.kind !== 'resolved') return;
    assert.equal(current.policy.softInputLimitTokens, 131_072);
    assert.equal(current.policy.revision, 'agent-context-policy/v1');
    assert.equal(next.policy.softInputLimitTokens, 65_536);
    assert.equal(next.policy.revision, 'agent-context-policy/test-hot');
  });
});

const costTokenizer: WireRequestTokenizer = {
  tokenizerRef: 'reducer-cost/v1',
  measure: request => ({
    tokens: Number(request.body.cost), upperBoundTokens: Number(request.body.cost), precision: 'exact',
  }),
};

const contextSegment = (id: string, cost: number, retention: ContextSegmentV1['retention']): ContextSegmentV1 => ({
  id, kind: id.startsWith('summary') ? 'compaction_summary' : id === 'required' ? 'stable_system' : 'history_round',
  retention, sourceRefs: [`source:${id}`],
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'x'.repeat(cost) }] }],
});

class ReducerContractTransport implements GovernedLlmTransport<Readonly<ContextCandidateV1>, string> {
  profile() {
    return {
      kind: 'resolved' as const,
      profile: { ...exactProfile, contextWindowTokens: 2_000, maxOutputTokens: 500, tokenizerRef: costTokenizer.tokenizerRef },
    };
  }
  prepare(candidate: Readonly<ContextCandidateV1>) {
    const cost = candidate.segments.reduce((sum, item) => sum + item.messages[0]!.content[0]!.text.length, 0);
    return { exact: { path: '/fixture', body: { cost } }, prepared: candidate };
  }
  async dispatch(candidate: Readonly<ContextCandidateV1>) {
    return { value: candidate.segments.map(item => item.id).join(',') };
  }
}

describe('FEAT-CROSS-29 · reducer substitution contract', () => {
  it('LS-03/04 substitutes drop-optional and summarize-oldest reducers without core type checks', async () => {
    const input: ContextCandidateV1 = {
      segments: [contextSegment('required', 400, 'required'), contextSegment('old', 400, 'optional')],
      tools: [], requestedOutputTokens: 200,
    };
    const reducers: AgentContextReducer[] = [
      { reduce: async request => ({ kind: 'reduced', segments: request.candidate.segments.filter(item => item.retention !== 'optional') }) },
      { reduce: async request => ({ kind: 'reduced', segments: [request.candidate.segments[0]!, contextSegment('summary:old', 100, 'compactable')] }) },
    ];
    for (const reducer of reducers) {
      const result = await new GovernedLlmPort({
        purpose: 'test',
        policy: () => ({
          revision: 'v1', purposes: { test: {
            softInputLimitTokens: 1_000, minimumSafetyReserveTokens: 100, safetyReserveRatio: 0.05,
            compactionTriggerRatio: 0.85, compactionTargetRatio: 0.70,
            minimumRecentHistoryTokens: 100, maxSummaryTokens: 200,
          } },
        }),
        transport: new ReducerContractTransport(), reducer,
        meter: new RequestTokenMeter([costTokenizer]),
      }).call(input);
      assert.equal(result.kind, 'completed');
      if (result.kind === 'completed') assert.equal(result.receipt.reduced, true);
    }
  });
});
