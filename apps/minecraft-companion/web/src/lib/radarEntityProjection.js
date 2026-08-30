import { mineflayerYawBasis } from './minecraftOrientation.js';

const RADAR_RADIUS_PERCENT = 44;
const RANGE_EPSILON = 1;

const CATEGORY_PRESENTATION = Object.freeze({
  player: Object.freeze({ key: 'player', label: '玩家' }),
  hostile: Object.freeze({ key: 'hostile', label: '敌对生物' }),
  passive: Object.freeze({ key: 'passive', label: '被动生物' }),
  neutral: Object.freeze({ key: 'neutral', label: '中立生物' }),
  item: Object.freeze({ key: 'item', label: '掉落物' }),
  other: Object.freeze({ key: 'other', label: '其他实体' }),
});

export function projectRadarEntities(worldState) {
  const selfPosition = worldState?.self?.position;
  if (!hasFiniteHorizontalPosition(selfPosition)) return emptyProjection();

  const basis = mineflayerYawBasis(worldState?.self?.yaw);
  const entities = Array.isArray(worldState?.entities) ? worldState.entities : [];
  const candidates = [];

  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    if (!hasFiniteHorizontalPosition(entity?.position)) continue;

    const dx = entity.position.x - selfPosition.x;
    const dz = entity.position.z - selfPosition.z;
    const horizontalDistance = Math.hypot(dx, dz);
    const measuredDistance = finiteNumber(entity?.distance, distance3d(selfPosition, entity.position));
    const presentation = categoryPresentation(entity?.category);
    const name = displayName(entity);

    candidates.push({
      id: `${entity?.id ?? 'entity'}:${index}`,
      entityId: entity?.id ?? null,
      name,
      category: presentation.key,
      categoryLabel: presentation.label,
      distance: Math.max(0, measuredDistance),
      horizontalDistance,
      right: dx * basis.right.x + dz * basis.right.z,
      forward: dx * basis.forward.x + dz * basis.forward.z,
    });
  }

  if (candidates.length === 0) return emptyProjection();

  const range = Math.max(RANGE_EPSILON, ...candidates.map(candidate => candidate.horizontalDistance));
  const markers = candidates.map(candidate => projectCandidate(candidate, range));

  return {
    range,
    rangeLabel: formatDistance(range),
    total: markers.length,
    markers,
  };
}

export function radarCategoryPresentation(category) {
  return categoryPresentation(category);
}

function projectCandidate(candidate, range) {
  const normalizedDistance = Math.min(1, candidate.horizontalDistance / range);
  const radialPercent = normalizedDistance * RADAR_RADIUS_PERCENT;
  const unitRight = candidate.horizontalDistance > 0 ? candidate.right / candidate.horizontalDistance : 0;
  const unitForward = candidate.horizontalDistance > 0 ? candidate.forward / candidate.horizontalDistance : 0;
  const xPercent = 50 + unitRight * radialPercent;
  const yPercent = 50 - unitForward * radialPercent;
  const description = `${candidate.name} · ${candidate.categoryLabel} · ${formatDistance(candidate.distance)} 格`;

  return {
    ...candidate,
    xPercent: roundCoordinate(xPercent),
    yPercent: roundCoordinate(yPercent),
    edge: normalizedDistance >= 1,
    description,
  };
}

function categoryPresentation(category) {
  return CATEGORY_PRESENTATION[category] ?? CATEGORY_PRESENTATION.other;
}

function displayName(entity) {
  const value = typeof entity?.name === 'string' ? entity.name.trim() : '';
  if (value) return value;
  const droppedItem = typeof entity?.droppedItem?.name === 'string' ? entity.droppedItem.name.trim() : '';
  return droppedItem || 'unknown';
}

function hasFiniteHorizontalPosition(position) {
  return Number.isFinite(position?.x) && Number.isFinite(position?.z);
}

function distance3d(left, right) {
  const dx = finiteNumber(right?.x, left.x) - left.x;
  const dy = finiteNumber(right?.y, left.y ?? 0) - finiteNumber(left?.y, 0);
  const dz = finiteNumber(right?.z, left.z) - left.z;
  return Math.hypot(dx, dy, dz);
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function formatDistance(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function roundCoordinate(value) {
  return Math.round(value * 1000) / 1000;
}

function emptyProjection() {
  return { range: 0, rangeLabel: '—', total: 0, markers: [] };
}
