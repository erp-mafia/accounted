# Decision Log

One decision per file, one line per decision, at most 300 characters: `[YYYY-MM-DD] <decision>: <why>`. Details belong in the PR body. Written by agents and humans when a non-obvious choice is made. Search before re-litigating a past decision:

```bash
grep -ri "<topic>" docs/decisions
```

## Where decisions live

- **New decisions**: a file of their own, `docs/decisions/YYYY-MM/YYYY-MM-DD-<slug>.md` (slug: lowercase words joined by hyphens), for example `docs/decisions/2026-10/2026-10-14-decision-log-one-file-each.md`. Never append to this file: two merge requests that append to one file conflict, and `check:guards` (decision-log) fails a dated line here.
- **Earlier decisions**, verbatim and in their original order:
  - [October 2026, before one file per decision](docs/decisions/2026-10.md)
  - [September 2026](docs/decisions/2026-09.md)
  - [August 2026](docs/decisions/2026-08.md)
  - Before August 2026: `git show c36bc125a:DECISIONS.md` (archived on 2026-09-13). Code comments citing a July date refer to that archive.

A code comment that cites `DECISIONS.md <date>` means the entry of that date, wherever it lives now.
