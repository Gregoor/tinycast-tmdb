// Minimal base64 codec over Uint8Array, standard JS only (works in JavaScriptCore and Node).
// Avoids Buffer so the library has no runtime-specific dependency.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REVERSE = (() => {
  const map = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET.charCodeAt(i)] = i;
  map["=".charCodeAt(0)] = 0;
  return map;
})();

export function bytesToBase64(bytes) {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < len ? ALPHABET[b2 & 63] : "=";
  }
  return out;
}

export function base64ToBytes(text) {
  const str = String(text);
  let len = str.length;
  while (len > 0 && str.charCodeAt(len - 1) === "=".charCodeAt(0)) len--;
  const out = new Uint8Array(((len * 3) / 4) | 0);
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const v = REVERSE[str.charCodeAt(i)];
    if (v < 0) continue; // tolerate whitespace/newlines
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}