# openclaw-patcher

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Automatically re-apply patches to OpenClaw's installed files after every version update.**

When you apply a hotfix to an OpenClaw source file (e.g., patching a cron scheduler bug in the bundled gateway), `npm update openclaw` overwrites your changes. openclaw-patcher solves this by storing your patches as code and re-applying them automatically on every gateway start.

---

## How It Works

1. You create a **patch directory** inside `patches/` with a metadata file (`patch.json`) and a patch implementation (`patch.js` or `patch.diff`).
2. On every `gateway_start`, the plugin checks the installed OpenClaw version, detects which patches are still needed, and applies them.
3. When an upstream release fixes the issue your patch addresses, the plugin detects this, marks the patch as **resolved**, and stops applying it.

No more manual patching after updates. No more forgetting which files you changed.

---

## Installation

### 1. Clone into extensions

```bash
cd ~/.openclaw/extensions
git clone https://github.com/joshuaswarren/openclaw-patcher.git
cd openclaw-patcher
npm install && npm run build
```

### 2. Register the plugin

Add `"openclaw-patcher"` to the `plugins.allow` array and add an entry under `plugins.entries` in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-patcher"],
    "entries": {
      "openclaw-patcher": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

### 3. Restart the gateway

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

---

## Creating a Patch

### Quick start

```bash
openclaw patcher add my-fix-name
```

This scaffolds a new patch directory:

```
patches/my-fix-name/
  patch.json   # metadata
  patch.js     # patch logic (JS type)
```

### Patch metadata (`patch.json`)

```json
{
  "name": "cron-scheduler-fix",
  "description": "Fix cron scheduler stall after SIGUSR1 restart (PR #10350)",
  "issue": "https://github.com/openclaw/openclaw/pull/10350",
  "enabled": true,
  "targetFiles": ["dist/gateway-cli-*.js"],
  "type": "js",
  "appliedAt": null,
  "appliedVersion": null,
  "resolvedAt": null,
  "resolvedReason": null
}
```

| Field | Description |
|-------|-------------|
| `name` | Unique identifier for the patch |
| `description` | Human-readable description of what the patch fixes |
| `issue` | Link to the upstream issue or PR |
| `enabled` | Set to `false` to disable without deleting |
| `targetFiles` | Glob patterns relative to the OpenClaw install directory |
| `type` | `"js"` for programmatic patches, `"diff"` for text-replace patches |
| `appliedAt` | Timestamp of last successful application (auto-set) |
| `appliedVersion` | OpenClaw version the patch was last applied to (auto-set) |
| `resolvedAt` | Timestamp when the patch was detected as no longer needed (auto-set) |
| `resolvedReason` | Why the patch was resolved (auto-set) |
| `minVersion` | Minimum OpenClaw version (inclusive) for patch to apply |
| `maxVersion` | Maximum OpenClaw version (exclusive) for patch to apply |

### JS patches (`patch.js`)

JS patches give you full programmatic control. Export an object with three methods:

```javascript
export default {
  // Return true if the buggy code is present and the fix is NOT applied
  check(fileContent, filePath) {
    return fileContent.includes('if (state.running) return;') &&
           !fileContent.includes('resetStoreLock');
  },

  // Return true if upstream has shipped a proper fix
  isResolved(fileContent, filePath) {
    return fileContent.includes('skipRecompute') &&
           fileContent.includes('resetStoreLock');
  },

  // Return the patched file content
  apply(fileContent, filePath) {
    return fileContent.replace(
      'if (state.running) return;',
      'if (state.running) { resetStoreLock(); return; }'
    );
  }
};
```

### Diff patches (`patch.diff`)

For simple text replacements, use the block diff format:

```
=== BEFORE ===
if (state.running) return;
=== AFTER ===
if (state.running) { resetStoreLock(); return; }
=== END ===
```

Multiple hunks are supported -- just add more BEFORE/AFTER/END blocks.

---

## Asset Patches (`type: "asset"`)

Asset patches inject files, create symlinks, or make directories. Use them when a fix requires:

- Creating missing files or directories
- Fixing path mismatches with symlinks
- Injecting pre-built assets that weren't compiled

### patch.json for asset patches

```json
{
  "name": "bundled-hooks-fix",
  "description": "Fix bundled hooks path mismatch",
  "type": "asset",
  "targetFiles": [],
  "assets": [
    { "src": "dist/hooks/bundled", "dest": "dist/bundled", "type": "symlink" },
    { "type": "mkdir", "src": "", "dest": "dist/some-dir" },
    { "src": "handler.js", "dest": "dist/bundled/my-hook/handler.js", "type": "copy" }
  ]
}
```

### Asset operations

| Type | Description | `src` | `dest` |
|------|-------------|-------|--------|
| `symlink` | Create symbolic link | Target path (relative to install dir) | Link location |
| `mkdir` | Create directory | (ignored) | Directory to create |
| `copy` | Copy file/directory | Path in patch's `assets/` folder | Destination in install dir |

### Example: fixing a path with symlink

```json
{
  "assets": [
    { "src": "dist/hooks/bundled", "dest": "dist/bundled", "type": "symlink" }
  ]
}
```

### Example: injecting pre-built files

For `copy` operations, place files in your patch's `assets/` subdirectory:

```
patches/my-fix/
├── patch.json
└── assets/
    └── handler.js      # Will be copied to dest path
```

```json
{
  "assets": [
    { "src": "handler.js", "dest": "dist/bundled/my-hook/handler.js", "type": "copy" }
  ]
}
```

---

## Importing PRs as Patches

Want to use an unmerged fix from the OpenClaw repo? Import it directly as a patch:

```bash
openclaw patcher import-pr 10350
```

This fetches PR #10350 from GitHub, parses the diff, finds matching patterns in your installed bundle files, and creates a ready-to-apply patch.

### Options

| Flag | Description |
|------|-------------|
| `-r, --repo <repo>` | Repository to fetch from (default: `openclaw/openclaw`) |
| `-t, --type <type>` | Patch type: `js` or `diff` (default: `diff`) |
| `-n, --name <name>` | Override patch name (default: `pr-{number}`) |
| `--dry-run` | Preview what would be created without writing files |

### Examples

```bash
# Preview what would be imported
openclaw patcher import-pr 10350 --dry-run

# Import from a fork
openclaw patcher import-pr 42 --repo myuser/openclaw

# Import as a JS patch for more control
openclaw patcher import-pr 10350 --type js

# Custom name
openclaw patcher import-pr 10350 --name cron-fix-v2
```

### How It Works

1. Fetches PR metadata and file diffs from GitHub (uses `gh` CLI if available, falls back to API)
2. Parses unified diffs into before/after hunks
3. Searches your installed bundle files for matching "before" patterns
4. Creates a patch with the matched hunks
5. Reports any hunks that couldn't be mapped (may need manual adjustment)

The original PR diff is saved as `pr-original.diff` for reference.

---

## Version Targeting

Patches can target specific OpenClaw versions using `minVersion` and `maxVersion`:

```json
{
  "name": "cron-scheduler-fix",
  "minVersion": "2026.2.6",
  "maxVersion": "2026.3.0",
  ...
}
```

- `minVersion` (inclusive): Patch only applies to this version or newer
- `maxVersion` (exclusive): Patch only applies to versions before this

This is useful when:
- A fix is only needed for certain version ranges
- You maintain different patches for different OpenClaw versions
- A patch should stop applying once upstream ships a fix in a specific version

---

## CLI Commands

All commands are available under `openclaw patcher`:

| Command | Description |
|---------|-------------|
| `openclaw patcher list` | List all patches and their current status |
| `openclaw patcher apply [name]` | Apply a specific patch, or all pending patches |
| `openclaw patcher check` | Check which patches are still needed |
| `openclaw patcher add <name>` | Scaffold a new patch directory with template files |
| `openclaw patcher status` | Show installed version, last-patched version, and patch states |
| `openclaw patcher import-pr <number>` | Import a GitHub PR as a local patch |
| `openclaw patcher compile-hooks [name]` | Compile bundled hook handlers from GitHub source |
| `openclaw patcher fix-bundled-hooks` | One-command fix for PR #9295 (bundled hooks) |

### Examples

```bash
# See what patches exist and their states
openclaw patcher list

# Check if any patches need applying
openclaw patcher check

# Apply all pending patches
openclaw patcher apply

# Apply a specific patch
openclaw patcher apply cron-scheduler-fix

# Create a new patch
openclaw patcher add my-new-fix
openclaw patcher add my-diff-fix --type diff

# Import an unmerged PR as a patch
openclaw patcher import-pr 10350
openclaw patcher import-pr 10350 --dry-run

# Fix bundled hooks broken since 2026.2.2 (PR #9295)
openclaw patcher fix-bundled-hooks
openclaw patcher fix-bundled-hooks --dry-run

# Compile individual hooks manually
openclaw patcher compile-hooks session-memory
openclaw patcher compile-hooks  # all hooks

# Full status overview
openclaw patcher status
```

---

## Agent Tools

Two tools are registered for use by OpenClaw agents:

| Tool | Description |
|------|-------------|
| `patcher_status` | Check the status of all patches |
| `patcher_apply` | Apply pending patches (optionally by name) |

Agents can use these tools to check patch health, apply patches after detecting an update, or report on patch status when asked.

---

## Configuration

Configuration is set in `openclaw.json` under `plugins.entries.openclaw-patcher.config`:

```json
{
  "openclaw-patcher": {
    "enabled": true,
    "config": {
      "openclawInstallDir": "/opt/homebrew/lib/node_modules/openclaw",
      "patchesDir": "~/.openclaw/extensions/openclaw-patcher/patches",
      "autoApplyOnStart": true,
      "backupBeforePatch": true,
      "debug": false
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `openclawInstallDir` | `/opt/homebrew/lib/node_modules/openclaw` | Path to the OpenClaw npm installation |
| `patchesDir` | `<plugin-dir>/patches` | Override the patches directory location |
| `autoApplyOnStart` | `true` | Automatically check and apply patches on gateway start |
| `backupBeforePatch` | `true` | Create `.bak` backup files before modifying targets |
| `debug` | `false` | Enable verbose debug logging |

---

## Patch Lifecycle

```
  [created]
      |
      v
  [pending]  -- patch is needed, not yet applied
      |
      v
  [applied]  -- patch has been applied to current version
      |
      |--- (npm update) ---> [pending]  -- version changed, re-check needed
      |
      |--- (upstream fix) --> [resolved]  -- patch no longer needed
      |
      v
  [resolved]  -- upstream fixed the issue; patch auto-disabled
```

When a patch is resolved, the plugin logs a prominent warning message so you know it can be cleaned up.

---

## Directory Structure

```
~/.openclaw/extensions/openclaw-patcher/
  src/
    index.ts          # Plugin entry point
    config.ts         # Configuration parsing
    logger.ts         # Logging wrapper
    patch-manager.ts  # Core patch logic
    cli.ts            # CLI command registration
    tools.ts          # Agent tool registration
    types.ts          # TypeScript interfaces
    github.ts         # GitHub API integration for PR import
    diff-converter.ts # Diff parsing and pattern matching
  patches/
    _template/        # Copy this to create a new patch
      patch.json
      patch.js
    .gitkeep
  dist/               # Built output (gitignored)
  package.json
  openclaw.plugin.json
  tsconfig.json
  tsup.config.ts
  CHANGELOG.md        # Version history
```

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-improvement`)
3. Make your changes
4. Run `npm run build` to verify the build succeeds
5. Commit your changes (`git commit -m 'Add my improvement'`)
6. Push to the branch (`git push origin feature/my-improvement`)
7. Open a Pull Request

Please keep patches generic and reusable. If your patch is specific to a particular OpenClaw bug, consider opening an issue upstream first.

---

## License

[MIT](LICENSE)
