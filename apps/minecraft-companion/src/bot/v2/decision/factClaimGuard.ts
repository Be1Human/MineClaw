/**
 * FEAT-CROSS-28 · FactClaimGuard (design §5.3).
 * Blocks factual drafts (latest position, nearby objects, inventory, capability
 * status, task progress) unless a fresh, matching machine-validated answer is in
 * evidence. A missing answer never falls back to "generated" content.
 */
import type { KnowledgeAnswerV1 } from './goalAgentPort/knowledgeQueryContracts.js';

export interface MainBrainDraft {
  readonly kind: 'say' | 'answer' | 'narrate';
  readonly text: string;
  readonly claimedFacts?: readonly string[];
}

export type DraftDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'block'; readonly reason: string; readonly rule: string };

const FACT_CLAIM_PATTERNS: readonly RegExp[] = [
  /(?:附近|旁边|周围|你那边|我这里|现在还在|刚刚|已经被|已经完成|完成了|完成任务|做完|搞定|还有|背包里|手里有|身上有|坐标在|位置在|正在(?:做|走|挖|砍|采集)|进度|成熟了|收割完)/,
  /(?:has|have|is (?:at|near|there)|there are|done|finished|collected|inventory|position|north of|south of)/i,
];

const QUESTION_NOISE = /^(?:你应该|或许|可能是|我想|我猜|帮我|请)/;

export class FactClaimGuard {
  validateDraft(draft: MainBrainDraft, evidence: readonly KnowledgeAnswerV1[]): DraftDecision {
    const claims = draft.claimedFacts ?? [];
    const textClaims = FACT_CLAIM_PATTERNS.filter(pattern => pattern.test(draft.text));
    if (claims.length === 0 && textClaims.length === 0) {
      return { decision: 'allow' };
    }
    const fresh = evidence.filter(answer => answer.outcome === 'answered' && isFresh(answer, Date.now()));
    const matching = fresh.filter(answer => answer.facts.length > 0);
    if (matching.length === 0) {
      return {
        decision: 'block',
        reason: 'draft states fresh world facts without a machine-validated KnowledgeAnswer in evidence',
        rule: textClaims.length > 0 ? 'fact_claim_pattern' : 'fact_claim_declared',
      };
    }
    // Every declared claim must map to at least one fact with a covered fact kind.
    for (const claim of claims) {
      const covered = matching.some(answer => answer.facts.some(fact => claim.includes(fact.factKind) || String(fact.factKind).includes(claim)));
      if (!covered) {
        return { decision: 'block', reason: `claim "${claim}" has no matching covered fact`, rule: 'fact_claim_uncovered' };
      }
    }
    // Uncertain/incomplete answers may not support absolute claims ("完成了" etc.).
    if (matching.some(answer => answer.completeness === 'partial' || answer.facts.some(fact => !fact.complete))) {
      return {
        decision: 'block',
        reason: 'evidence is partial/incomplete; draft may not state absolute fresh facts',
        rule: 'fact_claim_partial_evidence',
      };
    }
    return { decision: 'allow' };
  }
}

function isFresh(answer: KnowledgeAnswerV1, now: number, maxAgeMs = 60_000): boolean {
  const observed = Date.parse(answer.observedAt);
  if (!Number.isFinite(observed)) return false;
  return now - observed <= maxAgeMs;
}

/** Deterministic renderer: a failing/generating model must never rob the player of an answer. */
export function renderKnowledgeAnswer(answer: KnowledgeAnswerV1): string {
  if (answer.outcome === 'answered') {
    const parts = answer.facts.map(fact => {
      const summary = summarizeFact(fact);
      const suffix = fact.truncated || !fact.complete ? '（部分观察，仅供参考）' : '';
      return suffix ? `${summary}${suffix}` : summary;
    });
    const prefix = parts.length > 0 ? parts.join('；') : '没有找到可确认的事实。';
    return normalizePeriod(prefix);
  }
  switch (answer.outcome) {
    case 'not_found': return `在可确认的范围内没有找到${answer.facts.length === 0 ? '对应内容' : '更多内容'}。`;
    case 'unsupported': return `我不具备观察这项游戏事实的能力（${answer.reason ?? 'unsupported'}）。`;
    case 'ambiguous': return `目标不够明确，我需要你确认：${answer.clarification?.question ?? '请补充位置或对象。'}`;
    case 'unavailable': return `现在无法取得这部分世界信息（${answer.reason ?? 'unavailable'}），稍后再试或换个说法。`;
    case 'cancelled': return '查询已取消。';
  }
  return `无法回答（${answer.outcome}）。`;
}

function summarizeFact(fact: { factKind: string; payload: Readonly<Record<string, unknown>> }): string {
  const payload = fact.payload as Record<string, unknown>;
  switch (fact.factKind) {
    case 'nearby_crops': return `附近${String(payload.crops ?? '作物')}：${describeEntries(payload) || '未发现'}。`;
    case 'nearby_blocks': return `附近的方块：${describeEntries(payload) || '未发现'}。`;
    case 'nearby_entities': return `附近的实体：${describeEntries(payload) || '未发现'}。`;
    case 'inventory': return `背包：${describeEntries(payload) || '空'}。`;
    case 'owner_location': return `主人在${String(payload.position ?? '未知位置')}附近。`;
    case 'self_location': return `我在${String(payload.position ?? '未知位置')}。`;
    case 'task_status': return `任务进度：${String(payload.summary ?? '进行中')}。`;
    case 'capability_status': return `当前可观察的事实种类：${describeEntries(payload) || '无'}。`;
    default: return `${fact.factKind}：${describeEntries(payload) || '无'}。`;
  }
}

function describeEntries(payload: Record<string, unknown>): string {
  const entries = payload.entries;
  if (Array.isArray(entries) && entries.length > 0) return String(entries.join('、'));
  if (typeof payload.count === 'number') return `${payload.count} 项`;
  return '';
}

function normalizePeriod(text: string): string {
  return /[。！？]$/.test(text) ? text : `${text}。`;
}
