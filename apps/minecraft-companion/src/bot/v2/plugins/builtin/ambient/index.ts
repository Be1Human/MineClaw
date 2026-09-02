/**
 * mineclaw.ambient · proactive owner-presence trigger.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';

const PLUGIN_ID = 'mineclaw.ambient';

export function createMineclawAmbientPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (): readonly PluginContribution[] => [
      {
        kind: 'proactive',
        id: `${PLUGIN_ID}.proactive.owner-presence`,
        version: '1.0.0',
        label: '主人在场观察',
        description: '主人上线/出现时主动反馈',
        goalTarget: 'mineclaw.minecraft-presence.observation.owner-context',
        rate: 'slow',
        priority: 0.2,
        evaluator: (input) => (input as { ownerPresent?: boolean }).ownerPresent === true,
      },
    ],
  };
}
