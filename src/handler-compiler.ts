/**
 * Handler Compiler
 *
 * Fetches bundled hook handler sources from GitHub and compiles them
 * using esbuild to create standalone handler.js files.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { log } from "./logger.js";

const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/openclaw/openclaw/main";

/** Known bundled hooks and their dependencies */
const BUNDLED_HOOKS: Record<string, { handler: string; deps: string[] }> = {
  "session-memory": {
    handler: "src/hooks/bundled/session-memory/handler.ts",
    deps: ["src/hooks/llm-slug-generator.ts"],
  },
  "command-logger": {
    handler: "src/hooks/bundled/command-logger/handler.ts",
    deps: [],
  },
  "boot-md": {
    handler: "src/hooks/bundled/boot-md/handler.ts",
    deps: [],
  },
  "soul-evil": {
    handler: "src/hooks/bundled/soul-evil/handler.ts",
    deps: [],
  },
};

/**
 * Fetch a file from GitHub raw content
 */
async function fetchFromGitHub(filePath: string, ref: string = "main"): Promise<string> {
  const url = `https://raw.githubusercontent.com/openclaw/openclaw/${ref}/${filePath}`;
  log.debug(`fetching ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${filePath}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Compile a bundled hook handler from source
 */
export async function compileHandler(
  hookName: string,
  outputDir: string,
  options: { ref?: string; dryRun?: boolean } = {},
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const { ref = "main", dryRun = false } = options;

  const hookInfo = BUNDLED_HOOKS[hookName];
  if (!hookInfo) {
    return {
      success: false,
      error: `Unknown hook: ${hookName}. Known hooks: ${Object.keys(BUNDLED_HOOKS).join(", ")}`,
    };
  }

  const tempDir = path.join(outputDir, ".tmp-compile");

  try {
    // Create temp directory for source files
    if (!dryRun) {
      await fs.mkdir(tempDir, { recursive: true });
    }

    // Fetch handler source
    log.info(`fetching ${hookName} handler from GitHub (ref: ${ref})...`);
    const handlerSource = await fetchFromGitHub(hookInfo.handler, ref);

    if (dryRun) {
      log.info(`[DRY RUN] Would compile ${hookInfo.handler}`);
      return { success: true };
    }

    // Write handler source to temp file
    const handlerPath = path.join(tempDir, "handler.ts");
    await fs.writeFile(handlerPath, handlerSource);

    // Fetch and write dependencies
    for (const dep of hookInfo.deps) {
      const depSource = await fetchFromGitHub(dep, ref);
      const depName = path.basename(dep);
      await fs.writeFile(path.join(tempDir, depName), depSource);
    }

    // Transform imports to work with the bundled OpenClaw installation
    // The key insight: we need to mark internal imports as external and
    // let the runtime resolve them from the installed openclaw package
    const transformedSource = transformImports(handlerSource, hookName);
    await fs.writeFile(handlerPath, transformedSource);

    // Bundle with esbuild
    log.info(`compiling ${hookName} handler...`);
    const outfile = path.join(outputDir, hookName, "handler.js");
    await fs.mkdir(path.dirname(outfile), { recursive: true });

    await build({
      entryPoints: [handlerPath],
      bundle: true,
      platform: "node",
      target: "es2022",
      format: "esm",
      outfile,
      // Mark all openclaw internal imports as external
      external: [
        "../../../*",
        "../../*",
        "../*",
        "node:*",
        "fs",
        "path",
        "os",
      ],
      // Don't minify for readability
      minify: false,
      // Write shim for dynamic imports
      banner: {
        js: `// Compiled by openclaw-patcher from ${hookInfo.handler}\n`,
      },
    });

    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });

    log.info(`compiled handler: ${outfile}`);
    return { success: true, outputPath: outfile };

  } catch (error) {
    // Clean up on error
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    const msg = error instanceof Error ? error.message : String(error);
    log.error(`failed to compile ${hookName}: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Transform imports in handler source to work standalone
 *
 * The handlers import from relative paths like "../../../config/config.js"
 * which don't exist in the installed package structure.
 *
 * We need to rewrite these to import from the installed openclaw package.
 */
function transformImports(source: string, hookName: string): string {
  // For now, we'll use a stub approach - replace internal imports with
  // dynamic imports that resolve at runtime from the openclaw package

  // The handlers primarily need:
  // - HookHandler type (can be inlined as any for runtime)
  // - createSubsystemLogger
  // - resolveAgentWorkspaceDir
  // - generateSlugViaLLM (for session-memory)
  // - isAgentBootstrapEvent, isSubagentSessionKey (for soul-evil)

  let transformed = source;

  // Remove type-only imports (they're not needed at runtime)
  transformed = transformed.replace(/^import type .+$/gm, "// [removed type import]");

  // Replace value imports with stubs
  // This is a simplified approach - a full solution would inject proper shims
  const stubImports = `
// Stubs for openclaw internal imports (injected by patcher)
const createSubsystemLogger = (name) => ({
  info: (...args) => console.log(\`[\${name}]\`, ...args),
  warn: (...args) => console.warn(\`[\${name}]\`, ...args),
  error: (...args) => console.error(\`[\${name}]\`, ...args),
  debug: (...args) => {},
});

const resolveAgentWorkspaceDir = async (config, agentId) => {
  return config?.workspace?.dir || process.env.HOME + "/.openclaw/workspace";
};

const resolveAgentIdFromSessionKey = (sessionKey) => {
  const parts = sessionKey?.split(":") || [];
  return parts[1] || "main";
};

const resolveHookConfig = (config, hookName) => {
  return config?.hooks?.internal?.entries?.[hookName] || {};
};

const generateSlugViaLLM = async (content, config) => {
  // Fallback to timestamp if LLM not available
  return new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
};

// Soul-evil specific stubs
const isAgentBootstrapEvent = (event) => event?.type === "agent_bootstrap";
const isSubagentSessionKey = (sessionKey) => sessionKey?.includes(":subagent:");
const applySoulEvilOverride = async (workspaceDir, bootstrapFiles, soulConfig) => {
  // Soul-evil override logic would go here
  console.log("[soul-evil] Override not implemented in patched handler");
};
const resolveSoulEvilConfigFromHook = (hookConfig, logger) => {
  if (!hookConfig) return null;
  return {
    evilSoulPath: hookConfig.evilSoulPath || null,
    purgeWindow: hookConfig.purgeWindow || null,
    randomChance: hookConfig.randomChance || 0,
  };
};
`;

  // Remove the original imports and add stubs
  transformed = transformed.replace(
    /^import \{ [^}]+ \} from ["'][^"']+["'];?\s*$/gm,
    "// [removed import - using stubs]"
  );

  // Add stubs at the top (after any shebang or initial comments)
  const insertPoint = transformed.search(/^(?!\/\/|\/\*|\s*$)/m);
  if (insertPoint >= 0) {
    transformed = transformed.slice(0, insertPoint) + stubImports + "\n" + transformed.slice(insertPoint);
  }

  return transformed;
}

/**
 * Compile all bundled handlers
 */
export async function compileAllHandlers(
  outputDir: string,
  options: { ref?: string; dryRun?: boolean } = {},
): Promise<{ success: boolean; results: Record<string, { success: boolean; error?: string }> }> {
  const results: Record<string, { success: boolean; error?: string }> = {};
  let allSuccess = true;

  for (const hookName of Object.keys(BUNDLED_HOOKS)) {
    const result = await compileHandler(hookName, outputDir, options);
    results[hookName] = { success: result.success, error: result.error };
    if (!result.success) {
      allSuccess = false;
    }
  }

  return { success: allSuccess, results };
}

/**
 * Get list of known bundled hooks
 */
export function getKnownHooks(): string[] {
  return Object.keys(BUNDLED_HOOKS);
}
