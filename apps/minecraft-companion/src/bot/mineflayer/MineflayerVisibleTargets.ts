import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Vec3 } from '../adapter/types.js';
import type { DecisionContext } from '../v2/plugins/builtin/fastbrain/adapter.js';
import {
  unavailableSearch,
  type VisibleTarget,
  type VisibleTargetReader,
  type VisibleTargetResolution,
  type VisibleTargetSearch,
} from '../v2/plugins/builtin/fastbrain/visibleTargets.js';
import { tuning } from '../v2/infra/tuning.js';

interface SpawnProof {
  readonly bot: Bot;
  readonly entity: Bot['entity'];
  readonly world: Bot['world'];
  readonly actor: string;
  readonly dimension: string;
  readonly generation: number;
}
interface TargetRecord { readonly target: VisibleTarget; readonly proof: SpawnProof; readonly stateId: number; readonly radius: number }
const position = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z });
const finitePosition = (p: Vec3 | null | undefined): p is Vec3 => !!p && [p.x, p.y, p.z].every(Number.isFinite);
const samePosition = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
const dimensionName = (value: string): string => value.replace(/^minecraft:/, '');

/**
 * Concrete Mineflayer query mapping. Spawn proof is recorded BEFORE use, not
 * inferred from safe-default GameView data or an observer's wall clock.
 */
export class MineflayerVisibleTargets {
  private bot: Bot | null = null;
  private proof: SpawnProof | null = null;
  private generation = 0;
  private blockRevision = 0;
  private readonly invalidations = new Set<(position?: Vec3) => void>();
  constructor(private readonly getBot: () => Bot | null, private readonly now: () => number = Date.now) {}

  private readonly spawned = () => {
    const bot = this.bot;
    this.invalidate();
    if (!bot?.username || !bot.entity || !bot.world || !bot.game?.dimension
      || !finitePosition(bot.entity.position) || !Number.isInteger(bot.entity.id)
      || !Number.isFinite(bot.health) || bot.health <= 0) return;
    this.proof = { bot, entity: bot.entity, world: bot.world, actor: bot.username,
      dimension: dimensionName(bot.game.dimension), generation: this.generation };
  };
  private readonly lost = () => this.invalidate();
  private readonly changedBlock = (oldBlock: Block | null, newBlock: Block | null) => {
    this.blockRevision++;
    const p = newBlock?.position ?? oldBlock?.position;
    if (p) for (const invalidate of this.invalidations) invalidate(p);
  };

  /** Called by the same connection boundary that rebinds the GameAdapter. */
  rebind(bot: Bot | null): void {
    if (bot === this.bot) return;
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('spawn', this.spawned);
      this.bot.removeListener('respawn', this.lost);
      this.bot.removeListener('death', this.lost);
      this.bot.removeListener('end', this.lost);
      this.bot.removeListener('blockUpdate', this.changedBlock);
    }
    this.invalidate();
    this.bot = bot;
    if (bot && typeof bot.on === 'function') {
      bot.on('spawn', this.spawned);
      bot.on('respawn', this.lost);
      bot.on('death', this.lost);
      bot.on('end', this.lost);
      bot.on('blockUpdate', this.changedBlock);
    }
  }

  private invalidate(): void {
    this.proof = null;
    this.generation++;
    for (const invalidate of this.invalidations) invalidate();
  }

  /** Opaque freshness check for read-only operations; never exposes a Bot or targets. */
  captureReadGeneration(actor: string, dimension: string): () => boolean {
    const proof = this.proof;
    return () => !!proof && this.proof === proof && this.getBot() === proof.bot
      && this.bot === proof.bot && this.generation === proof.generation
      && proof.bot.entity === proof.entity && proof.bot.world === proof.world
      && proof.bot.username === actor && proof.actor === actor
      && dimensionName(proof.bot.game?.dimension ?? '') === dimensionName(dimension)
      && proof.dimension === dimensionName(dimension) && finitePosition(proof.bot.entity?.position)
      && Number.isFinite(proof.bot.health) && proof.bot.health > 0;
  }

  private current(context: DecisionContext): SpawnProof | string {
    const live = this.getBot();
    if (live !== this.bot) this.rebind(live);
    if (context.signal.aborted || !context.isCurrent()) return 'decision_context_revoked';
    const now = this.now();
    if (now >= context.deadlineAt) return 'decision_deadline_exceeded';
    if (now < context.notBefore) return 'observation_stale';
    const proof = this.proof;
    if (!proof || !live) return 'visible_targets_not_spawned';
    if (live !== proof.bot || live.entity !== proof.entity || live.world !== proof.world
      || live.username !== proof.actor || dimensionName(live.game?.dimension ?? '') !== proof.dimension
      || proof.generation !== this.generation || !finitePosition(live.entity?.position)
      || !Number.isFinite(live.health) || live.health <= 0) return 'visible_targets_world_changed';
    if (context.actor !== proof.actor || dimensionName(context.dimension) !== proof.dimension) return 'observation_identity_mismatch';
    if (!context.sessionId) return 'visible_targets_session_required';
    return proof;
  }

  /** Each service owns its references; stopping it does not close another service's reader. */
  open(): VisibleTargetReader {
    let closed = false;
    let latestVersion: string | null = null;
    const records = new Map<string, TargetRecord>();
    const invalidate = (p?: Vec3) => {
      if (!p) { records.clear(); latestVersion = null; return; }
      for (const [id, record] of records) if (samePosition(record.target.position, p)) records.delete(id);
    };
    this.invalidations.add(invalidate);
    const unavailable = (radius: number, reason: string): VisibleTargetSearch => unavailableSearch(radius, reason,
      reason === 'decision_context_revoked' ? 'cancelled' : reason === 'decision_deadline_exceeded' ? 'timeout' : 'blocked');
    const resolve = (targetId: string, context: DecisionContext): VisibleTargetResolution => {
      if (closed) return { status: 'unavailable', reason: 'visible_targets_closed' };
      const proof = this.current(context);
      if (typeof proof === 'string') return { status: 'unavailable', reason: proof };
      const record = records.get(targetId);
      if (!record || record.proof !== proof || record.target.observationVersion !== latestVersion) {
        return { status: 'unavailable', reason: 'target_ref_stale_or_unknown' };
      }
      if (record.target.sessionId !== context.sessionId) return { status: 'unavailable', reason: 'target_ref_session_mismatch' };
      const p = record.target.position;
      const self = proof.bot.entity.position;
      if (Math.hypot(p.x + 0.5 - self.x, p.y + 0.5 - self.y, p.z + 0.5 - self.z) > record.radius) {
        return { status: 'unavailable', reason: 'target_ref_out_of_bounds' };
      }
      const age = this.now() - record.target.observedAt;
      const freshness = tuning().knowledgeQuery.maxFreshnessMs;
      if (!Number.isFinite(freshness) || freshness < 0 || age < 0 || age > freshness) return { status: 'unavailable', reason: 'target_ref_stale' };
      try {
        const revision = this.blockRevision;
        const block = proof.bot.blockAt(proof.bot.entity.position.clone().set(
          record.target.position.x, record.target.position.y, record.target.position.z));
        if (!block || block.stateId !== record.stateId || block.name !== record.target.name || !proof.bot.canSeeBlock(block)) {
          records.delete(targetId);
          return { status: 'unavailable', reason: 'target_ref_no_longer_visible' };
        }
        if (this.current(context) !== proof || !records.has(targetId) || revision !== this.blockRevision) {
          return { status: 'unavailable', reason: 'target_ref_stale_or_unknown' };
        }
        return { status: 'resolved', target: structuredClone({ ...record.target,
          canDig: typeof proof.bot.canDigBlock === 'function' ? proof.bot.canDigBlock(block) : null }), validatedAt: this.now() };
      } catch { return { status: 'unavailable', reason: 'target_visibility_unverified' }; }
    };
    return {
      search: (kind, radius, context) => {
        invalidate();
        if (closed) return unavailable(radius, 'visible_targets_closed');
        const proof = this.current(context);
        if (typeof proof === 'string') return unavailable(radius, proof);
        const scan = tuning().worldScan;
        if (!Number.isInteger(radius) || radius <= 0 || radius > scan.blockScanRadius) return unavailable(radius, 'search_radius_out_of_bounds');
        if (!Number.isInteger(scan.blockScanCount) || scan.blockScanCount < 1) return unavailable(radius, 'search_budget_unavailable');
        const bot = proof.bot;
        if (typeof bot.findBlocks !== 'function' || typeof bot.blockAt !== 'function' || typeof bot.canSeeBlock !== 'function') {
          return unavailable(radius, 'visible_targets_query_unavailable');
        }
        const name = kind.replace(/^minecraft:/, '');
        const definition = bot.registry?.blocksByName?.[name];
        if (!definition) return unavailable(radius, 'search_block_kind_unsupported');
        const origin = position(bot.entity.position);
        const revision = this.blockRevision;
        const at = this.now();
        const version = `mineflayer-visible:${randomUUID()}`;
        const targets: VisibleTarget[] = [];
        let truncated = false;
        try {
          const candidates = bot.findBlocks({ matching: definition.id, point: bot.entity.position.clone(),
            maxDistance: radius, count: scan.blockScanCount + 1 });
          truncated = candidates.length > scan.blockScanCount;
          const visited = new Set<string>();
          for (const p of candidates.slice(0, scan.blockScanCount)) {
            const current = this.current(context);
            if (current !== proof) { invalidate(); return unavailable(radius, typeof current === 'string' ? current : 'visible_targets_world_changed'); }
            if (!finitePosition(p) || ![p.x, p.y, p.z].every(Number.isInteger)) continue;
            const key = `${p.x},${p.y},${p.z}`;
            if (visited.has(key)) continue;
            visited.add(key);
            const distance = Math.hypot(p.x + 0.5 - origin.x, p.y + 0.5 - origin.y, p.z + 0.5 - origin.z);
            if (distance > radius) continue;
            const block = bot.blockAt(p);
            if (!block || block.name !== name || !samePosition(block.position, p) || !bot.canSeeBlock(block)) continue;
            const target: VisibleTarget = { targetId: `mineflayer-target:${randomUUID()}`, kind: 'block', name,
              stateId: block.stateId, canDig: typeof bot.canDigBlock === 'function' ? bot.canDigBlock(block) : null,
              position: position(block.position), observationVersion: version, observedAt: at,
              sessionId: context.sessionId, actor: proof.actor, dimension: proof.dimension,
              evidenceRefs: [`${version}:los:${targets.length}`] };
            records.set(target.targetId, { target, proof, stateId: block.stateId, radius });
            targets.push(target);
          }
          const final = this.current(context);
          if (final !== proof) { invalidate(); return unavailable(radius, typeof final === 'string' ? final : 'visible_targets_world_changed'); }
          if (revision !== this.blockRevision) { invalidate(); return unavailable(radius, 'visible_targets_changed_during_query'); }
          latestVersion = version;
          return { status: 'partial', reason: 'search_coverage_unproven', observationVersion: version, observedAt: at,
            targets: structuredClone(targets), requestedBounds: { radius, origin },
            observedBounds: { kind: 'visible_target_points', positions: targets.map(target => position(target.position)) },
            complete: false, truncated, evidenceRefs: [version, ...targets.flatMap(target => target.evidenceRefs)] };
        } catch { invalidate(); return unavailableSearch(radius, 'visible_targets_query_failed', 'error'); }
      },
      resolve,
      close: () => { closed = true; invalidate(); this.invalidations.delete(invalidate); },
    };
  }
}
