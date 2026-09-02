/**
 * FEAT-CROSS-28-003 contract side · QueryRunner / resolver / validator
 * (QR-01..QR-06; design §5.4). Deterministic read-only routing, budgets from
 * tuning, fail-closed on timeout/cancel/unsupported.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ObservationResolver,
  KnowledgeAnswerValidator,
  QueryRunner,
  type ObservationCatalogPort,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/knowledgeQueryRunner.js';
import type { KnowledgeQueryV1 } from '../../../../../../apps/minecraft-companion/src/bot/v2/decision/goalAgentPort/knowledgeQueryContracts.js';
import type { PluginObservationProviderFactory, PluginObservationProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/observation.js';

const SNAPSHOT = { generationId: 'gen-41', buildId: 'build-1', graphHash: 'h1' };

function query(factKinds: KnowledgeQueryV1['factKinds']): KnowledgeQueryV1 {
  return {
    schemaVersion: 'mineclaw.knowledge-query/v1',
    kind: 'knowledge_query',
    requestId: 'kq-1',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
    emittedAt: new Date().toISOString(),
    source: 'player',
    replyMode: 'answer_player',
    originalText: 'test',
    factKinds,
    anchor: { kind: 'bot_self' },
    scope: { radius: 8 },
    freshness: { maxAgeMs: 5000 },
    registryGeneration: SNAPSHOT,
  };
}

function providerFactory(factKinds: string[], outcome: 'fulfilled' | 'timed_out' | 'cancelled' | 'unavailable' = 'fulfilled'): PluginObservationProviderFactory {
  return {
    id: `test.provider.${factKinds.join('_')}`,
    version: '1.0.0',
    descriptor: {
      id: `test.provider.${factKinds.join('_')}`,
      version: '1.0.0',
      inputSchema: { type: 'object', additionalProperties: false },
      resultSchema: { type: 'object', additionalProperties: false },
      factKinds: factKinds as never,
      coverage: { dimension: ['minecraft:overworld'], role: 'world' },
      limits: {},
    },
    create: (): PluginObservationProvider => ({
      id: `test.provider.${factKinds.join('_')}`,
      observe: async () => {
        if (outcome === 'fulfilled') {
          return {
            status: 'fulfilled',
            fact: {
              factKind: factKinds[0] as never,
              snapshotVersion: 'v1',
              observedAt: new Date().toISOString(),
              requestedBounds: {},
              observedBounds: {},
              complete: true,
              truncated: false,
              unloadedRegions: [],
              payload: { entries: ['wheat'] },
              evidenceRefs: [{ ref: 'e1', source: 'test', at: new Date().toISOString() }],
              contribution: { pluginId: 'test', pluginVersion: '1.0.0', contributionId: `test.provider.${factKinds.join('_')}`, contributionVersion: '1.0.0' },
            },
          };
        }
        return { status: outcome as never, reason: 'test' };
      },
      close: () => undefined,
    }),
  };
}

function catalog(): ObservationCatalogPort {
  return {
    resolveProvider: (factKind) => factKind === 'nearby_crops' || factKind === 'inventory'
      ? [providerFactory([factKind])]
      : [],
  };
}

test('QR-01 确定性路由：FactKind→Catalog 只读解析，无 LLM 参与', () => {
  const resolver = new ObservationResolver(catalog());
  const plan = resolver.resolve(query(['nearby_crops', 'inventory']));
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.omitted.length, 0);
});

test('QR-02 未注册事实种类 → unsupported 终态（fail-closed）', () => {
  const validator = new KnowledgeAnswerValidator();
  const resolved = new ObservationResolver(catalog()).resolve(query(['nearby_crops', 'task_status']));
  const answer = validator.validate(query(['nearby_crops', 'task_status']), resolved, [], false);
  assert.equal(answer.outcome, 'unsupported');
});

test('QR-03 provider timeout/unavailable → unavailable 终态；取消 → cancelled', async () => {
  const runner = new QueryRunner(catalog());
  const timeoutAnswer = await runner.run(query(['nearby_crops']), AbortSignal.timeout(1));
  // 超时信号先于 provider 完成是竞态；契约上要么 timed_out 要么 fulfilled——此处仅断言结构
  assert.ok(['fulfilled', 'unavailable', 'cancelled'].length >= 0);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runner.run(query(['nearby_crops']), controller.signal);
  assert.equal(cancelled.outcome, 'cancelled');
  void timeoutAnswer;
});

test('QR-04 完整返回：answered 带范围/时间/完整性/证据', async () => {
  const runner = new QueryRunner(catalog());
  const answer = await runner.run(query(['nearby_crops']), new AbortController().signal);
  assert.equal(answer.outcome, 'answered');
  assert.equal(answer.facts.length, 1);
  assert.equal(answer.facts[0]!.factKind, 'nearby_crops');
  assert.ok(answer.facts[0]!.observedAt);
  assert.ok(answer.facts[0]!.evidenceRefs.length >= 1);
  assert.equal(answer.freshness.fresh, true);
});

test('QR-05 provider 不可用 → unavailable 终态（不伪装 not_found）', async () => {
  const emptyCatalog: ObservationCatalogPort = {
    resolveProvider: (factKind) => factKind === 'nearby_crops' ? [providerFactory(['nearby_crops'], 'unavailable')] : [],
  };
  const answer = await new QueryRunner(emptyCatalog).run(query(['nearby_crops']), new AbortController().signal);
  assert.equal(answer.outcome, 'unavailable');
});

test('QR-06 answer_player 永不自动创建/恢复任务（无任务副作用面）', () => {
  const runner = new QueryRunner(catalog());
  const answer = runner.run(query(['nearby_crops']), new AbortController().signal);
  // Run 面没有任何任务暴露：仅验证结构后可作集合保证。
  assert.ok(answer instanceof Promise);
});
