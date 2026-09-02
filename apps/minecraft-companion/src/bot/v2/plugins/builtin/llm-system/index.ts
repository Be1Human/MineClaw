/**
 * mineclaw.llm-system · first-party system plugin (release trust list).
 * Owns the LLM port integration for the runtime; constructed with systemPorts
 * containing the llm client at startup assembly.
 */
import type { PluginFactory } from '../../../plugin-kernel/discovery.js';
import type { PluginContribution } from '../../../plugin-sdk/index.js';

const PLUGIN_ID = 'mineclaw.llm-system';

export function createMineclawLlmSystemPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${PLUGIN_ID}`,
    create: (context): readonly PluginContribution[] => {
      const ports = (context.systemPorts ?? {}) as { llm?: unknown };
      const integration = {
        id: `${PLUGIN_ID}.integration.llm`,
        version: '1.0.0',
        integration: {
          id: `${PLUGIN_ID}.integration.llm`,
          version: '1.0.0',
          start: async (): Promise<void> => undefined,
          stop: async (): Promise<void> => undefined,
          status: (): 'running' | 'stopped' => ports.llm ? 'running' : 'stopped',
          services: Object.freeze(ports.llm ? { 'llm.client': ports.llm } : {}),
        },
      };
      return [{ kind: 'integration', ...integration }];
    },
  };
}
