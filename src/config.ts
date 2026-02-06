import path from "node:path";
import type { PatcherConfig } from "./types.js";

const PLUGIN_DIR = path.dirname(path.dirname(import.meta.url.replace("file://", "")));

export function parseConfig(raw: Record<string, unknown>): PatcherConfig {
  const pluginDir = getPluginDir();
  return {
    openclawInstallDir: asString(raw.openclawInstallDir, "/opt/homebrew/lib/node_modules/openclaw"),
    patchesDir: asString(raw.patchesDir, path.join(pluginDir, "patches")),
    autoApplyOnStart: asBool(raw.autoApplyOnStart, true),
    backupBeforePatch: asBool(raw.backupBeforePatch, true),
    debug: asBool(raw.debug, false),
  };
}

function getPluginDir(): string {
  // import.meta.url will be something like file:///path/to/dist/index.js
  // We want the plugin root directory
  const distDir = path.dirname(import.meta.url.replace("file://", ""));
  return path.dirname(distDir);
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
