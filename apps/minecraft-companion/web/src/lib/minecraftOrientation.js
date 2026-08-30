const MODEL_FORWARD_POSITIVE_Z = '+z';
const MODEL_FORWARD_NEGATIVE_Z = '-z';

/**
 * Mineflayer yaw follows Minecraft's horizontal convention:
 * 0 = north (-Z), PI/2 = west (-X).
 */
export function mineflayerYawBasis(value) {
  const yaw = finiteYaw(value);

  return {
    forward: { x: -Math.sin(yaw), z: -Math.cos(yaw) },
    right: { x: Math.cos(yaw), z: -Math.sin(yaw) },
  };
}

/** Convert Mineflayer yaw to a Three.js Y rotation for a model's local front axis. */
export function mineflayerYawToThreeRotation(value, modelForward = MODEL_FORWARD_POSITIVE_Z) {
  const yaw = finiteYaw(value);
  if (modelForward === MODEL_FORWARD_POSITIVE_Z) return Math.PI + yaw;
  if (modelForward === MODEL_FORWARD_NEGATIVE_Z) return yaw;
  throw new TypeError(`Unsupported model forward axis: ${modelForward}`);
}

function finiteYaw(value) {
  const yaw = Number(value);
  return Number.isFinite(yaw) ? yaw : 0;
}
