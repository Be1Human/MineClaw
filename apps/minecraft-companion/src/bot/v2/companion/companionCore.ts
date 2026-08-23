/**
 * Companion Core · pure chat companion domain.
 *
 * This module deliberately has no Minecraft, WebUI, LLM, or storage dependency.
 * Callers persist its serializable state in their own profile-scoped store.
 */

export type OverlayState = 'active' | 'rolled_back';
export type EmotionState = 'candidate' | 'active' | 'corrected';

export interface CorePersona {
  id: string;
  version: number;
  traits: string[];
  boundaries: string[];
}

export interface PersonaOverlay {
  id: string;
  version: number;
  changes: string[];
  sourceIds: string[];
  state: OverlayState;
  createdAt: number;
}

export interface EmotionEstimate {
  id: string;
  label: string;
  confidence: number;
  evidence: string[];
  alternatives: string[];
  revisable: boolean;
  state: EmotionState;
  correction?: string;
  createdAt: number;
}

export interface RelationshipState {
  trust: number;
  familiarity: number;
  evidenceIds: string[];
  updatedAt: number;
}

export interface InitiativePolicy {
  enabled: boolean;
  quietHours?: { start: number; end: number };
  cooldownMs: number;
  dailyBudget: number;
}

export interface InitiativeDecision {
  allowed: boolean;
  reason: 'disabled' | 'quiet_hours' | 'cooldown' | 'budget' | 'allowed';
}

export interface CompanionCoreState {
  profileId: string;
  corePersona: CorePersona;
  overlays: PersonaOverlay[];
  emotions: EmotionEstimate[];
  relationship: RelationshipState;
  initiative: InitiativePolicy;
  lastInitiativeAt?: number;
  initiativeDay?: string;
  initiativesToday: number;
}

export interface CompanionCoreOptions {
  profileId: string;
  corePersona: CorePersona;
  initiative?: Partial<InitiativePolicy>;
  state?: Partial<CompanionCoreState>;
  now?: () => number;
  maxRelationshipDelta?: number;
  minEmotionConfidence?: number;
}

export interface CompanionContext {
  profileId: string;
  corePersona: CorePersona;
  overlays: PersonaOverlay[];
  relationship: RelationshipState;
  emotions: EmotionEstimate[];
}

const DEFAULT_INITIATIVE: InitiativePolicy = {
  enabled: false,
  cooldownMs: 6 * 60 * 60 * 1000,
  dailyBudget: 1,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isQuietHour(hour: number, quiet?: { start: number; end: number }): boolean {
  if (!quiet) return false;
  if (quiet.start === quiet.end) return true;
  return quiet.start < quiet.end
    ? hour >= quiet.start && hour < quiet.end
    : hour >= quiet.start || hour < quiet.end;
}

/** Profile-scoped companion state machine. */
export class CompanionCore {
  private readonly now: () => number;
  private readonly maxRelationshipDelta: number;
  private readonly minEmotionConfidence: number;
  private readonly profileId: string;
  private readonly corePersona: CorePersona;
  private overlays: PersonaOverlay[];
  private emotions: EmotionEstimate[];
  private relationship: RelationshipState;
  private initiative: InitiativePolicy;
  private lastInitiativeAt?: number;
  private initiativeDay?: string;
  private initiativesToday: number;

  constructor(options: CompanionCoreOptions) {
    if (!options.profileId.trim()) throw new Error('profileId is required');
    if (!options.corePersona.id.trim()) throw new Error('corePersona.id is required');
    this.now = options.now ?? Date.now;
    this.maxRelationshipDelta = options.maxRelationshipDelta ?? 0.1;
    this.minEmotionConfidence = options.minEmotionConfidence ?? 0.6;
    this.profileId = options.profileId;
    this.corePersona = clone(options.corePersona);
    this.overlays = clone(options.state?.overlays ?? []);
    this.emotions = clone(options.state?.emotions ?? []);
    this.relationship = clone(options.state?.relationship ?? {
      trust: 0,
      familiarity: 0,
      evidenceIds: [],
      updatedAt: this.now(),
    });
    this.initiative = { ...DEFAULT_INITIATIVE, ...options.state?.initiative, ...options.initiative };
    this.lastInitiativeAt = options.state?.lastInitiativeAt;
    this.initiativeDay = options.state?.initiativeDay;
    this.initiativesToday = options.state?.initiativesToday ?? 0;
  }

  getCorePersona(): CorePersona { return clone(this.corePersona); }

  applyPersonaOverlay(input: { id: string; changes: string[]; sourceIds: string[] }): PersonaOverlay {
    if (!input.id.trim() || input.changes.length === 0 || input.sourceIds.length === 0) {
      throw new Error('overlay requires id, changes, and sourceIds');
    }
    const overlay: PersonaOverlay = {
      id: input.id,
      version: (this.overlays.at(-1)?.version ?? 0) + 1,
      changes: [...input.changes],
      sourceIds: [...input.sourceIds],
      state: 'active',
      createdAt: this.now(),
    };
    this.overlays.push(overlay);
    return clone(overlay);
  }

  rollbackOverlaysAfter(version: number): void {
    for (const overlay of this.overlays) {
      if (overlay.version > version) overlay.state = 'rolled_back';
    }
  }

  applyRelationshipEvidence(input: { evidenceId: string; trustDelta?: number; familiarityDelta?: number }): RelationshipState {
    if (!input.evidenceId.trim()) throw new Error('relationship evidenceId is required');
    const limit = this.maxRelationshipDelta;
    this.relationship.trust = clamp(this.relationship.trust + clamp(input.trustDelta ?? 0, -limit, limit), -1, 1);
    this.relationship.familiarity = clamp(this.relationship.familiarity + clamp(input.familiarityDelta ?? 0, -limit, limit), -1, 1);
    if (!this.relationship.evidenceIds.includes(input.evidenceId)) this.relationship.evidenceIds.push(input.evidenceId);
    this.relationship.updatedAt = this.now();
    return clone(this.relationship);
  }

  observeEmotion(input: { id: string; label: string; confidence: number; evidence: string[]; alternatives: string[] }): EmotionEstimate {
    if (!input.id.trim() || !input.label.trim() || input.evidence.length === 0) throw new Error('emotion requires id, label, and evidence');
    const emotion: EmotionEstimate = {
      id: input.id,
      label: input.label,
      confidence: clamp(input.confidence, 0, 1),
      evidence: [...input.evidence],
      alternatives: [...input.alternatives],
      revisable: true,
      state: 'candidate',
      createdAt: this.now(),
    };
    this.emotions = this.emotions.filter(item => item.id !== emotion.id);
    this.emotions.push(emotion);
    return clone(emotion);
  }

  correctEmotion(id: string, correction: string): void {
    const emotion = this.emotions.find(item => item.id === id);
    if (!emotion) throw new Error(`emotion not found: ${id}`);
    emotion.state = 'corrected';
    emotion.correction = correction;
  }

  setInitiativePolicy(patch: Partial<InitiativePolicy>): InitiativePolicy {
    this.initiative = { ...this.initiative, ...patch };
    return clone(this.initiative);
  }

  decideInitiative(at = this.now()): InitiativeDecision {
    if (!this.initiative.enabled) return { allowed: false, reason: 'disabled' };
    if (isQuietHour(new Date(at).getHours(), this.initiative.quietHours)) return { allowed: false, reason: 'quiet_hours' };
    const currentDay = dayKey(at);
    const todayCount = this.initiativeDay === currentDay ? this.initiativesToday : 0;
    if (todayCount >= this.initiative.dailyBudget) return { allowed: false, reason: 'budget' };
    if (this.lastInitiativeAt !== undefined && at - this.lastInitiativeAt < this.initiative.cooldownMs) return { allowed: false, reason: 'cooldown' };
    return { allowed: true, reason: 'allowed' };
  }

  recordInitiative(at = this.now()): InitiativeDecision {
    const decision = this.decideInitiative(at);
    if (!decision.allowed) return decision;
    const currentDay = dayKey(at);
    this.initiativesToday = this.initiativeDay === currentDay ? this.initiativesToday + 1 : 1;
    this.initiativeDay = currentDay;
    this.lastInitiativeAt = at;
    return decision;
  }

  getContext(): CompanionContext {
    return {
      profileId: this.profileId,
      corePersona: this.getCorePersona(),
      overlays: clone(this.overlays.filter(item => item.state === 'active')),
      relationship: clone(this.relationship),
      emotions: clone(this.emotions.filter(item => item.state !== 'corrected' && item.confidence >= this.minEmotionConfidence)),
    };
  }

  toPromptContext(): string {
    const context = this.getContext();
    const lines = [
      '── 陪伴上下文（辅助判断，不得当作用户事实）──',
      `核心人格 v${context.corePersona.version}：${context.corePersona.traits.join('；') || '未配置'}`,
      context.corePersona.boundaries.length ? `不可越界：${context.corePersona.boundaries.join('；')}` : '',
      context.overlays.length ? `已确认的相处偏好：${context.overlays.flatMap(item => item.changes).join('；')}` : '',
      `关系状态：熟悉度 ${context.relationship.familiarity.toFixed(2)}，信任 ${context.relationship.trust.toFixed(2)}（证据 ${context.relationship.evidenceIds.join(', ') || '无'}）`,
      context.emotions.length ? `可修正的情绪线索：${context.emotions.map(item => `${item.label}（置信度 ${item.confidence.toFixed(2)}，备选：${item.alternatives.join('/') || '无'}）`).join('；')}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  exportState(): CompanionCoreState {
    return clone({
      profileId: this.profileId,
      corePersona: this.corePersona,
      overlays: this.overlays,
      emotions: this.emotions,
      relationship: this.relationship,
      initiative: this.initiative,
      lastInitiativeAt: this.lastInitiativeAt,
      initiativeDay: this.initiativeDay,
      initiativesToday: this.initiativesToday,
    });
  }
}
