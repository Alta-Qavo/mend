# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Alta-Qavo/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Alta-Qavo/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format. It reads a patch written
by a model — a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, a V4A patch, or text-editor tool calls as JSON — turns it into one
written specification, finds the lines each edit names even when the model
drifted the whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22, standard library only. `PATCH` is a path relative to the working
directory (the root of the tree); when it is absent or `-`, the patch is
read from standard input. `--format` is one of `auto` (the default),
`unified`, `search-replace`, `v4a` or `json`. `--check` does everything but
write. `--strict` matches lines exactly.

## What it does

- **Four readers, one contract.** Unified diffs (sections from
  `diff --git` or `---`/`+++`, renames, creates, deletes, moves, hunks
  found by nearest occurrence to the stated line number, corrected by the
  cumulative length delta), SEARCH/REPLACE blocks (path from the nearest
  line above the block, or the previous block's path), V4A patches
  (Add/Delete/Update sections, anchored chunks, a cursor that only moves
  forward, `*** End of File` chunks), and JSON edits (array or JSON Lines:
  `create`, `str_replace`, `insert`).
- **Three-tier matching.** An old block is found at the first tier where
  it occurs: exact lines, then lines equal once trailing spaces and tabs
  are removed, then lines equal once leading and trailing spaces and tabs
  are removed. `--strict` tries the first tier only. Context lines are
  always written as the file's own lines, and at tier 2 every other new
  line is re-indented from the old block's leading whitespace to the
  file's.
- **Every file or none.** Edits apply in patch order to the tree as
  earlier edits left it. A failed edit changes nothing, later edits still
  run, every failure is reported, and when any edit failed no file is
  written at all.
- **Faithful bytes.** A changed file keeps its own line break (CRLF or
  LF) and its final line break, except where the spec says a unified hunk
  decides it. Created files use LF. Paths are checked safe before anything
  else about an edit.

Exit codes and output follow `SPEC.md` exactly: exit 2 for usage,
missing patch, undetected format or a parse fault (with the patch line
that faulted); exit 1 with one `error: <code> <path>` line per failed
edit and a `failed: <k> of <n> edits` line; exit 0 with one line per
changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move, sorted by
path in UTF-8 byte order) and an `ok: <n> files` line.

## Files

- `main.ts` — the whole tool.
- `runner.ts` — the kit's trial runner, kept as shipped.
- `check.ts` — runs the kit's practice set against `main.ts`.
- `SPEC.md` — the full specification this tool implements.

## Checks

```sh
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

Practice: **100 of 100 passed (score 1000)**. On top of that, an
adversarial suite of 183 hand-written checks — one per sentence of
`SPEC.md`, covering CRLF, empty files, files without a final
line break, duplicate anchors, out-of-order hunks, wrong line numbers,
unsafe paths, chained moves, creates followed by edits in the same
patch, `--check` writing nothing, `--strict`, stdin patches, wrong
explicit formats, JSON array vs JSON Lines, anchors that are not there,
and every parse-fault line number — also passes 183 of 183.
