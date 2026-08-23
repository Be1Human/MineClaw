import type { Vec3 } from '../../../../adapter/types.js';
import type { WorldStateView } from '../../../types.js';

export type ContainerRelation = 'left' | 'right' | 'front' | 'back' | 'nearby';

export interface ChestTarget {
  pos: Vec3;
  relation: ContainerRelation;
  distance: number;
}

export function rankChestTargets(
  positions: Vec3[],
  requestText: string,
  world: WorldStateView,
): ChestTarget[] {
  const owner = world.owner;
  const origin = owner?.position;
  const requestedSide = sideFromText(requestText);
  if (!origin) return [];
  const ownerEntity = world.entities.find(entity =>
    (owner.entityId !== null && entity.id === owner.entityId)
    || entity.name === owner.username);
  const yaw = ownerEntity?.yaw;
  const resolvedYaw = typeof yaw === 'number' && Number.isFinite(yaw) ? yaw : undefined;
  if (requestedSide && resolvedYaw === undefined) return [];

  const unique = [...new Map(positions
    .filter(isFinitePosition)
    .map(position => [`${position.x}:${position.y}:${position.z}`, position])).values()];
  const ranked = unique.map(pos => describe(pos, origin, resolvedYaw));
  return ranked
    .filter(target => !requestedSide || target.relation === requestedSide)
    .sort((a, b) => a.distance - b.distance || positionKey(a.pos).localeCompare(positionKey(b.pos)));
}

function describe(pos: Vec3, origin: Vec3, yaw: number | undefined): ChestTarget {
  const dx = pos.x - origin.x;
  const dy = pos.y - origin.y;
  const dz = pos.z - origin.z;
  const distance = Math.hypot(dx, dy, dz);
  if (yaw === undefined) return { pos: structuredClone(pos), relation: 'nearby', distance };
  const leftScore = dx * -Math.cos(yaw) + dz * Math.sin(yaw);
  const forwardScore = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
  const relation: ContainerRelation = Math.abs(leftScore) >= Math.abs(forwardScore)
    ? leftScore >= 0 ? 'left' : 'right'
    : forwardScore >= 0 ? 'front' : 'back';
  return { pos: structuredClone(pos), relation, distance };
}

function sideFromText(text: string): 'left' | 'right' | null {
  if (/(?:左边|左侧|左手|\bleft\b)/i.test(text)) return 'left';
  if (/(?:右边|右侧|右手|\bright\b)/i.test(text)) return 'right';
  return null;
}

function isFinitePosition(value: Vec3): boolean {
  return [value.x, value.y, value.z].every(Number.isFinite);
}

function positionKey(value: Vec3): string {
  return `${value.x}:${value.y}:${value.z}`;
}
