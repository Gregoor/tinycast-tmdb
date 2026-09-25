// The delta's selection: what it carries, what it supersedes, and the key it has to agree with the store
// and the loader on.
//
//   node test/wikipedia-delta.test.mjs

import { deltaFor } from "../src/wikipedia/delta.mjs";
import { shipping, stableKey, strength } from "../src/wikipedia/popularity.mjs";
import { stableKey as storeKey } from "../Scripts/store.mjs";

let pass = 0;
let fail = 0;
function check(description, condition, extra = "") {
  if (condition) {
    pass += 1;
    console.log(`  ok    ${description}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${description}${extra ? ` — ${extra}` : ""}`);
  }
}

// The three places a stable key is computed must agree, or a delta supersedes rows that are not there.
check("the module's key matches the store's", [3, 40, 12345, 2 ** 31 - 1].every(
  (id) => stableKey({ id, mediaType: "movie" }) === storeKey("movie", id)));
check("...and the tv bit still separates them",
  stableKey({ id: 9, mediaType: "tv" }) === storeKey("tv", 9));

const record = (id, changedOn, extra = {}) => ({ id, mediaType: "movie", changedOn, ...extra });
const records = [
  record(1, "2026-09-24"),
  record(2, "2026-09-25"),
  record(3, "2026-09-25", { prevId: 99 }),
  record(4, ""),
];

const { touched, superseded } = deltaFor(records, [7], "2026-09-24");
check("only the rows that changed since the marker are carried",
  touched.map((row) => row.id).join(",") === "2,3", touched.map((row) => row.id).join(","));
check("a carried row supersedes itself",
  superseded.includes(storeKey("movie", 2)) && superseded.includes(storeKey("movie", 3)));
check("a row that changed id supersedes the id it used to have",
  superseded.includes(storeKey("movie", 99)));
check("a row that left the band is superseded, though nothing replaces it",
  superseded.includes(storeKey("movie", 7)) && !touched.some((row) => row.id === 7));
check("an unchanged row is neither carried nor superseded",
  !superseded.includes(storeKey("movie", 1)) && !superseded.includes(storeKey("movie", 4)));

const quiet = deltaFor(records, [], "2026-09-25");
check("nothing changed is an empty delta",
  quiet.touched.length === 0 && quiet.superseded.length === 0);

const unmarked = deltaFor(records, [], "");
check("an unmarked store ships everything rather than nothing",
  unmarked.touched.length === 3 && !unmarked.touched.some((row) => row.id === 4));

// What actually ships: the level in both numeric fields, so the volatile exact score never reaches the
// index — which is the only reason a delta can be small.
const [shipped] = shipping([{ id: 5, mediaType: "movie", title: "x", popularity: 6.4, voteCount: 0 }]);
check("a shipped row carries its level, not its score",
  shipped.popularity === strength(6.4) && shipped.voteCount === strength(6.4));
check("shipping keeps everything else", shipped.title === "x" && shipped.id === 5);

console.log(`\n${fail === 0 ? "ALL PASSED" : `${fail} FAILED`} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
