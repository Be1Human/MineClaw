/**
 * Non-Bot entities have exactly one visible owner at a time.
 * The authentic renderer owns them only after its first frame is active;
 * the simple renderer remains the safe fallback while authentic data loads.
 */
export function shouldRenderSimpleEntities(activeRendererId) {
  return activeRendererId !== 'authentic';
}
