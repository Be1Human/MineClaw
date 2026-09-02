/**
 * FEAT-CROSS-26-001-004-001 · Plugin SDK / Manifest / typed contribution contracts.
 * Contract-side coverage for U27, U29–U31, P06/P07 (see 测试用例.md §2.6/§5.0.1).
 * No production discovery/registration here — that belongs to -002.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validatePluginManifest,
  parsePermissions,
  parseDependencies,
  parseContributionRequirements,
  assertExecutionClosure,
  verifyExecutionClosure,
  evaluateContributionAvailability,
  observationProviderContract,
  predicateContract,
  planningContract,
  behaviorFactoryContract,
  resultProjectionContract,
  systemIntegrationContract,
  PluginContractError,
  defaultScopedContext,
  defaultLease,
  defaultContrib,
  type PluginManifestV1,
  type PluginObservationProviderFactory,
  type PluginObservationProvider,
  type PluginPredicateEvaluator,
  type PluginBindingProvider,
  type PluginResultProjection,
  type PluginSystemIntegration,
} from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/index.js';

const HOST = { hostApiVersion: '2.0.0', trustedSystemPlugins: ['mineclaw.minecraft-system'] };

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'mineclaw.plugin/v1',
    id: 'mineclaw.agriculture',
    version: '1.2.3',
    apiVersion: '^2.0.0',
    kind: 'domain',
    entry: 'plugins/builtin/agriculture',
    dependencies: { plugins: [{ pluginId: 'mineclaw.minecraft-system', range: '^1.0.0' }] },
    permissions: ['world.read:bounded-block-snapshot'],
    contributions: [
      {
        kind: 'skill', id: 'mineclaw.agriculture.skill.planting', version: '1.0.0',
        entryRef: 'skills/planting.md',
        requirements: [{ contributionId: 'mineclaw.agriculture.operation.sow-cell', range: '^1.0.0', purpose: 'planting guidance' }],
      },
    ],
    integrity: { contentSha256: 'a'.repeat(64) },
    ...overrides,
  };
}

test('T1 合法 domain 插件通过校验并深度冻结', () => {
  const manifest = validatePluginManifest(validManifest(), HOST);
  assert.equal(manifest.schema, 'mineclaw.plugin/v1');
  assert.equal(manifest.contributions.length, 1);
  assert.deepEqual(manifest.permissions, ['world.read:bounded-block-snapshot']);
  assert.ok(Object.isFrozen(manifest.contributions));
  assert.ok(Object.isFrozen(manifest.dependencies));
});

test('T2 未知 schema / 非法 id / 坏版本 → manifest_invalid', () => {
  for (const overrides of [
    { schema: 'mineclaw.plugin/v2' },
    { id: 'MineClaw.Agriculture' },
    { id: 'mineclaw' },
    { version: '1.2' },
    { version: 'abc' },
    { kind: 'urban' },
  ]) {
    assert.throws(() => validatePluginManifest(validManifest(overrides), HOST),
      (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid',
      JSON.stringify(overrides));
  }
});

test('T3 apiVersion 主版本不匹配 → plugin_api_incompatible', () => {
  assert.throws(
    () => validatePluginManifest(validManifest({ apiVersion: '^3.0.0' }), HOST),
    (error: unknown) => error instanceof PluginContractError && error.code === 'plugin_api_incompatible',
  );
  assert.throws(
    () => validatePluginManifest(validManifest({ apiVersion: 'not-a-range' }), HOST),
    (error: unknown) => error instanceof PluginContractError && error.code === 'plugin_api_incompatible',
  );
});

test('T4 data 插件禁止代码入口、非空权限与代码型贡献', () => {
  const base = { ...validManifest(), kind: 'data' as const, entry: undefined, permissions: [] };
  assert.throws(() => validatePluginManifest({ ...base, kind: 'data', entry: 'plugins/x', permissions: [] }, HOST),
    (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid');
  assert.throws(() => validatePluginManifest({ ...base, kind: 'data', permissions: ['world.read:bounded-block-snapshot'] }, HOST),
    (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid');
  const withObservation = { ...base, contributions: [{ kind: 'observation', id: 'mineclaw.agriculture.observation.fields', version: '1.0.0', factory: { create: () => ({}) } }] };
  assert.throws(() => validatePluginManifest(withObservation, HOST),
    (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid');
});

test('T5 贡献 id 必须在插件命名空间内且版本为独立 SemVer', () => {
  assert.throws(() => validatePluginManifest(validManifest({
    contributions: [{ kind: 'skill', id: 'other.skill.x', version: '1.0.0', entryRef: 'x.md' }],
  }), HOST), (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid');
  assert.throws(() => validatePluginManifest(validManifest({
    contributions: [{ kind: 'skill', id: 'mineclaw.agriculture.skill.x', version: '1', entryRef: 'x.md' }],
  }), HOST), (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid');
});

test('T6 结构 dependencies 与运行时 requirements 是两份合同', () => {
  const dependencies = parseDependencies({ plugins: [{ pluginId: 'mineclaw.minecraft-system', range: '^1.0.0' }] });
  assert.equal(dependencies.plugins!.length, 1);
  const requirements = parseContributionRequirements([
    { contributionId: 'mineclaw.agriculture.operation.sow-cell', range: '^1.0.0', purpose: 'plant' },
  ]);
  assert.equal(requirements.length, 1);
  // 结构依赖坏：整包拒绝路径（manifest 层格式错误）
  assert.throws(() => parseDependencies({ plugins: [{ pluginId: 'x', range: 'bad!' }] }),
    (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid');
  // requirements 缺失：不阻止 manifest 校验，仅影响 availability
  const availabilityOk = evaluateContributionAvailability(
    [{ contributionId: 'mineclaw.agriculture.operation.sow-cell', range: '^1.0.0', purpose: 'plant' }],
    new Set(['mineclaw.agriculture.operation.sow-cell']),
  );
  assert.equal(availabilityOk, 'available');
  const availabilityMissing = evaluateContributionAvailability(
    [{ contributionId: 'mineclaw.agriculture.operation.sow-cell', range: '^1.0.0', purpose: 'plant' }],
    new Set<string>(),
  );
  assert.equal(availabilityMissing, 'missing_dependency');
});

test('T7 权限闭合：未知动作/domain 用 system.* / data 非空均拒绝', () => {
  assert.throws(() => parsePermissions(['profile.read:self'], 'domain'),
    (error: unknown) => error instanceof PluginContractError && error.code === 'permission_denied');
  assert.throws(() => parsePermissions(['system.adapter'], 'domain'),
    (error: unknown) => error instanceof PluginContractError && error.code === 'permission_denied');
  assert.throws(() => parsePermissions(['world.read:bounded-block-snapshot'], 'data'),
    (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid');
  assert.deepEqual(parsePermissions(['world.read:bounded-block-snapshot', 'body.submit:mineclaw.minecraft-system.atomic.move-to'], 'domain'),
    ['world.read:bounded-block-snapshot', 'body.submit:mineclaw.minecraft-system.atomic.move-to']);
});

test('T8 integrity：data 必填且必须为 64 位 hex', () => {
  assert.throws(() => validatePluginManifest(
    validManifest({ kind: 'data', entry: undefined, permissions: [], integrity: undefined }),
    HOST,
  ), (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid');
  assert.throws(() => validatePluginManifest(
    validManifest({ integrity: { contentSha256: 'zz' } }),
    HOST,
  ), (error: unknown) => error instanceof PluginContractError && error.code === 'manifest_invalid');
});

test('T9 U27 合同侧：Knowledge-only 数据插件无需执行合同；Observation-only 无身体权限', () => {
  const knowledgeOnly = validatePluginManifest({
    schema: 'mineclaw.plugin/v1', id: 'mineclaw.crops', version: '1.0.0', apiVersion: '^2.0.0', kind: 'data',
    dependencies: {}, permissions: [],
    contributions: [{ kind: 'knowledge', id: 'mineclaw.crops.knowledge.crops', version: '1.0.0', contentRef: 'crops.yaml' }],
    integrity: { contentSha256: 'b'.repeat(64) },
  }, HOST);
  assert.equal(knowledgeOnly.contributions[0]!.kind, 'knowledge');

  const observationOnly = validatePluginManifest({
    schema: 'mineclaw.plugin/v1', id: 'mineclaw.scout', version: '1.0.0', apiVersion: '^2.0.0', kind: 'domain',
    entry: 'plugins/builtin/scout',
    dependencies: {}, permissions: ['world.read:bounded-block-snapshot'],
    contributions: [{
      kind: 'observation', id: 'mineclaw.scout.observation.nearby', version: '1.0.0',
      factory: { id: 'mineclaw.scout.observation.nearby', version: '1.0.0', descriptor: { id: 'mineclaw.scout.observation.nearby', version: '1.0.0', inputSchema: { type: 'object', additionalProperties: false }, resultSchema: { type: 'object', additionalProperties: false }, factKinds: ['nearby_blocks'], coverage: { dimension: ['minecraft:overworld'], role: 'world' }, limits: {} }, create: () => ({ id: 'x', observe: async () => ({ status: 'unavailable' as const, reason: 'no-op' }), close: () => undefined }) },
    }],
  }, HOST);
  assert.equal(observationOnly.contributions[0]!.kind, 'observation');
  assert.ok(!observationOnly.permissions.some((permission) => permission.startsWith('body.submit')));
});

test('T10 U31 合同侧：九段闭环完整通过，缺 ring 以 package_incomplete 拒绝', () => {
  const closed = buildClosedManifest();
  assertExecutionClosure(validatePluginManifest(closed, HOST));

  const missingProgress = buildClosedManifest();
  const exec = missingProgress.contributions.find((value: Record<string, unknown>) => value.kind === 'execution') as Record<string, unknown>;
  const operation = { ...(exec.operation as Record<string, unknown>), progressContributionId: 'mineclaw.agriculture.progress.none' };
  missingProgress.contributions = missingProgress.contributions.map((value: Record<string, unknown>) =>
    value.kind === 'execution' ? { ...value, operation } : value);
  const verification = verifyExecutionClosure(validatePluginManifest(missingProgress, HOST));
  assert.equal(verification.closed, false);
  assert.ok(verification.missing.some((ring: string) => ring.endsWith(':progress')));
  assert.throws(() => assertExecutionClosure(validatePluginManifest(missingProgress, HOST)),
    (error: unknown) => error instanceof PluginContractError && error.code === 'package_incomplete');
});

test('T11 U30 共享替换契约：合规 Providers 全部通过', async () => {
  const observation = await observationProviderContract('observation', makeObservationFactory());
  assert.equal(observation.failures.length, 0, JSON.stringify(observation.failures));

  const predicate = await predicateContract('predicate', makePredicate());
  assert.equal(predicate.failures.length, 0, JSON.stringify(predicate.failures));

  const binding = await planningContract('binding', { kind: 'binding', impl: makeBindingProvider() });
  assert.equal(binding.failures.length, 0, JSON.stringify(binding.failures));

  const candidate = await planningContract('candidate', {
    kind: 'candidate',
    impl: { id: 'c.1', list: async () => ({ status: 'complete' as const, candidates: [{ candidateId: 'c-1', operationContribution: defaultContrib(), params: {}, evidenceRefs: [], contribution: defaultContrib() }] }) },
  });
  assert.equal(candidate.failures.length, 0, JSON.stringify(candidate.failures));

  const behavior = await behaviorFactoryContract('behavior', makeBehaviorFactory());
  assert.equal(behavior.failures.length, 0, JSON.stringify(behavior.failures));

  const projection = await resultProjectionContract('result', makeProjection());
  assert.equal(projection.failures.length, 0, JSON.stringify(projection.failures));

  const integration = await systemIntegrationContract('integration', makeIntegration());
  assert.equal(integration.failures.length, 0, JSON.stringify(integration.failures));
});

test('T12 U30 恶意实现被合同套件拒绝：越权完成 / 空候选伪装 / close 后观察 / 谓词抛错', async () => {
  // Result projection rewriting verdict.
  const evilProjection = await resultProjectionContract('evil-result', {
    id: 'evil.result', version: '1.0.0',
    project: async () => ({ status: 'projected' as const, output: { presentation: { verdict: 'completed' }, audience: 'owner' as const, summary: 'done', evidenceRefs: [], contribution: defaultContrib() } }),
  });
  assert.equal(evilProjection.passed, 1); // 仅取消宽容探针通过
  assert.ok(evilProjection.failures.length >= 3, JSON.stringify(evilProjection.failures));

  // Empty candidate claiming complete.
  const emptyCandidate = await planningContract('evil-candidate', {
    kind: 'candidate',
    impl: { id: 'c.2', list: async () => ({ status: 'complete' as const, candidates: [] }) },
  });
  assert.equal(emptyCandidate.failures.length, 1, JSON.stringify(emptyCandidate.failures)); // 空候选伪装 complete 被拒

  // Provider still observable after close.
  const brokenObservation = await observationProviderContract('evil-observation', {
    id: 'evil.observation', version: '1.0.0',
    descriptor: { id: 'evil.observation', version: '1.0.0', inputSchema: { type: 'object', additionalProperties: false }, resultSchema: { type: 'object', additionalProperties: false }, factKinds: ['nearby_blocks'], coverage: { dimension: ['x'], role: 'world' }, limits: {} },
    create: () => ({ id: 'x', observe: async () => ({ status: 'fulfilled' as const, fact: { factKind: 'nearby_blocks' as const, snapshotVersion: 'v1', observedAt: 'now', requestedBounds: {}, observedBounds: {}, complete: true, truncated: false, unloadedRegions: [], payload: {}, evidenceRefs: [{ ref: 'r', source: 's', at: 'now' }], contribution: defaultContrib() } }), close: () => undefined }),
  });
  assert.ok(brokenObservation.failures.length > 0, JSON.stringify(brokenObservation.failures));

  // Predicate that throws.
  const throwingPredicate = await predicateContract('evil-predicate', {
    id: 'evil.p', version: '1.0.0',
    evaluate: () => { throw new Error('boom'); },
  } as unknown as PluginPredicateEvaluator);
  assert.ok(throwingPredicate.failures.length > 0);
});

function buildClosedManifest(): Record<string, unknown> {
  const contribution = (id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind, id: `mineclaw.agriculture.${id}`, version: '1.0.0', ...extra,
  });
  return {
    schema: 'mineclaw.plugin/v1', id: 'mineclaw.agriculture', version: '1.0.0', apiVersion: '^2.0.0', kind: 'domain',
    entry: 'plugins/builtin/agriculture',
    dependencies: { plugins: [{ pluginId: 'mineclaw.minecraft-system', range: '^1.0.0' }] },
    permissions: ['world.read:bounded-block-snapshot'],
    contributions: [
      contribution('goal.sow', 'goal', { target: { registryId: 'mineclaw.agriculture.goal.sow-field', goalKind: 'composite', aliases: ['播种'], successCriteria: [{ type: 'predicate', predicate: 'mineclaw.agriculture.verification.field-sown' }] } }),
      contribution('binding.sow', 'goal', { target: { registryId: 'mineclaw.agriculture.binding.sow-request', goalKind: 'composite', aliases: [], successCriteria: [{ type: 'predicate', predicate: 'mineclaw.agriculture.verification.field-sown' }] } }),
      contribution('observation.fields', 'observation', { factory: { id: 'mineclaw.agriculture.observation.fields', version: '1.0.0', descriptor: { id: 'mineclaw.agriculture.observation.fields', version: '1.0.0', inputSchema: { type: 'object', additionalProperties: false }, resultSchema: { type: 'object', additionalProperties: false }, factKinds: ['nearby_crops'], coverage: { dimension: ['minecraft:overworld'], role: 'world' }, limits: {} }, create: () => ({ id: 'x', observe: async () => ({ status: 'unavailable' as const, reason: 'x' }), close: () => undefined }) } }),
      contribution('planning.sow-candidates', 'planning', { candidateProvider: { id: 'c', list: async () => ({ status: 'complete' as const, candidates: [{ candidateId: 'c-1', operationContribution: defaultContrib(), params: {}, evidenceRefs: [], contribution: defaultContrib() }] }) } }),
      contribution('verification.field-sown', 'verification', { predicates: [makePredicate()] }),
      contribution('execution.sow', 'execution', {
        operation: {
          operationId: 'mineclaw.agriculture.operation.sow-cell',
          goalContributionId: 'mineclaw.agriculture.goal.sow',
          bindingContributionId: 'mineclaw.agriculture.binding.sow',
          factKinds: ['nearby_crops'],
          candidateContributionId: 'mineclaw.agriculture.planning.sow-candidates',
          predicateContributionId: 'mineclaw.agriculture.verification.field-sown',
          progressContributionId: 'mineclaw.agriculture.progress.sow',
          resultContributionId: 'mineclaw.agriculture.result.sow',
          cancellable: true,
        },
        behaviorFactory: makeBehaviorFactory(),
      }),
      contribution('progress.sow', 'planning', { candidateProvider: { id: 'p', list: async () => ({ status: 'complete' as const, candidates: [] }) } }),
      contribution('result.sow', 'result', { projection: makeProjection() }),
    ],
  };
}

function makeObservationFactory(): PluginObservationProviderFactory {
  return {
    id: 'mineclaw.test.observation', version: '1.0.0',
    descriptor: {
      id: 'mineclaw.test.observation', version: '1.0.0',
      inputSchema: { type: 'object', additionalProperties: false },
      resultSchema: { type: 'object', additionalProperties: false },
      factKinds: ['nearby_blocks'], coverage: { dimension: ['minecraft:overworld'], role: 'world' }, limits: {},
    },
    create: (): PluginObservationProvider => {
      let closed = false;
      return {
        id: 'mineclaw.test.observation',
        observe: async () => {
          if (closed) return { status: 'unavailable', reason: 'closed' };
          return {
            status: 'fulfilled',
            fact: {
              factKind: 'nearby_blocks', snapshotVersion: 'v1', observedAt: '2026-09-02T00:00:00.000Z',
              requestedBounds: {}, observedBounds: {}, complete: true, truncated: false,
              unloadedRegions: [], payload: { blocks: [] },
              evidenceRefs: [{ ref: 'r1', source: 'test', at: '2026-09-02T00:00:00.000Z' }],
              contribution: defaultContrib('mineclaw.test.observation'),
            },
          };
        },
        close: () => { closed = true; },
      };
    },
  };
}

function makePredicate(): PluginPredicateEvaluator {
  return {
    id: 'mineclaw.test.predicate', version: '1.0.0',
    evaluate: () => ({ verdict: 'satisfied' as const, evidenceRefs: ['r1'], contribution: defaultContrib('mineclaw.test.predicate') }),
  };
}

function makeBindingProvider(): PluginBindingProvider {
  return {
    id: 'mineclaw.test.binding',
    list: async () => ({
      status: 'complete', bindings: [{ bindingId: 'b1', scope: {}, evidenceRefs: ['r1'], contribution: defaultContrib('mineclaw.test.binding') }],
    }),
  };
}

function makeBehaviorFactory(): { id: string; version: string; create: (lease: unknown, scoped: unknown) => { instanceId: string; contribution: { pluginId: string; pluginVersion: string; contributionId: string; contributionVersion: string }; run: (ctx: unknown) => Promise<{ ok: boolean; cancelled: boolean }>; halt: () => Promise<void>; close: () => Promise<void>; settled: boolean } } {
  return {
    id: 'mineclaw.test.behavior', version: '1.0.0',
    create: () => ({
      instanceId: `inst-${Math.random()}`,
      contribution: defaultContrib('mineclaw.test.behavior'),
      run: async () => ({ ok: true, cancelled: false }),
      halt: async () => undefined,
      close: async () => undefined,
      settled: true,
    }),
  };
}

function makeProjection(): PluginResultProjection {
  return {
    id: 'mineclaw.test.result', version: '1.0.0',
    project: (input) => {
      if (input.evidence.verdict === 'needs_owner') {
        return {
          status: 'projected',
          output: { presentation: {}, audience: 'owner', summary: '需要确认', question: { questionKind: 'field', options: ['A'] }, evidenceRefs: [], contribution: defaultContrib('mineclaw.test.result') },
        };
      }
      return {
        status: 'projected',
        output: { presentation: {}, audience: 'owner', summary: '已处理', evidenceRefs: [], contribution: defaultContrib('mineclaw.test.result') },
      };
    },
  };
}

function makeIntegration(): PluginSystemIntegration {
  let state: PluginSystemIntegration['status'] = 'stopped';
  return {
    id: 'mineclaw.test.integration', version: '1.0.0',
    async start(scoped: ReturnType<typeof defaultScopedContext>, signal: AbortSignal): Promise<void> {
      void scoped; void signal;
      state = 'running';
    },
    async stop(signal: AbortSignal): Promise<void> {
      void signal;
      state = 'stopped';
    },
    status: () => state,
  };
}
