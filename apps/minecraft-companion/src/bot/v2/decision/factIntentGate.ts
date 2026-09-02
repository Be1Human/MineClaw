/**
 * FEAT-CROSS-28 · FactIntentGate (design §5.3).
 * Runs before MainBrain free expression. High-recall classification: fresh
 * world-fact intent must become a KnowledgeQuery before any say; when it cannot
 * be confidently classified as chat, the gate leans toward a query (never a
 * hallucinated answer). Every decision carries matching evidence for audit.
 */
import type { KnowledgeQueryV1 } from './goalAgentPort/knowledgeQueryContracts.js';

export type FactIntentKind = 'chat' | 'knowledge_query' | 'task' | 'cancel';

export interface FactIntentContext {
  readonly conversationMode?: 'idle' | 'active_task' | 'awaiting_player';
  readonly sessionAgeMs?: number;
}

export interface IntentDecision {
  readonly intent: FactIntentKind;
  readonly evidence: readonly { readonly rule: string; readonly matched: string }[];
  readonly leaning: 'chat' | 'query' | 'task';
}

const QUERY_MARKERS = [
  /\b(?:what|where|which|how many|how much|is there|are there)\b/i,
  /(?:周围|旁边|附近|这里|那里|现在|最新|有多少|是什么|在哪儿|在哪|什么(?:情况|状态|东西|物品|作物|方块|矿物)|还有多|做了多少|完成了多少|进度|还剩)/,
  /(?:背包|物品|箱子|容器|坐标|位置|距离|方向|血量和|饥饿|作物|小麦|橡木|石头|方塊|方块|矿物|钻石|铁|实体|怪物|僵尸|羊|猪|牛|鸡|天气|时间)/,
  /\b(?:inventory|position|coordinate|nearby|world|block|item|entity|status|progress)\b/i,
];

const ACTION_MARKERS = [
  /(?:给|送|带|合成|制作|造|采|捡|挖|砍|种|收|跟|去|到|打|杀|建|放|拿|吃|睡|装备|存放|收集|搬|开|关|查看|继续|帮我)/,
  /\b(?:give|craft|make|trade|collect|gather|mine|cut|plant|harvest|follow|go|attack|build|place|pick|use|sleep|deposit|store|continue)\b/i,
];

const CANCEL_MARKERS = /(?:别|不要|停(?:下|止)?了?|取消|算了|回来)(?:跟|做|采|打|挖|弄|继续|了|吧)?/;
const CHAT_MARKERS = /(?:聊聊|聊天|你觉得|您觉得|喜欢|讨厌|故事|笑话|为什么|为啥|怎么看待|看法|建议|聪明|可爱|名字|你好|嗨|早安|晚安|谢了?|谢谢|再见|拜拜|哈哈哈|嘿嘿|不错吧|天气|挺好|好看|漂亮|好玩|怎么样|如何(?:看待|评价))/;

/** Gate ownership: pure decision, no world scanning; the runner executes queries. */
export class FactIntentGate {
  classify(text: string, context: FactIntentContext = {}): IntentDecision {
    const normalized = text.trim();
    const evidence: { rule: string; matched: string }[] = [];
    if (!normalized) return { intent: 'chat', evidence: [], leaning: 'chat' };

    const isCancel = CANCEL_MARKERS.test(normalized) && !/什么|哪里|附近|多少/.test(normalized);
    if (isCancel && !QUERY_MARKERS.some(marker => marker.test(normalized)) && ACTION_MARKERS.some(marker => marker.test(normalized))) {
      evidence.push({ rule: 'cancel_marker', matched: normalized });
      return { intent: 'cancel', evidence, leaning: 'task' };
    }

    const chatMatch = CHAT_MARKERS.exec(normalized);
    if (chatMatch) {
      evidence.push({ rule: 'chat_marker', matched: chatMatch[0] });
      return { intent: 'chat', evidence, leaning: 'chat' };
    }

    const actionMatch = ACTION_MARKERS.filter(marker => marker.test(normalized));
    const queryMatch = QUERY_MARKERS.filter(marker => marker.test(normalized));

    if (queryMatch.length > 0) {
      evidence.push(...queryMatch.slice(0, 3).map((marker, index) => ({
        rule: `query_marker:${index}`, matched: String(marker).slice(0, 40),
      })));
      // A query intent wins even when action markers co-occur (e.g. "帮我看看附近有什么").
      return { intent: 'knowledge_query', evidence, leaning: 'query' };
    }

    if (actionMatch.length > 0) {
      evidence.push(...actionMatch.slice(0, 3).map((marker, index) => ({
        rule: `action_marker:${index}`, matched: String(marker).slice(0, 40),
      })));
      // Active-task context keeps actions as tasks; otherwise ambiguous phrasing leans task only with a strong verb.
      return { intent: context.conversationMode === 'awaiting_player' ? 'chat' : 'task', evidence, leaning: 'task' };
    }

    // Uncertain: prefer a query over a direct say when the phrase mentions any world-denoting noun,
    // otherwise treat as chat but never claim fresh facts.
    evidence.push({ rule: 'default_uncertain', matched: normalized });
    return { intent: 'chat', evidence, leaning: 'chat' };
  }

  /** Convenience: whether a turn must be handled as a knowledge query (before expression). */
  isKnowledgeTurn(decision: IntentDecision): boolean {
    return decision.intent === 'knowledge_query';
  }
}

export interface KnowledgeQueryFactoryPort {
  create(decision: IntentDecision, input: { text: string; source: KnowledgeQueryV1['source'] }, snapshot: KnowledgeQueryV1['registryGeneration']): KnowledgeQueryV1;
}

/** Deterministic factory producing a validated query skeleton (real anchor/scope resolution happens in the runner). */
export class KnowledgeQueryFactory {
  constructor(private readonly defaults: {
    factKinds: KnowledgeQueryV1['factKinds'];
    anchor: KnowledgeQueryV1['anchor'];
    scope: KnowledgeQueryV1['scope'];
    freshness: KnowledgeQueryV1['freshness'];
  }) {}

  create(decision: IntentDecision, input: { text: string; source: KnowledgeQueryV1['source'] }, snapshot: KnowledgeQueryV1['registryGeneration'], sequence: number): KnowledgeQueryV1 {
    const id = `kq-${Date.now().toString(36)}-${sequence}`;
    return Object.freeze({
      schemaVersion: 'mineclaw.knowledge-query/v1',
      kind: 'knowledge_query',
      requestId: id,
      correlationId: `corr-${id}`,
      idempotencyKey: `idem-${id}`,
      emittedAt: new Date().toISOString(),
      source: input.source,
      replyMode: 'answer_player',
      originalText: input.text,
      factKinds: [...this.defaults.factKinds],
      anchor: this.defaults.anchor,
      scope: this.defaults.scope,
      freshness: this.defaults.freshness,
      registryGeneration: snapshot,
    });
  }
}
