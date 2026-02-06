// Template patch module
// Copy this directory, rename it, and modify these functions.
//
// - check()      => return true if the buggy code is present and the fix is NOT
// - isResolved() => return true if upstream shipped a real fix
// - apply()      => return the patched file content

export default {
  check(fileContent, filePath) {
    // Replace with your detection logic
    return false;
  },

  isResolved(fileContent, filePath) {
    // Replace with upstream-fix detection logic
    return false;
  },

  apply(fileContent, filePath) {
    // Replace with your patching logic
    return fileContent;
  },
};
