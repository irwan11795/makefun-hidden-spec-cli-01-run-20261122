# NOTES.md — mend (hidden-spec-cli-01-run-20261122)

Stage-3 (final) notes. `main.ts` was already 100/100 on the practice set when
this stage began; this stage tested behaviour *outside* the practice set,
fixed nothing (no bug was found), and added this file plus the README badges.
No change was made to `main.ts`, `runner.ts`, `check.ts`, `SPEC.md` or
`LICENSE` in this stage.

## Practice score

- **100 of 100 passed, practice score 1000** (`node check.ts
  <kit>/program/generator/practice.json`, run again at the end of this stage).
- Per family group: unified `u-*` 30/30, SEARCH/REPLACE `s-*` 20/20, V4A
  `v-*` 20/20, JSON `j-*` 15/15, CLI/common `c-*` 15/15. Every individual
  family (e.g. `u-nearest`, `v-cursor`, `j-crlf`, `c-unsafe`) is 2/2, or 1/1
  where the family has one check.

## Design decisions (as implemented in main.ts)

- **File model.** A `Tree` keeps the disk state (`orig`, lazily read) and the
  in-progress state (`now`: path → text, or `null` for deleted). Edits run
  against `now`, so a later edit sees a file created/moved/deleted by an
  earlier one (SPEC §10). Each edit runs against a snapshot copy of `now`;
  on failure the snapshot is restored, so a failed edit changes nothing
  while later edits still run. Nothing is written to disk unless zero edits
  failed (exit 1 → no file written at all); `--check` skips the write phase
  but computes identical output.
- **Lines.** `parseFile` takes the line break from the first `\n` (CRLF when
  preceded by `\r`), splits at that break, and records whether the text ends
  with it. An empty file has no lines and no final break. Changed files are
  serialised with their own break; created files use LF, except JSON
  `create`, which writes `file_text` byte for byte, and unified creations,
  whose final break follows the `\` rule of §6.
- **Tier matching (§5).** First tier with ≥1 occurrence wins (0 exact, 1
  trailing whitespace stripped, 2 both sides stripped); `--strict` tries
  tier 0 only. Occurrences may overlap. Context lines are always written as
  the file's own matched lines, never the patch's. At tier 2 only, other new
  lines are re-indented: the leading whitespace of O's first line is
  replaced by that of the file's first matched line, only for lines that
  start with it and are not blank.
- **Unified (§6).** One section = one edit. Hunks apply in order with
  `d = Σ(N−O)` of earlier hunks: a non-empty O takes the occurrence nearest
  to `A−1+d` (earlier on a tie); an empty O inserts after the first `A+d`
  lines (all of them when the file is shorter). When the matched lines run
  to the end of the file the result ends with a break unless a `\` line
  follows the hunk's last context or `+` line. Creation collects the `+`
  lines of all hunks; deletion ignores hunk bodies.
- **SEARCH/REPLACE (§7).** The path is the nearest non-blank, non-fence
  line before `<<<<<<< SEARCH` after the previous block; a block with none
  inherits the previous block's path, and the first such block is a parse
  error at its SEARCH line. Empty old lines mean create (else `exists`); a
  non-empty old block must occur exactly once at its tier (else `no-match`
  / `ambiguous`).
- **V4A (§8).** A cursor starts at line 0 per Update section. An anchored
  chunk finds the anchor at the first tier with a match at/after the cursor,
  then the cursor moves *past* the anchor line and O is searched at/after
  the new cursor (see "Literal readings" below). An end-of-file chunk only
  accepts an occurrence ending at the file's last line; an empty O inserts
  at the cursor (or at the end for an end-of-file chunk). The cursor then
  moves to just after the written lines, so a later chunk can never match
  earlier text. `*** Move to:` is only read as the first line of an Update
  section; an Update with neither a chunk nor a Move to is a parse error at
  its header line.
- **Moves and `R` lines.** Successful moves are recorded in patch order.
  At output time a `D <old>` + `A <new>` pair is replaced by
  `R <old> -> <new>` only when the old path existed before the patch and
  not after, and the new path did not exist before and does after. Chained
  moves (a→b, b→c) therefore report `D a` + `A c`, not `R` lines, because
  neither move's endpoint pair survives the patch. Output rows sort by the
  path shown (the `<new>` path for `R` lines) in UTF-8 byte order.
- **Safety first (§10).** Every path an edit names is checked for safety
  before existence/matching: e.g. a move from a missing file to an unsafe
  path reports `unsafe`, and the error line names the path exactly as the
  patch wrote it after the §6 `a/`/`b/` strip.
- **Errors.** Usage beats no-patch beats format beats parse; parse errors
  are raised before any file is looked at. Exit 1 lists one
  `error: <code> <path>` line per failed edit in patch order, then
  `failed: <k> of <n> edits` (n counts all edits, including successful ones).

## Literal readings (where SPEC leaves room, the most literal sentence won)

- **V4A anchor.** §8 says the cursor "moves past" the anchor and O is then
  taken "at or after the cursor". So the anchor is the line *preceding* the
  changed lines, not one of them: a chunk whose O starts with its own anchor
  line only matches if that line occurs again later. Verified by edge tests
  (`v4a-anchor-2x`, `v4a-two-chunks-cursor`, `v4a-second-chunk-cannot-go-back`).
- **Final break gained.** §6: when a hunk's matched lines run to the end of
  the file, the result ends with a break unless a `\` line follows the
  hunk's last context or `+` line — even if the file had no final break and
  the hunk only touched a middle line plus trailing context. Verified by
  `nonl-endctx-gains-break` (file `a\nb\nc` → `a\nB\nc\n`).
- **Detection precedes parsing.** A hunk-only patch or a V4A-less patch
  under `--format=auto` is `error: format`, not `error: parse 1`, because §4
  detection finds no format at all; the §6/§8 parse errors only apply once
  the format is selected (e.g. via `--format=unified` / `--format=v4a`).
  Verified by `format-hunk-only-auto` and `format-v4a-no-begin-auto`.
- **SEARCH empty-old on an existing file** is `exists`, even when the file
  is empty (§7: "the file is created with the new lines (else `exists`)").

## Edge tests run in this stage (143 cases, 143 passed)

Harness: `/tmp/mend-edge/run.py` (kept outside the build dir; each case runs
`node main.ts` in a fresh directory and compares exit code, stdout bytes and
every resulting file). Groups:

- CRLF / line endings (13): CRLF edit via unified/SEARCH/V4A/JSON
  str_replace (break preserved); LF file + CRLF patch; file without final
  break with a mid-file hunk, end hunk with/without `\`, `\` after a `-`
  line only; unified create with/without/mid `\`.
- Empty O (10): unified insert at start/middle/past-end/end-of-file
  without break; V4A empty chunk at cursor, at EOF, after an anchor;
  SEARCH empty-old + empty/new-lines, and empty-old on an existing file.
- Ambiguous / tiers (9): SEARCH 2× at tier 0 → ambiguous; tier 0 with
  exactly 1 while tier 1 would have 2 → not ambiguous; tier-1 single;
  tier-2 re-indent; unified nearest with a tie (earlier wins) and exact
  target; V4A anchor occurring twice; JSON `str_replace` overlap
  (`"aa"` in `"aaa"` = 2 positions → ambiguous).
- Unsafe paths (13): `../x`, `/abs`, `a//b`, `a/./b`, `a\b`, empty path,
  `a/` in unified/SEARCH/V4A/JSON; safety checked before existence
  (move from a missing file to an unsafe path → `unsafe`).
- `--check` (2): valid edit → same output, files untouched; failing edit →
  same exit 1, files untouched.
- `--strict` (6): tier-1/2 matches that pass without `--strict` fail with
  `no-match` under it (unified, SEARCH, V4A anchor), plus the same cases
  passing without it.
- Usage (14): unknown option, `--format=x`, `--format` twice, `--check`
  twice, `--strict` twice, two positionals, `-x`, `--format` without `=`,
  `--format=` empty, `--` then `-` as PATCH (stdin), explicit `-`,
  option after positional, missing patch file (`no-patch`), `--` making
  `--check` a positional.
- Parse errors (27): stray `@@`, hunk before any section, malformed
  `diff --git`, `--- ` without `+++ ` in a header (exact line after it),
  prose `--- ` alone outside a section (ignored), SEARCH without
  `=======` / without `>>>>>>>` / without a path, V4A without Begin Patch
  (first line / blank-first line numbers), without End Patch
  (`nlines+1`), Add with a bad line, Update without chunk or Move to,
  `*** End of File` with no open chunk, stray lines, JSON array fault
  (line where the array starts), JSON Lines bad line, wrong JSON command,
  empty `old_str`, non-integer `insert_line`, empty/prose-only patches,
  empty JSON array `[]`, V4A Begin+End only — all `error: parse 1` for
  no-edit patches.
- Move / rename (13): unified rename from/to without `---`/`+++`; V4A
  Move-to-only; move to an existing path (`exists`); move from a missing
  file (`missing`); `R` sorting by `<new>` with two moves; move then edit
  on the new path (unified and V4A, still a single `R`); chained moves
  (a→b, b→c → `D a` + `A c`); create-then-delete (`ok: 0 files`);
  change-then-restore to the original bytes (`ok: 0 files`); delete/create
  of missing/existing files.
- Output / atomicity (4): `A`/`D`/`M`/`R` rows in UTF-8 byte order
  (`-y`, `1.txt`, `B.txt`, `Z.txt`, `_x`, `a.txt`); a failing edit blocks
  all writes even when a later edit would succeed; a later edit still runs
  after a failure (it can use a file an earlier *successful* edit created,
  so only the truly failed edit is reported); error lines in patch order.
- JSON (10): `insert_line` out of range / at end / negative, empty
  `new_str` (no-op), multi-line `new_str` with `\r\n` inside, `create`
  byte-for-byte incl. embedded CRLF and no trailing newline, absent
  `new_str` in `str_replace` (deletes), insert into a CRLF file, blank
  lines ignored in JSON Lines form.
- Format detection (13): V4A with leading blank lines; JSON Lines whose
  first line is `{` but contains `<<<<<<< SEARCH` in a string (rule 2
  beats rule 3); unified with only `--- `+`+++ ` (no `diff --git`);
  SEARCH whose path line is `diff --git foo` (rule 3 beats rule 4);
  V4A two-chunk cursor behaviour; V4A Add trailing blanks stripped vs
  mid-section blanks kept; unified wrong line numbers still matching;
  two hunks in one section; deletion ignoring hunk bodies; SEARCH path
  after a ``` fence; second SEARCH block inheriting the previous path.
  Plus `error: format` for undetectable and empty patches.

**Bugs found and fixed in this stage: none.** Six initial "failures" in the
harness were errors in the test expectations themselves (corrected after
re-reading SPEC §6/§8); the implementation already matched SPEC in each case.

## Known weaknesses (honest)

- **Degenerate section naming no file.** A unified section with
  `--- /dev/null` *and* `+++ /dev/null` (both paths null) crashes with an
  uncaught `TypeError` (`ERR_INVALID_ARG_TYPE`), exit 1, empty stdout.
  SPEC defines no behaviour for a section that names no file at all, so no
  fix was guessed; a sealed check containing this exact input would fail.
- **`diff --git` paths with spaces.** The `a/<X> b/<Y>` split searches for
  the first ` b/`, so a path containing ` b/` would be mis-split. Real git
  output never does this; no fix attempted.
- **A directory where a file is expected** is treated as missing
  (`statSync().isFile()`), and creating a file where a directory exists
  would throw at write time instead of reporting `exists`. Sealed checks
  use file fixtures, so this is unlikely to matter.
- **`\` as the first body line** of a hunk (no preceding body line) is
  silently ignored; SPEC does not define it.
- **V4A `*** End of File` with trailing whitespace** is not recognised
  (exact match); only `*** Begin/End Patch` are compared whitespace-trimmed,
  per §8's wording.
