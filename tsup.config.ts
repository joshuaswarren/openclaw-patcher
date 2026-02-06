import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  external: ["openclaw"],
  banner: {
    js: "// openclaw-patcher: Auto-apply patches after OpenClaw updates",
  },
});
