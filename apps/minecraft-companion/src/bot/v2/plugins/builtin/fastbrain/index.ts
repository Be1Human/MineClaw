import type { PluginFactory } from '../../../plugin-kernel/discovery.js';

export const FASTBRAIN_PLUGIN_ID = 'mineclaw.fastbrain';
export const FASTBRAIN_PROTOCOL_REF = 'src/bot/v2/plugins/builtin/fastbrain/protocol.md';

/** Public protocol knowledge, not an executable capability or a system plugin. */
export function createMineclawFastbrainPlugin(): PluginFactory {
  return {
    entryKey: `plugins/builtin/${FASTBRAIN_PLUGIN_ID}`,
    create: context => {
      const content = context.packageContents?.get(FASTBRAIN_PROTOCOL_REF);
      if (!content) throw new Error('fastbrain_protocol_content_missing');
      return [{ kind: 'knowledge', id: `${FASTBRAIN_PLUGIN_ID}.knowledge.decision-protocol`, version: '1.0.0',
        contentRef: FASTBRAIN_PROTOCOL_REF, content,
        contentSchema: { format: 'mineclaw.domain-knowledge/v1', mediaType: 'text/markdown' } }];
    },
  };
}
