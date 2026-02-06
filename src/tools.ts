import { Type } from "@sinclair/typebox";
import type { PatchManager } from "./patch-manager.js";

interface ToolApi {
  registerTool(
    spec: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        details: undefined;
      }>;
    },
    options: { name: string },
  ): void;
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export function registerTools(api: ToolApi, manager: PatchManager): void {
  api.registerTool(
    {
      name: "patcher_status",
      label: "Patcher Status",
      description: `Check the status of all patches managed by openclaw-patcher.

Returns: Installed version, last patched version, and the state of each patch.
Cost: Free (local file read)
Speed: Fast

Best for:
- Checking if patches need to be applied after an update
- Verifying which patches are still needed
- Reporting on patch health`,
      parameters: Type.Object({}),
      async execute() {
        const summary = await manager.getStatusSummary();

        const lines: string[] = [
          `## Patcher Status`,
          ``,
          `- **OpenClaw version:** ${summary.installedVersion ?? "unknown"}`,
          `- **Last patched version:** ${summary.lastPatchedVersion ?? "never"}`,
          `- **Last patched at:** ${summary.lastPatchedAt ?? "never"}`,
          `- **Total patches:** ${summary.patchCount}`,
          ``,
        ];

        if (summary.statuses.length > 0) {
          lines.push("### Patches\n");
          for (const s of summary.statuses) {
            const icon = s.state === "pending" ? "!" : s.state === "applied" ? "+" : s.state === "resolved" ? "~" : "x";
            lines.push(`- **[${icon}] ${s.name}** \`${s.state}\` - ${s.message}`);
            if (s.meta.description) lines.push(`  ${s.meta.description}`);
            if (s.meta.issue) lines.push(`  Issue: ${s.meta.issue}`);
          }
        } else {
          lines.push("No patches found.");
        }

        return toolResult(lines.join("\n"));
      },
    },
    { name: "patcher_status" },
  );

  api.registerTool(
    {
      name: "patcher_apply",
      label: "Apply Patches",
      description: `Apply pending patches to OpenClaw installation files.

Returns: Results for each patch (applied, already applied, resolved, or error).
Cost: Free (local file modification)
Speed: Fast

Best for:
- Re-applying patches after an OpenClaw update
- Applying a specific patch by name
- Fixing issues that require patched code`,
      parameters: Type.Object({
        name: Type.Optional(
          Type.String({
            description: "Specific patch name to apply. Omit to apply all pending patches.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { name } = params as { name?: string };

        if (name) {
          const result = await manager.applyPatch(name);
          return toolResult(
            `## Patch: ${result.name}\n\n` +
            `- **State:** ${result.state}\n` +
            `- **Message:** ${result.message}`,
          );
        }

        const results = await manager.applyAll();
        if (results.length === 0) {
          return toolResult("No patches found. Create patches in the patches/ directory.");
        }

        const lines = ["## Patch Results\n"];
        for (const r of results) {
          lines.push(`- **${r.name}:** \`${r.state}\` - ${r.message}`);
        }

        return toolResult(lines.join("\n"));
      },
    },
    { name: "patcher_apply" },
  );
}
