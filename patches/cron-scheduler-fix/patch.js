// cron-scheduler-fix patch for v2026.2.6+
// Fixes cron scheduler stall after SIGUSR1 restart.
// v2026.2.6 includes the skipRecompute fix natively (PRs #9733, #9823, #9948, #9932),
// but still needs resetStoreLock and timer re-arming (PR #10350).

export default {
  /**
   * Check if this patch is still needed.
   * Returns true if the file contains unpatched cron scheduler code.
   *
   * For v2026.2.6+, we only need to check:
   *   - The onTimer function has bare `if (state.running) return;` (no re-arm)
   *   - The stop function does NOT call resetStoreLock
   *   - The resetStoreLock function does not exist
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

    // Check 3: resetStoreLock function does not exist
    const missingResetStoreLock = !fileContent.includes('function resetStoreLock(state)');

    // Patch is needed if ANY of the three fixes are missing
    return hasBareRunningGuard || hasSimpleStop || missingResetStoreLock;
  },

  /**
   * Check if the upstream has natively resolved the issue.
   * Returns true if the code contains resetStoreLock natively (upstream merged PR #10350).
   */
  isResolved(fileContent, filePath) {
    // If the cron store region is completely gone, upstream rewrote it
    if (!fileContent.includes('//#region src/cron/store.ts')) {
      return fileContent.includes('gateway') || fileContent.includes('cron');
    }

    // If all three markers are present natively, check if it's our patch or upstream
    const hasResetStoreLock = fileContent.includes('function resetStoreLock(state)');
    const hasRearmGuard = fileContent.includes('if (state.running) { armTimer(state); return; }');

    if (hasResetStoreLock && hasRearmGuard) {
      // Check if the implementation changed (upstream shipped their own version)
      const hasOurLockedPattern = fileContent.includes('storeLocks.delete(storePath)');
      if (!hasOurLockedPattern) {
        return true;
      }
    }

    return false;
  },

  /**
   * Apply the cron scheduler fixes to the file content.
   * For v2026.2.6+, we only apply:
   *   1. Add resetStoreLock() function
   *   2. Update stop() to call resetStoreLock
   *   3. Re-arm timer when running guard triggers in onTimer
   */
  apply(fileContent, filePath) {
    let result = fileContent;

    // === Change 1: Add resetStoreLock() function after locked() ===
    // Find the end of the locked function and add resetStoreLock after it
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

    // === Change 2: Update stop() to clear locks and running state ===
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
    // This prevents the scheduler from stalling when a tick is dropped due to running guard
    if (result.includes('async function onTimer(state)')) {
      result = result.replace(
        'async function onTimer(state) {\n\tif (state.running) return;',
        'async function onTimer(state) {\n\tif (state.running) { armTimer(state); return; }'
      );
    }

    return result;
  }
};
