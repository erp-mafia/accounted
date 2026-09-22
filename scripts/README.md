# Repository scripts

Run scripts from the repository root. Prefer the named commands in [package.json](../package.json) for routine development; these are also the entry points used by CI.

| Purpose | Entry points |
| --- | --- |
| Extension registry | `npm run setup:extensions` |
| Product skill bodies | `npm run skills:generate`, `npm run skills:check` |
| Installable API skill | `npm run apiskill:generate`, `npm run apiskill:check` |
| Taxonomy registry | `npm run taxonomy:generate`, `npm run taxonomy:check` |
| Self-hosted cron schedule | `npm run crontabs:generate` |
| Bookkeeping packs and community registry | `npm run validate:packs`, `npm run validate:registry` |
| Existing lint, type, and code guards | `npm run check:lint`, `npm run check:types`, `npm run check:guards` |

## Operational tools

| Directory | Purpose |
| --- | --- |
| `self-host/` | Backup, restore, and access-control helpers |
| `sie-import/` | Import acceptance, staging benchmarks, and reviewed repairs |
| `provider-migration/` | Synthetic load and recovery harnesses; [measured results](provider-migration/README.md) |
| `migration/` | Targeted migration follow-up tools |
| `support/` | Account support actions |
| `salary/` | Salary maintenance |
| `parties/` | Party matching evaluation; [method and fixtures](parties/README.md) |
| `perf/` | Performance analysis; [usage](perf/README.md) |
| `peppol/`, `scb/` | Integration probes and discovery |
| `data/` | Versioned input files for import tools, including tax tables |

Standalone `backfill-*`, `migrate-*`, `repair-*`, and parity scripts are manual operational tools, not application startup steps. Their headers document the incident, target environment, and invocation. A lack of imports does not mean a manual tool is retired.

Read a script's header before running it. Follow the repository's environment and database-write rules; `.env.local` must be treated as production. Generated reports and customer data belong outside version control. Retained synthetic benchmark results are identified in their accompanying README.

The public installation entry point remains [`setup.sh`](../setup.sh). See the [self-hosting guide](../docs/SELF-HOSTING.md) for its complete workflow.
