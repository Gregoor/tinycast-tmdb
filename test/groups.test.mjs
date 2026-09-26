// The cross-language map's reader: two sorted arrays, both binary searched, and a header believed only
// as far as it is checked.
//
//   node test/groups.test.mjs

import { openGroups } from "../src/wikipedia/groups.mjs";

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

/// The file `Scripts/fetch-wiki-groups.mjs` writes, by hand: a group has at most one row per language,
/// so neither array repeats a key. The forward key is a row's stable id — `id * 2`, so a large number
/// rather than a position — and the reverse value is that row's base position.
function build(rows, groups, magic = "TCWG0002") {
  const bytes = Buffer.alloc(20 + rows.length * 8 + groups.length * 8);
  bytes.write(magic, 0, "utf8");
  bytes.writeUInt32LE(3, 8);
  bytes.writeUInt32LE(rows.length, 12);
  bytes.writeUInt32LE(groups.length, 16);
  let at = 20;
  for (const [stableId, groupId] of rows) {
    bytes.writeUInt32LE(stableId, at);
    bytes.writeUInt32LE(groupId, at + 4);
    at += 8;
  }
  for (const [groupId, rowIndex] of groups) {
    bytes.writeUInt32LE(groupId, at);
    bytes.writeUInt32LE(rowIndex, at + 4);
    at += 8;
  }
  return bytes;
}

// Stable ids forward (large, even), base positions back (small): the asymmetry is deliberate.
const rows = [[1206, 7], [2208, 4], [4022, 9], [9010, 12]];
const groups = [[4, 11], [7, 3], [9, 40], [12, 90]];
const map = openGroups(build(rows, groups));

check("counts survive the round trip", map.byRowCount === 4 && map.byGroupCount === 4,
  `${map.byRowCount}/${map.byGroupCount}`);
check("a mapped row knows its entity", map.groupOfRow(2208) === 4, String(map.groupOfRow(2208)));
check("a row that stands alone has no entity", map.groupOfRow(1) === 0, String(map.groupOfRow(1)));
check("an entity maps back to the row it has here",
  map.rowOfGroup(12) === 90 && map.rowOfGroup(4) === 11,
  `${map.rowOfGroup(12)}/${map.rowOfGroup(4)}`);
check("the first and last entries are found", map.groupOfRow(1206) === 7 && map.groupOfRow(9010) === 12);
// The forward column is a stable id, so a position — including one this file stores in the reverse
// column — must not resolve as a row's key.
check("a position is not mistaken for a stable id",
  map.groupOfRow(0) === 0 && map.groupOfRow(3) === 0 && map.groupOfRow(11) === 0,
  `${map.groupOfRow(0)}/${map.groupOfRow(3)}/${map.groupOfRow(11)}`);
check("an entity this wiki has no row for is nil", map.rowOfGroup(999) === null);
check("a buffer that is not a map is refused", openGroups(Buffer.from("nope")) === null);
// The magic moved with the forward key, so a map cached under the old shape cannot be read as this one.
check("a map under the old magic is refused", openGroups(build(rows, groups, "TCWG0001")) === null);
check("a header counting more than the file holds is refused",
  openGroups(build(rows, groups).subarray(0, 20 + 8)) === null);

console.log(`\n${fail === 0 ? "ALL PASSED" : `${fail} FAILED`} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
