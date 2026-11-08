# Search semantics: local rows vs whole-file scan

Status: **CSV A2, log line-level and JSONL record-level full scan implemented**
Scope: CSV uses cell occurrences; log uses one result per matching line; JSONL uses one result
per non-empty raw record. diff still uses the older one-cell row search without a whole-file scan.

## Implemented CSV A2

```text
cell matcher
→ occurrence inside a cell
→ occurrence count
→ occurrence navigation
→ header excluded
→ full scan parses rows with the same matcher
→ 5,000 navigable occurrences, complete count retained
```

The active occurrence is highlighted separately from the other matches in the same row.
A phrase spanning two cells does not match. Raw CSV delimiters are not searchable from
the table view.

## Historical mismatch

Before A2, the preview had two search paths:

```text
local search  → parsed rows already in memory
full scan     → raw CSV text / file slices
```

They do not share the same match definition. The difference is larger than
“partial coverage”: the unit, the searched text, the count and the highlight all
differ.

## Previous mismatch (historical)

| Dimension | Local search | Whole-file scan |
|---|---|---|
| Unit | one result per row | one result per regex occurrence |
| Text | `row.join(' ')` | raw CSV text |
| Header | excluded (`view.body`) | included in the count; dropped from jump rows |
| Highlight | per cell via `Marked` | per cell; a raw match containing delimiters cannot be highlighted |
| Multiple hits in one row | one result | multiple results, possibly the same row repeated |
| `^` / `$` | start/end of each row | start/end of the whole text |
| Order | file order | file source starts at the current row and wraps |
| Delimiter / quotes | not searchable | searchable as raw text |

Two concrete examples:

```csv
foo,bar
```

- Local `foo bar` matches because cells are joined with a space; no cell
  contains `foo bar`, so no cell is highlighted.
- Full `foo,bar` can match the raw text; no cell contains the comma, so no cell
  is highlighted.

```csv
foo foo foo
```

- Local: one matching row.
- Full: three occurrences.

The full scan also counts a match in the header while `linesToRows` removes the
header from the navigable rows.

## Candidate semantics

### A. Cell match, row result (recommended)

- A row matches when any cell matches.
- Count and navigation use matching rows.
- Highlight every matching cell/occurrence inside the cell.
- Header is excluded.
- Full scan parses rows and applies the same cell predicate.

This matches spreadsheet / database-grid behavior, keeps count and navigation
on the same unit, and makes a block-count index straightforward.

Tradeoff: a query spanning two cells no longer matches, and raw CSV delimiters
are not searchable from the table view.

### B. Row join, row result

- Preserve `row.join(' ')`; one result per row.
- Full scan must parse rows and use the same joined text.

This is closest to the current local behavior, but retains matches that do not
exist in any single cell and cannot be highlighted accurately.

### C. Raw text, occurrence result

- Search the raw CSV text; count occurrences.
- Full fidelity to file bytes, but table highlighting cannot express cross-row
  or delimiter matches, and block boundaries need overlap handling.

Not recommended as the table view’s default.

## Peer behavior (summary)

- Text editors (VS Code, Vim, JetBrains editor find): whole buffer, occurrence
  count, navigate occurrences. They do not mix a local-row count with a raw
  occurrence count.
- Line tools (grep / ripgrep): one result per matching line; occurrence counting
  is a separate mode.
- Spreadsheets / grids: cell-based find; one result per matching cell, or a row
  containing a cell.
- Large-file viewers: stream, show progress, do not present a partial count as a
  complete total.

## Open decisions

1. Result unit for CSV: row or cell?
2. Count unit: matching rows or occurrences?
3. Is cross-cell search required?
4. Is raw CSV syntax search required, or should it live in a separate source view?
5. Full scan order: file order, or current-row wrap?
6. Do we keep the 5,000 navigable-match cap until a block index exists?

## Suggested next design

The CSV table uses A2:

```text
cell matcher
→ occurrence result
→ occurrence count
→ occurrence navigation
→ header excluded
→ file-order scan
→ full scan parses rows with the same matcher
→ 5,000 navigable occurrences
```

Then a block index can store occurrence and matching-row counts per block and re-run
the same matcher inside the selected block. Do not build the block index on the older
mixed semantics.

## Related implementation points

- `kernel/search.ts` — compile / ranges / occurrence walk.
- `previews/csv/match.ts` — pure cell matcher and count.
- `previews/csv/search.ts` — CSV local search hook and text scan.
- `previews/csv/table.tsx` — per-cell `Marked` with the active occurrence.
- `previews/csv/scan.ts` — whole-file occurrence scan + 5,000 cap.
- `kernel/row-file.ts` — byte slices, row parsing and file scan.
