import { extractRetrievalAnchors, parseFactTriple } from '../../../apps/minecraft-companion/src/bot/v2/infra/chatMemory.js';

export interface LatestGraphAudit {
  anchors: string[];
  expectedReachable: boolean;
  rawExpectedPresent: boolean;
  reachedObjects: string[];
  traversedFactCount: number;
}

interface SequencedRelation {
  key: string;
  subject: string;
  object: string;
  content: string;
  sequence: number;
}

/**
 * 只按问题显式实体遍历“同 subject/relation 最大序号”关系图。
 * expected 仅在遍历完成后做覆盖判定，绝不参与路径选择。
 */
export function auditLatestRelationGraph(context: string, question: string, expected: readonly string[], maxHops = 8): LatestGraphAudit {
  const latest = new Map<string, SequencedRelation>();
  const lines = context.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  lines.forEach((content, index) => {
    const triple = parseFactTriple(content);
    if (!triple) return;
    const serial = Number.parseInt(content.match(/^\s*(\d+)\./)?.[1] ?? '', 10);
    const sequence = Number.isFinite(serial) ? serial : index;
    const previous = latest.get(triple.key);
    if (!previous || sequence >= previous.sequence) latest.set(triple.key, { ...triple, content, sequence });
  });

  const bySubject = new Map<string, SequencedRelation[]>();
  for (const relation of latest.values()) {
    const key = normalizeEntity(relation.subject);
    const group = bySubject.get(key) ?? [];
    group.push(relation);
    bySubject.set(key, group);
  }

  const anchors = extractRetrievalAnchors(question, false);
  let frontier = anchors.map(normalizeEntity).filter(Boolean);
  const seenEntities = new Set(frontier);
  const traversed = new Map<string, SequencedRelation>();
  const reachedObjects = new Set<string>();
  for (let hop = 0; hop <= maxHops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const entity of frontier) {
      for (const relation of bySubject.get(entity) ?? []) {
        traversed.set(relation.key, relation);
        reachedObjects.add(relation.object);
        const object = normalizeEntity(relation.object);
        if (object && !seenEntities.has(object)) {
          seenEntities.add(object);
          next.push(object);
        }
      }
    }
    frontier = next;
  }

  const normalizedExpected = expected.map(normalizeAnswer).filter(Boolean);
  const normalizedObjects = [...reachedObjects].map(normalizeAnswer);
  const normalizedContext = normalizeAnswer(context);
  return {
    anchors,
    expectedReachable: normalizedExpected.length > 0 && normalizedExpected.some(answer => normalizedObjects.some(object => object.includes(answer))),
    rawExpectedPresent: normalizedExpected.length > 0 && normalizedExpected.some(answer => normalizedContext.includes(answer)),
    reachedObjects: [...reachedObjects],
    traversedFactCount: traversed.size,
  };
}

export function normalizedAnswerPresent(text: string, expected: readonly string[]): boolean {
  const normalized = normalizeAnswer(text);
  return expected.map(normalizeAnswer).filter(Boolean).some(answer => normalized.includes(answer));
}

function normalizeEntity(value: string): string {
  return value.toLocaleLowerCase().replace(/^["'“”‘’]+|["'“”‘’.。]+$/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeAnswer(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\b(?:a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
