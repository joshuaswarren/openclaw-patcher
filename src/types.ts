/** Metadata for a single patch, stored as patch.json */
export interface PatchMeta {
  name: string;
  description: string;
  issue?: string;
  enabled: boolean;
  targetFiles: string[];
  type: "js" | "diff";
  /** Minimum OpenClaw version this patch applies to (inclusive). Uses semver comparison. */
  minVersion?: string;
  /** Maximum OpenClaw version this patch applies to (exclusive). Uses semver comparison. */
  maxVersion?: string;
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
