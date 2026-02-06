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

## CLI Commands

All commands are available under `openclaw patcher`:

| Command | Description |
|---------|-------------|
| `openclaw patcher list` | List all patches and their current status |
| `openclaw patcher apply [name]` | Apply a specific patch, or all pending patches |
| `openclaw patcher check` | Check which patches are still needed |
| `openclaw patcher add <name>` | Scaffold a new patch directory with template files |
| `openclaw patcher status` | Show installed version, last-patched version, and patch states |

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
