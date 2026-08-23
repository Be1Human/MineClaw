import type { BenchmarkCheck, CheckKind } from './types.js';

export function check(input: {
  id: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  evidence: string | string[];
  weight?: number;
  critical?: boolean;
  kind?: CheckKind;
}): BenchmarkCheck {
  return {
    id: input.id,
    kind: input.kind ?? 'capability',
    passed: input.passed,
    weight: input.weight ?? 1,
    critical: input.critical ?? false,
    expected: input.expected,
    actual: input.actual,
    evidence: Array.isArray(input.evidence) ? input.evidence : [input.evidence],
  };
}

export function positionDistance(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function includesRecord(actual: Record<string, unknown> | undefined, expected: Record<string, string>): boolean {
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}
