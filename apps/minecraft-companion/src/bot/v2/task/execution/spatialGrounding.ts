interface Position {
  x: number;
  y: number;
  z: number;
}

interface GroundedPoint {
  position: Position;
  blockName?: string;
  source: 'locate_block' | 'find_mineral' | 'find_chest_with';
}

export type SpatialGroundingVerdict =
  | { ok: true }
  | { ok: false; code: 'contract.ungrounded_position'; detail: string };

/**
 * Session-local evidence ledger for resource collection actions.
 * Query tools may authorize positions; LLM prose and numeric shape alone may not.
 */
export class SpatialGroundingLedger {
  private readonly points: GroundedPoint[] = [];

  record(toolName: string, result: unknown): void {
    if (!isGroundingTool(toolName)) return;
    const payload = unwrapResult(result);
    if (!isRecord(payload)) return;
    const blockName = toolName === 'locate_block' && typeof payload.block === 'string'
      ? normalize(payload.block)
      : undefined;
    const values = toolName === 'locate_block'
      ? payload.blocks
      : toolName === 'find_mineral'
        ? payload.minerals
        : payload.chests;
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (!isRecord(value) || !isPosition(value.position)) continue;
      this.points.push({
        position: value.position,
        ...(blockName ? { blockName } : {}),
        source: toolName,
      });
    }
  }

  validate(goalText: string, toolName: string, input: Record<string, unknown>): SpatialGroundingVerdict {
    if (!isResourceCollectionGoal(goalText)) return { ok: true };
    const target = spatialTarget(toolName, input);
    if (!target) return { ok: true };
    if (!isPosition(target.position)) return { ok: true };
    const position = target.position;
    const expectedBlock = target.blockName ? normalize(target.blockName) : undefined;
    const grounded = this.points.some(point => {
      if (expectedBlock && point.blockName && point.blockName !== expectedBlock) return false;
      return distance(point.position, position) <= target.radius;
    });
    return grounded
      ? { ok: true }
      : {
          ok: false,
          code: 'contract.ungrounded_position',
          detail: `resource action position (${position.x},${position.y},${position.z}) has no current locate evidence`,
        };
  }

  size(): number { return this.points.length; }
}

function spatialTarget(
  toolName: string,
  input: Record<string, unknown>,
): { position: unknown; blockName?: string; radius: number } | null {
  if (toolName === 'invoke_behavior') {
    if (input.behavior !== 'gather_block' || !isRecord(input.params)) return null;
    return {
      position: input.params.pos,
      ...(typeof input.params.blockName === 'string' ? { blockName: input.params.blockName } : {}),
      radius: 1.75,
    };
  }
  if (toolName !== 'invoke_atomic' || !isRecord(input.args)) return null;
  const atomic = typeof input.atomic === 'string' ? input.atomic : '';
  if (!['dig', 'mine_to', 'move_to', 'goto_position'].includes(atomic)) return null;
  return { position: input.args.position, radius: atomic === 'dig' ? 1.75 : 3 };
}

function isResourceCollectionGoal(goalText: string): boolean {
  return /(采集|挖掘|收集|寻找.*(?:木|石|矿)|gather|collect|mine)/i.test(goalText);
}

function isGroundingTool(value: string): value is GroundedPoint['source'] {
  return value === 'locate_block' || value === 'find_mineral' || value === 'find_chest_with';
}

function unwrapResult(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 2; depth += 1) {
    if (!isRecord(current) || !('result' in current)) break;
    current = current.result;
  }
  return current;
}

function isPosition(value: unknown): value is Position {
  if (!isRecord(value)) return false;
  return ['x', 'y', 'z'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/^minecraft:/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
