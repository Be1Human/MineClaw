/**
 * FEAT-CROSS-26-001-004-004 · mineclaw.follow plugin (P2-6).
 * Follow-owner closed loop via the owner-context fact; executor reports missing
 * body service explicitly; candidate/binding unavailable without owner position.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginHost } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/index.js';
import { createMineclawMinecraftSystemPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-system/index.js';
import { createMineclawMinecraftPresencePlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/minecraft-presence/index.js';
import { createMineclawFollowPlugin } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/follow/index.js';
import type { BuiltinPluginIndex } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-kernel/discovery.js';
import type { PluginObservationProvider } from '../../../../../../apps/minecraft-companion/src/bot/v2/plugin-sdk/contracts/observation.js';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUILTIN = fileURLToPath(new URL('../../../../../../apps/minecraft-companion/src/bot/v2/plugins/builtin/', import.meta.url));

function index(): BuiltinPluginIndex {
  const entry = (id: string, factory: () => unknown): { entryKey: string; manifest: Record<string, unknown>; factory: never } => {
    const manifest = parse(readFileSync(`${BUILTIN}/${id}/plugin.yaml`, 'utf8')) as Record<string, unknown>;
    return { entryKey: `plugins/builtin/${manifest.id}`, manifest, factory: factory() as never };
  };
  return {
    byEntryKey: new Map([
      ['plugins/builtin/mineclaw.minecraft-system', entry('minecraft-system', createMineclawMinecraftSystemPlugin)],
      ['plugins/builtin/mineclaw.minecraft-presence', entry('minecraft-presence', createMineclawMinecraftPresencePlugin)],
      ['plugins/builtin/mineclaw.follow', entry('follow', createMineclawFollowPlugin)],
    ]),
  };
}

test('P2-6 follow 闭环注册：goal/candidate/predicate/execution/progress/result 同源身份', async () => {
  const host = new PluginHost({
    hostApiVersion: '2.0.0',
    buildId: 'build-1',
    builtinIndex: index(),
    trustedSystemPlugins: ['mineclaw.minecraft-system'],
    systemPorts: {
      ownerContextObservation: {
        observe: async () => ({
          snapshotVersion: 'v1',
          observedAt: new Date().toISOString(),
          dimension: 'minecraft:overworld',
          botPosition: { x: 0, y: 64, z: 0 },
          ownerPosition: { x: 4, y: 64, z: 2 },
          pointing: { kind: 'observed', yaw: 0, pitch: 0 },
          complete: true,
          evidenceRefs: ['pos-1'],
        }),
      },
    },
  });
  const result = await host.boot();
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.ok(result.installed.includes('mineclaw.follow'));
  const active = result.slot.read().active;
  for (const id of [
    'mineclaw.follow.goal.follow-owner',
    'mineclaw.follow.planning.follow-candidates',
    'mineclaw.follow.verification.follow-satisfied',
    'mineclaw.follow.execution.follow-owner',
    'mineclaw.follow.progress.follow',
    'mineclaw.follow.result.follow',
  ]) {
    assert.ok(active.registry.byId.has(id), `missing ${id}`);
  }

  // 候选从 owner-context fact 生成。
  const factory = (active.registry.byId.get('mineclaw.minecraft-presence.observation.owner-context')!.contribution as { factory: { create: (c: { signal: AbortSignal }) => PluginObservationProvider } }).factory;
  const provider = factory.create({ signal: new AbortController().signal });
  const fact = await provider.observe({ params: {}, signal: new AbortController().signal, scope: {}, budget: { timeoutMs: 3000, maxResults: 1 } });
  assert.equal(fact.status, 'fulfilled');
  if (fact.status === 'fulfilled') {
    const candidateContribution = active.registry.byId.get('mineclaw.follow.planning.follow-candidates')!;
    const candidateProvider = (candidateContribution.contribution as { candidateProvider: { list: (input: unknown) => Promise<{ status: string; candidates: Array<{ params: { target?: { x: number } } }> }> } }).candidateProvider;
    const candidates = await candidateProvider.list({
      goal: {}, snapshot: {}, facts: [fact.fact], params: {}, signal: new AbortController().signal, budget: {},
    } as never);
    assert.equal(candidates.status, 'complete');
    assert.equal(candidates.candidates[0]!.params.target?.x, 4);
  }
});

test('P2-6 无主人位置时候选/绑定 unavailable；无 body 服务执行器显式失败', async () => {
  const contributions = createMineclawFollowPlugin().create({
    host: { version: '2.0.0', buildId: 'b' },
    plugin: { pluginId: 'mineclaw.follow', pluginVersion: '1.0.0' },
  });
  const candidate = (contributions.find(c => c.kind === 'planning' && c.id === 'mineclaw.follow.planning.follow-candidates') as { candidateProvider: { list: (input: unknown) => Promise<{ status: string; reason?: string }> } }).candidateProvider;
  const empty = await candidate.list({ goal: {}, snapshot: {}, facts: [], params: {}, signal: new AbortController().signal, budget: {} } as never);
  assert.equal(empty.status, 'unavailable');
  assert.match(empty.reason ?? '', /owner_location_unavailable/);

  const execution = contributions.find(c => c.kind === 'execution') as { behaviorFactory: { create: (lease: Record<string, unknown>) => { run: (ctx: { signal: AbortSignal; facts: Record<string, unknown>[] }) => Promise<{ ok: boolean; cancelled: boolean; error?: string }>; halt: () => Promise<void>; close: () => Promise<void>; settled: boolean } } };
  const outcome = await execution.behaviorFactory.create({ goalId: 'g1' } as never).run({ signal: new AbortController().signal, facts: [] } as never);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /body_submit_service_missing/);
});
