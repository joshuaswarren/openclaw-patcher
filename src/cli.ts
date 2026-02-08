import type { PatchManager } from "./patch-manager.js";
import { compileHandler, compileAllHandlers, getKnownHooks } from "./handler-compiler.js";
import path from "node:path";

interface CliApi {
  registerCli(
    handler: (opts: { program: CliProgram }) => void,
    options: { commands: string[] },
  ): void;
}

interface CliProgram {
  command(name: string): CliCommand;
}

interface CliCommand {
  description(desc: string): CliCommand;
  option(flags: string, desc: string, defaultValue?: string): CliCommand;
  argument(name: string, desc: string): CliCommand;
  action(fn: (...args: unknown[]) => Promise<void> | void): CliCommand;
  command(name: string): CliCommand;
}

export function registerCli(api: CliApi, manager: PatchManager): void {
  api.registerCli(
    ({ program }) => {
      const cmd = program
        .command("patcher")
        .description("Manage patches applied to OpenClaw installation files");

      // --- list ---
      cmd
        .command("list")
        .description("List all patches and their current status")
        .action(async () => {
          const statuses = await manager.checkAll();

          if (statuses.length === 0) {
            console.log("No patches found. Use 'openclaw patcher add <name>' to create one.");
            return;
          }

          console.log("\n=== Patches ===\n");
          for (const s of statuses) {
            const icon = stateIcon(s.state);
            console.log(`  ${icon} ${s.name} [${s.state}]`);
            console.log(`     ${s.message}`);
            if (s.meta.description) {
              console.log(`     ${s.meta.description}`);
            }
            if (s.meta.issue) {
              console.log(`     Issue: ${s.meta.issue}`);
            }
            console.log();
          }
        });

      // --- apply ---
      cmd
        .command("apply")
        .argument("[name]", "Specific patch name to apply (omit for all)")
        .description("Apply a specific patch or all pending patches")
        .action(async (name?: string) => {
          if (name) {
            const result = await manager.applyPatch(name);
            const icon = stateIcon(result.state);
            console.log(`${icon} ${result.name}: ${result.state} - ${result.message}`);
          } else {
            const results = await manager.applyAll();
            if (results.length === 0) {
              console.log("No patches found.");
              return;
            }
            console.log("\n=== Patch Results ===\n");
            for (const r of results) {
              const icon = stateIcon(r.state);
              console.log(`  ${icon} ${r.name}: ${r.state} - ${r.message}`);
            }
          }
        });

      // --- check ---
      cmd
        .command("check")
        .description("Check which patches are still needed")
        .action(async () => {
          const statuses = await manager.checkAll();

          if (statuses.length === 0) {
            console.log("No patches found.");
            return;
          }

          console.log("\n=== Patch Check ===\n");
          const pending = statuses.filter((s) => s.state === "pending");
          const applied = statuses.filter((s) => s.state === "applied");
          const resolved = statuses.filter((s) => s.state === "resolved");
          const errors = statuses.filter((s) => s.state === "error");
          const disabled = statuses.filter((s) => s.state === "disabled");

          if (pending.length > 0) {
            console.log(`  Pending (need apply): ${pending.map((s) => s.name).join(", ")}`);
          }
          if (applied.length > 0) {
            console.log(`  Applied: ${applied.map((s) => s.name).join(", ")}`);
          }
          if (resolved.length > 0) {
            console.log(`  Resolved (no longer needed): ${resolved.map((s) => s.name).join(", ")}`);
          }
          if (errors.length > 0) {
            console.log(`  Errors: ${errors.map((s) => `${s.name} (${s.message})`).join(", ")}`);
          }
          if (disabled.length > 0) {
            console.log(`  Disabled: ${disabled.map((s) => s.name).join(", ")}`);
          }
          console.log();
        });

      // --- add ---
      cmd
        .command("add")
        .argument("<name>", "Name for the new patch (e.g., cron-scheduler-fix)")
        .option("-t, --type <type>", "Patch type: js or diff", "js")
        .description("Scaffold a new patch directory with template files")
        .action(async (name: string, options?: Record<string, string>) => {
          const type = (options?.type ?? "js") as "js" | "diff";
          const dir = await manager.scaffoldPatch(name, type);
          console.log(`\nCreated patch scaffold at:\n  ${dir}/\n`);
          console.log("Files created:");
          console.log("  patch.json  - Metadata (edit targetFiles, description, issue)");
          console.log(`  patch.${type === "js" ? "js" : "diff"}    - Patch logic (implement your fix)`);
          console.log("\nNext steps:");
          console.log("  1. Edit patch.json to set targetFiles and description");
          console.log(`  2. Edit patch.${type === "js" ? "js" : "diff"} to implement your fix`);
          console.log("  3. Run 'openclaw patcher check' to verify detection");
          console.log("  4. Run 'openclaw patcher apply' to apply");
        });

      // --- status ---
      cmd
        .command("status")
        .description("Show current version, last-patched version, and patch states")
        .action(async () => {
          const summary = await manager.getStatusSummary();

          console.log("\n=== Patcher Status ===\n");
          console.log(`  OpenClaw version:     ${summary.installedVersion ?? "unknown"}`);
          console.log(`  Last patched version: ${summary.lastPatchedVersion ?? "never"}`);
          console.log(`  Last patched at:      ${summary.lastPatchedAt ?? "never"}`);
          console.log(`  Total patches:        ${summary.patchCount}`);

          if (summary.statuses.length > 0) {
            console.log("\n  Patch states:");
            for (const s of summary.statuses) {
              console.log(`    ${stateIcon(s.state)} ${s.name}: ${s.state}`);
            }
          }
          console.log();
        });

      // --- import-pr ---
      cmd
        .command("import-pr")
        .argument("<pr-number>", "GitHub PR number to import")
        .option("-r, --repo <repo>", "Repository (owner/name)", "openclaw/openclaw")
        .option("-t, --type <type>", "Patch type: js or diff", "diff")
        .option("-n, --name <name>", "Override patch name (default: pr-{number})")
        .option("--dry-run", "Show what would be created without writing")
        .description("Import a GitHub PR as a local patch")
        .action(async (prNumberStr: string, options?: Record<string, string | boolean>) => {
          const prNumber = parseInt(prNumberStr, 10);
          if (isNaN(prNumber) || prNumber <= 0) {
            console.error(`Invalid PR number: ${prNumberStr}`);
            return;
          }

          const repo = (options?.repo as string) ?? "openclaw/openclaw";
          const type = ((options?.type as string) ?? "diff") as "js" | "diff";
          const name = options?.name as string | undefined;
          const dryRun = Boolean(options?.dryRun ?? options?.["dry-run"]);

          console.log(`\nImporting PR #${prNumber} from ${repo}...`);
          if (dryRun) {
            console.log("(dry run - no files will be created)\n");
          }

          const result = await manager.scaffoldFromPR({
            prNumber,
            repo,
            type,
            name,
            dryRun,
          });

          if (result.success) {
            console.log(`\n[+] ${result.message}\n`);

            if (result.filesCreated.length > 0) {
              console.log("Files created:");
              for (const file of result.filesCreated) {
                console.log(`  ${file}`);
              }
            }

            if (result.unmappedHunks.length > 0) {
              console.log(`\n[!] ${result.unmappedHunks.length} hunk(s) could not be mapped:`);
              for (const hunk of result.unmappedHunks) {
                console.log(`  - ${hunk.sourcePath}: ${hunk.reason}`);
                console.log(`    Pattern: ${hunk.oldText.slice(0, 60)}...`);
              }
            }

            if (!dryRun) {
              console.log("\nNext steps:");
              console.log("  1. Review the generated patch files");
              console.log("  2. Run 'openclaw patcher check' to verify detection");
              console.log("  3. Run 'openclaw patcher apply' to apply the patch");
            }
          } else {
            console.error(`\n[x] ${result.message}`);
            if (result.unmappedHunks.length > 0) {
              console.log("\nUnmapped hunks:");
              for (const hunk of result.unmappedHunks) {
                console.log(`  - ${hunk.sourcePath}: ${hunk.reason}`);
              }
            }
          }
          console.log();
        });

      // --- compile-hooks ---
      cmd
        .command("compile-hooks")
        .argument("[hook-name]", "Specific hook to compile (omit for all)")
        .option("--ref <ref>", "Git ref to fetch from (branch, tag, or commit)", "main")
        .option("--dry-run", "Show what would be compiled without writing")
        .description("Compile bundled hook handlers from GitHub source")
        .action(async (hookName?: string, options?: Record<string, string | boolean>) => {
          const ref = (options?.ref as string) ?? "main";
          const dryRun = Boolean(options?.dryRun ?? options?.["dry-run"]);

          // Output to a temp location first, then we can move to a patch
          const outputDir = path.join(process.cwd(), ".compiled-hooks");

          if (hookName) {
            console.log(`\nCompiling ${hookName} handler from GitHub (ref: ${ref})...`);
            if (dryRun) {
              console.log("(dry run - no files will be created)\n");
            }

            const result = await compileHandler(hookName, outputDir, { ref, dryRun });

            if (result.success) {
              console.log(`\n[+] Successfully compiled ${hookName}`);
              if (result.outputPath) {
                console.log(`    Output: ${result.outputPath}`);
              }
            } else {
              console.error(`\n[x] Failed to compile ${hookName}: ${result.error}`);
            }
          } else {
            console.log(`\nCompiling all bundled hooks from GitHub (ref: ${ref})...`);
            console.log(`Known hooks: ${getKnownHooks().join(", ")}\n`);
            if (dryRun) {
              console.log("(dry run - no files will be created)\n");
            }

            const { success, results } = await compileAllHandlers(outputDir, { ref, dryRun });

            console.log("\n=== Compilation Results ===\n");
            for (const [name, result] of Object.entries(results)) {
              if (result.success) {
                console.log(`  [+] ${name}: compiled`);
              } else {
                console.log(`  [x] ${name}: ${result.error}`);
              }
            }

            if (success) {
              console.log(`\nAll handlers compiled to: ${outputDir}/`);
              console.log("\nTo use these handlers:");
              console.log("  1. Create an asset patch with 'openclaw patcher add bundled-hooks-fix --type asset'");
              console.log("  2. Copy handlers to the patch's assets/ directory");
              console.log("  3. Configure assets in patch.json to copy them to dist/bundled/");
            }
          }
          console.log();
        });

      // --- fix-bundled-hooks ---
      cmd
        .command("fix-bundled-hooks")
        .option("--ref <ref>", "Git ref to fetch from (branch, tag, or commit)", "main")
        .option("--dry-run", "Show what would be done without making changes")
        .description("Create a complete patch for PR #9295 (bundled hooks fix)")
        .action(async (options?: Record<string, string | boolean>) => {
          const ref = (options?.ref as string) ?? "main";
          const dryRun = Boolean(options?.dryRun ?? options?.["dry-run"]);

          console.log("\n=== Creating Bundled Hooks Fix ===\n");
          console.log("This will create a patch that:");
          console.log("  1. Creates symlink dist/bundled -> dist/hooks/bundled");
          console.log("  2. Compiles and injects handler.js files for all bundled hooks");
          console.log(`\nFetching handlers from GitHub (ref: ${ref})...\n`);

          if (dryRun) {
            console.log("(dry run - no files will be created)\n");
          }

          const patchName = "bundled-hooks-fix";
          const patchDir = path.join(process.cwd(), "patches", patchName);
          const assetsDir = path.join(patchDir, "assets");

          // Compile handlers
          const { success, results } = await compileAllHandlers(assetsDir, { ref, dryRun });

          if (!success) {
            console.error("\n[x] Some handlers failed to compile:");
            for (const [name, result] of Object.entries(results)) {
              if (!result.success) {
                console.error(`    ${name}: ${result.error}`);
              }
            }
            console.log("\nPatch not created due to compilation errors.");
            return;
          }

          if (dryRun) {
            console.log("[+] All handlers would compile successfully");
            console.log(`\nPatch would be created at: ${patchDir}/`);
            return;
          }

          // Create patch.json
          const patchMeta = {
            name: patchName,
            description: "Fix bundled hooks broken since 2026.2.2 (PR #9295) - creates symlink and injects compiled handlers",
            issue: "https://github.com/openclaw/openclaw/pull/9295",
            enabled: true,
            targetFiles: [],
            type: "asset",
            assets: [
              { src: "dist/hooks/bundled", dest: "dist/bundled", type: "symlink" },
              ...getKnownHooks().map(hook => ({
                src: `${hook}/handler.js`,
                dest: `dist/bundled/${hook}/handler.js`,
                type: "copy" as const,
              })),
            ],
            minVersion: "2026.2.2",
            appliedAt: null,
            appliedVersion: null,
            resolvedAt: null,
            resolvedReason: null,
          };

          const fs = await import("node:fs/promises");
          await fs.mkdir(patchDir, { recursive: true });
          await fs.writeFile(
            path.join(patchDir, "patch.json"),
            JSON.stringify(patchMeta, null, 2),
          );

          console.log("\n[+] Patch created successfully!\n");
          console.log(`Patch directory: ${patchDir}/`);
          console.log("\nFiles:");
          console.log("  patch.json");
          for (const hook of getKnownHooks()) {
            console.log(`  assets/${hook}/handler.js`);
          }
          console.log("\nNext steps:");
          console.log("  1. Run 'openclaw patcher check' to verify");
          console.log("  2. Run 'openclaw patcher apply bundled-hooks-fix' to apply");
          console.log();
        });
    },
    { commands: ["patcher"] },
  );
}

function stateIcon(state: string): string {
  switch (state) {
    case "pending":
      return "[!]";
    case "applied":
      return "[+]";
    case "resolved":
      return "[~]";
    case "disabled":
      return "[-]";
    case "error":
      return "[x]";
    default:
      return "[?]";
  }
}
