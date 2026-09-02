/**
 * FEAT-CROSS-28-003 port side (IT-01/IT-04/IT-06; design §5.6).
 * submit → session → runner → at-least-once delivery with replyKey dedupe;
 * deterministic fallback answers; cancellation never revives; acknowledge
 * deduplicates player-side.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { KnowledgeQueryPort, unavailableAnswer } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/knowledgeQueryPort.js';
import { QueryRunner, type ObservationCatalogPort } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/knowledgeQueryRunner.js';
import type { KnowledgeQueryV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/knowledgeQueryContracts.js';
import type { PluginObservationProviderFactory } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/observation.js';

const SNAPSHOT = { generationId: 'gen-41', buildId: 'build-1', graphHash: 'h1' };

function query(overrides: Partial<KnowledgeQueryV1> = {}): KnowledgeQueryV1 {
  return {
    schemaVersion: 'mineclaw.knowledge-query/v1',
    kind: 'knowledge_query',
    requestId: 'kq-1',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
    emittedAt: new Date().toISOString(),
    source: 'player',
    replyMode: 'answer_player',
    originalText: '附近有什么',
    factKinds: ['nearby_crops'],
    anchor: { kind: 'bot_self' },
    scope: { radius: 8 },
    freshness: { maxAgeMs: 5000 },
    registryGeneration: SNAPSHOT,
    ...overrides,
  };
}

function catalog(): ObservationCatalogPort {
  const factory: PluginObservationProviderFactory = {
    id: 'test.crops', version: '1.0.0',
    descriptor: {
      id: 'test.crops', version: '1.0.0',
      inputSchema: { type: 'object', additionalProperties: false },
      resultSchema: { type: 'object', additionalProperties: false },
      factKinds: ['nearby_crops'], coverage: { dimension: ['minecraft:overworld'], role: 'world' }, limits: {},
    },
    create: () => ({
      id: 'test.crops',
      observe: async () => ({
        status: 'fulfilled',
        fact: {
          factKind: 'nearby_crops', snapshotVersion: 'v1', observedAt: new Date().toISOString(),
          requestedBounds: {}, observedBounds: {}, complete: true, truncated: false, unloadedRegions: [],
          payload: { crops: '小麦' },
          evidenceRefs: [{ ref: 'w1', source: 'scan', at: new Date().toISOString() }],
          contribution: { pluginId: 'test', pluginVersion: '1.0.0', contributionId: 'test.crops', contributionVersion: '1.0.0' },
        },
      }),
      close: () => undefined,
    }),
  };
  return { resolveProvider: (factKind) => factKind === 'nearby_crops' ? [factory] : [] };
}

function port(overrides: { sinkAccepted?: boolean } = {}) {
  const delivered: unknown[] = [];
  const sink = {
    deliver: async (answer: unknown) => {
      delivered.push(answer);
      return overrides.sinkAccepted === false
        ? { accepted: false, reason: 'sink_busy' }
        : { accepted: true };
    },
  };
  const instance = new KnowledgeQueryPort({ runner: new QueryRunner(catalog()), sink });
  return { instance, delivered };
}

test('IT-01 提交即执行并至少一次投递（replyKey 可去重）', async () => {
  const { instance, delivered } = port();
  const receipt = await instance.submitKnowledgeQuery(query());
  assert.equal(receipt.sessionId, 'kq:kq-1');
  assert.equal(delivered.length, 1);
  const record = instance.check('kq-1');
  assert.equal(record!.state, 'delivered');
  assert.equal(record!.answer!.outcome, 'answered');

  const ack = await instance.acknowledgePlayerReply(record!.replyKey);
  assert.equal(ack.sessionId, 'kq:kq-1');
  assert.equal(ack.deduplicated, true, '玩家侧重复确认应去重');
});

test('IT-04 投递失败 → 确定性回执 fallback，答复义务闭合（保留已记录答案）', async () => {
  const { instance, delivered } = port({ sinkAccepted: false });
  const receipt = await instance.submitKnowledgeQuery(query());
  assert.equal(receipt.sessionId, 'kq:kq-1');
  const record = instance.check('kq-1');
  assert.equal(record!.state, 'delivered');
  assert.equal(record!.answer!.outcome, 'answered');
  assert.ok(delivered.length >= 1);
});

test('IT-06 重复 replyKey/已终态不再重复发言；未知 replyKey 拒绝', async () => {
  const { instance } = port();
  await instance.submitKnowledgeQuery(query());
  const record = instance.check('kq-1')!;
  await assert.rejects(() => instance.acknowledgePlayerReply('unknown-key'));
  const twice = await instance.acknowledgePlayerReply(record.replyKey);
  assert.equal(twice.deduplicated, true);
});

test('outcome 覆盖：unavailableAnswer 是确定性可投递答案', () => {
  const fallback = unavailableAnswer(query(), 'test_reason');
  assert.equal(fallback.outcome, 'unavailable');
  assert.equal(fallback.reason, 'test_reason');
  assert.equal(fallback.completeness, 'not_applicable');
});
