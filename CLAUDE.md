# openclaw-patcher

## PUBLIC REPOSITORY — Privacy Policy

**This repository is PUBLIC on GitHub.** Every commit is visible to the world.

### Rules for ALL agents committing to this repo:

1. **NEVER commit personal data** — no names, emails, addresses, phone numbers, account IDs, or user identifiers
2. **NEVER commit API keys, tokens, or secrets** — even in comments or examples
3. **NEVER commit user-specific patches** — patches in `patches/` that are specific to one user's setup should not be committed unless they're generally useful
4. **NEVER commit `.env` files** or any file containing credentials
5. **NEVER reference specific users or their systems** in code comments or commit messages
6. **Config examples must use placeholders** — `${OPENAI_API_KEY}`, not actual keys

### What IS safe to commit:
- Source code (`src/`)
- Package manifests (`package.json`, `tsconfig.json`, `tsup.config.ts`)
- Plugin manifest (`openclaw.plugin.json`)
- Documentation (`README.md`, `CHANGELOG.md`, `docs/`)
- Example patches that fix common issues (e.g., `cron-scheduler-fix`)
- Build configuration
- `.gitignore`
- This `CLAUDE.md` file

### Before every commit, verify:
- `git diff --cached` contains NO personal information
- No hardcoded API keys, URLs with tokens, or credentials
- No references to specific users or their patches

## Architecture Notes

### File Structure
```
src/
├── index.ts              # Plugin entry point
├── config.ts             # Config parsing
├── types.ts              # All type definitions
├── logger.ts             # Logging wrapper
├── patch-manager.ts      # Core patch logic
├── cli.ts                # CLI commands
├── tools.ts              # Agent tools
├── github.ts             # GitHub PR fetcher
├── diff-converter.ts     # Parse PR diffs
└── handler-compiler.ts   # Compile JS patches

patches/
├── cron-scheduler-fix/
│   ├── patch.json        # Metadata
│   └── patch.js          # JS patch handler
└── example-diff-patch/
    ├── patch.json
    └── patch.diff
```

### Key Patterns

1. **Patches auto-apply on startup** — service `start` callback runs `autoApply()`
2. **Version targeting** — patches can specify `minVersion`/`maxVersion`
3. **Glob patterns for targets** — handle changing bundle hashes
4. **Three patch types** — JS (programmatic), diff (find-replace), asset (file copy)
5. **State in patch.json** — each patch tracks its own applied/resolved state

### Patch Types

**JS Patches** (`type: "js"`):
```javascript
export default {
  check(content, path) { return needsPatching; },
  isResolved(content, path) { return upstreamFixed; },
  apply(content, path) { return patchedContent; }
};
```

**Diff Patches** (`type: "diff"`):
```
=== BEFORE ===
old code here
=== AFTER ===
new code here
=== END ===
```

**Asset Patches** (`type: "asset"`):
- Copy files from `assets/` directory
- Create symlinks
- Make directories

### Integration Points

- `api.registerCommand()` — CLI interface (`openclaw patcher status`, etc.)
- `api.registerTool()` — agent tools
- `api.registerService()` — auto-apply on startup

### Testing Locally

```bash
# Build
npm run build

# Full restart (service start hook needs this)
launchctl kickstart -k gui/501/ai.openclaw.gateway

# Or for hot reload (but patches won't auto-apply)
kill -USR1 $(pgrep openclaw-gateway)

# Check status
openclaw patcher status

# View logs
grep "\[patcher\]" ~/.openclaw/logs/gateway.log
```

### Common Gotchas

1. **Bundle hashes change** — use glob patterns in `targetFiles`
2. **Patterns must be unique** — include enough context in BEFORE blocks
3. **Minified files** — no newlines in patterns for bundled JS
4. **Version matching is exclusive** — `maxVersion: "2026.2.7"` means "before 2026.2.7"
