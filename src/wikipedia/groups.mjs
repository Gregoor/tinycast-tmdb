// The cross-language entity map, as written by `Scripts/fetch-wiki-groups.mjs`: for one language, which
// entity each of its grouped rows belongs to.
//
// Two sorted arrays because the provider asks both ways — "which entity is this row" when a row
// matched, and "which row is this entity" for a language it wants to offer. Both are binary searched,
// so nothing here is scanned per query and no titles are held in memory.
//
//   "TCWG0001" | u32 languages | u32 byRowCount | u32 byGroupCount
//   (rowIndex, groupId) * byRowCount      sorted by rowIndex
//   (groupId, rowIndex) * byGroupCount    sorted by groupId

const MAGIC = "TCWG0001";
const HEADER_BYTES = 20;

/// The row an entity has in this language, or nil when it has none.
export function openGroups(buffer) {
  if (!buffer || buffer.length < HEADER_BYTES || buffer.toString("utf8", 0, 8) !== MAGIC) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const byRowCount = view.getUint32(12, true);
  const byGroupCount = view.getUint32(16, true);
  const rowsAt = HEADER_BYTES;
  const groupsAt = rowsAt + byRowCount * 8;
  if (groupsAt + byGroupCount * 8 > buffer.byteLength) return null;

  /// The pair at `at` whose first field is the smallest one >= `wanted`, or nil.
  function seek(at, count, wanted) {
    let low = 0;
    let high = count - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const found = view.getUint32(at + mid * 8, true);
      if (found === wanted) return view.getUint32(at + mid * 8 + 4, true);
      if (found < wanted) low = mid + 1;
      else high = mid - 1;
    }
    return null;
  }

  return {
    byRowCount,
    byGroupCount,
    /// The entity a row belongs to, or 0 when it stands alone.
    groupOfRow: (rowIndex) => seek(rowsAt, byRowCount, rowIndex) ?? 0,
    /// The row an entity has in this language, or nil.
    rowOfGroup: (groupId) => seek(groupsAt, byGroupCount, groupId),
  };
}
