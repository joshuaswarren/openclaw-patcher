import fs from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import type {
  JsPatchModule,
  PatcherConfig,
  PatcherState,
  PatchMeta,
  PatchStatus,
} from "./types.js";

export class PatchManager {
  private config: PatcherConfig;
  private state: PatcherState;
  private stateFile: string;

  constructor(config: PatcherConfig) {
    this.config = config;
    this.stateFile = path.join(config.patchesDir, ".patcher-state.json");
    this.state = {
      lastPatchedVersion: null,
      lastPatchedAt: null,
      patchResults: {},
    };
  }

  /** Load persisted state from disk */
  async loadState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateFile, "utf-8");
      this.state = JSON.parse(raw) as PatcherState;
      log.debug(`loaded state: lastPatchedVersion=${this.state.lastPatchedVersion}`);
    } catch {
      log.debug("no existing state file, starting fresh");
    }
  }

  /** Save state to disk */
  async saveState(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2), "utf-8");
  }

  /** Get the currently installed OpenClaw version */
  async getInstalledVersion(): Promise<string | null> {
    try {
      const pkgPath = path.join(this.config.openclawInstallDir, "package.json");
      const raw = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as { version?: string };
      return pkg.version ?? null;
    } catch (err) {
      log.error("failed to read OpenClaw package.json", err);
      return null;
    }
  }

  /** Discover all patch directories */
  async discoverPatches(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.config.patchesDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      log.debug("patches directory does not exist or is empty");
      return [];
    }
  }

  /** Read a single patch's metadata */
  async readPatchMeta(patchName: string): Promise<PatchMeta | null> {
    const metaPath = path.join(this.config.patchesDir, patchName, "patch.json");
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(raw) as PatchMeta;
    } catch {
      log.warn(`could not read patch.json for "${patchName}"`);
      return null;
    }
  }

  /** Write updated patch metadata */
  async writePatchMeta(patchName: string, meta: PatchMeta): Promise<void> {
    const metaPath = path.join(this.config.patchesDir, patchName, "patch.json");
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }

  /** Resolve glob-like target file patterns to actual file paths */
  async resolveTargetFiles(patterns: string[]): Promise<string[]> {
    const results: string[] = [];
    for (const pattern of patterns) {
      const dir = path.dirname(pattern);
      const filePattern = path.basename(pattern);
      const searchDir = path.join(this.config.openclawInstallDir, dir);

      try {
        const entries = await fs.readdir(searchDir);
        for (const entry of entries) {
          if (matchGlob(entry, filePattern)) {
            results.push(path.join(searchDir, entry));
          }
        }
      } catch {
        log.debug(`directory not found for pattern "${pattern}": ${searchDir}`);
      }
    }
    return results;
  }

  /** Check the status of a single patch against target files */
  async checkPatch(patchName: string): Promise<PatchStatus> {
    const dir = path.join(this.config.patchesDir, patchName);
    const meta = await this.readPatchMeta(patchName);

    if (!meta) {
      return {
        name: patchName,
        meta: {} as PatchMeta,
        dir,
        state: "error",
        message: "Missing or invalid patch.json",
      };
    }

    if (!meta.enabled) {
      return { name: patchName, meta, dir, state: "disabled", message: "Patch is disabled" };
    }

    if (meta.resolvedAt) {
      return {
        name: patchName,
        meta,
        dir,
        state: "resolved",
        message: meta.resolvedReason ?? "Resolved upstream",
      };
    }

    const targetFiles = await this.resolveTargetFiles(meta.targetFiles);
    if (targetFiles.length === 0) {
      return {
        name: patchName,
        meta,
        dir,
        state: "error",
        message: `No files matched patterns: ${meta.targetFiles.join(", ")}`,
      };
    }

    if (meta.type === "js") {
      return this.checkJsPatch(patchName, meta, dir, targetFiles);
    } else {
      return this.checkDiffPatch(patchName, meta, dir, targetFiles);
    }
  }

  /** Check a JS-type patch */
  private async checkJsPatch(
    patchName: string,
    meta: PatchMeta,
    dir: string,
    targetFiles: string[],
  ): Promise<PatchStatus> {
    try {
      const patchModule = await this.loadJsPatchModule(patchName);
      if (!patchModule) {
        return { name: patchName, meta, dir, state: "error", message: "Could not load patch.js" };
      }

      for (const filePath of targetFiles) {
        const content = await fs.readFile(filePath, "utf-8");

        if (patchModule.isResolved(content, filePath)) {
          return { name: patchName, meta, dir, state: "resolved", message: "Upstream fix detected" };
        }

        if (patchModule.check(content, filePath)) {
          return { name: patchName, meta, dir, state: "pending", message: "Patch needed" };
        }
      }

      return { name: patchName, meta, dir, state: "applied", message: "Already applied" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { name: patchName, meta, dir, state: "error", message: `Check failed: ${msg}` };
    }
  }

  /** Check a diff-type patch (simple string matching) */
  private async checkDiffPatch(
    patchName: string,
    meta: PatchMeta,
    dir: string,
    targetFiles: string[],
  ): Promise<PatchStatus> {
    try {
      const diffPath = path.join(dir, "patch.diff");
      const diffContent = await fs.readFile(diffPath, "utf-8");
      const hunks = parseDiffHunks(diffContent);

      if (hunks.length === 0) {
        return { name: patchName, meta, dir, state: "error", message: "No valid hunks in patch.diff" };
      }

      for (const filePath of targetFiles) {
        const content = await fs.readFile(filePath, "utf-8");

        // Check if the new text (replacement) is already present => applied
        const allNewPresent = hunks.every((h) => content.includes(h.newText));
        if (allNewPresent) {
          return { name: patchName, meta, dir, state: "applied", message: "Already applied" };
        }

        // Check if old text is present => patch needed
        const allOldPresent = hunks.every((h) => content.includes(h.oldText));
        if (allOldPresent) {
          return { name: patchName, meta, dir, state: "pending", message: "Patch needed" };
        }

        // Neither old nor new text found => resolved upstream
        return {
          name: patchName,
          meta,
          dir,
          state: "resolved",
          message: "Original code no longer present; upstream may have fixed this",
        };
      }

      return { name: patchName, meta, dir, state: "error", message: "No target files to check" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { name: patchName, meta, dir, state: "error", message: `Check failed: ${msg}` };
    }
  }

  /** Apply a single patch */
  async applyPatch(patchName: string): Promise<PatchStatus> {
    const status = await this.checkPatch(patchName);

    if (status.state !== "pending") {
      return status;
    }

    const { meta } = status;
    const targetFiles = await this.resolveTargetFiles(meta.targetFiles);
    const version = await this.getInstalledVersion();

    try {
      for (const filePath of targetFiles) {
        const content = await fs.readFile(filePath, "utf-8");

        // Backup if enabled
        if (this.config.backupBeforePatch) {
          await fs.writeFile(`${filePath}.bak`, content, "utf-8");
          log.debug(`backed up ${filePath}`);
        }

        let patched: string;
        if (meta.type === "js") {
          const patchModule = await this.loadJsPatchModule(patchName);
          if (!patchModule) {
            return { ...status, state: "error", message: "Could not load patch.js for apply" };
          }
          patched = patchModule.apply(content, filePath);
        } else {
          const diffPath = path.join(status.dir, "patch.diff");
          const diffContent = await fs.readFile(diffPath, "utf-8");
          patched = applyDiffHunks(content, parseDiffHunks(diffContent));
        }

        await fs.writeFile(filePath, patched, "utf-8");
        log.info(`patched ${filePath}`);
      }

      // Update patch metadata
      meta.appliedAt = new Date().toISOString();
      meta.appliedVersion = version;
      await this.writePatchMeta(patchName, meta);

      // Update state
      this.state.patchResults[patchName] = {
        state: "applied",
        message: "Applied successfully",
        appliedAt: meta.appliedAt,
      };
      await this.saveState();

      return {
        ...status,
        state: "applied",
        message: `Applied to ${targetFiles.length} file(s)`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`failed to apply patch "${patchName}": ${msg}`);
      return { ...status, state: "error", message: `Apply failed: ${msg}` };
    }
  }

  /** Apply all active patches */
  async applyAll(): Promise<PatchStatus[]> {
    const patchNames = await this.discoverPatches();
    const results: PatchStatus[] = [];

    for (const name of patchNames) {
      const status = await this.applyPatch(name);
      results.push(status);

      if (status.state === "resolved") {
        const meta = await this.readPatchMeta(name);
        if (meta && !meta.resolvedAt) {
          meta.resolvedAt = new Date().toISOString();
          meta.resolvedReason = status.message;
          await this.writePatchMeta(name, meta);
          log.warn(
            `=== PATCH RESOLVED: "${name}" ===\n` +
            `  Reason: ${status.message}\n` +
            `  Issue: ${meta.issue ?? "N/A"}\n` +
            `  This patch is no longer needed and has been marked as resolved.`,
          );
        }
      }
    }

    return results;
  }

  /** Check all patches without applying */
  async checkAll(): Promise<PatchStatus[]> {
    const patchNames = await this.discoverPatches();
    const results: PatchStatus[] = [];

    for (const name of patchNames) {
      results.push(await this.checkPatch(name));
    }

    return results;
  }

  /** Run the auto-apply workflow triggered on gateway_start */
  async runAutoApply(): Promise<void> {
    await this.loadState();
    const version = await this.getInstalledVersion();

    if (!version) {
      log.warn("could not determine OpenClaw version; skipping auto-apply");
      return;
    }

    const patchNames = await this.discoverPatches();
    if (patchNames.length === 0) {
      log.debug("no patches found; nothing to do");
      return;
    }

    log.info(`checking ${patchNames.length} patch(es) against OpenClaw v${version}...`);

    const results = await this.applyAll();

    const applied = results.filter((r) => r.state === "applied" && r.message.includes("Applied"));
    const resolved = results.filter((r) => r.state === "resolved");
    const errors = results.filter((r) => r.state === "error");
    const alreadyApplied = results.filter(
      (r) => r.state === "applied" && r.message === "Already applied",
    );

    if (applied.length > 0) {
      log.info(`applied ${applied.length} patch(es): ${applied.map((r) => r.name).join(", ")}`);
    }
    if (alreadyApplied.length > 0) {
      log.debug(`${alreadyApplied.length} patch(es) already applied`);
    }
    if (resolved.length > 0) {
      log.warn(
        `${resolved.length} patch(es) resolved (no longer needed): ${resolved.map((r) => r.name).join(", ")}`,
      );
    }
    if (errors.length > 0) {
      log.error(
        `${errors.length} patch(es) had errors: ${errors.map((r) => `${r.name}: ${r.message}`).join("; ")}`,
      );
    }

    // Update global state
    this.state.lastPatchedVersion = version;
    this.state.lastPatchedAt = new Date().toISOString();
    await this.saveState();
  }

  /** Scaffold a new patch directory with template files */
  async scaffoldPatch(name: string, type: "js" | "diff" = "js"): Promise<string> {
    const dir = path.join(this.config.patchesDir, name);
    await fs.mkdir(dir, { recursive: true });

    const meta: PatchMeta = {
      name,
      description: "TODO: describe what this patch fixes",
      issue: "",
      enabled: true,
      targetFiles: ["dist/gateway-cli-*.js"],
      type,
      appliedAt: null,
      appliedVersion: null,
      resolvedAt: null,
      resolvedReason: null,
    };

    await fs.writeFile(path.join(dir, "patch.json"), JSON.stringify(meta, null, 2), "utf-8");

    if (type === "js") {
      await fs.writeFile(
        path.join(dir, "patch.js"),
        JS_PATCH_TEMPLATE,
        "utf-8",
      );
    } else {
      await fs.writeFile(
        path.join(dir, "patch.diff"),
        DIFF_PATCH_TEMPLATE,
        "utf-8",
      );
    }

    return dir;
  }

  /** Get summary for status display */
  async getStatusSummary(): Promise<{
    installedVersion: string | null;
    lastPatchedVersion: string | null;
    lastPatchedAt: string | null;
    patchCount: number;
    statuses: PatchStatus[];
  }> {
    await this.loadState();
    const version = await this.getInstalledVersion();
    const statuses = await this.checkAll();

    return {
      installedVersion: version,
      lastPatchedVersion: this.state.lastPatchedVersion,
      lastPatchedAt: this.state.lastPatchedAt,
      patchCount: statuses.length,
      statuses,
    };
  }

  /** Load a JS patch module dynamically */
  private async loadJsPatchModule(patchName: string): Promise<JsPatchModule | null> {
    const patchPath = path.join(this.config.patchesDir, patchName, "patch.js");
    try {
      // Use a cache-busting query to reload the module each time
      const mod = await import(`file://${patchPath}?t=${Date.now()}`);
      return (mod.default ?? mod) as JsPatchModule;
    } catch (err) {
      log.error(`failed to load patch.js for "${patchName}"`, err);
      return null;
    }
  }
}

// =============================================================================
// Diff parsing helpers
// =============================================================================

interface DiffHunk {
  oldText: string;
  newText: string;
}

/** Parse a simplified diff format:
 *  Lines starting with "---" are old text, "+++" are new text.
 *  Or use a simple BEFORE/AFTER block format.
 */
function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];

  // Support a simple block format:
  // === BEFORE ===
  // <old text>
  // === AFTER ===
  // <new text>
  // === END ===
  const blockRegex = /=== BEFORE ===\n([\s\S]*?)\n=== AFTER ===\n([\s\S]*?)\n=== END ===/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(diff)) !== null) {
    hunks.push({
      oldText: match[1],
      newText: match[2],
    });
  }

  return hunks;
}

function applyDiffHunks(content: string, hunks: DiffHunk[]): string {
  let result = content;
  for (const hunk of hunks) {
    if (result.includes(hunk.oldText)) {
      result = result.replace(hunk.oldText, hunk.newText);
    }
  }
  return result;
}

// =============================================================================
// Glob matching helper (basic wildcards only)
// =============================================================================

function matchGlob(filename: string, pattern: string): boolean {
  // Convert simple glob (* and ?) to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(filename);
}

// =============================================================================
// Templates
// =============================================================================

const JS_PATCH_TEMPLATE = `// Patch module template
// Modify the check, isResolved, and apply functions for your specific patch.

export default {
  /**
   * Check if this patch is still needed.
   * Return true if the file contains the buggy code that needs patching.
   */
  check(fileContent, filePath) {
    // Example: return true if buggy code is present and fix is NOT present
    return fileContent.includes('BUGGY_CODE_MARKER') &&
           !fileContent.includes('FIX_MARKER');
  },

  /**
   * Check if the upstream has fixed the issue (patch no longer needed).
   * Return true if the upstream fix is detected.
   */
  isResolved(fileContent, filePath) {
    // Example: return true if upstream introduced a proper fix
    return fileContent.includes('UPSTREAM_FIX_MARKER');
  },

  /**
   * Apply the patch to the file content.
   * Return the modified file content.
   */
  apply(fileContent, filePath) {
    let result = fileContent;
    // Example: result = result.replace('BUGGY_CODE', 'FIXED_CODE');
    return result;
  }
};
`;

const DIFF_PATCH_TEMPLATE = `=== BEFORE ===
OLD_CODE_TO_REPLACE
=== AFTER ===
NEW_REPLACEMENT_CODE
=== END ===
`;
