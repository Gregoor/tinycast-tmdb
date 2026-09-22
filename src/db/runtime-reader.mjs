// The extension-runtime positional reader. Zero imports: it depends only on the injected `fs`
// node-shim and standard JS, so this file is safe to bundle into a command that runs in
// JavaScriptCore. See loaders.mjs for the Node/test counterpart.

/// A reader backed by the extension runtime's `fs` node-shim (`openSync`/`readSync`/`closeSync`),
/// which performs synchronous host calls on the JS thread (no per-read await hop). `fs` in the
/// bundle is `require("fs")`; tests inject a shim. Returns the reader interface `load(offset, len)`
/// that MovieIndex expects.
export function openRuntimeReader(path, fs) {
  const fd = fs.openSync(path, "r");
  let closed = false;
  const buf = new Uint8Array(1 << 20); // reusable ≤1 MB chunk buffer
  return {
    load(offset, byteLength) {
      if (closed) throw new Error("reader closed");
      const out = new Uint8Array(byteLength);
      let got = 0;
      while (got < byteLength) {
        const want = Math.min(buf.length, byteLength - got);
        const n = fs.readSync(fd, buf, 0, want, offset + got);
        if (n === 0) break;
        out.set(buf.subarray(0, n), got);
        got += n;
      }
      return got === byteLength ? out : out.slice(0, got);
    },
    close() {
      if (!closed) {
        closed = true;
        fs.closeSync(fd);
      }
    },
  };
}