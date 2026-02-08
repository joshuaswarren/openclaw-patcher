import fs from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

/**
 * Represents a single hunk from a unified diff
 */
export interface DiffHunk {
  /** Lines removed (without - prefix) */
  oldLines: string[];
  /** Lines added (without + prefix) */
  newLines: string[];
  /** The old text as a single string */
  oldText: string;
  /** The new text as a single string */
  newText: string;
  /** Source file path from the diff header */
  sourcePath: string;
}

/**
 * Parse a unified diff into hunks
 *
 * Unified diff format:
 * --- a/path/to/file
 * +++ b/path/to/file
 * @@ -start,count +start,count @@
 * -removed line
 * +added line
 *  context line
 */
export function parseUnifiedDiff(unifiedDiff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = unifiedDiff.split("\n");

  let currentFile = "";
  let inHunk = false;
  let oldLines: string[] = [];
  let newLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: +++ b/path/to/file
    if (line.startsWith("+++ b/") || line.startsWith("+++ ")) {
      currentFile = line.replace(/^\+\+\+ [ab]?\//, "").trim();
      continue;
    }

    // Hunk header: @@ -start,count +start,count @@
    if (line.startsWith("@@")) {
      // If we have a previous hunk, save it
      if (inHunk && (oldLines.length > 0 || newLines.length > 0)) {
        hunks.push(createHunk(oldLines, newLines, currentFile));
      }
      // Start new hunk
      inHunk = true;
      oldLines = [];
      newLines = [];
      continue;
    }

    if (!inHunk) continue;

    // Removed line
    if (line.startsWith("-") && !line.startsWith("---")) {
      oldLines.push(line.slice(1));
    }
    // Added line
    else if (line.startsWith("+") && !line.startsWith("+++")) {
      newLines.push(line.slice(1));
    }
    // Context line (appears in both old and new)
    else if (line.startsWith(" ") || line === "") {
      // Context lines help with matching but we primarily care about the changes
      // For simple BEFORE/AFTER patches, we want just the changed lines
    }
  }

  // Don't forget the last hunk
  if (inHunk && (oldLines.length > 0 || newLines.length > 0)) {
    hunks.push(createHunk(oldLines, newLines, currentFile));
  }

  return hunks;
}

function createHunk(oldLines: string[], newLines: string[], sourcePath: string): DiffHunk {
  return {
    oldLines,
    newLines,
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
    sourcePath,
  };
}

/**
 * Parse a GitHub PR file patch (per-file unified diff)
 * GitHub's patch format is slightly different - it's just the hunks without full file headers
 *
 * For simple replacements (- lines followed by + lines), creates BEFORE/AFTER hunks.
 * For insertions (+ lines only), includes surrounding context so we know where to insert.
 */
export function parsePRFilePatch(patch: string, filePath: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = patch.split("\n");

  let inHunk = false;
  let oldLines: string[] = [];      // Lines being removed
  let newLines: string[] = [];      // Lines being added
  let contextBefore: string[] = []; // Context lines before the change
  let contextAfter: string[] = [];  // Context lines after the change
  let seenChange = false;           // Have we seen a - or + line in this hunk?

  const flushHunk = () => {
    if (oldLines.length > 0 || newLines.length > 0) {
      // For pure insertions (no oldLines), use context to create a valid BEFORE
      if (oldLines.length === 0 && newLines.length > 0 && contextBefore.length > 0) {
        // Take the last few context lines as the "before" anchor
        const anchorLines = contextBefore.slice(-3);
        const beforeText = anchorLines.join("\n");
        const afterText = [...anchorLines, ...newLines].join("\n");
        hunks.push({
          oldLines: anchorLines,
          newLines: [...anchorLines, ...newLines],
          oldText: beforeText,
          newText: afterText,
          sourcePath: filePath,
        });
      } else if (oldLines.length > 0) {
        // Standard modification or deletion
        hunks.push(createHunk(oldLines, newLines, filePath));
      }
    }
  };

  for (const line of lines) {
    // Hunk header
    if (line.startsWith("@@")) {
      flushHunk();
      inHunk = true;
      oldLines = [];
      newLines = [];
      contextBefore = [];
      contextAfter = [];
      seenChange = false;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith("-")) {
      seenChange = true;
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      seenChange = true;
      newLines.push(line.slice(1));
    } else if (line.startsWith(" ") || line === "") {
      // Context line
      const contextLine = line.startsWith(" ") ? line.slice(1) : "";
      if (!seenChange) {
        // Context before any changes
        contextBefore.push(contextLine);
      } else {
        // Context after changes - this means we're starting a new change block
        // Flush the current change and start accumulating new context
        flushHunk();
        oldLines = [];
        newLines = [];
        seenChange = false;
        contextBefore = [contextLine];
      }
    }
  }

  // Last hunk
  flushHunk();

  return hunks;
}

/**
 * Search bundle files for a pattern and return the matching file path
 *
 * OpenClaw's bundles are not heavily minified, so source patterns
 * can often be found directly in the compiled output.
 */
export async function findPatternInBundles(
  pattern: string,
  bundleDir: string
): Promise<string | null> {
  try {
    const entries = await fs.readdir(bundleDir);
    const bundleFiles = entries.filter(
      (e) => e.startsWith("gateway-cli-") && e.endsWith(".js")
    );

    for (const file of bundleFiles) {
      const filePath = path.join(bundleDir, file);
      const content = await fs.readFile(filePath, "utf-8");

      if (content.includes(pattern)) {
        log.debug(`found pattern in ${file}`);
        return filePath;
      }
    }
  } catch (err) {
    log.debug(`error searching bundles: ${err}`);
  }

  return null;
}

/**
 * Search all bundle files for patterns and return a map of pattern -> file
 */
export async function findPatternsInBundles(
  patterns: string[],
  bundleDir: string
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  try {
    const entries = await fs.readdir(bundleDir);
    const bundleFiles = entries.filter(
      (e) => e.startsWith("gateway-cli-") && e.endsWith(".js")
    );

    // Read all bundle files once
    const bundleContents = new Map<string, string>();
    for (const file of bundleFiles) {
      const filePath = path.join(bundleDir, file);
      bundleContents.set(filePath, await fs.readFile(filePath, "utf-8"));
    }

    // Search for each pattern
    for (const pattern of patterns) {
      for (const [filePath, content] of bundleContents) {
        if (content.includes(pattern)) {
          results.set(pattern, filePath);
          break;
        }
      }
    }
  } catch (err) {
    log.debug(`error searching bundles: ${err}`);
  }

  return results;
}

/**
 * Convert hunks to the simple BEFORE/AFTER format used by diff-type patches
 *
 * For modifications (both old and new text), uses simple BEFORE/AFTER replacement.
 * For pure additions (only new text), the hunk is skipped since we can't do simple
 * string replacement without context.
 * For pure deletions (only old text), the AFTER section will be empty.
 */
export function hunksToSimpleFormat(hunks: DiffHunk[]): string {
  const blocks: string[] = [];

  for (const hunk of hunks) {
    // Only include hunks that have both old and new text (modifications)
    // Pure additions without context can't be handled by simple replacement
    if (hunk.oldText && hunk.newText) {
      blocks.push(
        `=== BEFORE ===\n${hunk.oldText}\n=== AFTER ===\n${hunk.newText}\n=== END ===`
      );
    } else if (hunk.oldText && !hunk.newText) {
      // Pure deletion - replace old text with nothing
      blocks.push(
        `=== BEFORE ===\n${hunk.oldText}\n=== AFTER ===\n\n=== END ===`
      );
    }
    // Pure additions (hunk.newText but no hunk.oldText) are skipped
    // as we can't determine where to insert without context
  }

  return blocks.join("\n\n");
}

/**
 * Find a minimal unique substring from the old text that can be used
 * for pattern matching. Prefers lines with distinctive content.
 */
export function findMinimalPattern(oldText: string, minLength: number = 20): string {
  const lines = oldText.split("\n").filter((l) => l.trim().length > 0);

  // Prefer lines with function names, class names, or unique identifiers
  for (const line of lines) {
    const trimmed = line.trim();
    // Look for function definitions, method calls, or distinctive code
    if (
      trimmed.includes("function ") ||
      trimmed.includes("const ") ||
      trimmed.includes("let ") ||
      trimmed.includes("export ") ||
      trimmed.includes("=>") ||
      (trimmed.length >= minLength && !trimmed.startsWith("//"))
    ) {
      return trimmed;
    }
  }

  // Fallback: return the first non-empty line
  for (const line of lines) {
    if (line.trim().length >= minLength) {
      return line.trim();
    }
  }

  // Last resort: return the whole old text
  return oldText.slice(0, Math.min(oldText.length, 100));
}
