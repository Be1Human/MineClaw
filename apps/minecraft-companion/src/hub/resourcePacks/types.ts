export type ResourcePackSourceKind = 'local-import' | 'server-pack' | 'mineclaw-original';

export interface ResourcePackLimits {
  maxPackBytes: number;
  maxPackEntries: number;
  maxPackFileBytes: number;
  maxExpandedPackBytes: number;
  maxCompressionRatio: number;
  maxImageDimension: number;
}

export interface ResourcePackImportInput {
  archive: Uint8Array;
  fileName: string;
  minecraftVersion: string;
  source: ResourcePackSourceKind;
  licenseId?: string;
  distributable?: boolean;
}

export interface ResourcePackDescriptor {
  id: string;
  sha256: string;
  fileName: string;
  title: string;
  minecraftVersion: string;
  declaredMinecraftVersion: string | null;
  versionVerified: boolean;
  packFormat: number;
  source: ResourcePackSourceKind;
  licenseId: string | null;
  distributable: boolean;
  entryCount: number;
  archiveBytes: number;
  expandedBytes: number;
  importedAt: string;
}

export type ResourcePackErrorCode =
  | 'PACK_INVALID_ARCHIVE'
  | 'PACK_ZIP64_UNSUPPORTED'
  | 'PACK_ENCRYPTED_UNSUPPORTED'
  | 'PACK_TOO_LARGE'
  | 'PACK_TOO_MANY_ENTRIES'
  | 'PACK_ENTRY_TOO_LARGE'
  | 'PACK_EXPANDED_TOO_LARGE'
  | 'PACK_COMPRESSION_RATIO_TOO_HIGH'
  | 'PACK_UNSAFE_PATH'
  | 'PACK_SYMLINK_UNSUPPORTED'
  | 'PACK_MISSING_METADATA'
  | 'PACK_INVALID_METADATA'
  | 'PACK_VERSION_MISMATCH'
  | 'PACK_LICENSE_REQUIRED'
  | 'PACK_INVALID_IMAGE';

export class ResourcePackError extends Error {
  constructor(
    readonly code: ResourcePackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ResourcePackError';
  }
}
