/**
 * L6 · ResourceResolver
 *
 * 职责：把"任务前置不满足的资源缺口"转成"候选获取方案列表"。
 * 不做决策，只列候选。"选哪个"是 DecisionPolicy / LLM / 主人的事。
 *
 * 流程：
 *   1. 收到 ResourceRequirement
 *   2. 遍历所有注册的 IResourceProvider
 *   3. 收集所有候选
 *   4. 按 estimatedCostSec 升序 + full > partial > none 排序
 */

import type { WorldStateView } from '../types.js';
import type {
  IResourceProvider,
  ResourceCandidate,
  ResourceRequirement,
} from './resourceProvider.js';

export interface ResolutionResult {
  requirement: ResourceRequirement;
  candidates: ResourceCandidate[];
  /** 是否至少有一个 full 候选 */
  hasFullSolution: boolean;
}

export class ResourceResolver {
  private providers: IResourceProvider[] = [];

  register(p: IResourceProvider): void {
    this.providers.push(p);
  }

  resolve(req: ResourceRequirement, world: WorldStateView): ResolutionResult {
    const candidates: ResourceCandidate[] = [];
    for (const p of this.providers) {
      try {
        candidates.push(...p.provide(req, world));
      } catch (e) {
        // 单个 provider 报错不影响整体
        candidates.push({
          providerId: p.id,
          summary: `provider ${p.id} 报错：${(e as Error).message}`,
          estimatedCostSec: Infinity,
          subtaskSuggestion: null,
          satisfaction: 'none',
        });
      }
    }
    candidates.sort((a, b) => {
      const satRank = { full: 0, partial: 1, none: 2 } as const;
      const sa = satRank[a.satisfaction] - satRank[b.satisfaction];
      if (sa !== 0) return sa;
      return a.estimatedCostSec - b.estimatedCostSec;
    });
    return {
      requirement: req,
      candidates,
      hasFullSolution: candidates.some(c => c.satisfaction === 'full'),
    };
  }
}
