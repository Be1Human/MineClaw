import type { EpisodeKind, EpisodeRule } from './contracts.js';

export class EpisodeRuleRegistry {
  private readonly rules = new Map<EpisodeKind, EpisodeRule>();

  constructor(registerDefaults = true) {
    if (registerDefaults) {
      this.register({ kind: 'combat', maxGapMs: 90_000, healthDelta: 3, positionDelta: 16 });
      this.register({ kind: 'danger', maxGapMs: 120_000, healthDelta: 3, positionDelta: 16 });
      this.register({ kind: 'task', maxGapMs: 10 * 60_000, healthDelta: 5, positionDelta: 32 });
      this.register({ kind: 'social', maxGapMs: 5 * 60_000, healthDelta: 5, positionDelta: 24 });
      this.register({ kind: 'exploration', maxGapMs: 15 * 60_000, healthDelta: 5, positionDelta: 48 });
    }
  }

  register(rule: EpisodeRule): this {
    if (this.rules.has(rule.kind)) throw new Error(`[EpisodeRuleRegistry] duplicate kind: ${rule.kind}`);
    if (rule.maxGapMs <= 0 || rule.healthDelta < 0 || rule.positionDelta < 0) {
      throw new Error(`[EpisodeRuleRegistry] invalid rule: ${rule.kind}`);
    }
    this.rules.set(rule.kind, { ...rule });
    return this;
  }

  get(kind: EpisodeKind): EpisodeRule {
    const rule = this.rules.get(kind);
    if (!rule) throw new Error(`[EpisodeRuleRegistry] unknown kind: ${kind}`);
    return rule;
  }
}
