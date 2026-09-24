// Normalization shared byte-for-byte by the importer (index build) and the query path, so what a
// query folds to is exactly what the corpus was folded to. Uses only standard JS so it runs
// unmodified in both JavaScriptCore and Node.

const SPACE = " ";

// NFD, drop combining marks (diacritics), lower-case, and keep letters and digits of ANY script,
// collapsing every other run to a single space. Unambiguous: café -> cafe, Zoë -> zoe,
// déjà-vu -> deja vu, and unlike an [a-z0-9] filter it does not silently delete every non-Latin
// title: 千と千尋の神隠し -> 千と千尋の神隠し, Дневной дозор -> дневной дозор.
//
// Marks are dropped rather than spaced so a diacritic cannot split a word; everything else that is
// not a letter or digit (punctuation, symbols, emoji) becomes a separator.
export function foldText(input) {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, SPACE)
    .trim();
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