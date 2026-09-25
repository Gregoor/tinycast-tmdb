// What a delta for one wiki carries, and what it supersedes.
//
// The store already knows the day each row's shipped level last moved, and which ids left the band, so
// choosing a delta is arithmetic over the store rather than a diff between two indexes.

import { stableKey } from "./popularity.mjs";

/// The records touched since `since` (a `YYYY-MM-DD` sample date), and every stable key that supersedes.
///
/// Superseded is a superset of touched, deliberately: a client must drop the stale row whether or not
/// this file ships a replacement. A row whose id moved names its old id too — a title that had only a
/// hash and has since been resolved to a Wikidata item is a new key, and the row it used to be would
/// otherwise stay behind.
export function deltaFor(records, dropped, since) {
  const touched = [];
  const superseded = new Set();
  for (const record of records) {
    if (!record.changedOn || record.changedOn <= since) continue;
    touched.push(record);
    superseded.add(stableKey(record));
    if (record.prevId) superseded.add(record.prevId * 2);
  }
  for (const id of dropped) superseded.add(id * 2);
  return { touched, superseded: [...superseded] };
}
