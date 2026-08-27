export const BRAIN_TAB_IDS = Object.freeze(['overview', 'decision', 'memory', 'capabilities']);

/**
 * FEAT-WEBUI-16 · 把旧顶层 memory 工作区迁入大脑内部，不改写其他伙伴的选择。
 */
export function migrateMemoryWorkspaceTabs(workspaceTabs, brainTabs = {}) {
  const nextWorkspaceTabs = { ...(workspaceTabs ?? {}) };
  const nextBrainTabs = { ...(brainTabs ?? {}) };
  let changed = false;

  for (const [profileId, workspace] of Object.entries(nextWorkspaceTabs)) {
    if (workspace !== 'memory') continue;
    nextWorkspaceTabs[profileId] = 'brain';
    nextBrainTabs[profileId] = 'memory';
    changed = true;
  }

  return { workspaceTabs: nextWorkspaceTabs, brainTabs: nextBrainTabs, changed };
}
