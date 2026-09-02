/**
 * FEAT-CROSS-28 · MainBrain query answer bridge (design §5.3).
 * After a KnowledgeAnswer arrives, the renderer may only transcribe it; when
 * the model fails or produces an invalid draft, the deterministic fallback
 * speech closes the reply obligation. Fact claims without a fresh matching
 * answer are blocked before expression.
 */
import { FactClaimGuard, renderKnowledgeAnswer, type MainBrainDraft, type DraftDecision } from './factClaimGuard.js';
import { knowledgeAnswerContextEvent, type RuntimeContextEventV1 } from './runtimeContextEvent.js';
import type { KnowledgeAnswerV1 } from './goalAgentPort/knowledgeQueryContracts.js';

export interface AnswerTurnResult {
  readonly speech: string;
  readonly contextEvent: RuntimeContextEventV1 | null;
  readonly blockedDraft: DraftDecision | null;
}

/** Deterministic speech for a turn carrying an answer; never invents facts. */
export function answerTurnSpeech(answer: KnowledgeAnswerV1 | null, originalText: string): string {
  if (!answer) {
    return `我查询一下“${originalText.slice(0, 24)}”的情况，稍等。`;
  }
  return renderKnowledgeAnswer(answer);
}

/** Bridge the answer into the MainBrain turn: speech + machine-validated context event. */
export function applyAnswerToTurn(answer: KnowledgeAnswerV1 | null, originalText: string): AnswerTurnResult {
  const speech = answerTurnSpeech(answer, originalText);
  const contextEvent = answer ? null_toEvent(answer) : null;
  return { speech, contextEvent, blockedDraft: null };
}

function null_toEvent(answer: KnowledgeAnswerV1): RuntimeContextEventV1 {
  return knowledgeAnswerContextEvent(answer);
}

/**
 * Draft gate: a factual draft may only proceed with fresh matching evidence.
 * Returns the draft decision as-is; callers must not speak on 'block'.
 */
export function guardDraft(draft: MainBrainDraft, evidence: readonly KnowledgeAnswerV1[]): DraftDecision {
  return new FactClaimGuard().validateDraft(draft, evidence);
}

/** Deterministic turn composition: speech + context event (audit-safe). */
export function composeTurn(answer: KnowledgeAnswerV1, originalText: string): { speech: string; event: RuntimeContextEventV1 } {
  const speech = answerTurnSpeech(answer, originalText);
  const event = knowledgeAnswerContextEvent(answer);
  return { speech, event };
}
