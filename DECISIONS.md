# Decision Log

The maintainers keep the decision log outside this repository. Entries up to 2026-10-04 are in this file's history: `git show b0b481b9d:DECISIONS.md`, and for entries before August 2026 `git show c36bc125a:DECISIONS.md`.

A code comment that cites `DECISIONS.md <date>` refers to the entry of that date.
[2026-11-22] Lost dimension tags in closed periods are restored through a separate service-role RPC (restore_closed_period_line_dimensions) instead of relaxing retag_line_dimensions or using storno: it only fills UNTAGGED lines on posted verifikat in closed/locked periods, owner/admin actor, dimension column only via the existing trigger carve-out, one immutable log row per line; changing an existing tag past a lock still requires storno. A storno would add verifikat to a closed year to repair metadata the original verifikat already carried.
