// Loads the compact index artifact and serves two-stage search. Runs unmodified in JavaScriptCore
// (the extension runtime) and Node. In memory it keeps only the inverted index (terms + postings);
// the title/original pools and per-row metadata stay on disk and are paged only for candidate rows
// via positional reads (`readRange`), keeping this far below the ~500 MB a full in-memory load costs.

import { normalizeTerms } from "../movies/normalize.mjs";
import {
  MAGIC, VERSION, HEADER_BYTES, ROW_RECORD_BYTES, parseHeader, decodeRow,
} from "./index-format.mjs";
import { utf8Decode } from "./utf8.mjs";

/// Options: `load` — a function `(path, offset, byteLength) -> Promise<Uint8Array>` doing positional
/// reads. Node passes one backed by `fs`; the Tinycast runtime passes `readRange`. This indirection
/// keeps the class free of any runtime-specific import.
export class MovieIndex {
  constructor({ reader }) {
    this.reader = reader;
    this.rowCount = 0;
    this.termCount = 0;
    // in-memory inverted index (loaded fully at open())
    this.termOffsets = null; // Uint32Array: byte offset per term into termsBlob
    this.termsBlob = null; // Uint8Array: packed UTF-8 of every term
    this.termRanges = null; // Uint32Array: [start,end) per term into postings
    this.postings = null; // Uint32Array: row indices, ascending within each term
    // on-disk sections (paged)
    this.offRowMeta = 0;
    this.offTitlePool = 0;
    this.titlePoolBytes = 0;
    this.offOriginalPool = 0;
    this.originalPoolBytes = 0;
    this.offPosterPool = 0;
    this.posterPoolBytes = 0;
    this.offSuperseded = 0;
    // Stable keys this index replaces/removes (empty for a base index).
    this.supersededKeys = new Uint32Array(0);
  }

  /// Load the header + inverted index (postings is the bulk of the ~30 MB resident set).
  async open() {
    const headerBytes = await this.reader.load(0, HEADER_BYTES);
    const header = parseHeader(headerBytes);
    if (header.magic !== MAGIC) throw new Error("not a Tinycast movie index");
    if (header.version !== VERSION) throw new Error(`unsupported index version ${header.version}`);
    this.rowCount = header.rowCount;
    this.termCount = header.termCount;

    this.offRowMeta = header.offRowMeta;
    this.offTitlePool = header.offTitlePool;
    this.titlePoolBytes = header.titlePoolBytes;
    this.offOriginalPool = header.offOriginalPool;
    this.originalPoolBytes = header.originalPoolBytes;
    this.offPosterPool = header.offPosterPool;
    this.posterPoolBytes = header.posterPoolBytes;

    const termOffsetsBytes = await this.reader.load(header.offTermOffsets, this.termCount * 4);
    this.termOffsets = u32View(termOffsetsBytes);

    this.termsBlob = await this.reader.load(header.offTermsBlob, header.offTermRanges - header.offTermsBlob);

    const rangesBytes = await this.reader.load(header.offTermRanges, header.offPostings - header.offTermRanges);
    this.termRanges = u32View(rangesBytes);

    const postingsBytes = await this.reader.load(header.offPostings, header.postingsCount * 4);
    this.postings = u32View(postingsBytes);

    // Deltas carry the stable keys they replace/remove (empty for a base index).
    if (header.supersededCount > 0) {
      const bytes = await this.reader.load(header.offSuperseded, header.supersededCount * 4);
      this.supersededKeys = u32View(bytes);
    }
    return this;
  }

  /// The stable identity of a record: `id * 2 + mediaType`, matching how the store and deltas key
  /// records. Used to dedupe and to apply a delta's supersede list.
  static stableKey(mediaType, id) {
    return id * 2 + (mediaType === 1 ? 1 : 0);
  }

  static stableKeyOfRow(rec) {
    return MovieIndex.stableKey(rec.mediaType, rec.tmdbID);
  }

  // ── candidate retrieval ───────────────────────────────────────────────────────────────────────

  /// Fold + tokenize a query into terms.
  static queryTerms(query) {
    return normalizeTerms(query);
  }

  /// [start,end) into this.postings for all terms with the given folded prefix, or null.
  _termRange(foldedPrefix) {
    // Binary search: first index whose term >= prefix.
    let lo = 0, hi = this.termCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (comparePrefix(foldedPrefix, this._termAt(mid)) <= 0) hi = mid;
      else lo = mid + 1;
    }
    const first = lo;
    if (first >= this.termCount || !startsWith(this._termAt(first), foldedPrefix)) return null;
    // Binary search: first index whose term does NOT start with prefix.
    lo = first; hi = this.termCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (startsWith(this._termAt(mid), foldedPrefix)) lo = mid + 1;
      else hi = mid;
    }
    const last = lo - 1; // inclusive term index
    // The final term's range ends at the postings tail, which has no `termRanges` entry of its own.
    const end = last + 1 < this.termCount ? this.termRanges[(last + 1) * 2] : this.postings.length;
    return [this.termRanges[first * 2], end];
  }

  _termAt(i) {
    const start = this.termOffsets[i];
    const end = i + 1 < this.termCount ? this.termOffsets[i + 1] : this.termsBlob.length;
    return utf8Decode(this.termsBlob.slice(start, end));
  }

  /// Return up to `cap` candidate row indices for the folded query terms.
  ///
  /// Semantics: every term before the last must appear as an exact term in the title/original
  /// (intersection); the last term matches as a word PREFIX (its whole prefix range). This is the
  /// "conservative superset" contract: any movie whose folded title has `query[0..n-1]` exact and
  /// `query[n-1]` as a word prefix IS a candidate, so the reranker ranks without misses.
  ///
  /// Cost: single-word queries return the first `cap` rows of the prefix range directly (never
  /// materialising a huge prefix like "alien*" wholesale). Multi-word starts from the SMALLEST
  /// required-term range and keeps rows present in every other range and the last prefix range,
  /// stopping at `cap` — so a giant "2010*" range is never copied.
  /// Like `_termRange`, but returns one [start,end) per matching term. A prefix spanning several
  /// terms yields a concatenation that is NOT globally ascending, so membership must be tested
  /// against each term's slice separately — binary-searching the whole span would miss rows.
  _termRanges(foldedPrefix) {
    const span = this._termRange(foldedPrefix);
    if (!span) return [];
    const out = [];
    for (let i = span[0]; i < span[1]; ) {
      // Walk term by term; termRanges[i] holds each term's start, so skip to the next term's start.
      out.push([i, 0]);
      break;
    }
    // Derive term indices from the binary search rather than guessing: recompute the first/last term.
    let lo = 0, hi = this.termCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (comparePrefix(foldedPrefix, this._termAt(mid)) <= 0) hi = mid;
      else lo = mid + 1;
    }
    const first = lo;
    lo = first; hi = this.termCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (startsWith(this._termAt(mid), foldedPrefix)) lo = mid + 1;
      else hi = mid;
    }
    const last = lo - 1;
    const ranges = [];
    for (let t = first; t <= last; t++) {
      const start = this.termRanges[t * 2];
      const end = t + 1 < this.termCount ? this.termRanges[(t + 1) * 2] : this.postings.length;
      ranges.push([start, end]);
    }
    return ranges;
  }

  collectCandidates(queryTerms, cap) {
    const n = queryTerms.length;
    if (n === 0) return [];
    const lastRange = this._termRange(queryTerms[n - 1]);
    if (!lastRange) return [];

    if (n === 1) {
      // Every row in the span matches the prefix; take the first `cap` as a sample (deduped).
      const hi = Math.min(lastRange[1], lastRange[0] + cap);
      const out = new Array(hi - lastRange[0]);
      for (let p = lastRange[0], k = 0; p < hi; p++, k++) out[k] = this.postings[p];
      return dedupe(out);
    }

    const last = this._termRanges(queryTerms[n - 1]);
    if (last.length === 0) return [];

    const required = [];
    for (let t = 0; t < n - 1; t++) {
      const rs = this._termRanges(queryTerms[t]);
      if (rs.length === 0) return [];
      let size = 0;
      for (const [a, b] of rs) size += b - a;
      required.push({ rs, size });
    }
    // Every match contains all required terms, so scanning the smallest one is a superset.
    required.sort((a, b) => a.size - b.size);
    const base = required[0].rs;
    const others = required.slice(1).map((r) => r.rs);

    const out = [];
    outer:
    for (const [a, b] of base) {
      for (let p = a; p < b; p++) {
        const row = this.postings[p];
        let matches = true;
        for (const rs of others) {
          if (!unionHas(this.postings, row, rs)) {
            matches = false;
            break;
          }
        }
        if (!matches || !unionHas(this.postings, row, last)) continue;
        out.push(row);
        if (out.length >= cap) break outer;
      }
    }
    return dedupe(out);
  }

  // ── row decoding (paged) ──────────────────────────────────────────────────────────────────────

  /// Decode records for `indices` (row indices). Returns records in the same order as `indices`.
  ///
  /// Candidate rows are sparse (they can span the whole file), so reading one contiguous
  /// min..max span would fetch tens of MB for nothing; each row record is read individually (a
  /// persistent-handle positioned read is tens of microseconds, so ~50 of them is a millisecond).
  /// `indices` is assumed sorted ascending and duplicate-free (collectCandidates guarantees this).
  async readRows(indices) {
    if (indices.length === 0) return [];
    const out = new Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
      const row = indices[i];
      const bytes = await this.reader.load(this.offRowMeta + row * ROW_RECORD_BYTES, ROW_RECORD_BYTES);
      out[i] = decodeRow(new DataView(bytes.buffer, bytes.byteOffset), 0);
    }
    return out;
  }

  /// Decode the title text for a record.
  async readTitle(rec) {
    const bytes = await this.reader.load(this.offTitlePool + rec.titleOffset, rec.titleLength);
    return utf8Decode(bytes);
  }

  /// Decode the original-title text for a record.
  async readOriginal(rec) {
    const bytes = await this.reader.load(this.offOriginalPool + rec.originalOffset, rec.originalLength);
    return utf8Decode(bytes);
  }

  /// Decode a row's TMDB poster_path ("" when absent).
  async readPoster(rec) {
    if (rec.posterLength === 0) return "";
    const bytes = await this.reader.load(this.offPosterPool + rec.posterOffset, rec.posterLength);
    return utf8Decode(bytes);
  }

  /// Decode poster_paths for several records (paged, span-merged like readTitles).
  async readPosters(records) {
    const out = new Array(records.length);
    const spans = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.posterLength > 0) spans.push({ at: this.offPosterPool + rec.posterOffset, len: rec.posterLength, i });
    }
    spans.sort((a, b) => a.at - b.at);
    let s = 0;
    while (s < spans.length) {
      let e = s;
      let end = spans[s].at + spans[s].len;
      while (e + 1 < spans.length && spans[e + 1].at <= end) {
        e++;
        const cand = spans[e].at + spans[e].len;
        if (cand > end) end = cand;
      }
      const bytes = await this.reader.load(spans[s].at, end - spans[s].at);
      for (let k = s; k <= e; k++) {
        const sp = spans[k];
        out[sp.i] = utf8Decode(bytes.slice(sp.at - spans[s].at, sp.at - spans[s].at + sp.len));
      }
      s = e + 1;
    }
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = "";
    return out;
  }

  /// Decode both title and original title for every record in one pass, batching the pool reads into
  /// the fewest possible contiguous positional reads (each pread boundary-crossing is expensive).
  /// Returns two parallel arrays: `{ titles, originals }`.
  async readTitles(records) {
    // Collect (poolOffset, length, recordIndex, isTitle) spans.
    const spans = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.titleLength) {
        spans.push({ at: this.offTitlePool + rec.titleOffset, len: rec.titleLength, i, title: true });
      }
      // The title and original pools are independent, so their offsets are unrelated: an original is
      // present whenever it has bytes, not when its offset differs from the title's.
      if (rec.originalLength) {
        spans.push({ at: this.offOriginalPool + rec.originalOffset, len: rec.originalLength, i, title: false });
      }
    }
    spans.sort((a, b) => a.at - b.at);
    const titles = new Array(records.length);
    const originals = new Array(records.length);
    // Merge overlapping/adjacent spans into one contiguous pread, then decode per span.
    let s = 0;
    while (s < spans.length) {
      let e = s;
      let end = spans[s].at + spans[s].len;
      while (e + 1 < spans.length && spans[e + 1].at <= end) {
        e++;
        const cand = spans[e].at + spans[e].len;
        if (cand > end) end = cand;
      }
      const bytes = await this.reader.load(spans[s].at, end - spans[s].at);
      for (let k = s; k <= e; k++) {
        const sp = spans[k];
        const text = utf8Decode(bytes.slice(sp.at - spans[s].at, sp.at - spans[s].at + sp.len));
        if (sp.title) titles[sp.i] = text;
        else originals[sp.i] = text;
      }
      s = e + 1;
    }
    return { titles, originals };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function u32View(bytes) {
  return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

function comparePrefix(prefix, term) {
  const n = prefix.length < term.length ? prefix.length : term.length;
  for (let i = 0; i < n; i++) {
    const a = prefix.charCodeAt(i);
    const b = term.charCodeAt(i);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return prefix.length <= term.length ? 0 : 1;
}

function startsWith(term, prefix) {
  if (prefix.length > term.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (term.charCodeAt(i) !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/// Does `row` appear in postings[r0..r1)? Postings within a term block are sorted ascending, so this
/// is a binary search.
/// Membership in a union of per-term slices (each individually ascending).
function unionHas(postings, row, ranges) {
  for (const [a, b] of ranges) if (inRange(postings, row, a, b)) return true;
  return false;
}

/// A row can appear under two terms that share a prefix ("wire wired"), so drop duplicates.
function dedupe(rows) {
  if (rows.length < 2) return rows;
  rows.sort((a, b) => a - b);
  let w = 1;
  for (let i = 1; i < rows.length; i++) if (rows[i] !== rows[i - 1]) rows[w++] = rows[i];
  rows.length = w;
  return rows;
}

function inRange(postings, row, r0, r1) {
  let lo = r0;
  let hi = r1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = postings[mid];
    if (v === row) return true;
    if (v < row) lo = mid + 1;
    else hi = mid;
  }
  return false;
}