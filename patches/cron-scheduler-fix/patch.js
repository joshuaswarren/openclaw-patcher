// cron-scheduler-fix patch
// Fixes cron scheduler stall after SIGUSR1 restart and recomputeNextRuns race condition.
// Upstream tracking: PR #10350

export default {
  /**
   * Check if this patch is still needed.
   * Returns true if the file contains unpatched cron scheduler code.
   *
   * We detect the unpatched state by looking for ANY of these conditions:
   *   - The onTimer function has bare `if (state.running) return;` (no re-arm)
   *   - The stop function does NOT call resetStoreLock
   *   - The ensureLoaded function does NOT have skipRecompute guard
   *   - The resetStoreLock function does not exist at all
   *
   * If ALL four fixes are already present, this returns false (already patched).
   */
  check(fileContent, filePath) {
    // Must contain the cron store region to be a relevant file
    if (!fileContent.includes('//#region src/cron/store.ts')) {
      return false;
    }

    // Check 1: onTimer has bare `if (state.running) return;` without re-arming
    const hasBareRunningGuard = fileContent.includes('if (state.running) return;');

    // Check 2: stop() only calls stopTimer (no resetStoreLock)
    const hasSimpleStop = fileContent.includes('function stop(state) {\n\tstopTimer(state);\n}');

    // Check 3: ensureLoaded does not have skipRecompute guard
    const missingSkipRecompute = !fileContent.includes('skipRecompute');

    // Check 4: resetStoreLock function does not exist
    const missingResetStoreLock = !fileContent.includes('function resetStoreLock(state)');

    // Patch is needed if ANY of the four fixes are missing
    return hasBareRunningGuard || hasSimpleStop || missingSkipRecompute || missingResetStoreLock;
  },

  /**
   * Check if the upstream has natively resolved the issue.
   * Returns true if the code contains BOTH skipRecompute AND resetStoreLock
   * but in a way that differs from our patch (i.e., upstream rewrote the section).
   *
   * For now, we consider it resolved if:
   *   - The cron/store region no longer exists (code was completely rewritten), OR
   *   - Both fixes exist AND the locked() function signature changed
   */
  isResolved(fileContent, filePath) {
    // If the cron store region is completely gone, upstream rewrote it
    if (!fileContent.includes('//#region src/cron/store.ts')) {
      // But only if the file still looks like a gateway file
      return fileContent.includes('gateway') || fileContent.includes('cron');
    }

    // If both markers exist natively and the old buggy patterns are gone,
    // AND the code structure changed (e.g., locked function signature changed),
    // then upstream has fixed it their own way.
    const hasResetStoreLock = fileContent.includes('function resetStoreLock(state)');
    const hasSkipRecompute = fileContent.includes('skipRecompute');
    const hasRearmGuard = fileContent.includes('if (state.running) { armTimer(state); return; }');

    // If all three markers are present, it could be our patch or upstream.
    // We consider it "resolved" only if the locked() function pattern has changed,
    // meaning upstream shipped their own version of the fix.
    if (hasResetStoreLock && hasSkipRecompute && hasRearmGuard) {
      // Check if locked() no longer uses our exact pattern (storeLocks map)
      // If the implementation changed, upstream merged a proper fix
      const hasOurLockedPattern = fileContent.includes('storeLocks.set(storePath, keepAlive)');
      if (!hasOurLockedPattern) {
        return true;
      }
    }

    return false;
  },

  /**
   * Apply all four cron scheduler fixes to the file content.
   * Returns the modified content.
   */
  apply(fileContent, filePath) {
    let result = fileContent;

    // === Change 1: Add resetStoreLock() function after locked() ===
    // The locked function ends with `return await next;\n}`
    // followed by the cron/store region marker.
    const lockedEndMarker = 'return await next;\n}\n\n//#endregion\n//#region src/cron/store.ts';
    const lockedEndWithResetStoreLock =
      'return await next;\n}\n' +
      'function resetStoreLock(state) {\n' +
      '\tconst storePath = state.deps.storePath;\n' +
      '\tstoreLocks.delete(storePath);\n' +
      '\tstate.op = void 0;\n' +
      '}\n' +
      '\n//#endregion\n//#region src/cron/store.ts';

    if (result.includes(lockedEndMarker) && !result.includes('function resetStoreLock(state)')) {
      result = result.replace(lockedEndMarker, lockedEndWithResetStoreLock);
    }

    // === Change 2: Update stop() to clear locks ===
    const simpleStop = 'function stop(state) {\n\tstopTimer(state);\n}';
    const fixedStop =
      'function stop(state) {\n' +
      '\tstopTimer(state);\n' +
      '\tresetStoreLock(state);\n' +
      '\tstate.running = false;\n' +
      '}';

    if (result.includes(simpleStop)) {
      result = result.replace(simpleStop, fixedStop);
    }

    // === Change 3: Re-arm timer when running guard triggers in onTimer ===
    const bareRunningGuard = 'if (state.running) return;';
    const rearmRunningGuard = 'if (state.running) { armTimer(state); return; }';

    // Only replace within the onTimer function context
    if (result.includes('async function onTimer(state)')) {
      result = result.replace(
        'async function onTimer(state) {\n\tif (state.running) return;',
        'async function onTimer(state) {\n\tif (state.running) { armTimer(state); return; }'
      );
    }

    // === Change 4: Add skipRecompute support ===

    // 4a: In ensureLoaded, guard recomputeNextRuns with skipRecompute check
    // Find the specific line in ensureLoaded context (after storeFileMtimeMs assignment)
    const ensureLoadedRecompute = '\tstate.storeFileMtimeMs = fileMtimeMs;\n\trecomputeNextRuns(state);';
    const ensureLoadedRecomputeFixed = '\tstate.storeFileMtimeMs = fileMtimeMs;\n\tif (!opts?.skipRecompute) recomputeNextRuns(state);';

    if (result.includes(ensureLoadedRecompute)) {
      result = result.replace(ensureLoadedRecompute, ensureLoadedRecomputeFixed);
    }

    // 4b: In onTimer's locked callback, add skipRecompute to ensureLoaded
    //     and move recomputeNextRuns after runDueJobs
    const onTimerOriginal =
      '\t\t\tawait ensureLoaded(state, { forceReload: true });\n' +
      '\t\t\tawait runDueJobs(state);\n' +
      '\t\t\tawait persist(state);';
    const onTimerFixed =
      '\t\t\tawait ensureLoaded(state, { forceReload: true, skipRecompute: true });\n' +
      '\t\t\tawait runDueJobs(state);\n' +
      '\t\t\trecomputeNextRuns(state);\n' +
      '\t\t\tawait persist(state);';

    if (result.includes(onTimerOriginal)) {
      result = result.replace(onTimerOriginal, onTimerFixed);
    }

    return result;
  }
};
