/**
 * L6 · DecisionPolicy
 *
 * 三层决策金字塔：
 *   ① 规则（本类自己决定）—— 候选 ≤1 / 唯一 full / cost 差距巨大
 *   ② LLM decide（升级到 MainBrain）—— 多候选 cost 接近，需要 LLM 选
 *   ③ 反问玩家（升级到 ask_master）—— 关键信息不足（如"只能种 1 亩 vs 等 30s 探险"，主人没说要不要这个代价）
 *
 * 本类输出一个 Verdict，告诉调用方（L7 MainBrain）："你该走哪条路"
 */

import type { ResolutionResult } from './resourceResolver.js';
import type { ResourceCandidate } from './resourceProvider.js';

export type DecisionVerdict =
  | { kind: 'auto'; chosen: ResourceCandidate; reason: string }
  | { kind: 'escalate_llm'; candidates: ResourceCandidate[]; reason: string }
  | { kind: 'ask_master'; candidates: ResourceCandidate[]; question: string; reason: string }
  | { kind: 'no_solution'; reason: string };

export class DecisionPolicy {
  decide(res: ResolutionResult): DecisionVerdict {
    const cs = res.candidates;
    if (cs.length === 0) {
      return {
        kind: 'no_solution',
        reason: `没有 provider 能解决 ${describeReq(res.requirement)}`,
      };
    }

    // 1. 唯一候选 → 规则直选
    if (cs.length === 1) {
      return {
        kind: 'auto',
        chosen: cs[0],
        reason: `唯一候选 · ${cs[0].summary}`,
      };
    }

    // 2. 只有 1 个 full · 其余 partial / none → 规则直选 full
    const fulls = cs.filter(c => c.satisfaction === 'full');
    if (fulls.length === 1) {
      return {
        kind: 'auto',
        chosen: fulls[0],
        reason: `唯一 full 候选 · ${fulls[0].summary}`,
      };
    }

    // 3. 多个 full · cost 差距 > 3 倍 → 规则选低 cost
    if (fulls.length >= 2) {
      const cheapest = fulls[0];
      const second = fulls[1];
      if (
        cheapest.estimatedCostSec * 3 < second.estimatedCostSec ||
        second.estimatedCostSec === Infinity
      ) {
        return {
          kind: 'auto',
          chosen: cheapest,
          reason: `多候选但 cost 差距大（${cheapest.estimatedCostSec}s vs ${second.estimatedCostSec}s）`,
        };
      }
      // cost 接近 → 升级 LLM
      return {
        kind: 'escalate_llm',
        candidates: cs,
        reason: `${fulls.length} 个 full 候选 cost 接近 · 升级 LLM 选`,
      };
    }

    // 4. 全是 partial · 关键信息缺失（要不要为了 full 付出额外代价） → 问主人
    const hasPartial = cs.some(c => c.satisfaction === 'partial');
    const hasNone = cs.some(c => c.satisfaction === 'none');
    if (hasPartial && !hasNone) {
      const partial = cs.find(c => c.satisfaction === 'partial')!;
      return {
        kind: 'ask_master',
        candidates: cs,
        reason: 'partial 候选 vs 无 full · 信息不足',
        question: buildAskQuestion(res, partial),
      };
    }

    // 5. partial + 不可行的 → 也问
    if (hasPartial) {
      const partial = cs.find(c => c.satisfaction === 'partial')!;
      return {
        kind: 'ask_master',
        candidates: cs,
        reason: 'partial 是唯一可行 · 但和原始需求不符',
        question: buildAskQuestion(res, partial),
      };
    }

    return {
      kind: 'no_solution',
      reason: '所有候选都不可行',
    };
  }
}

function buildAskQuestion(res: ResolutionResult, partial: ResourceCandidate): string {
  const req = res.requirement;
  const target = req.name;
  const amount = partial.partialAmount ?? '部分';
  const fullCandidate = res.candidates.find(
    c => c.satisfaction === 'full' && c.providerId !== partial.providerId,
  );
  if (fullCandidate) {
    return (
      `我手上的 ${target} 只够做 ${amount} 份。` +
      `要么 A 我先做这 ${amount} 份；要么 B ${fullCandidate.summary}（约 ${fullCandidate.estimatedCostSec}s）。选哪个？`
    );
  }
  // 没有 full · 只能 partial
  return `我手上的 ${target} 只够做 ${amount} 份，要先做这些吗？`;
}

function describeReq(req: ResolutionResult['requirement']): string {
  if (req.kind === 'item') {
    const parts: string[] = [req.name];
    if (req.minCount) parts.push(`x${req.minCount}`);
    if (req.minDurability) parts.push(`耐久≥${req.minDurability}`);
    return parts.join(' ');
  }
  return JSON.stringify(req);
}
