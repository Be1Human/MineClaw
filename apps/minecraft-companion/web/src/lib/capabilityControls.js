export const emptyCapabilityControlSnapshot = () => ({ capabilities: [] });

export function capabilityControlCards(snapshot = emptyCapabilityControlSnapshot()) {
  return (Array.isArray(snapshot?.capabilities) ? snapshot.capabilities : []).map(entry => ({
    id: String(entry?.id || ''),
    label: String(entry?.label || entry?.id || '未命名能力'),
    description: String(entry?.description || ''),
    icon: String(entry?.icon || 'skill'),
    kind: String(entry?.kind || 'base'),
    enabled: Boolean(entry?.enabled),
    defaultEnabled: Boolean(entry?.defaultEnabled),
    statusLabel: String(entry?.statusLabel || (entry?.enabled ? '已启用' : '未启用')),
    control: entry?.control?.method === 'PATCH' && typeof entry?.control?.href === 'string'
      ? { method: 'PATCH', href: entry.control.href }
      : null,
  })).filter(entry => entry.id);
}
