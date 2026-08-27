import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import {
  ResourcePackError,
  type ResourcePackDescriptor,
  type ResourcePackImportInput,
  type ResourcePackLimits,
} from './types.js';

interface ZipEntryIndex {
  path: string;
  compressedBytes: number;
  expandedBytes: number;
  directory: boolean;
}

export interface InspectedResourcePack {
  descriptor: ResourcePackDescriptor;
  files: Map<string, Uint8Array>;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const MAX_EOCD_SEARCH_BYTES = 65_557;

export function inspectResourcePack(
  input: ResourcePackImportInput,
  limits: ResourcePackLimits,
  now = new Date(),
): InspectedResourcePack {
  if (input.archive.byteLength > limits.maxPackBytes) {
    throw new ResourcePackError('PACK_TOO_LARGE', `archive exceeds ${limits.maxPackBytes} bytes`);
  }
  validateMinecraftVersion(input.minecraftVersion);
  const indexed = inspectCentralDirectory(input.archive, limits);

  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(input.archive);
  } catch (error) {
    throw new ResourcePackError(
      'PACK_INVALID_ARCHIVE',
      `archive cannot be decompressed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const unpackedByNormalizedPath = new Map<string, Uint8Array>();
  for (const [rawPath, bytes] of Object.entries(unpacked)) {
    const normalizedPath = normalizePackPath(rawPath);
    if (unpackedByNormalizedPath.has(normalizedPath)) {
      throw new ResourcePackError('PACK_INVALID_ARCHIVE', `duplicate normalized path: ${normalizedPath}`);
    }
    unpackedByNormalizedPath.set(normalizedPath, bytes);
  }

  const files = new Map<string, Uint8Array>();
  for (const entry of indexed) {
    if (entry.directory) continue;
    const bytes = unpackedByNormalizedPath.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.expandedBytes) {
      throw new ResourcePackError('PACK_INVALID_ARCHIVE', `archive entry size mismatch: ${entry.path}`);
    }
    if (entry.path.toLowerCase().endsWith('.png')) validatePng(entry.path, bytes, limits.maxImageDimension);
    files.set(entry.path, bytes);
  }

  const metadataBytes = files.get('pack.mcmeta');
  if (!metadataBytes) throw new ResourcePackError('PACK_MISSING_METADATA', 'pack.mcmeta is required');
  const metadata = parseMetadata(metadataBytes);
  const declaredMinecraftVersion = readDeclaredVersion(metadata);
  if (declaredMinecraftVersion && declaredMinecraftVersion !== input.minecraftVersion) {
    throw new ResourcePackError(
      'PACK_VERSION_MISMATCH',
      `resource pack targets ${declaredMinecraftVersion}, requested ${input.minecraftVersion}`,
    );
  }

  const metadataLicense = readString(metadata, ['mineclaw', 'license']);
  const licenseId = cleanOptional(input.licenseId) ?? metadataLicense;
  const distributable = input.distributable === true;
  if (input.source === 'mineclaw-original' && (!distributable || !licenseId)) {
    throw new ResourcePackError(
      'PACK_LICENSE_REQUIRED',
      'mineclaw-original packs must be distributable and declare a license',
    );
  }

  const sha256 = createHash('sha256').update(input.archive).digest('hex');
  const expandedBytes = indexed.reduce((sum, entry) => sum + entry.expandedBytes, 0);
  const descriptor: ResourcePackDescriptor = {
    id: `pack-${sha256.slice(0, 16)}`,
    sha256,
    fileName: safeFileName(input.fileName),
    title: readPackTitle(metadata),
    minecraftVersion: input.minecraftVersion,
    declaredMinecraftVersion,
    versionVerified: declaredMinecraftVersion === input.minecraftVersion,
    packFormat: readPackFormat(metadata),
    source: input.source,
    licenseId: licenseId ?? null,
    distributable,
    entryCount: files.size,
    archiveBytes: input.archive.byteLength,
    expandedBytes,
    importedAt: now.toISOString(),
  };
  return { descriptor, files };
}

export function normalizePackPath(raw: string): string {
  if (!raw || raw.includes('\0')) {
    throw new ResourcePackError('PACK_UNSAFE_PATH', 'resource pack path is empty or contains NUL');
  }
  const normalized = raw.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new ResourcePackError('PACK_UNSAFE_PATH', `absolute resource pack path is forbidden: ${raw}`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '..')) {
    throw new ResourcePackError('PACK_UNSAFE_PATH', `parent traversal is forbidden: ${raw}`);
  }
  const compact = segments.filter(segment => segment !== '' && segment !== '.').join('/');
  if (!compact) throw new ResourcePackError('PACK_UNSAFE_PATH', `invalid resource pack path: ${raw}`);
  return normalized.endsWith('/') ? `${compact}/` : compact;
}

function inspectCentralDirectory(archive: Uint8Array, limits: ResourcePackLimits): ZipEntryIndex[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocdOffset = findEocd(view);
  if (eocdOffset < 0) throw new ResourcePackError('PACK_INVALID_ARCHIVE', 'zip end record was not found');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralBytes = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ResourcePackError('PACK_ZIP64_UNSUPPORTED', 'zip64 resource packs are not supported');
  }
  if (entryCount > limits.maxPackEntries) {
    throw new ResourcePackError('PACK_TOO_MANY_ENTRIES', `archive has ${entryCount} entries`);
  }
  if (centralOffset + centralBytes > archive.byteLength) {
    throw new ResourcePackError('PACK_INVALID_ARCHIVE', 'central directory exceeds archive bounds');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: ZipEntryIndex[] = [];
  let cursor = centralOffset;
  let expandedTotal = 0;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > archive.byteLength || view.getUint32(cursor, true) !== CENTRAL_FILE_SIGNATURE) {
      throw new ResourcePackError('PACK_INVALID_ARCHIVE', 'invalid central directory entry');
    }
    const versionMadeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const expandedBytes = view.getUint32(cursor + 24, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    if ((flags & 0x1) !== 0) {
      throw new ResourcePackError('PACK_ENCRYPTED_UNSUPPORTED', 'encrypted resource packs are not supported');
    }
    const nameStart = cursor + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > archive.byteLength) throw new ResourcePackError('PACK_INVALID_ARCHIVE', 'entry name exceeds archive bounds');
    let decoded: string;
    try {
      decoded = decoder.decode(archive.subarray(nameStart, nameEnd));
    } catch {
      throw new ResourcePackError('PACK_INVALID_ARCHIVE', 'entry name is not valid UTF-8');
    }
    const path = normalizePackPath(decoded);
    const unixOrigin = (versionMadeBy >> 8) === 3;
    const unixMode = externalAttributes >>> 16;
    if (unixOrigin && (unixMode & 0o170000) === 0o120000) {
      throw new ResourcePackError('PACK_SYMLINK_UNSUPPORTED', `symbolic link is forbidden: ${path}`);
    }
    if (expandedBytes > limits.maxPackFileBytes) {
      throw new ResourcePackError('PACK_ENTRY_TOO_LARGE', `${path} exceeds ${limits.maxPackFileBytes} bytes`);
    }
    expandedTotal += expandedBytes;
    if (expandedTotal > limits.maxExpandedPackBytes) {
      throw new ResourcePackError('PACK_EXPANDED_TOO_LARGE', `expanded archive exceeds ${limits.maxExpandedPackBytes} bytes`);
    }
    const ratio = compressedBytes === 0 ? (expandedBytes === 0 ? 1 : Number.POSITIVE_INFINITY) : expandedBytes / compressedBytes;
    if (ratio > limits.maxCompressionRatio) {
      throw new ResourcePackError('PACK_COMPRESSION_RATIO_TOO_HIGH', `${path} compression ratio is ${ratio.toFixed(1)}`);
    }
    entries.push({ path, compressedBytes, expandedBytes, directory: path.endsWith('/') });
    cursor = nameEnd + extraLength + commentLength;
  }
  if (cursor > centralOffset + centralBytes) {
    throw new ResourcePackError('PACK_INVALID_ARCHIVE', 'central directory length mismatch');
  }
  return entries;
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - MAX_EOCD_SEARCH_BYTES);
  for (let cursor = view.byteLength - 22; cursor >= min; cursor--) {
    if (view.getUint32(cursor, true) === EOCD_SIGNATURE) return cursor;
  }
  return -1;
}

function validatePng(path: string, bytes: Uint8Array, maxDimension: number): void {
  if (bytes.byteLength < 24) throw new ResourcePackError('PACK_INVALID_IMAGE', `${path} is not a complete PNG`);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((value, index) => bytes[index] !== value)) {
    throw new ResourcePackError('PACK_INVALID_IMAGE', `${path} has an invalid PNG signature`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension) {
    throw new ResourcePackError('PACK_INVALID_IMAGE', `${path} dimensions ${width}x${height} exceed policy`);
  }
}

function parseMetadata(bytes: Uint8Array): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root is not an object');
    readPackFormat(parsed as Record<string, unknown>);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ResourcePackError) throw error;
    throw new ResourcePackError(
      'PACK_INVALID_METADATA',
      `pack.mcmeta is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readPackFormat(metadata: Record<string, unknown>): number {
  const pack = metadata.pack;
  const format = pack && typeof pack === 'object' && !Array.isArray(pack)
    ? (pack as Record<string, unknown>).pack_format
    : undefined;
  if (!Number.isInteger(format) || (format as number) < 1) {
    throw new ResourcePackError('PACK_INVALID_METADATA', 'pack.pack_format must be a positive integer');
  }
  return format as number;
}

function readPackTitle(metadata: Record<string, unknown>): string {
  const pack = metadata.pack;
  const description = pack && typeof pack === 'object' && !Array.isArray(pack)
    ? (pack as Record<string, unknown>).description
    : undefined;
  if (typeof description === 'string' && description.trim()) return description.trim().slice(0, 160);
  if (description && typeof description === 'object' && !Array.isArray(description)) {
    const text = (description as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 160);
  }
  return 'Minecraft Resource Pack';
}

function readDeclaredVersion(metadata: Record<string, unknown>): string | null {
  return readString(metadata, ['mineclaw', 'game_version'])
    ?? readString(metadata, ['mineclaw', 'minecraftVersion'])
    ?? null;
}

function readString(root: Record<string, unknown>, path: string[]): string | undefined {
  let value: unknown = root;
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validateMinecraftVersion(version: string): void {
  if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9._-]+)?$/.test(version)) {
    throw new ResourcePackError('PACK_INVALID_METADATA', `invalid Minecraft version: ${version}`);
  }
}

function safeFileName(fileName: string): string {
  const base = fileName.replaceAll('\\', '/').split('/').at(-1)?.trim() || 'resource-pack.zip';
  return base.slice(0, 160);
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
