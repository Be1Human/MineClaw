/**
 * Release-owned Skill/Knowledge package. Resource bytes are embedded by the
 * builtin-index generator and injected through PluginConstructionContext, so
 * consumers never scan an external skills directory or reopen mutable files.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/contributions.js';

const PLUGIN_ID = 'mineclaw.agent-guidance';
const VERSION = '1.0.0';

const SKILLS = [
  ['owner-memory', 'skills/主人记忆/SKILL.md'],
  ['task-management', 'skills/任务管理/SKILL.md'],
  ['agriculture-sowing', 'skills/农活种植/SKILL.md'],
  ['landmark-navigation', 'skills/去地标/SKILL.md'],
  ['crafting', 'skills/合成造物/SKILL.md'],
  ['location-memory', 'skills/地点记忆/SKILL.md'],
  ['world-perception', 'skills/感知世界/SKILL.md'],
  ['agriculture-harvest', 'skills/成熟农田归仓/SKILL.md'],
  ['item-search', 'skills/找东西/SKILL.md'],
  ['skill-evolution', 'skills/技能进化/SKILL.md'],
  ['exploration', 'skills/探索找路/SKILL.md'],
  ['clarification', 'skills/沟通澄清/SKILL.md'],
  ['capability-index', 'skills/能力索引/SKILL.md'],
  ['resource-decision', 'skills/资源决策/SKILL.md'],
  ['follow-owner', 'skills/跟随主人/SKILL.md'],
  ['owner-protection', 'skills/保护我/SKILL.md'],
  ['gathering', 'skills/采集材料/SKILL.md'],
] as const;

const KNOWLEDGE_REF = 'src/bot/v2/plugins/builtin/agent-guidance/agriculture-knowledge.md';

export function createMineclawAgentGuidancePlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: context => {
      const contents = context.packageContents;
      if (!contents) throw new Error('plugin_package_contents_missing');
      const contributions: PluginContribution[] = SKILLS.map(([name, entryRef]) => ({
        kind: 'skill',
        id: `${PLUGIN_ID}.skill.${name}`,
        version: VERSION,
        entryRef,
        content: requiredContent(contents, entryRef),
      }));
      contributions.push({
        kind: 'knowledge',
        id: `${PLUGIN_ID}.knowledge.agriculture-basics`,
        version: VERSION,
        contentRef: KNOWLEDGE_REF,
        content: requiredContent(contents, KNOWLEDGE_REF),
        contentSchema: { format: 'mineclaw.domain-knowledge/v1', mediaType: 'text/markdown' },
      });
      return Object.freeze(contributions);
    },
  };
}

function requiredContent(contents: ReadonlyMap<string, string>, ref: string): string {
  const content = contents.get(ref);
  if (!content?.trim()) throw new Error(`plugin_package_content_missing:${ref}`);
  return content;
}
