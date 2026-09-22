// Positional-read adapter for the MovieIndex. `openNodeReader` returns a `{ load(offset, len),
// close() }` backed by ONE persistent file handle (no per-read fd open/close), with reads done via
// Node's positioned `FileHandle.read`. Tinycast's runtime will supply its own `readRange`-based
// reader instead; swapping it here is the only integration point.

import { open } from "node:fs/promises";
export { openRuntimeReader } from "./runtime-reader.mjs";

/// Open a persistent positional reader over `path` (Node / tests).
export async function openNodeReader(path) {
  const fd = await open(path, "r");
  const buf = new Uint8Array(1 << 20); // reusable read buffer (≤1 MB per chunk)
  return {
    /// Read up to `byteLength` bytes at `offset`; returns a Uint8Array of the bytes available
    /// (clamped to the file tail).
    async load(offset, byteLength) {
      const out = new Uint8Array(byteLength);
      let got = 0;
      while (got < byteLength) {
        const want = Math.min(buf.length, byteLength - got);
        const res = await fd.read(buf, 0, want, offset + got);
        if (res.bytesRead === 0) break;
        out.set(res.buffer.slice(0, res.bytesRead), got);
        got += res.bytesRead;
      }
      return got === byteLength ? out : out.slice(0, got);
    },
    async close() {
      await fd.close();
    },
  };
}