# openclaw-patcher - Agent Guide

## What This Plugin Does (Simple Explanation)

This plugin automatically re-applies user-defined patches to OpenClaw files after updates.

Think of it like an automatic "modder" for OpenClaw:
- You define patches once (fix a bug, add a feature)
- Every time OpenClaw updates, your patches get re-applied automatically
- If a patch is no longer needed (upstream fixed it), the plugin detects that

## Why This Exists

OpenClaw is updated frequently. When you find a bug or need a feature that isn't merged yet:
1. You could manually edit OpenClaw's files - but they get overwritten on update
2. You could wait for upstream - but that might take weeks
3. **OR** you use this plugin to automatically maintain your fixes

Common use cases:
- Applying fixes from unmerged PRs
- Adding custom functionality
- Working around bugs in specific versions
- Version-specific workarounds (apply patch only to version X.Y.Z)

## How It Fits Into OpenClaw

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                         │
│                                                              │
│  ┌────────────────────┐                                     │
│  │   gateway_start    │──────┐                              │
│  │      (hook)        │      │                              │
│  └────────────────────┘      │                              │
│                              ▼                              │
│                    ┌─────────────────┐                      │
│                    │    Patcher      │  <-- THIS PLUGIN     │
│                    │   (service)     │                      │
│                    └────────┬────────┘                      │
│                             │                               │
│         ┌───────────────────┼───────────────────┐          │
│         ▼                   ▼                   ▼          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    │
│  │ patches/    │    │ patches/    │    │ patches/    │    │
│  │ cron-fix/   │    │ model-fix/  │    │ pr-10350/   │    │
│  └─────────────┘    └─────────────┘    └─────────────┘    │
│                             │                               │
│                             ▼                               │
│                    ┌─────────────────┐                      │
│                    │  OpenClaw Core  │                      │
│                    │ /opt/homebrew/  │                      │
│                    │ lib/node_modules│                      │
│                    │ /openclaw/dist/ │                      │
│                    └─────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

The plugin:
1. **Runs on gateway_start** - Checks all patches against installed OpenClaw
2. **Applies pending patches** - Modifies bundled JS files
3. **Detects resolved patches** - Marks patches that are no longer needed
4. **Provides CLI commands** - `openclaw patcher status`, `openclaw patcher apply`

## Key Concepts

### 1. Patch Types

**JS Patches** (`type: "js"`):
- Full programmatic control with `check()`, `isResolved()`, `apply()`
- Best for complex changes or pattern matching
- Uses JavaScript module format

**Diff Patches** (`type: "diff"`):
- Simple find-and-replace
- Uses BEFORE/AFTER block format
- Best for straightforward text replacements

**Asset Patches** (`type: "asset"`):
- Copy files, create symlinks, make directories
- No code modification needed
- Best for adding new files to OpenClaw

### 2. Patch States

| State | Meaning |
|-------|---------|
| `pending` | Patch needed, ready to apply |
| `applied` | Patch successfully applied |
| `resolved` | Upstream fixed the issue, patch no longer needed |
| `disabled` | Manually disabled or version mismatch |
| `error` | Something went wrong |

### 3. Version Targeting

Patches can target specific OpenClaw versions:
- `minVersion`: Apply to this version and above
- `maxVersion`: Apply below this version (exclusive)

Example: A patch only for v2026.2.6
```json
{
  "minVersion": "2026.2.6",
  "maxVersion": "2026.2.7"
}
```

### 4. Target File Patterns

Target files use glob patterns:
```json
{
  "targetFiles": ["dist/gateway-cli-*.js"]
}
```

This matches any file like `gateway-cli-abc123.js` (bundle hash varies per build).

## File Structure

```
~/.openclaw/extensions/openclaw-patcher/
├── src/
│   ├── index.ts            # Plugin entry, hooks, service
│   ├── config.ts           # Config parsing
│   ├── types.ts            # TypeScript interfaces
│   ├── logger.ts           # Logging wrapper
│   ├── patch-manager.ts    # Core patch logic
│   ├── cli.ts              # CLI commands
│   ├── tools.ts            # Agent tools
│   ├── github.ts           # GitHub PR fetcher
│   ├── diff-converter.ts   # Parse PR diffs
│   └── handler-compiler.ts # Compile JS patches
│
└── patches/                 # Your patches live here
    ├── cron-scheduler-fix/
    │   ├── patch.json      # Metadata
    │   └── patch.js        # JS patch module
    │
    └── my-custom-patch/
        ├── patch.json
        └── patch.diff      # Diff patch file
```

### Patch Directory Structure

Each patch lives in its own directory:

```
patches/example-fix/
├── patch.json              # Required: metadata
├── patch.js                # For JS patches
├── patch.diff              # For diff patches
├── assets/                 # For asset patches (files to copy)
│   └── my-file.js
└── pr-original.diff        # Original PR diff (for reference)
```

### patch.json Format

```json
{
  "name": "example-fix",
  "description": "Fixes the example bug in scheduler",
  "issue": "https://github.com/openclaw/openclaw/pull/10350",
  "enabled": true,
  "type": "js",
  "targetFiles": ["dist/gateway-cli-*.js"],
  "minVersion": "2026.2.6",
  "maxVersion": null,
  "appliedAt": "2026-02-07T12:00:00Z",
  "appliedVersion": "2026.2.6",
  "resolvedAt": null,
  "resolvedReason": null
}
```

### JS Patch Format (patch.js)

```javascript
export default {
  // Return true if patch is still needed
  check(fileContent, filePath) {
    return fileContent.includes('BUGGY_CODE') &&
           !fileContent.includes('FIXED_CODE');
  },

  // Return true if upstream fixed the issue
  isResolved(fileContent, filePath) {
    return fileContent.includes('UPSTREAM_FIX');
  },

  // Apply the patch, return modified content
  apply(fileContent, filePath) {
    return fileContent.replace('BUGGY_CODE', 'FIXED_CODE');
  }
};
```

### Diff Patch Format (patch.diff)

```
=== BEFORE ===
const oldCode = "buggy";
=== AFTER ===
const newCode = "fixed";
=== END ===
```

You can have multiple BEFORE/AFTER/END blocks for multiple changes.

## Common Tasks

### Creating a New Patch Manually

```bash
# Scaffold a new JS patch
openclaw patcher scaffold my-fix --type=js

# Or a diff patch
openclaw patcher scaffold my-fix --type=diff

# Edit the files in patches/my-fix/
```

### Importing a Patch from a GitHub PR

```bash
# Import PR #10350 from openclaw/openclaw
openclaw patcher import-pr 10350 --name=my-pr-fix

# Dry run first
openclaw patcher import-pr 10350 --dry-run
```

### Checking Patch Status

```bash
# See all patches and their states
openclaw patcher status
```

### Applying All Patches

```bash
# Apply all pending patches
openclaw patcher apply
```

### Disabling a Patch

Edit the patch's `patch.json` and set `"enabled": false`.

## Footguns (Common Mistakes)

### 1. Bundle Hash Changes
OpenClaw bundles have hashes in filenames (`gateway-cli-abc123.js`). When OpenClaw updates, the hash changes.

**Fix**: Use glob patterns in `targetFiles`: `"dist/gateway-cli-*.js"`

### 2. Pattern Not Unique
If your BEFORE text appears multiple times, the patch will fail.

**Fix**: Include more surrounding context to make the pattern unique.

### 3. Whitespace Sensitivity
Bundle files are minified. A pattern with newlines won't match.

**Fix**: Match the actual minified output. Use `check()` to debug what's actually in the file.

### 4. Version Mismatch Silent Skip
If your patch has version targeting and the current version doesn't match, it silently skips.

**Fix**: Check `openclaw patcher status` to see why a patch is disabled.

### 5. Forgetting to Back Up
The plugin backs up files by default, but if you disable that, you could lose changes.

**Fix**: Keep `backupBeforePatch: true` in config.

### 6. Patch Detected as Resolved Incorrectly
Sometimes your `isResolved()` logic matches when it shouldn't.

**Fix**: Make your resolution detection more specific.

## Testing Changes

```bash
# Build the plugin
cd ~/.openclaw/extensions/openclaw-patcher
npm run build

# Reload OpenClaw gateway (full restart needed for service)
launchctl kickstart -k gui/501/ai.openclaw.gateway

# Check status
openclaw patcher status

# View logs
grep "\[patcher\]" ~/.openclaw/logs/gateway.log
```

## Debug Mode

Enable in `openclaw.json`:
```json
{
  "plugins": {
    "openclaw-patcher": {
      "debug": true
    }
  }
}
```

## Real Example: Cron Scheduler Fix

The `cron-scheduler-fix` patch adds missing functionality:

```javascript
// patch.js
export default {
  check(content) {
    // Check if resetStoreLock is missing
    return !content.includes("resetStoreLock") &&
           content.includes("storeLocks");
  },

  isResolved(content) {
    // Check if upstream added resetStoreLock
    return content.includes("resetStoreLock") &&
           content.includes("storeLocks.clear");
  },

  apply(content) {
    // Add the resetStoreLock function
    return content
      .replace(
        'storeLocks=new Map',
        'resetStoreLock=e=>{storeLocks.clear();e.op=void 0;},storeLocks=new Map'
      )
      .replace(
        'stop:()=>{',
        'stop:()=>{resetStoreLock(state);'
      );
  }
};
```
