// The folding decisions the index depends on.
//
// These are contracts, not incidental behaviour: the query path folds with this same code, so a change
// here silently changes what is findable — and it is the one place where a whole class of titles can
// disappear without anything failing. The [a-z0-9] era did exactly that: every non-Latin title folded
// to nothing and no test noticed, because every fixture was English.

import { foldText, tokenize, normalizeTerms, foldTitle } from "../src/movies/normalize.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// Latin: diacritics dropped, punctuation spaced, case folded. These must not drift.
check("café → cafe", foldText("café") === "cafe", foldText("café"));
check("Zoë → zoe", foldText("Zoë") === "zoe", foldText("Zoë"));
check("déjà-vu → deja vu", foldText("déjà-vu") === "deja vu", foldText("déjà-vu"));
check("punctuation becomes a separator", foldText("Léon: The Professional") === "leon the professional");
check("runs of separators collapse to one space", foldText("a  —  b") === "a b", foldText("a  —  b"));
check("trimmed at both ends", foldText("  (2001)  ") === "2001", JSON.stringify(foldText("  (2001)  ")));
check("digits survive", foldText("8 Mile (2002)") === "8 mile 2002");

// Any script survives. This is the regression: a fold that keeps [a-z0-9] deletes every one of these.
check("Japanese survives", foldText("千と千尋の神隠し") === "千と千尋の神隠し", foldText("千と千尋の神隠し"));
check("Cyrillic survives (и folding of й)", foldText("Ночной дозор") === "ночнои дозор", foldText("Ночной дозор"));
check("Greek survives", foldText("Ο Νονός") === "ο νονος", foldText("Ο Νονός"));
check("Arabic survives", foldText("لعبة الحبار") === "لعبة الحبار", foldText("لعبة الحبار"));
check("a script without spaces is one term", tokenize(foldText("千と千尋の神隠し")).length === 1);

// Symbols and emoji are separators, never part of a term.
check("emoji is a separator", foldText("Amélie 🎬  (2001)") === "amelie 2001", foldText("Amélie 🎬  (2001)"));
check("a title of only punctuation folds to nothing", foldText("!!! ???") === "", JSON.stringify(foldText("!!! ???")));
check("missing input is empty", foldText("") === "" && foldText(null) === "" && foldText(undefined) === "");

// The tokenisation the retrieval path relies on, including the apostrophe that splits a word.
check("an apostrophe splits a word", JSON.stringify(normalizeTerms("Where's Wanda")) === JSON.stringify(["where", "s", "wanda"]),
  JSON.stringify(normalizeTerms("Where's Wanda")));
check("foldTitle is the same fold", foldTitle("Amélie") === foldText("Amélie"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);