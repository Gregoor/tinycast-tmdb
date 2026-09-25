// Fetching and unpacking release artifacts through the runtime's `child_process` shim. Both providers
// need exactly this, and a bundle inlines what it imports, so sharing the source costs nothing at
// runtime — while keeping the curl and gunzip flags in one place.

/// Fetch `url` to `path` through curl, writing beside the target and renaming, so a failed or partial
/// transfer never leaves a truncated file where the loader would open it.
export function download(url, path) {
  const { execFileSync } = require("child_process");
  const fs = require("fs");
  execFileSync("/usr/bin/curl", ["-fsSL", "--retry", "3", url, "-o", `${path}.part`]);
  fs.renameSync(`${path}.part`, path);
}

/// Unpack `from` into `to`, again beside the target and renamed. gzip comes from the OS rather than a
/// bundled library, as curl does. `--compressed` cannot make the *download* do this: GitHub serves a
/// release asset as the bytes it was uploaded as, with no `Content-Encoding` to negotiate.
export function gunzip(from, to) {
  const { execFileSync } = require("child_process");
  const fs = require("fs");
  execFileSync("/bin/sh", ["-c", `/usr/bin/gunzip -c '${from}' > '${to}.part'`]);
  fs.renameSync(`${to}.part`, to);
}
