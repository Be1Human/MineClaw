export const emptyProactiveSnapshot = () => ({
  catalog: [],
  states: [],
  lease: { active: null, releasing: null },
});

export function proactiveCapabilityCards(snapshot = emptyProactiveSnapshot()) {
  const states = Array.isArray(snapshot.states) ? snapshot.states : [];
  return (Array.isArray(snapshot.catalog) ? snapshot.catalog : []).map(entry => {
    const state = states.find(item => item.id === entry.id);
    return {
      id: `proactive:${entry.id}`,
      enabled: Boolean(entry.enabled),
      label: entry.label || entry.id,
      icon: 'activity',
      description: entry.description || '',
      statusLabel: entry.enabled
        ? `${state?.state || 'idle'}${state?.reason ? ` · ${state.reason}` : ''}`
        : '未启用',
    };
  });
}
