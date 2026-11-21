# Repository scripts

Run scripts from the repository root. Prefer the named commands in [package.json](../package.json) for routine development; these are also the entry points used by CI.

| Purpose | Entry points |
| --- | --- |
| Extension registry | `npm run setup:extensions` |
| Product skill bodies | `npm run skills:generate`, `npm run skills:check` |
| Installable API skill | `npm run apiskill:generate`, `npm run apiskill:check` |
| Taxonomy registry | `npm run taxonomy:generate`, `npm run taxonomy:check` |
| Third-party list in NOTICE | `npm run notice:generate`, `npm run notice:check` |
| Self-hosted cron schedule | `npm run crontabs:generate` |
| Bookkeeping packs and community registry | `npm run validate:packs`, `npm run validate:registry` |
| Existing lint, type, and code guards | `npm run check:lint`, `npm run check:types`, `npm run check:guards` |
| The app on a throwaway local Supabase, checked in a real browser (`local/`) | `npm run local:up`, `npm run local:check -- <path>...`, `npm run local:down` |

## Operational tools

| Directory | Purpose |
| --- | --- |
| `self-host/` | Backup, restore, and access-control helpers; `smoke-boot.sh` boots an image under `docker-compose.yml` (run by `docker-publish.yml` before `latest` moves) |
| `ci/` | Helpers the CI workflows run; `replay-migrations.sh` applies migration files in one database session, a fresh session per file |
| `ops/` | Read-only database snapshots; `background-freshness.sql` shows when each background path last did real work per company |
| `perf/` | Performance analysis; [usage](perf/README.md) |
| `peppol/`, `scb/` | Integration probes and discovery |
| `data/` | Versioned input files for import tools, including tax tables |

Standalone `backfill-*`, `repair-*`, `heal-*` and parity scripts are manual operator tools, not application startup steps: each is the companion of a shipped migration or module, for an install that holds older data. A lack of imports does not mean a manual tool is retired.

Read a script's header before running it, and check which database your environment file points at first. Generated reports and customer data belong outside version control.

The public installation entry point remains [`docker/setup.sh`](../docker/setup.sh). See the [self-hosting guide](../docs/SELF-HOSTING.md) for its complete workflow.
