// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old, new]. */
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** Section 5: a file's lines, its line break, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  endsWithBreak: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const endsWithBreak = text.endsWith(br);
  if (endsWithBreak) lines.pop();
  return { lines, br, endsWithBreak };
}

function serialize(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.endsWithBreak ? doc.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** 0-based positions where O occurs in lines at tier; occurrences may overlap. */
function findOccurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, or -1. */
function matchTier(lines: string[], o: string[], strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) if (findOccurrences(lines, o, t).length > 0) return t;
  return -1;
}

/**
 * Build N with context lines taken from the file's own matched lines and, at
 * tier 2, the other lines re-indented from O's first line to the file's.
 * ctx[i] is the index into O of N[i] when N[i] is a context line, else null.
 */
function buildNew(n: string[], ctx: (number | null)[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? leadingWs(fileLines[pos] ?? '') : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  for (let i = 0; i < n.length; i++) {
    const c = ctx[i];
    if (c !== null && c !== undefined) {
      out.push(fileLines[pos + c]!);
      continue;
    }
    let line = n[i]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
    out.push(line);
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 6: one hunk of a unified diff. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** A `\` line followed this body line. */
  noNL: boolean;
}
interface Hunk {
  /** A from `@@ -A[,B] +C[,D] @@`. */
  a: number;
  body: BodyLine[];
}

/** O is the hunk's context and `-` lines, N its context and `+` lines, in body order. */
function hunkLines(hunk: Hunk): { o: string[]; n: string[]; ctx: (number | null)[]; lastNoNL: boolean } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: (number | null)[] = [];
  for (const e of hunk.body) {
    if (e.kind === 'ctx') {
      ctx.push(o.length);
      o.push(e.text);
      n.push(e.text);
    } else if (e.kind === 'del') o.push(e.text);
    else {
      ctx.push(null);
      n.push(e.text);
    }
  }
  let lastNoNL = false;
  for (let i = hunk.body.length - 1; i >= 0; i--) {
    const e = hunk.body[i]!;
    if (e.kind === 'ctx' || e.kind === 'add') {
      lastNoNL = e.noNL;
      break;
    }
  }
  return { o, n, ctx, lastNoNL };
}

/** Apply one hunk to a file; d is the net length change of this section's earlier hunks. */
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean, path: string): FileDoc {
  const { o, n, ctx, lastNoNL } = hunkLines(hunk);
  let lines: string[];
  let touchesEnd: boolean;
  if (o.length > 0) {
    const tier = matchTier(doc.lines, o, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occs = findOccurrences(doc.lines, o, tier);
    const target = hunk.a - 1 + d;
    let pos = occs[0]!;
    let best = Math.abs(pos - target);
    for (const q of occs) {
      const dist = Math.abs(q - target);
      if (dist < best) {
        best = dist;
        pos = q;
      }
    }
    const rep = buildNew(n, ctx, doc.lines, pos, o, tier);
    lines = [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + o.length)];
    touchesEnd = pos + o.length === doc.lines.length;
  } else {
    const at = Math.max(0, Math.min(hunk.a + d, doc.lines.length));
    const rep = buildNew(n, ctx, doc.lines, at, o, -1);
    lines = [...doc.lines.slice(0, at), ...rep, ...doc.lines.slice(at)];
    touchesEnd = at === doc.lines.length;
  }
  return { lines, br: doc.br, endsWithBreak: touchesEnd ? !lastNoNL : doc.endsWithBreak };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one hunk starting at lines[i]; returns it and the index just past its body. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const hunk: Hunk = { a: Number(m[1]), body: [] };
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ')) {
      hunk.body.push({ kind: 'ctx', text: l.slice(1), noNL: false });
      j++;
    } else if (l.startsWith('-')) {
      hunk.body.push({ kind: 'del', text: l.slice(1), noNL: false });
      j++;
    } else if (l.startsWith('+')) {
      hunk.body.push({ kind: 'add', text: l.slice(1), noNL: false });
      j++;
    } else if (l.startsWith('\\')) {
      const prev = hunk.body[hunk.body.length - 1];
      if (prev !== undefined) prev.noNL = true;
      j++;
    } else if (l === '') {
      hunk.body.push({ kind: 'ctx', text: '', noNL: false });
      j++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (hunk.body.length > 0) {
    const last = hunk.body[hunk.body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
    else break;
  }
  return { hunk, next: j };
}

/** The path a `--- ` / `+++ ` header line names (null: /dev/null). */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Section 6: one section of a unified diff is one edit. */
interface Section {
  /** undefined: not named; null: /dev/null. */
  oldP: string | null | undefined;
  newP: string | null | undefined;
  /** A `--- ` / `+++ ` pair named the paths. */
  pair: boolean;
  renFrom: boolean;
  renTo: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** Read a unified patch into edits (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice(11);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const sep = rest.indexOf(' b/', 2);
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      const x = rest.slice(2, sep);
      const y = rest.slice(sep + 3).trim();
      if (x === '' || y === '') throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldP: x, newP: y, pair: false, renFrom: false, renTo: false, create: false, del: false, hunks: [] };
      sections.push(sec);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && inHeader && !sec.pair) {
        sec.oldP = headerPath(l);
        sec.newP = headerPath(lines[i + 1]!);
        sec.pair = true;
      } else {
        sec = { oldP: headerPath(l), newP: headerPath(lines[i + 1]!), pair: true, renFrom: false, renTo: false, create: false, del: false, hunks: [] };
        sections.push(sec);
      }
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && sec !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i);
      sec.hunks.push(r.hunk);
      inHeader = false;
      i = r.next;
      continue;
    }
    if (sec !== null && inHeader) {
      if (l.startsWith('rename from ')) {
        if (!sec.pair && !sec.renFrom) {
          sec.oldP = l.slice(12).trim();
          sec.renFrom = true;
        }
      } else if (l.startsWith('rename to ')) {
        if (!sec.pair && !sec.renTo) {
          sec.newP = l.slice(10).trim();
          sec.renTo = true;
        }
      } else if (l.startsWith('new file mode')) sec.create = true;
      else if (l.startsWith('deleted file mode')) sec.del = true;
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: and any other line are ignored.
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

/** One section's edit: creation, deletion, move or change. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.oldP === undefined ? sec.newP : sec.oldP;
  const newP = sec.newP === undefined ? sec.oldP : sec.newP;
  return (tree) => {
    // Section 10: every path the edit names is checked for safety first, old then new.
    if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.create;
    const isDelete = !isCreate && (newP === null || sec.del);
    if (isCreate) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastNoNL = false;
      for (const h of sec.hunks) for (const e of h.body) if (e.kind === 'add') plus.push(e.text);
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let ei = body.length - 1; ei >= 0; ei--) {
          if (body[ei]!.kind === 'add') {
            lastNoNL = body[ei]!.noNL;
            break outer;
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : `${plus.join('\n')}${lastNoNL ? '' : '\n'}`);
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (op !== np) {
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let doc = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        const { o, n } = hunkLines(h);
        doc = applyHunk(doc, h, d, strict, op);
        d += n.length - o.length;
      }
      tree.now.set(np, serialize(doc));
      tree.now.set(op, null);
      tree.moves.push({ old: op, nw: np });
      return;
    }
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    let doc = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = hunkLines(h);
      doc = applyHunk(doc, h, d, strict, op);
      d += n.length - o.length;
    }
    tree.now.set(op, serialize(doc));
  };
}

/** Section 7: one SEARCH/REPLACE block. */
interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

/** Read a SEARCH/REPLACE patch into edits (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1; // 0-based index of the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // Path: nearest suitable line before SEARCH, after the previous block.
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    // Find =======, then >>>>>>> REPLACE, before the next SEARCH or the end.
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j]!.trimEnd();
      if (m === '=======') {
        eq = j;
        break;
      }
      if (m === '>>>>>>> REPLACE' || m === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const m = lines[j]!.trimEnd();
      if (m === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (m === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, old: lines.slice(i + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

/** One SEARCH/REPLACE block's edit: create, or replace its old lines. */
function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : `${b.nw.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const doc = parseFile(before);
    const tier = matchTier(doc.lines, b.old, strict);
    if (tier < 0) throw new Fail('no-match', b.path);
    const occs = findOccurrences(doc.lines, b.old, tier);
    if (occs.length > 1) throw new Fail('ambiguous', b.path);
    const pos = occs[0]!;
    // No context line here, so every new line takes the tier 2 re-indent rule.
    const rep = buildNew(b.nw, b.nw.map(() => null), doc.lines, pos, b.old, tier);
    tree.now.set(b.path, serialize({ lines: [...doc.lines.slice(0, pos), ...rep, ...doc.lines.slice(pos + b.old.length)], br: doc.br, endsWithBreak: doc.endsWithBreak }));
  };
}

/** Section 8: one chunk of an Update File section. */
interface V4Chunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ kind: 'ctx' | 'del' | 'add'; text: string }>;
}

/** Section 8: one Add / Delete / Update File section is one edit. */
interface V4Section {
  kind: 'add' | 'del' | 'update';
  path: string;
  headerLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4Chunk[];
}

const V4_ADD = '*** Add File: ';
const V4_DEL = '*** Delete File: ';
const V4_UPD = '*** Update File: ';
const V4_MOVE = '*** Move to: ';

/** Read a V4A patch into edits (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4Section[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let sec: V4Section | null = null;
    if (l.startsWith(V4_ADD)) sec = { kind: 'add', path: l.slice(V4_ADD.length).trim(), headerLine: i + 1, addLines: [], moveTo: null, chunks: [] };
    else if (l.startsWith(V4_DEL)) sec = { kind: 'del', path: l.slice(V4_DEL.length).trim(), headerLine: i + 1, addLines: [], moveTo: null, chunks: [] };
    else if (l.startsWith(V4_UPD)) sec = { kind: 'update', path: l.slice(V4_UPD.length).trim(), headerLine: i + 1, addLines: [], moveTo: null, chunks: [] };
    else throw new Exit2(`error: parse ${i + 1}`);
    sections.push(sec);
    i++;
    if (sec.kind === 'add') {
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith(V4_ADD) || b.startsWith(V4_DEL) || b.startsWith(V4_UPD)) break;
        if (b.startsWith('+')) {
          sec.addLines.push(b.slice(1));
          i++;
        } else if (blank(b)) {
          sec.addLines.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1] === '') sec.addLines.pop();
    } else if (sec.kind === 'del') {
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith(V4_ADD) || b.startsWith(V4_DEL) || b.startsWith(V4_UPD)) break;
        if (blank(b)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
    } else {
      if (i < last && lines[i]!.startsWith(V4_MOVE)) {
        sec.moveTo = lines[i]!.slice(V4_MOVE.length).trim();
        i++;
      }
      let cur: V4Chunk | null = null;
      const push = (): void => {
        if (cur !== null) {
          sec!.chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith(V4_ADD) || b.startsWith(V4_DEL) || b.startsWith(V4_UPD)) break;
        if (b.startsWith('@@')) {
          push();
          const anchor = b.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          i++;
        } else if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          push();
          i++;
        } else if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || blank(b)) {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push(b === '' ? { kind: 'ctx', text: '' } : b.startsWith(' ') ? { kind: 'ctx', text: b.slice(1) } : b.startsWith('-') ? { kind: 'del', text: b.slice(1) } : { kind: 'add', text: b.slice(1) });
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      push();
      // Blank lines at the end of the section are not part of it.
      const lc = sec.chunks[sec.chunks.length - 1];
      if (lc !== undefined) {
        while (lc.body.length > 0) {
          const e = lc.body[lc.body.length - 1]!;
          if (e.kind === 'ctx' && e.text === '') lc.body.pop();
          else break;
        }
        if (lc.body.length === 0 && lc.anchor === null && !lc.eof) sec.chunks.pop();
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.headerLine}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4Edit(s, strict));
}

/** O is the chunk's context and `-` lines, N its context and `+` lines. */
function chunkLines(c: V4Chunk): { o: string[]; n: string[]; ctx: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: (number | null)[] = [];
  for (const e of c.body) {
    if (e.kind === 'ctx') {
      ctx.push(o.length);
      o.push(e.text);
      n.push(e.text);
    } else if (e.kind === 'del') o.push(e.text);
    else {
      ctx.push(null);
      n.push(e.text);
    }
  }
  return { o, n, ctx };
}

/** First line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = from; k < lines.length; k++) {
      if (lineEq(lines[k]!, anchor, t)) return k;
    }
  }
  return -1;
}

/** Apply one V4A chunk; the cursor moves to just after the lines written. */
function applyV4Chunk(doc: FileDoc, chunk: V4Chunk, cursor: number, strict: boolean, path: string): { doc: FileDoc; cursor: number } {
  let lines = doc.lines;
  let cur = cursor;
  if (chunk.anchor !== null) {
    const at = findAnchor(lines, chunk.anchor, cur, strict);
    if (at < 0) throw new Fail('no-match', path);
    cur = at + 1;
  }
  const { o, n, ctx } = chunkLines(chunk);
  if (o.length === 0) {
    const at = chunk.eof ? lines.length : cur;
    const rep = buildNew(n, ctx, lines, at, o, -1);
    lines = [...lines.slice(0, at), ...rep, ...lines.slice(at)];
    return { doc: { lines, br: doc.br, endsWithBreak: doc.endsWithBreak }, cursor: at + rep.length };
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let tier = -1;
  let pos = -1;
  for (const t of tiers) {
    const occs = findOccurrences(lines, o, t).filter((p) => p >= cur && (!chunk.eof || p + o.length === lines.length));
    if (occs.length > 0) {
      tier = t;
      pos = occs[0]!;
      break;
    }
  }
  if (tier < 0) throw new Fail('no-match', path);
  const rep = buildNew(n, ctx, lines, pos, o, tier);
  lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
  return { doc: { lines, br: doc.br, endsWithBreak: doc.endsWithBreak }, cursor: pos + rep.length };
}

/** One V4A section's edit: add, delete, or update (with an optional move). */
function v4Edit(sec: V4Section, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : `${sec.addLines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let doc = parseFile(before);
    let cursor = 0;
    for (const c of sec.chunks) {
      const r = applyV4Chunk(doc, c, cursor, strict, sec.path);
      doc = r.doc;
      cursor = r.cursor;
    }
    const out = serialize(doc);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push({ old: sec.path, nw: sec.moveTo });
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byPath = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byPath)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const changed = new Map<string, string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const m of tree.moves) {
    if (tree.original(m.old) === null) continue;
    if (tree.get(m.old) !== null) continue;
    if (tree.original(m.nw) !== null) continue;
    if (tree.get(m.nw) === null) continue;
    if (changed.get(m.old) !== `D ${m.old}`) continue;
    if (changed.get(m.nw) !== `A ${m.nw}`) continue;
    changed.delete(m.old);
    changed.delete(m.nw);
    changed.set(m.nw, `R ${m.old} -> ${m.nw}`);
  }
  const rows = [...changed.entries()].sort((a, b) => byPath(a[0], b[0])).map((e) => e[1]);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
