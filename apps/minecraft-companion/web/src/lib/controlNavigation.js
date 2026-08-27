export const CONTROL_TAB_IDS = Object.freeze(['status', 'tasks', 'inventory', 'logs']);

/**
 * FEAT-WEBUI-24 · “状态”和“聊天”合并为“互动”，技术 ID 继续使用 status。
 */
export function normalizeControlTab(tab) {
  if (tab === 'chat') return 'status';
  return CONTROL_TAB_IDS.includes(tab) ? tab : null;
}

export function migrateControlTabs(controlTabs = {}) {
  if (!controlTabs || Array.isArray(controlTabs) || typeof controlTabs !== 'object') {
    return { controlTabs: {}, changed: true };
  }

  const nextControlTabs = {};
  let changed = false;
  for (const [profileId, tab] of Object.entries(controlTabs)) {
    const normalized = normalizeControlTab(tab);
    if (!normalized) {
      changed = true;
      continue;
    }
    nextControlTabs[profileId] = normalized;
    if (normalized !== tab) changed = true;
  }
  return { controlTabs: nextControlTabs, changed };
}
