import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { initLogger, log } from "./logger.js";
import { PatchManager } from "./patch-manager.js";
import { registerTools } from "./tools.js";
import { registerCli } from "./cli.js";

export default {
  id: "openclaw-patcher",
  name: "Patcher",
  description:
    "Automatically re-apply user-defined patches to OpenClaw files after version updates.",
  kind: "utility" as const,

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    initLogger(api.logger, cfg.debug);

    const manager = new PatchManager(cfg);

    // ========================================================================
    // Register tools and CLI
    // ========================================================================
    registerTools(api as unknown as Parameters<typeof registerTools>[0], manager);
    registerCli(api as unknown as Parameters<typeof registerCli>[0], manager);

    // ========================================================================
    // Register service — auto-apply runs on service start
    // ========================================================================
    api.registerService({
      id: "openclaw-patcher",
      start: async () => {
        log.info("patcher service started");

        if (!cfg.autoApplyOnStart) {
          log.debug("auto-apply disabled; skipping patch check");
          return;
        }

        try {
          await manager.runAutoApply();
        } catch (err) {
          log.error("auto-apply failed on service start", err);
        }
      },
      stop: () => {
        log.info("patcher service stopped");
      },
    });
  },
};
