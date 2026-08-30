import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface StoredWindowState extends WindowBounds {
  maximized: boolean;
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_STATE: StoredWindowState = Object.freeze({
  width: 1280,
  height: 800,
  maximized: false,
});

export const MINIMUM_WINDOW_SIZE = Object.freeze({ width: 900, height: 600 });

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function intersects(left: Required<WindowBounds>, right: WorkArea): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

export function normalizeWindowState(raw: unknown, workAreas: WorkArea[]): StoredWindowState {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const maximumWidth = Math.max(MINIMUM_WINDOW_SIZE.width, ...workAreas.map(area => area.width));
  const maximumHeight = Math.max(MINIMUM_WINDOW_SIZE.height, ...workAreas.map(area => area.height));
  const width = Math.round(clamp(
    finiteNumber(value.width) ?? DEFAULT_WINDOW_STATE.width,
    MINIMUM_WINDOW_SIZE.width,
    maximumWidth,
  ));
  const height = Math.round(clamp(
    finiteNumber(value.height) ?? DEFAULT_WINDOW_STATE.height,
    MINIMUM_WINDOW_SIZE.height,
    maximumHeight,
  ));
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const bounds = x === undefined || y === undefined
    ? null
    : { x: Math.round(x), y: Math.round(y), width, height };
  const visible = bounds && (workAreas.length === 0 || workAreas.some(area => intersects(bounds, area)));

  return {
    ...(visible && bounds ? { x: bounds.x, y: bounds.y } : {}),
    width,
    height,
    maximized: value.maximized === true,
  };
}

export function loadWindowState(path: string, workAreas: WorkArea[]): StoredWindowState {
  try {
    return normalizeWindowState(JSON.parse(readFileSync(path, 'utf8')), workAreas);
  } catch {
    return normalizeWindowState(DEFAULT_WINDOW_STATE, workAreas);
  }
}

export function saveWindowState(path: string, state: StoredWindowState): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}
