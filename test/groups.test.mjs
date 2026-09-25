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
/// so neither array repeats a key.
function build(rows, groups) {
  const bytes = Buffer.alloc(20 + rows.length * 8 + groups.length * 8);
  bytes.write("TCWG0001", 0, "utf8");
  bytes.writeUInt32LE(3, 8);
  bytes.writeUInt32LE(rows.length, 12);
  bytes.writeUInt32LE(groups.length, 16);
  let at = 20;
  for (const [rowIndex, groupId] of rows) {
    bytes.writeUInt32LE(rowIndex, at);
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

const rows = [[3, 7], [11, 4], [40, 9], [90, 12]];
const groups = [[4, 11], [7, 3], [9, 40], [12, 90]];
const map = openGroups(build(rows, groups));

check("counts survive the round trip", map.byRowCount === 4 && map.byGroupCount === 4,
  `${map.byRowCount}/${map.byGroupCount}`);
check("a mapped row knows its entity", map.groupOfRow(11) === 4, String(map.groupOfRow(11)));
check("a row that stands alone has no entity", map.groupOfRow(1) === 0, String(map.groupOfRow(1)));
check("an entity maps back to the row it has here", map.rowOfGroup(12) === 90, String(map.rowOfGroup(12)));
check("the first and last entries are found", map.groupOfRow(3) === 7 && map.groupOfRow(90) === 12);
check("an entity this wiki has no row for is nil", map.rowOfGroup(999) === null);
check("a buffer that is not a map is refused", openGroups(Buffer.from("nope")) === null);
check("a header counting more than the file holds is refused",
  openGroups(build(rows, groups).subarray(0, 20 + 8)) === null);

console.log(`\n${fail === 0 ? "ALL PASSED" : `${fail} FAILED`} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
