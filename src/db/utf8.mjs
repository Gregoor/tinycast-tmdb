// UTF-8 encode/decode over Uint8Array, standard JS only (JavaScriptCore + Node). Handles astral
// surrogate pairs. Error-tolerant decode (replacement char), matching what a fuzzy result needs.

export function utf8Encode(text) {
  const s = String(text);
  const bytes = new Uint8Array(s.length * 3); // worst case: astral chars are 3 bytes after surrogate pairs
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      bytes[o++] = code;
    } else if (code < 0x800) {
      bytes[o++] = 0xc0 | (code >> 6);
      bytes[o++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      bytes[o++] = 0xe0 | (code >> 12);
      bytes[o++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[o++] = 0x80 | (code & 0x3f);
    } else {
      bytes[o++] = 0xf0 | (code >> 18);
      bytes[o++] = 0x80 | ((code >> 12) & 0x3f);
      bytes[o++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[o++] = 0x80 | (code & 0x3f);
    }
  }
  return bytes.slice(0, o);
}

export function utf8Decode(bytes) {
  // Historically we iterate with cumulative char codes; String.fromCharCode handles pairs.
  let out = "";
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i];
    let code;
    let width;
    if (b0 < 0x80) {
      code = b0;
      width = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      code = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      width = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      code = ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      width = 3;
    } else {
      code = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      width = 4;
    }
    if (code < 0x10000) {
      out += String.fromCharCode(code);
    } else {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    }
    i += width;
  }
  return out;
}