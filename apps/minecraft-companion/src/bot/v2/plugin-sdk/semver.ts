/**
 * Minimal SemVer handling for the plugin contract surface.
 * Scope: format validation, major-version equality and exact-range matching used
 * by the first-phase apiVersion gate. Range resolution belongs to the dependency
 * resolver (kernel design §5.5), not here.
 */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export interface ParsedSemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
  readonly build?: string;
}

export function parseSemVer(value: string): ParsedSemVer | null {
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] !== undefined ? { prerelease: match[4] } : {}),
    ...(match[5] !== undefined ? { build: match[5] } : {}),
  };
}

export function isValidSemVer(value: string): boolean {
  return parseSemVer(value) !== null;
}

/**
 * First-phase apiVersion compatibility: host and plugin must share the API major.
 * (Kernel design §5.2: "首期要求主版本相同且 Host 版本满足范围".)
 */
export function apiVersionCompatible(hostApiVersion: string, declaredRange: string): boolean {
  const host = parseSemVer(hostApiVersion);
  if (!host) return false;
  for (const part of splitRangeParts(declaredRange)) {
    if (rangePartMatches(part, host)) return true;
  }
  return false;
}

/**
 * First-phase exact dependency range matching: supports `^x.y.z`, `~x.y.z`,
 * plain `x.y.z`, `x`, `x.y`, `*` and comma/pipe-separated alternatives.
 * Anything else fails closed (dependency_missing shape is decided by the resolver,
 * this function only answers "does the range admit the version").
 */
export function versionInRange(version: string, range: string): boolean {
  const parsed = parseSemVer(version);
  if (!parsed) return false;
  for (const part of splitRangeParts(range)) {
    if (rangePartMatches(part, parsed)) return true;
  }
  return false;
}

/** True when the declared range syntax is admissible (not necessarily satisfiable). */
export function isValidVersionRange(range: string): boolean {
  const parts = splitRangeParts(range);
  return parts.length > 0 && parts.every((part) => {
    if (part === '*' || part === 'x' || part === 'X') return true;
    if (part.startsWith('^')) return parseSemVer(part.slice(1)) !== null;
    if (part.startsWith('~')) return parseSemVer(part.slice(1)) !== null;
    return parseSemVer(part) !== null;
  });
}

function splitRangeParts(range: string): string[] {
  return range
    .split(',')
    .flatMap((part) => part.split('|'))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function rangePartMatches(part: string, version: ParsedSemVer): boolean {
  if (part === '*' || part === 'x' || part === 'X') return true;
  if (part.startsWith('^')) return caretMatches(part.slice(1), version);
  if (part.startsWith('~')) return tildeMatches(part.slice(1), version);
  return exactMatches(part, version);
}

function exactMatches(part: string, version: ParsedSemVer): boolean {
  const [majorRaw, minorRaw, patchRaw] = part.split('.');
  const major = Number(majorRaw);
  if (!Number.isInteger(major)) return false;
  if (major !== version.major) return false;
  if (minorRaw !== undefined) {
    const minor = Number(minorRaw);
    if (!Number.isInteger(minor) || minor !== version.minor) return false;
  }
  if (patchRaw !== undefined) {
    const patch = Number(patchRaw);
    if (!Number.isInteger(patch) || patch !== version.patch) return false;
  }
  return true;
}

function caretMatches(base: string, version: ParsedSemVer): boolean {
  const parsed = parseSemVer(base);
  if (!parsed) return false;
  if (parsed.major > 0) return version.major === parsed.major;
  if (parsed.minor > 0) return version.major === 0 && version.minor >= parsed.minor;
  return version.major === 0 && version.minor === parsed.minor && version.patch >= parsed.patch;
}

function tildeMatches(base: string, version: ParsedSemVer): boolean {
  const parsed = parseSemVer(base);
  if (!parsed) return false;
  if (version.major !== parsed.major) return false;
  if (version.minor !== parsed.minor) return false;
  return version.patch >= parsed.patch;
}
