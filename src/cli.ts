import type { PatchManager } from "./patch-manager.js";

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
