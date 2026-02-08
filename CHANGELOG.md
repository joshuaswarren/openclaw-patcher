# Changelog

All notable changes to openclaw-patcher will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-02-07

### Added

- **Asset Patches**: New `type: "asset"` for injecting files, creating symlinks, or making directories
  - Supports three operations: `copy`, `symlink`, `mkdir`
  - For `copy`, place files in patch's `assets/` subdirectory
  - Useful for fixes that require creating missing files or fixing path mismatches
  - Example: fixing bundled hooks path with symlink from `dist/bundled` to `dist/hooks/bundled`

- **PR Import**: New `openclaw patcher import-pr <number>` command to automatically import unmerged PRs from GitHub as local patches
  - Fetches PR metadata and file diffs from GitHub API (uses `gh` CLI if available, falls back to unauthenticated API)
  - Parses unified diffs and searches bundle files for matching patterns
  - Generates diff-type or js-type patches with proper targetFiles
  - Saves original PR diff as `pr-original.diff` for reference
  - Supports `--dry-run` to preview without creating files
  - Supports `--repo` to import from forks or other repositories
  - Supports `--name` to override the default `pr-{number}` naming

- **Version Targeting**: Patches can now specify `minVersion` and `maxVersion` in `patch.json`
  - `minVersion`: Minimum OpenClaw version (inclusive) for the patch to apply
  - `maxVersion`: Maximum OpenClaw version (exclusive) for the patch to apply
  - Allows maintaining separate patches for different OpenClaw versions

### Changed

- Improved pattern matching for bundle files with `findMinimalPattern()` helper

## [1.0.0] - 2026-02-06

### Added

- Initial release of openclaw-patcher plugin
- Automatic patch reapplication after OpenClaw version updates
- Support for two patch types:
  - **JS patches**: Full programmatic control with `check()`, `isResolved()`, and `apply()` methods
  - **Diff patches**: Simple BEFORE/AFTER text replacement format
- CLI commands:
  - `openclaw patcher list` - List all patches and their status
  - `openclaw patcher status` - Show version info and patch states
  - `openclaw patcher check` - Check which patches are needed
  - `openclaw patcher apply [name]` - Apply patches
  - `openclaw patcher add <name>` - Scaffold a new patch
- Agent tools for programmatic access:
  - `patcher_status` - Get current patcher state
  - `patcher_apply` - Apply patches programmatically
- Glob pattern support for `targetFiles` (e.g., `dist/gateway-cli-*.js`)
- Automatic backup creation before patching (configurable)
- Persistent state tracking in `.patcher-state.json`
- Auto-apply on gateway start (configurable)
- Resolved patch detection and reporting

[1.1.0]: https://github.com/joshuaswarren/openclaw-patcher/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/joshuaswarren/openclaw-patcher/releases/tag/v1.0.0
