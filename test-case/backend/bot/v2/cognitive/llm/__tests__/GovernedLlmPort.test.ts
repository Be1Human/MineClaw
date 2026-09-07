import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  GovernedLlmPort,
  type AgentContextReducer,
  type ContextCandidateV1,
  type ContextSegmentV1,
  type GovernedLlmTransport,
} from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/contextGovernance.js';
import { RequestTokenMeter, type WireRequestTokenizer } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/requestTokenMeter.js';
import type { AgentContextPolicyConfigV1 } from '../../../../../../../apps/minecraft-companion/src/bot/v2/cognitive/llm/contextBudget.js';
import type { ModelContextProfileResolution } from '../../../../../../../apps/minecraft-companion/src/llm/modelContextProfile.js';

const policy: AgentContextPolicyConfigV1 = {
  revision: 'governance-test/v1',
  purposes: {
    test: {
      softInputLimitTokens: 1_000,
      minimumSafetyReserveTokens: 100,
      safetyReserveRatio: 0.05,
      compactionTriggerRatio: 0.85,
      compactionTargetRatio: 0.70,
      minimumRecentHistoryTokens: 100,
      maxSummaryTokens: 200,
    },
  },
};

const resolvedProfile: ModelContextProfileResolution = {
  kind: 'resolved',
  profile: {
    schema: 'mineclaw.model-context-profile/v1', profileId: 'governed-profile', routeId: 'governed-route',
    model: 'governed-model', api: 'openai-completions', contextWindowTokens: 2_000, maxOutputTokens: 500,
    windowAccounting: 'input_plus_output', tokenizerRef: 'fixture-cost/v1',
    source: { kind: 'explicit_config', version: 'v1', verifiedAt: '2026-09-06T00:00:00.000Z' },
  },
};

const costTokenizer: WireRequestTokenizer = {
  tokenizerRef: 'fixture-cost/v1',
  measure: request => {
    const tokens = Number(request.body.tokenCost);
    return { tokens, upperBoundTokens: tokens, precision: 'exact' };
  },
};

const segment = (
  id: string,
  cost: number,
  retention: ContextSegmentV1['retention'],
  atomicGroupId?: string,
): ContextSegmentV1 => ({
  id,
  kind: id.startsWith('summary') ? 'compaction_summary' : id === 'system' ? 'stable_system' : id === 'instruction' ? 'current_instruction' : 'history_round',
  retention,
  ...(atomicGroupId ? { atomicGroupId } : {}),
  sourceRefs: [`event:${id}`],
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'x'.repeat(cost) }] }],
});

const candidate = (segments: readonly ContextSegmentV1[] = [
  segment('system', 200, 'required'),
  segment('old', 400, 'compactable'),
  segment('optional', 100, 'optional'),
  segment('instruction', 200, 'required'),
]): ContextCandidateV1 => ({ segments, tools: [], requestedOutputTokens: 200 });

class FakeTransport implements GovernedLlmTransport<Readonly<ContextCandidateV1>, string> {
  prepares = 0;
  dispatches = 0;
  throwOnDispatch = false;

  constructor(private readonly resolution: ModelContextProfileResolution = resolvedProfile) {}

  profile(): ModelContextProfileResolution { return this.resolution; }

  prepare(input: Readonly<ContextCandidateV1>) {
    this.prepares += 1;
    const tokenCost = input.segments.reduce((sum, item) => (
      sum + item.messages.reduce((messageSum, message) => messageSum + message.content.reduce((blockSum, block) => (
        blockSum + (block.kind === 'text' ? block.text.length : 0)
      ), 0), 0)
    ), 0);
    return { exact: { path: '/fixture', body: { tokenCost } }, prepared: input };
  }

  async dispatch(input: Readonly<ContextCandidateV1>) {
    this.dispatches += 1;
    if (this.throwOnDispatch) throw new Error('provider offline');
    const actualInputTokens = input.segments.reduce((sum, item) => sum + item.messages[0]!.content[0]!.text.length, 0);
    return { value: input.segments.map(item => item.id).join(','), actualInputTokens };
  }
}

const goodReducer: AgentContextReducer<{ checkpoint: string }> = {
  reduce: async request => ({
    kind: 'reduced',
    segments: [
      request.candidate.segments[0]!,
      segment('summary:v2', 100, 'compactable'),
      request.candidate.segments[3]!,
    ],
    proposal: { checkpoint: 'v2' },
  }),
};

const createPort = (
  transport: FakeTransport,
  reducer?: AgentContextReducer<{ checkpoint: string }>,
) => new GovernedLlmPort({
  purpose: 'test', policy: () => policy, transport, reducer,
  meter: new RequestTokenMeter([costTokenizer]),
});

describe('FEAT-CROSS-29 · GovernedLlmPort orchestration', () => {
  it('CP-01 dispatches the same prepared request once when input is below trigger', async () => {
    const transport = new FakeTransport();
    const result = await createPort(transport).call(candidate([
      segment('system', 200, 'required'), segment('instruction', 200, 'required'),
    ]));
    assert.equal(result.kind, 'completed');
    assert.equal(transport.prepares, 2);
    assert.equal(transport.dispatches, 1);
    if (result.kind === 'completed') assert.equal(result.receipt.reduced, false);
  });

  it('CP-02 reduces, reprepares, remeasures and returns a proposal without persisting it', async () => {
    const transport = new FakeTransport();
    const result = await createPort(transport, goodReducer).call(candidate());
    assert.equal(result.kind, 'completed');
    assert.equal(transport.prepares, 3);
    assert.equal(transport.dispatches, 1);
    if (result.kind === 'completed') {
      assert.equal(result.result, 'system,summary:v2,instruction');
      assert.deepEqual(result.proposal, { checkpoint: 'v2' });
      assert.equal(result.receipt.measureBefore.upperBoundTokens, 900);
      assert.equal(result.receipt.measureAfter?.upperBoundTokens, 500);
      assert.equal(result.receipt.reduced, true);
    }
  });

  it('CP-03 rejects a reducer that removes or mutates a required segment', async () => {
    const transport = new FakeTransport();
    const removesRequired: AgentContextReducer<{ checkpoint: string }> = {
      reduce: async request => ({ kind: 'reduced', segments: request.candidate.segments.filter(item => item.id !== 'system') }),
    };
    const result = await createPort(transport, removesRequired).call(candidate());
    assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.equal(result.reason, 'context_reducer_contract_violation');
    assert.equal(transport.dispatches, 0);
  });

  it('CP-04 rejects partial removal of an atomic tool group', async () => {
    const grouped = candidate([
      segment('system', 200, 'required'),
      segment('tool-call', 350, 'compactable', 'tool-round-1'),
      segment('tool-result', 350, 'compactable', 'tool-round-1'),
      segment('instruction', 200, 'required'),
    ]);
    const transport = new FakeTransport();
    const splitsGroup: AgentContextReducer = {
      reduce: async request => ({ kind: 'reduced', segments: request.candidate.segments.filter(item => item.id !== 'tool-result') }),
    };
    const result = await createPort(transport, splitsGroup).call(grouped);
    assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.match(result.detail ?? '', /atomic group split/);
    assert.equal(transport.dispatches, 0);
  });

  it('CP-05 rejects fake reduction success that remains above dispatch limit', async () => {
    const transport = new FakeTransport();
    const unchanged: AgentContextReducer = {
      reduce: async request => ({ kind: 'reduced', segments: request.candidate.segments }),
    };
    const result = await createPort(transport, unchanged).call(candidate([
      segment('system', 200, 'required'),
      segment('old', 400, 'compactable'),
      segment('optional', 110, 'optional'),
      segment('instruction', 200, 'required'),
    ]));
    assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.equal(result.reason, 'context_reduction_insufficient');
    assert.equal(transport.dispatches, 0);
  });

  it('CP-06 fails closed before Provider dispatch for unresolved profile and required overflow', async () => {
    const unresolved = new FakeTransport({
      kind: 'unresolved', reason: 'profile_not_found', routeId: 'r', model: 'm', detail: 'missing',
    });
    assert.equal((await createPort(unresolved).call(candidate())).reason, 'model_context_profile_unresolved');
    assert.equal(unresolved.prepares, 0);
    assert.equal(unresolved.dispatches, 0);

    const overflow = new FakeTransport();
    const result = await createPort(overflow).call(candidate([
      segment('system', 950, 'required'), segment('instruction', 100, 'required'),
    ]));
    assert.equal(result.kind, 'rejected');
    if (result.kind === 'rejected') assert.equal(result.reason, 'context_required_surface_exceeds_budget');
    assert.equal(overflow.dispatches, 0);
  });

  it('CP-07 converts reducer throw and cancellation into no-dispatch terminal results', async () => {
    const throwingTransport = new FakeTransport();
    const throwing: AgentContextReducer = { reduce: async () => { throw new Error('reducer bug'); } };
    const failed = await createPort(throwingTransport, throwing).call(candidate());
    assert.equal(failed.kind, 'failed');
    assert.equal(throwingTransport.dispatches, 0);

    const cancelledTransport = new FakeTransport();
    const cancelled: AgentContextReducer = { reduce: async () => ({ kind: 'cancelled', reason: 'stop' }) };
    const cancelledResult = await createPort(cancelledTransport, cancelled).call(candidate());
    assert.equal(cancelledResult.kind, 'cancelled');
    assert.equal(cancelledTransport.dispatches, 0);
  });

  it('CP-08 surfaces Provider failure and never returns the reducer proposal as committed', async () => {
    const transport = new FakeTransport();
    transport.throwOnDispatch = true;
    const result = await createPort(transport, goodReducer).call(candidate());
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.equal(result.reason, 'provider_dispatch_failed');
    assert.equal('proposal' in result, false);
    assert.equal(transport.dispatches, 1);
  });
});
