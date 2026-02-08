/** Asset operation for injecting files into the installation */
export interface AssetOperation {
  /** Source path relative to patch's assets/ directory */
  src: string;
  /** Destination path relative to OpenClaw install directory */
  dest: string;
  /** Operation type: copy file, create symlink, or create directory */
  type: "copy" | "symlink" | "mkdir";
}

/** Metadata for a single patch, stored as patch.json */
export interface PatchMeta {
  name: string;
  description: string;
  issue?: string;
  enabled: boolean;
  targetFiles: string[];
  type: "js" | "diff" | "asset";
  /** Minimum OpenClaw version this patch applies to (inclusive). Uses semver comparison. */
  minVersion?: string;
  /** Maximum OpenClaw version this patch applies to (exclusive). Uses semver comparison. */
  maxVersion?: string;
  /** Asset operations - copy files, create symlinks, or make directories */
  assets?: AssetOperation[];
  appliedAt: string | null;
  appliedVersion: string | null;
  resolvedAt: string | null;
  resolvedReason: string | null;
}

/** Runtime status for a patch after analysis */
export interface PatchStatus {
  name: string;
  meta: PatchMeta;
  dir: string;
  state: "pending" | "applied" | "resolved" | "error" | "disabled";
  message: string;
}

/** A JS-type patch module must export this shape */
export interface JsPatchModule {
  check(fileContent: string, filePath: string): boolean;
  isResolved(fileContent: string, filePath: string): boolean;
  apply(fileContent: string, filePath: string): string;
}

/** Plugin config after parsing */
export interface PatcherConfig {
  openclawInstallDir: string;
  patchesDir: string;
  autoApplyOnStart: boolean;
  backupBeforePatch: boolean;
  debug: boolean;
}

/** Version tracking state */
export interface PatcherState {
  lastPatchedVersion: string | null;
  lastPatchedAt: string | null;
  patchResults: Record<string, {
    state: string;
    message: string;
    appliedAt: string | null;
  }>;
}

// =============================================================================
// PR Import Types
// =============================================================================

/** Metadata for a GitHub Pull Request */
export interface PRMetadata {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  files: PRFile[];
}

/** A file changed in a PR */
export interface PRFile {
  path: string;
  status: string;
  /** The unified diff patch for this file */
  patch: string;
}

/** Options for importing a PR as a patch */
export interface PRImportOptions {
  prNumber: number;
  repo: string;
  type: "js" | "diff";
  name?: string;
  dryRun: boolean;
}

/** Result of importing a PR */
export interface PRImportResult {
  success: boolean;
  patchDir?: string;
  patchName: string;
  message: string;
  /** Hunks that couldn't be mapped to bundle files */
  unmappedHunks: UnmappedHunk[];
  /** Files created during import */
  filesCreated: string[];
}

/** A hunk that couldn't be located in the bundle files */
export interface UnmappedHunk {
  sourcePath: string;
  oldText: string;
  reason: string;
}
