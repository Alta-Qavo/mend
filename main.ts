// mend: one patch tool for every AI edit format.
// Reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the
// lines each edit names at the first of three matching tiers, and writes
// every change or none. Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

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

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function isDirPath(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when a parent component of p is a file in the tree (so p can never be written). */
function parentIsFile(p: string, tree: Tree): boolean {
  const parts = p.split('/');
  for (let k = 1; k < parts.length; k += 1) {
    if (tree.get(parts.slice(0, k).join('/')) !== null) return true;
  }
  return false;
}

function existsTarget(p: string, tree: Tree): boolean {
  if (tree.get(p) !== null || isDirPath(p) || parentIsFile(p, tree)) return true;
  const prefix = `${p}/`;
  for (const [k, v] of tree.now) {
    if (v !== null && k.startsWith(prefix)) return true;
  }
  return false;
}

function byteLess(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines: its own break, its lines, whether it ends with a break. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** One edit: applies itself to the tree, or throws Fail. `move` names a move it made. */
interface Edit {
  run: (tree: Tree) => void;
  move?: { old: string; next: string };
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

const normLine = (s: string, tier: number): string => {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
};

/** All positions where old matches lines at one tier (occurrences may overlap). */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length) return out;
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which old occurs at least once, with its positions, or null. */
function firstTier(lines: string[], old: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, old, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** Tier-2 re-indent of one new line: P (old first line's leading ws) becomes F (file's). */
function reindent(line: string, fileFirst: string, oldFirst: string): string {
  if (line === '' || line.trim() === '') return line;
  const f = leadingWs(fileFirst);
  const p = leadingWs(oldFirst);
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/**
 * One line of a replacement: either a context line (written as the file's own
 * matched line, at ctxIndex into the matched block) or a fresh line.
 */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Map replacement lines onto the file at pos, honouring context lines and tier 2. */
function mapNew(nlines: NewLine[], fileLines: string[], pos: number, old: string[], tier: number): string[] {
  if (tier !== 2) return nlines.map((n) => (n.ctx !== null ? fileLines[pos + n.ctx]! : n.text));
  const fileFirst = fileLines[pos]!;
  const oldFirst = old[0]!;
  return nlines.map((n) => {
    if (n.ctx !== null) return fileLines[pos + n.ctx]!;
    return reindent(n.text, fileFirst, oldFirst);
  });
}

/** Replace old (at pos) by the mapped new lines, in place on the model. */
function spliceReplace(m: FileModel, pos: number, oldLen: number, nlines: NewLine[], old: string[], tier: number): void {
  const mapped = mapNew(nlines, m.lines, pos, old, tier);
  m.lines.splice(pos, oldLen, ...mapped);
}

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return {
      run(tree) {
        if (!safePath(p)) throw new Fail('unsafe', p);
        if (existsTarget(p, tree)) throw new Fail('exists', p);
        tree.now.set(p, text);
      },
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      run(tree) {
        const before = existing(tree);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = flat(before);
        const old = flat(oldStr);
        let count = 0;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
        if (count === 0) throw new Fail('no-match', p);
        if (count > 1) throw new Fail('ambiguous', p);
        const at = t.indexOf(old);
        const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
        tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return {
      run(tree) {
        const before = existing(tree);
        const m = parseFile(before);
        if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
        m.lines.splice(line, 0, ...add);
        tree.now.set(p, serializeFile(m));
      },
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

/* ---------------- unified diffs ---------------- */

type BodyItem = { kind: 'ctx' | 'del' | 'add' | 'mark'; text: string };

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface UniSection {
  diffOld?: string;
  diffNew?: string;
  dashOld?: string | null;
  dashNew?: string | null;
  renOld?: string;
  renNew?: string;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
  startLine: number;
  /** Deletion section past its first hunk line: hunks are not read at all. */
  skipHunks?: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const body: BodyItem[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1) });
      j += 1;
    } else if (c === '-') {
      body.push({ kind: 'del', text: l.slice(1) });
      j += 1;
    } else if (c === '+') {
      body.push({ kind: 'add', text: l.slice(1) });
      j += 1;
    } else if (c === '\\') {
      body.push({ kind: 'mark', text: l });
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  return { hunk: { a: Number.parseInt(m[1]!, 10), body }, next: j };
}

/** Old lines and replacement lines of a hunk/chunk body. */
function oldNew(body: BodyItem[]): { old: string[]; nlines: NewLine[] } {
  const old: string[] = [];
  const nlines: NewLine[] = [];
  for (const it of body) {
    if (it.kind === 'ctx') {
      old.push(it.text);
      nlines.push({ text: it.text, ctx: old.length - 1 });
    } else if (it.kind === 'del') {
      old.push(it.text);
    } else if (it.kind === 'add') {
      nlines.push({ text: it.text, ctx: null });
    }
  }
  return { old, nlines };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: BodyItem[]): boolean {
  let lastNew = -1;
  for (let k = 0; k < body.length; k += 1) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'add') lastNew = k;
  }
  if (lastNew < 0) return false;
  return body[lastNew + 1] !== undefined && body[lastNew + 1]!.kind === 'mark';
}

function parseDashPair(lines: string[], i: number): { old: string | null; next: string | null } {
  const cut = (s: string): string => {
    const t = s.split('\t')[0]!;
    return t.trim();
  };
  const strip = (p: string): string | null => {
    if (p === '/dev/null') return null;
    if (p.startsWith('a/')) return p.slice(2);
    if (p.startsWith('b/')) return p.slice(2);
    return p;
  };
  const oldRaw = cut(lines[i]!.slice(4));
  const newRaw = cut(lines[i + 1]!.slice(4));
  return { old: strip(oldRaw), next: strip(newRaw) };
}

/** Whether a section is a deletion, from its header alone (mirrors unifiedEdit). */
function sectionIsDelete(sec: UniSection): boolean {
  const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renOld !== undefined ? sec.renOld : sec.diffOld;
  const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renNew !== undefined ? sec.renNew : sec.diffNew;
  const oldPath = oldP === undefined ? newP : oldP;
  const newPath = newP === undefined ? oldP : newP;
  if (oldPath === undefined || newPath === undefined) return false;
  const isCreate = sec.createFlag || oldPath === null;
  return !isCreate && (sec.delFlag || newPath === null);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  const startSection = (startLine: number): UniSection => {
    const s: UniSection = { createFlag: false, delFlag: false, hunks: [], startLine };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection(i + 1);
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = startSection(i + 1);
        const p = parseDashPair(lines, i);
        s.dashOld = p.old;
        s.dashNew = p.next;
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (cur.skipHunks) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = startSection(i + 1);
        const p = parseDashPair(lines, i);
        s.dashOld = p.old;
        s.dashNew = p.next;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (cur.hunks.length === 0) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.dashOld !== undefined) {
            const s = startSection(i + 1);
            const p = parseDashPair(lines, i);
            s.dashOld = p.old;
            s.dashNew = p.next;
          } else {
            const p = parseDashPair(lines, i);
            cur.dashOld = p.old;
            cur.dashNew = p.next;
          }
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.createFlag = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delFlag = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        if (sectionIsDelete(cur)) {
          cur.skipHunks = true;
          i += 1;
          continue;
        }
        const r = parseHunk(lines, i);
        cur.hunks.push(r.hunk);
        i = r.next;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection(i + 1);
      const p = parseDashPair(lines, i);
      s.dashOld = p.old;
      s.dashNew = p.next;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renOld !== undefined ? sec.renOld : sec.diffOld;
  const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renNew !== undefined ? sec.renNew : sec.diffNew;
  const oldPath = oldP === undefined ? newP : oldP;
  const newPath = newP === undefined ? oldP : newP;
  if (oldPath === undefined || newPath === undefined) throw new Exit2(`error: parse ${sec.startLine}`);
  const isCreate = sec.createFlag || oldPath === null;
  const isDelete = !isCreate && (sec.delFlag || newPath === null);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  const path = (isCreate ? newPath : oldPath) as string;
  if (isCreate && newPath === null) throw new Exit2(`error: parse ${sec.startLine}`);
  if (isDelete && oldPath === null) throw new Exit2(`error: parse ${sec.startLine}`);
  const applyHunks = (tree: Tree, source: string): string => {
    const cur = tree.get(source);
    if (cur === null) throw new Fail('missing', source);
    const m = parseFile(cur);
    let d = 0;
    for (const hunk of sec.hunks) {
      const { old, nlines } = oldNew(hunk.body);
      if (old.length > 0) {
        const found = firstTier(m.lines, old, strict);
        if (found === null) throw new Fail('no-match', source);
        const target = hunk.a - 1 + d;
        let pos = found.occ[0]!;
        let best = Math.abs(pos - target);
        for (const o of found.occ) {
          const dist = Math.abs(o - target);
          if (dist < best) {
            best = dist;
            pos = o;
          }
        }
        const touchesEnd = pos + old.length === m.lines.length;
        spliceReplace(m, pos, old.length, nlines, old, found.tier);
        if (touchesEnd) m.final = !hunkNoEol(hunk.body);
        d += nlines.length - old.length;
      } else {
        const at = Math.min(Math.max(hunk.a + d, 0), m.lines.length);
        const touchesEnd = at === m.lines.length;
        m.lines.splice(at, 0, ...nlines.map((n) => n.text));
        if (touchesEnd) m.final = !hunkNoEol(hunk.body);
        d += nlines.length;
      }
    }
    return serializeFile(m);
  };
  if (isCreate) {
    return {
      run(tree) {
        if (!safePath(path)) throw new Fail('unsafe', path);
        if (existsTarget(path, tree)) throw new Fail('exists', path);
        const made: string[] = [];
        for (const hunk of sec.hunks) {
          for (const it of hunk.body) if (it.kind === 'add') made.push(it.text);
        }
        let noEol = false;
        const flat: BodyItem[] = [];
        for (const hunk of sec.hunks) flat.push(...hunk.body);
        let lastAdd = -1;
        for (let k = 0; k < flat.length; k += 1) if (flat[k]!.kind === 'add') lastAdd = k;
        if (lastAdd >= 0 && flat[lastAdd + 1] !== undefined && flat[lastAdd + 1]!.kind === 'mark') noEol = true;
        tree.now.set(path, made.length === 0 ? '' : made.join('\n') + (noEol ? '' : '\n'));
      },
    };
  }
  if (isDelete) {
    return {
      run(tree) {
        if (!safePath(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      },
    };
  }
  if (isMove) {
    const oldS = oldPath as string;
    const newS = newPath as string;
    return {
      move: { old: oldS, next: newS },
      run(tree) {
        if (!safePath(oldS)) throw new Fail('unsafe', oldS);
        if (!safePath(newS)) throw new Fail('unsafe', newS);
        if (tree.get(oldS) === null) throw new Fail('missing', oldS);
        if (existsTarget(newS, tree)) throw new Fail('exists', newS);
        const out = applyHunks(tree, oldS);
        tree.now.set(oldS, null);
        tree.now.set(newS, out);
      },
    };
  }
  return {
    run(tree) {
      if (!safePath(path)) throw new Fail('unsafe', path);
      const out = applyHunks(tree, path);
      tree.now.set(path, out);
    },
  };
}

/* ---------------- SEARCH/REPLACE blocks ---------------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push({
      run(tree) {
        if (!safePath(path!)) throw new Fail('unsafe', path!);
        if (oldLines.length === 0) {
          if (existsTarget(path!, tree)) throw new Fail('exists', path!);
          tree.now.set(path!, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
          return;
        }
        const cur = tree.get(path!);
        if (cur === null) throw new Fail('missing', path!);
        const m = parseFile(cur);
        const found = firstTier(m.lines, oldLines, strict);
        if (found === null) throw new Fail('no-match', path!);
        if (found.occ.length > 1) throw new Fail('ambiguous', path!);
        const pos = found.occ[0]!;
        const nlines: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
        spliceReplace(m, pos, oldLines.length, nlines, oldLines, found.tier);
        tree.now.set(path!, serializeFile(m));
      },
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------- V4A patches ---------------- */

interface V4Chunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

interface V4Section {
  kind: 'add' | 'del' | 'update';
  path: string;
  moveTo?: string;
  addLines?: string[];
  chunks?: V4Chunk[];
  headLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isHead = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isHead(l)) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const made: string[] = [];
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (isHead(b)) break;
        if (b.startsWith('+')) {
          made.push(b.slice(1));
          i += 1;
        } else if (blank(b)) {
          made.push('');
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (made.length > 0 && made[made.length - 1] === '') made.pop();
      edits.push({
        run(tree) {
          if (!safePath(path)) throw new Fail('unsafe', path);
          if (existsTarget(path, tree)) throw new Fail('exists', path);
          tree.now.set(path, made.length === 0 ? '' : made.join('\n') + '\n');
        },
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (isHead(b)) break;
        if (blank(b)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push({
        run(tree) {
          if (!safePath(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        },
      });
      continue;
    }
    const path = l.slice(17).trim();
    i += 1;
    let moveTo: string | undefined;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice(13).trim();
      i += 1;
    }
    const chunks: V4Chunk[] = [];
    let curChunk: V4Chunk | null = null;
    let started = false;
    let lastByEof = false;
    const pushChunk = (): void => {
      if (curChunk !== null) {
        chunks.push(curChunk);
        curChunk = null;
      }
    };
    while (i < last) {
      const b = lines[i]!;
      if (isHead(b)) break;
      if (b.trim() === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
        curChunk.eof = true;
        pushChunk();
        lastByEof = true;
        i += 1;
        continue;
      }
      if (b.startsWith('@@')) {
        pushChunk();
        lastByEof = false;
        curChunk = { anchor: b.slice(2).trim() === '' ? null : b.slice(2).trim(), body: [], eof: false };
        started = true;
        i += 1;
        continue;
      }
      if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || blank(b)) {
        if (blank(b) && curChunk === null && started) {
          i += 1;
          continue;
        }
        if (curChunk === null) {
          if (started) throw new Exit2(`error: parse ${i + 1}`);
          curChunk = { anchor: null, body: [], eof: false };
          started = true;
        }
        lastByEof = false;
        if (b === '' || blank(b)) curChunk.body.push({ kind: 'ctx', text: '' });
        else if (b[0] === ' ') curChunk.body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') curChunk.body.push({ kind: 'del', text: b.slice(1) });
        else curChunk.body.push({ kind: 'add', text: b.slice(1) });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    pushChunk();
    if (!lastByEof && chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1]!;
      while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.kind === 'ctx' && lastChunk.body[lastChunk.body.length - 1]!.text === '') {
        lastChunk.body.pop();
      }
    }
    if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headLine}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | undefined, chunks: V4Chunk[], strict: boolean): Edit {
  const edit: Edit = {
    run(tree) {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (moveTo !== undefined && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      if (moveTo !== undefined && existsTarget(moveTo, tree)) throw new Fail('exists', moveTo);
      const m = parseFile(cur);
      let cursor = 0;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          let foundIdx = -1;
          for (const tier of tiers) {
            for (let j = cursor; j < m.lines.length; j += 1) {
              if (normLine(m.lines[j]!, tier) === normLine(chunk.anchor, tier)) {
                foundIdx = j;
                break;
              }
            }
            if (foundIdx >= 0) break;
          }
          if (foundIdx < 0) throw new Fail('no-match', path);
          cursor = foundIdx + 1;
        }
        const { old, nlines } = oldNew(chunk.body);
        if (old.length > 0) {
          let chosen: number | null = null;
          let tierUsed = 0;
          for (const tier of tiers) {
            const occ = occurrences(m.lines, old, tier).filter((o) => o >= cursor && (!chunk.eof || o + old.length === m.lines.length));
            if (occ.length > 0) {
              chosen = occ[0]!;
              tierUsed = tier;
              break;
            }
          }
          if (chosen === null) throw new Fail('no-match', path);
          spliceReplace(m, chosen, old.length, nlines, old, tierUsed);
          cursor = chosen + nlines.length;
        } else if (chunk.eof) {
          m.lines.splice(m.lines.length, 0, ...nlines.map((n) => n.text));
          cursor = m.lines.length;
        } else {
          m.lines.splice(cursor, 0, ...nlines.map((n) => n.text));
          cursor += nlines.length;
        }
      }
      const out = serializeFile(m);
      if (moveTo !== undefined) {
        tree.now.set(path, null);
        tree.now.set(moveTo, out);
      } else {
        tree.now.set(path, out);
      }
    },
  };
  if (moveTo !== undefined) edit.move = { old: path, next: moveTo };
  return edit;
}

/* ---------------- invocation, output, exit codes ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
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
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: { old: string; next: string }[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit.run(tree);
      if (edit.move !== undefined) moves.push(edit.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const entries: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const mv of moves) {
    if (used.has(mv.old) || used.has(mv.next)) continue;
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.next) === null && tree.get(mv.next) !== null) {
      entries.push({ key: mv.next, line: `R ${mv.old} -> ${mv.next}` });
      used.add(mv.old);
      used.add(mv.next);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteLess)) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => byteLess(a.key, b.key));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteLess)) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort(byteLess)) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
