// Normalization shared byte-for-byte by the importer (index build) and the query path, so what a
// query folds to is exactly what the corpus was folded to. Uses only standard JS so it runs
// unmodified in both JavaScriptCore and Node.

const SPACE = " ";

// NFD then strip combining marks (diacritics), then lower-case and keep [a-z0-9] only, collapsing
// gaps to single spaces. Unambiguous: café -> cafe, Zoë -> zoe, déjà-vu -> deja vu, ½ -> "".
export function foldText(input) {
  const decomposed = String(input ?? "").normalize("NFD");
  const out = [];
  let pendingSpace = false;
  for (let i = 0; i < decomposed.length; i++) {
    const ch = decomposed[i].toLowerCase();
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      if (pendingSpace && out.length) out.push(SPACE);
      pendingSpace = false;
      out.push(ch);
    } else if (ch === " ") {
      pendingSpace = true;
    } else if (decomposed.codePointAt(i) < 0x300) {
      // A non-combining non-alphanumeric (punctuation, symbols): treat like whitespace.
      pendingSpace = true;
    }
    // Combining marks (0x300+) are dropped silently, not turned into a space.
  }
  return out.join("");
}

/// Split folded text into words on runs of whitespace.
export function tokenize(folded) {
  return folded.split(SPACE).filter(Boolean);
}

/// Fold + tokenize in one step.
export function normalizeTerms(input) {
  return tokenize(foldText(String(input ?? "")));
}

/// Fold a single title for display-time comparison in the reranker.
export function foldTitle(input) {
  return foldText(String(input ?? ""));
}