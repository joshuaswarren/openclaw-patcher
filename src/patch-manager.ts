import fs from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import { fetchPR } from "./github.js";
import {
  parsePRFilePatch,
  findPatternsInBundles,
  hunksToSimpleFormat,
  findMinimalPattern,
  type DiffHunk as PRDiffHunk,
} from "./diff-converter.js";
import type {
  AssetOperation,
  JsPatchModule,
  PatcherConfig,
  PatcherState,
  PatchMeta,
  PatchStatus,
  PRImportOptions,
  PRImportResult,
  UnmappedHunk,
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

    // Check version targeting
    const currentVersion = await this.getInstalledVersion();
    if (currentVersion) {
      const versionMatch = matchVersionRange(currentVersion, meta.minVersion, meta.maxVersion);
      if (!versionMatch.matches) {
        return {
          name: patchName,
          meta,
          dir,
          state: "disabled",
          message: versionMatch.reason,
        };
      }
    }

    // Asset patches don't need targetFiles
    if (meta.type === "asset") {
      return this.checkAssetPatch(patchName, meta, dir);
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

  /** Check an asset-type patch (file/directory/symlink injection) */
  private async checkAssetPatch(
    patchName: string,
    meta: PatchMeta,
    dir: string,
  ): Promise<PatchStatus> {
    if (!meta.assets || meta.assets.length === 0) {
      return {
        name: patchName,
        meta,
        dir,
        state: "error",
        message: "No assets defined in patch.json",
      };
    }

    let allApplied = true;
    let anyMissing = false;

    for (const asset of meta.assets) {
      const destPath = path.join(this.config.openclawInstallDir, asset.dest);
      try {
        const stats = await fs.lstat(destPath);
        if (asset.type === "symlink") {
          if (!stats.isSymbolicLink()) {
            anyMissing = true;
          }
        } else if (asset.type === "mkdir") {
          if (!stats.isDirectory()) {
            anyMissing = true;
          }
        } else {
          // copy - check if file exists
          if (!stats.isFile()) {
            anyMissing = true;
          }
        }
      } catch {
        anyMissing = true;
        allApplied = false;
      }
    }

    if (anyMissing) {
      return { name: patchName, meta, dir, state: "pending", message: "Asset(s) missing" };
    }

    return { name: patchName, meta, dir, state: "applied", message: "All assets in place" };
  }

  /** Apply asset operations (copy files, create symlinks, make directories) */
  private async applyAssetOperations(
    patchName: string,
    meta: PatchMeta,
    patchDir: string,
  ): Promise<void> {
    if (!meta.assets || meta.assets.length === 0) {
      throw new Error("No assets defined");
    }

    const assetsDir = path.join(patchDir, "assets");

    for (const asset of meta.assets) {
      const destPath = path.join(this.config.openclawInstallDir, asset.dest);

      if (asset.type === "mkdir") {
        await fs.mkdir(destPath, { recursive: true });
        log.info(`created directory: ${destPath}`);
      } else if (asset.type === "symlink") {
        // For symlinks, src is the target path (can be relative or absolute)
        const targetPath = asset.src.startsWith("/")
          ? asset.src
          : path.join(this.config.openclawInstallDir, asset.src);

        // Remove existing file/symlink if present
        try {
          await fs.unlink(destPath);
        } catch {
          // Ignore - file doesn't exist
        }

        // Ensure parent directory exists
        await fs.mkdir(path.dirname(destPath), { recursive: true });

        // Create symlink (relative to dest's parent directory)
        const relativeTarget = path.relative(path.dirname(destPath), targetPath);
        await fs.symlink(relativeTarget, destPath);
        log.info(`created symlink: ${destPath} -> ${relativeTarget}`);
      } else {
        // copy - src is relative to assets/ directory
        const srcPath = path.join(assetsDir, asset.src);

        // Check if source exists
        try {
          await fs.access(srcPath);
        } catch {
          throw new Error(`Asset source not found: ${srcPath}`);
        }

        // Ensure parent directory exists
        await fs.mkdir(path.dirname(destPath), { recursive: true });

        // Check if source is a directory
        const srcStats = await fs.stat(srcPath);
        if (srcStats.isDirectory()) {
          // Recursively copy directory
          await this.copyDir(srcPath, destPath);
          log.info(`copied directory: ${srcPath} -> ${destPath}`);
        } else {
          // Copy single file
          await fs.copyFile(srcPath, destPath);
          log.info(`copied file: ${srcPath} -> ${destPath}`);
        }
      }
    }
  }

  /** Recursively copy a directory */
  private async copyDir(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
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
    const version = await this.getInstalledVersion();

    let appliedCount = 0;

    try {
      if (meta.type === "asset") {
        // Apply asset operations
        await this.applyAssetOperations(patchName, meta, status.dir);
        appliedCount = meta.assets?.length ?? 0;
      } else {
        // Apply file patches
        const targetFiles = await this.resolveTargetFiles(meta.targetFiles);
        appliedCount = targetFiles.length;

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

      const itemType = meta.type === "asset" ? "asset(s)" : "file(s)";
      return {
        ...status,
        state: "applied",
        message: `Applied ${appliedCount} ${itemType}`,
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
    const versionSkipped = results.filter(
      (r) => r.state === "disabled" && r.message.includes("Version"),
    );
    const manuallyDisabled = results.filter(
      (r) => r.state === "disabled" && r.message === "Patch is disabled",
    );

    if (applied.length > 0) {
      log.info(`applied ${applied.length} patch(es): ${applied.map((r) => r.name).join(", ")}`);
    }
    if (alreadyApplied.length > 0) {
      log.debug(`${alreadyApplied.length} patch(es) already applied`);
    }
    if (versionSkipped.length > 0) {
      log.debug(
        `${versionSkipped.length} patch(es) skipped (version mismatch): ${versionSkipped.map((r) => r.name).join(", ")}`,
      );
    }
    if (manuallyDisabled.length > 0) {
      log.debug(`${manuallyDisabled.length} patch(es) manually disabled`);
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
      minVersion: undefined,  // Optional: minimum version (inclusive), e.g., "2026.2.6"
      maxVersion: undefined,  // Optional: maximum version (exclusive), e.g., "2026.3.0"
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

  /**
   * Import a GitHub PR as a patch
   *
   * This fetches the PR from GitHub, parses the diffs, searches the bundle
   * files for the patterns, and creates a diff-type patch.
   */
  async scaffoldFromPR(options: PRImportOptions): Promise<PRImportResult> {
    const { prNumber, repo, type, dryRun } = options;
    const patchName = options.name ?? `pr-${prNumber}`;

    log.info(`importing PR #${prNumber} from ${repo} as "${patchName}"...`);

    // Check if patch already exists
    const patchDir = path.join(this.config.patchesDir, patchName);
    try {
      await fs.access(patchDir);
      return {
        success: false,
        patchName,
        message: `Patch "${patchName}" already exists. Use --name to specify a different name.`,
        unmappedHunks: [],
        filesCreated: [],
      };
    } catch {
      // Directory doesn't exist, which is what we want
    }

    // Fetch PR from GitHub
    let prData;
    try {
      prData = await fetchPR(prNumber, repo);
    } catch (err) {
      return {
        success: false,
        patchName,
        message: err instanceof Error ? err.message : String(err),
        unmappedHunks: [],
        filesCreated: [],
      };
    }

    // Parse all file patches into hunks
    const allHunks: PRDiffHunk[] = [];
    const originalDiffs: string[] = [];

    for (const file of prData.files) {
      if (!file.patch) {
        log.debug(`skipping ${file.path} (no patch content)`);
        continue;
      }

      // Only process TypeScript/JavaScript source files
      if (!file.path.endsWith(".ts") && !file.path.endsWith(".js")) {
        log.debug(`skipping ${file.path} (not a TS/JS file)`);
        continue;
      }

      originalDiffs.push(`--- a/${file.path}\n+++ b/${file.path}\n${file.patch}`);
      const hunks = parsePRFilePatch(file.patch, file.path);
      allHunks.push(...hunks);
    }

    if (allHunks.length === 0) {
      return {
        success: false,
        patchName,
        message: "No applicable code changes found in PR (no TS/JS files with patches)",
        unmappedHunks: [],
        filesCreated: [],
      };
    }

    log.info(`parsed ${allHunks.length} hunk(s) from ${prData.files.length} file(s)`);

    // Find patterns in bundle files
    const bundleDir = path.join(this.config.openclawInstallDir, "dist");
    const patterns = allHunks.map((h) => findMinimalPattern(h.oldText));
    const patternToFile = await findPatternsInBundles(patterns, bundleDir);

    // Separate mapped and unmapped hunks
    const mappedHunks: PRDiffHunk[] = [];
    const unmappedHunks: UnmappedHunk[] = [];
    const targetFiles = new Set<string>();

    for (let i = 0; i < allHunks.length; i++) {
      const hunk = allHunks[i];
      const pattern = patterns[i];
      const bundleFile = patternToFile.get(pattern);

      if (bundleFile) {
        mappedHunks.push(hunk);
        // Store relative path for targetFiles
        const relativePath = path.relative(this.config.openclawInstallDir, bundleFile);
        targetFiles.add(relativePath);
      } else {
        unmappedHunks.push({
          sourcePath: hunk.sourcePath,
          oldText: hunk.oldText.slice(0, 100) + (hunk.oldText.length > 100 ? "..." : ""),
          reason: "Pattern not found in any bundle file",
        });
      }
    }

    if (mappedHunks.length === 0) {
      return {
        success: false,
        patchName,
        message: `None of the ${allHunks.length} hunk(s) could be mapped to bundle files. ` +
                 "The PR may target code that doesn't exist in the installed version.",
        unmappedHunks,
        filesCreated: [],
      };
    }

    if (dryRun) {
      return {
        success: true,
        patchName,
        message: `[DRY RUN] Would create patch "${patchName}" with ${mappedHunks.length} hunk(s) ` +
                 `targeting ${targetFiles.size} file(s). ${unmappedHunks.length} hunk(s) unmapped.`,
        unmappedHunks,
        filesCreated: [
          path.join(patchDir, "patch.json"),
          path.join(patchDir, type === "js" ? "patch.js" : "patch.diff"),
          path.join(patchDir, "pr-original.diff"),
        ],
      };
    }

    // Create the patch directory and files
    await fs.mkdir(patchDir, { recursive: true });
    const filesCreated: string[] = [];

    // Create patch.json metadata
    const meta: PatchMeta = {
      name: patchName,
      description: prData.title,
      issue: prData.url,
      enabled: true,
      targetFiles: Array.from(targetFiles).map((f) => f.replace(/gateway-cli-[^.]+\.js/, "gateway-cli-*.js")),
      type,
      appliedAt: null,
      appliedVersion: null,
      resolvedAt: null,
      resolvedReason: null,
    };

    const metaPath = path.join(patchDir, "patch.json");
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    filesCreated.push(metaPath);

    // Create patch file based on type
    if (type === "diff") {
      const diffContent = hunksToSimpleFormat(mappedHunks);
      const diffPath = path.join(patchDir, "patch.diff");
      await fs.writeFile(diffPath, diffContent, "utf-8");
      filesCreated.push(diffPath);
    } else {
      // For JS type, generate a template with the patterns filled in
      const jsContent = generateJsPatchFromHunks(mappedHunks);
      const jsPath = path.join(patchDir, "patch.js");
      await fs.writeFile(jsPath, jsContent, "utf-8");
      filesCreated.push(jsPath);
    }

    // Save the original unified diff for reference
    const originalDiffPath = path.join(patchDir, "pr-original.diff");
    await fs.writeFile(originalDiffPath, originalDiffs.join("\n\n"), "utf-8");
    filesCreated.push(originalDiffPath);

    log.info(`created patch "${patchName}" with ${mappedHunks.length} hunk(s)`);
    if (unmappedHunks.length > 0) {
      log.warn(`${unmappedHunks.length} hunk(s) could not be mapped and were skipped`);
    }

    return {
      success: true,
      patchDir,
      patchName,
      message: `Successfully created patch "${patchName}" from PR #${prNumber}`,
      unmappedHunks,
      filesCreated,
    };
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
// Version matching helper
// =============================================================================

interface VersionMatchResult {
  matches: boolean;
  reason: string;
}

/**
 * Compare two version strings (e.g., "2026.2.6" vs "2026.2.3").
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  // Handle versions with suffixes like "2026.2.3-1" by splitting on "-"
  const normalize = (v: string) => v.split("-")[0];
  const partsA = normalize(a).split(".").map(Number);
  const partsB = normalize(b).split(".").map(Number);

  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}

/**
 * Check if a version matches the given range (minVersion inclusive, maxVersion exclusive).
 */
function matchVersionRange(
  version: string,
  minVersion?: string,
  maxVersion?: string,
): VersionMatchResult {
  if (minVersion && compareVersions(version, minVersion) < 0) {
    return {
      matches: false,
      reason: `Version ${version} is below minimum ${minVersion}`,
    };
  }

  if (maxVersion && compareVersions(version, maxVersion) >= 0) {
    return {
      matches: false,
      reason: `Version ${version} is at or above maximum ${maxVersion}`,
    };
  }

  return { matches: true, reason: "Version in range" };
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

// =============================================================================
// PR Import Helpers
// =============================================================================

/**
 * Generate a JS-type patch module from parsed hunks
 */
function generateJsPatchFromHunks(hunks: PRDiffHunk[]): string {
  // Build pattern arrays for check/apply
  const replacements = hunks.map((h, i) => ({
    id: i + 1,
    old: escapeForJs(h.oldText),
    new: escapeForJs(h.newText),
  }));

  const checksCode = replacements
    .map((r) => `    // Hunk ${r.id}\n    content.includes(${r.old})`)
    .join(" ||\n");

  const appliesCode = replacements
    .map(
      (r) =>
        `  // Hunk ${r.id}\n  result = result.replace(\n    ${r.old},\n    ${r.new}\n  );`
    )
    .join("\n\n");

  return `// Auto-generated from PR import
// Review and adjust the patterns as needed for your OpenClaw version

export default {
  /**
   * Check if this patch is still needed.
   * Return true if the file contains the buggy code that needs patching.
   */
  check(fileContent, filePath) {
    const content = fileContent;
    return (
${checksCode}
    );
  },

  /**
   * Check if the upstream has fixed the issue (patch no longer needed).
   * Return true if the upstream fix is detected.
   */
  isResolved(fileContent, filePath) {
    // Check if new code is already present
    const content = fileContent;
    const newCodePresent = ${replacements.map((r) => `content.includes(${r.new})`).join(" &&\n      ")};
    return newCodePresent;
  },

  /**
   * Apply the patch to the file content.
   * Return the modified file content.
   */
  apply(fileContent, filePath) {
    let result = fileContent;

${appliesCode}

    return result;
  }
};
`;
}

/**
 * Escape a string for use as a JavaScript string literal
 */
function escapeForJs(str: string): string {
  // Use template literals for multi-line strings
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\${/g, "\\${");

  if (str.includes("\n")) {
    return "`" + escaped + "`";
  }

  return JSON.stringify(str);
}
