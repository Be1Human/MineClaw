function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export const WORKSPACE_LAYOUT_CONFIG = Object.freeze({
  storageKey: 'mc.workspaceLayout.v1',
  defaults: Object.freeze({ first: 250, second: 380 }),
  firstMin: 180,
  firstMax: 360,
  secondMin: 300,
  secondMax: 600,
  remainingMin: 300,
  fixedSpace: 42,
});

export const TRACE_LAYOUT_CONFIG = Object.freeze({
  storageKey: 'mc.traceLayout.v1',
  defaults: Object.freeze({ first: 250, second: 340 }),
  firstMin: 180,
  firstMax: 420,
  secondMin: 260,
  secondMax: 700,
  remainingMin: 360,
  fixedSpace: 0,
});

export function constrainPanePair(layout, config, containerWidth = Number.POSITIVE_INFINITY) {
  let first = clamp(
    finiteNumber(layout?.first, config.defaults.first),
    config.firstMin,
    config.firstMax,
  );
  let second = clamp(
    finiteNumber(layout?.second, config.defaults.second),
    config.secondMin,
    config.secondMax,
  );

  if (Number.isFinite(containerWidth)) {
    const pairBudget = Math.max(
      config.firstMin + config.secondMin,
      Math.floor(containerWidth) - config.remainingMin - config.fixedSpace,
    );
    let excess = Math.max(0, first + second - pairBudget);
    const secondReduction = Math.min(excess, second - config.secondMin);
    second -= secondReduction;
    excess -= secondReduction;
    first -= Math.min(excess, first - config.firstMin);
  }

  return { first: Math.round(first), second: Math.round(second) };
}

export function readStoredPanePair(storage, config) {
  try {
    const parsed = JSON.parse(storage?.getItem(config.storageKey) || '{}');
    return constrainPanePair(parsed, config);
  } catch {
    return { ...config.defaults };
  }
}

export function storePanePair(storage, config, layout) {
  try {
    storage?.setItem(config.storageKey, JSON.stringify(constrainPanePair(layout, config)));
  } catch {
    // Layout preferences are best-effort and must never block the workspace.
  }
}

export function resizePanePair(layout, pane, delta, config, containerWidth) {
  const next = { ...layout };
  if (pane === 'first') next.first = finiteNumber(layout?.first, config.defaults.first) + delta;
  if (pane === 'second') next.second = finiteNumber(layout?.second, config.defaults.second) + delta;
  return constrainPanePair(next, config, containerWidth);
}
