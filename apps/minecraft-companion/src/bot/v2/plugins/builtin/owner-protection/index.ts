/**
 * mineclaw.owner-protection · default-on persistent owner protection.
 *
 * The activity owns only protection decisions. Every movement, attack and
 * recovery action remains a finite atomic submitted through the host body port.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';
import type { PluginBindingProvider, PluginCandidateProvider, PluginProgressProvider } from '../../../plugin-sdk/contracts/planning.js';
import type { PluginPredicateEvaluator } from '../../../plugin-sdk/contracts/verification.js';
import type { PluginActivityContext, PluginActivityFactory } from '../../../plugin-sdk/contracts/execution.js';
import type { PluginResultProjection } from '../../../plugin-sdk/contracts/result.js';
import type { ContributionRef } from '../../../plugin-sdk/identity.js';
import { decideProtectionStep, type Position, type ProtectionConfig } from './tactics.js';

const PLUGIN_ID = 'mineclaw.owner-protection';
const VERSION = '1.0.0';
const GOAL = `${PLUGIN_ID}.goal.protect-owner`;
const CANDIDATE = `${PLUGIN_ID}.planning.protect-owner-candidates`;
const PREDICATE = `${PLUGIN_ID}.verification.protection-active`;
const PROGRESS = `${PLUGIN_ID}.progress.protect-owner`;
const RESULT = `${PLUGIN_ID}.result.protect-owner`;
const OPERATION = `${PLUGIN_ID}.operation.protect-owner`;
const EXECUTOR = `${PLUGIN_ID}.execution.protect-owner`;

function ref(id: string): ContributionRef {
  return { pluginId: PLUGIN_ID, pluginVersion: VERSION, contributionId: id, contributionVersion: VERSION };
}

export function createMineclawOwnerProtectionPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (): readonly PluginContribution[] => {
      const bindingProvider: PluginBindingProvider = {
        id: GOAL,
        list: async () => ({
          status: 'complete',
          bindings: [{ bindingId: 'owner:current', scope: { owner: 'current' }, evidenceRefs: [], contribution: ref(GOAL) }],
        }),
      };
      const candidateProvider: PluginCandidateProvider = {
        id: CANDIDATE,
        list: async () => ({
          status: 'complete',
          candidates: [{ candidateId: 'protect:current-owner', operationContribution: ref(EXECUTOR), params: {}, evidenceRefs: [], contribution: ref(CANDIDATE) }],
        }),
      };
      const progressProvider: PluginProgressProvider = {
        id: PROGRESS,
        assess: async () => ({
          status: 'complete',
          progress: { completed: 0, total: 1, blocked: 0, truncated: false, evidenceRefs: [], contribution: ref(PROGRESS) },
        }),
      };
      const predicate: PluginPredicateEvaluator = {
        id: PREDICATE,
        version: VERSION,
        evaluate: input => ({
          verdict: input.evidence?.activityRunning === true ? 'satisfied' : 'unknown',
          evidenceRefs: [],
          reason: input.evidence?.activityRunning === true ? undefined : 'owner_protection_continues',
          contribution: ref(PREDICATE),
        }),
      };
      const activityFactory: PluginActivityFactory = {
        id: EXECUTOR,
        version: VERSION,
        hazardPolicy: { categories: ['hostile'] },
        prepareStart: () => Object.freeze({}),
        create: lease => new OwnerProtectionActivity(lease.goalId),
      };
      const projection: PluginResultProjection = {
        id: RESULT,
        version: VERSION,
        project: async input => ({
          status: 'projected',
          output: {
            presentation: { verdict: input.evidence.verdict },
            audience: 'owner',
            summary: input.evidence.verdict === 'completed' ? '保护任务已结束。' : '正在保护主人。',
            evidenceRefs: input.evidence.ledger.map(() => 'owner-protection:1'),
            contribution: ref(RESULT),
          },
        }),
      };
      return [
        { kind: 'goal', id: GOAL, version: VERSION, target: {
          registryId: GOAL, goalKind: 'composite', aliases: ['保护我', '护主', '保护主人', 'protect me', 'protect owner'], taskFamilies: ['protection'],
          successCriteria: [{ type: 'predicate', predicate: PREDICATE }],
        }, bindingProvider },
        { kind: 'planning', id: CANDIDATE, version: VERSION, candidateProvider },
        { kind: 'verification', id: PREDICATE, version: VERSION, predicates: [predicate] },
        { kind: 'execution', id: EXECUTOR, version: VERSION, operation: {
          operationId: OPERATION, goalContributionId: GOAL, bindingContributionId: GOAL, factKinds: ['owner_location', 'nearby_entities'],
          candidateContributionId: CANDIDATE, predicateContributionId: PREDICATE, progressContributionId: PROGRESS, resultContributionId: RESULT,
          cancellable: true, applicability: { outcomes: ['composed'], targetKinds: ['state'], taskFamilies: ['protection'], criterionTypes: ['predicate'] },
        }, activityFactory },
        { kind: 'planning', id: PROGRESS, version: VERSION, candidateProvider, progressProvider },
        { kind: 'result', id: RESULT, version: VERSION, projection },
        {
          kind: 'proactive', id: `${PLUGIN_ID}.proactive.auto-protect-owner`, version: VERSION,
          label: '自动保护主人', description: '保护我', goalTarget: GOAL,
          rate: 'fast', priority: 100, defaultEnabled: true, conflictGroups: ['minecraft:body'],
          evaluator: input => {
            const world = input.world as { owner?: { isVisible?: boolean; position?: Position | null } } | undefined;
            return world?.owner?.isVisible === true && world.owner.position !== null;
          },
        },
      ];
    },
  };
}

class OwnerProtectionActivity {
  readonly instanceId: string;
  readonly contribution = ref(EXECUTOR);
  private halted = false;
  private nextMoveAt = 0;
  private nextRecoveryAt = 0;
  private nextLoadoutAt = 0;

  constructor(goalId: string) {
    this.instanceId = `owner-protection-${goalId}`;
  }

  get settled(): boolean { return this.halted; }

  async run(ctx: PluginActivityContext): Promise<{ ok: boolean; cancelled: boolean; error?: string }> {
    try {
      while (!ctx.signal.aborted && !this.halted) {
        const world = ctx.observe();
        const config = protectionConfig(ctx.getHostConfig());
        const now = Date.now();
        const step = decideProtectionStep(world, config, now >= this.nextLoadoutAt);
        if (step.kind === 'wait_for_owner') {
          ctx.publish('owner_protection.waiting_for_owner', 'info', { reason: 'owner_not_visible' });
        } else if (step.kind === 'strike') {
          // A combat round owns readiness, effective burst timing and the
          // retreat. The activity must never split that into equip + attack.
          const result = await ctx.submitBody({ atomicId: 'combat_round', args: { entityId: step.target.id } });
          if (!result.ok) ctx.publish('owner_protection.attack_failed', 'warn', { entityId: String(step.target.id), error: String(result.error ?? 'unknown') });
        } else if (step.kind === 'intercept' && now >= this.nextMoveAt) {
          const result = await ctx.submitBody({ atomicId: 'invoke_behavior', args: {
            behavior: 'advanced_move_to', behaviorParams: { position: step.target.position, range: config.ownerProtectionEngagementRange },
          }, timeoutMs: config.ownerProtectionMovementSliceMs });
          this.nextMoveAt = now + config.ownerProtectionMoveCooldownMs;
          if (!result.ok) ctx.publish('owner_protection.intercept_failed', 'warn', { entityId: String(step.target.id), error: String(result.error ?? 'unknown') });
        } else if (step.kind === 'self_recover' && now >= this.nextRecoveryAt) {
          const result = await ctx.submitBody({ atomicId: 'eat', args: { emergency: true } });
          this.nextRecoveryAt = now + config.ownerProtectionRecoveryCooldownMs;
          if (!result.ok) ctx.publish('owner_protection.recovery_failed', 'warn', { error: String(result.error ?? 'unknown') });
        } else if (step.kind === 'loadout_recover') {
          this.nextLoadoutAt = now + config.ownerProtectionLoadoutRetryMs;
          const recovery = step.recovery;
          const result = recovery.kind === 'pickup'
            ? await ctx.submitBody({ atomicId: 'invoke_behavior', args: { behavior: 'advanced_move_to', behaviorParams: { position: recovery.position, range: 1 } } })
            : recovery.kind === 'armor'
              ? await ctx.submitBody({ atomicId: 'equip_best_armor', args: {} })
              : await ctx.submitBody({ atomicId: 'equip', args: { itemName: recovery.itemName } });
          if (!result.ok) ctx.publish('owner_protection.loadout_recovery_failed', 'warn', { kind: recovery.kind, error: String(result.error ?? 'unknown') });
        } else if (step.kind === 'follow' && now >= this.nextMoveAt) {
          const result = await ctx.submitBody({ atomicId: 'follow_entity', args: {
            entityId: step.entityId,
            range: config.ownerProtectionFollowDistance,
            durationMs: config.ownerProtectionFollowSliceMs,
          }, timeoutMs: config.ownerProtectionMovementSliceMs });
          this.nextMoveAt = now + config.ownerProtectionMoveCooldownMs;
          if (!result.ok) ctx.publish('owner_protection.follow_failed', 'warn', { error: String(result.error ?? 'unknown') });
        }
        await ctx.wait(config.loopIntervalMs);
      }
      return { ok: false, cancelled: true, error: 'owner_protection_stopped' };
    } catch (error) {
      if (ctx.signal.aborted || this.halted) return { ok: false, cancelled: true, error: 'owner_protection_stopped' };
      return { ok: false, cancelled: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async halt(): Promise<void> { this.halted = true; }
  async close(): Promise<void> { this.halted = true; }
}

function protectionConfig(value: Readonly<Record<string, unknown>>): ProtectionConfig {
  const number = (name: keyof ProtectionConfig): number => {
    const raw = value[name];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new Error(`owner_protection_config_invalid:${name}`);
    return raw;
  };
  return {
    loopIntervalMs: number('loopIntervalMs'),
    ownerProtectionFollowDistance: number('ownerProtectionFollowDistance'),
    ownerProtectionThreatRadius: number('ownerProtectionThreatRadius'),
    ownerProtectionEngagementRange: number('ownerProtectionEngagementRange'),
    ownerProtectionAttackRange: number('ownerProtectionAttackRange'),
    ownerProtectionMoveCooldownMs: number('ownerProtectionMoveCooldownMs'),
    ownerProtectionMovementSliceMs: number('ownerProtectionMovementSliceMs'),
    ownerProtectionFollowSliceMs: number('ownerProtectionFollowSliceMs'),
    ownerProtectionHealthThreshold: number('ownerProtectionHealthThreshold'),
    ownerProtectionRecoveryCooldownMs: number('ownerProtectionRecoveryCooldownMs'),
    ownerProtectionLoadoutPickupRadius: number('ownerProtectionLoadoutPickupRadius'),
    ownerProtectionLoadoutRetryMs: number('ownerProtectionLoadoutRetryMs'),
  };
}
