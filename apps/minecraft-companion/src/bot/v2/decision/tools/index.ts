/**
 * L7 · tools/ 装配入口（FEAT-L7-13）
 *
 * buildDefaultToolRegistry：把 deps 包装成 ToolContext（speak / recentOwnerText /
 * lastResolution 共享能力），收拢 defs/* 全部工具定义注册进 ToolRegistry。
 * 新增工具 = defs/ 下加定义 + 在这里的清单数组挂一行，框架零改动。
 */

import type { ConversationEntry } from '../../infra/memory.js';
import type { EventBusV2 } from '../../infra/eventBus.js';
import type { MemoryV2 } from '../../infra/memory.js';
import type { BotMemoryStore } from '../../infra/botMemory.js';
import type { GoalAgentPort } from '../goalAgentPort/goalAgentPort.js';
import { ToolRegistry } from './toolRegistry.js';
import type { ToolContext, ToolDeps } from './types.js';
import { worldTools } from './defs/worldTools.js';
import { speechTools } from './defs/speechTools.js';
import { resourceTools } from './defs/resourceTools.js';
import { memoryTools } from './defs/memoryTools.js';
import { queryTools } from './defs/queryTools.js';
import { skillTools } from './defs/skillTools.js';
import { strategyTools } from './defs/strategyTools.js';
import { companionTools } from './defs/companionTools.js';
import { goalAgentTools } from './defs/goalAgentTools.js';

export { ToolRegistry } from './toolRegistry.js';
export type {
  BriefWorldSnapshot,
  DispatcherDeps,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolDeps,
  ToolFailureReason,
  ToolResult,
} from './types.js';

export interface ToolRegistryPorts {
  /** MainBrain 持有的唯一可见发言提交口。未注入时只形成内部通知。 */
  speak?: (text: string, mode: 'say' | 'ask_master') => void;
}

/** MainBrain 可持有的最小能力集合，不含世界、TaskRuntime、原子动作或策略库。 */
export interface MainBrainToolDeps {
  bus: EventBusV2;
  ownerName: string;
  goalAgentPort?: Pick<GoalAgentPort, 'request'> & Partial<Pick<GoalAgentPort,
    'beginPlayerTurn' | 'beginContinuation' | 'endPlayerTurn' | 'markReplied' |
    'isManagedRequest' | 'cancelSessions' | 'abandonSession' | 'getCurrentStatus'>>;
  memory?: MemoryV2;
  botMemory?: BotMemoryStore;
  memorySystem?: {
    prepareContext(query:string,budget?:number):{text:string};
    deepRecall(input:{query:string;budget?:number;entities?:string[];locations?:string[];timeRange?:{from?:number;to?:number};includeEvidence?:boolean}):unknown;
  };
}

export function buildDefaultToolRegistry(deps: ToolDeps, ports: ToolRegistryPorts = {}): ToolRegistry {
  const isEmbodied = deps.isEmbodied ?? (() => deps.embodied !== false);
  const ctx: ToolContext = {
    ...deps,
    lastResolution: null,
    speak(text: string, mode = 'say'): void {
      if (ports.speak) {
        ports.speak(text, mode);
        return;
      }
      deps.bus.publish('brain.notice', 'suggestion', {
        source: 'tool_registry',
        topic: 'speech_request_without_brain',
        label: '收到未绑定大脑回合的发言请求',
        detail: text,
        wake: false,
      });
    },
    /**
     * 取最近一条主人对话原文（required 槽 dialogue 提取用）。
     * memory 是可选注入——无 memory 时返回空串，提取跳过、走 clarify（安全降级）。
     */
    recentOwnerText(): string {
      if (!deps.memory) return '';
      try {
        const convos = deps.memory.query('conversation') as ConversationEntry[];
        for (let i = convos.length - 1; i >= 0; i--) {
          if (convos[i]?.role === 'owner' && convos[i]?.content) return convos[i].content;
        }
      } catch { /* memory 查询失败不影响主流程 */ }
      return '';
    },
  };

  const registry = new ToolRegistry(ctx, {
    isEmbodied,
    companionSafe: new Set(['say', 'ask_master', 'stay_silent', 'save_memory', 'recall_memory', 'join_game']),
  });
  // 始终注册完整工具集，ToolRegistry 在每次 schema/dispatch 时按当前身体态过滤。
  // 这样进出游戏无需重建 MainBrain，已激活 skill 也不会丢失。
  const defs = [
    ...worldTools,
    ...speechTools,
    ...resourceTools,
    ...memoryTools,
    ...queryTools,
    ...skillTools,
    ...strategyTools,
    ...companionTools,
  ];
  for (const def of defs) {
    registry.register(def);
  }
  return registry;
}

/** MainBrain 专用白名单：人格/聊天/用户记忆 + 唯一 GoalAgentPort。 */
export function buildMainBrainToolRegistry(deps: MainBrainToolDeps, ports: ToolRegistryPorts = {}): ToolRegistry {
  const ctx = {
    ...deps,
    lastResolution: null,
    speak(text: string, mode = 'say'): void {
      if (ports.speak) ports.speak(text, mode);
      else deps.bus.publish('brain.notice', 'suggestion', { source:'mainbrain_registry',topic:'speech_unbound',label:'发言口未绑定',detail:text,wake:false });
    },
    recentOwnerText(): string {
      if (!deps.memory) return '';
      const entries = deps.memory.query('conversation') as ConversationEntry[];
      return [...entries].reverse().find(entry => entry.role === 'owner')?.content ?? '';
    },
  } as ToolContext;
  const allowed = new Set(['say', 'ask_master', 'stay_silent', 'propose_chat', 'save_memory']);
  const registry = new ToolRegistry(ctx, {
    isEmbodied: () => true,
    companionSafe: allowed,
    failureWorldSnapshot: false,
  });
  for (const def of [...speechTools, ...memoryTools, ...goalAgentTools]) {
    if (allowed.has(def.name) || ['submit_goal_request','get_goal_status'].includes(def.name)) registry.register(def);
  }
  return registry;
}
