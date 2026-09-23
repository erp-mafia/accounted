# SIE import operations

This is a coordinated database, application and flag cutover. Merging the PR
alone does not enable imports. `SIE_IMPORT_JOBS` defaults off, and the migrations
retire the old import, undo and replacement RPCs. An application-only rollback
cannot restore the old writer.

## Runtime contract

- Archive source bytes before admission. Identical retries reuse one execution;
  corrected replacements create a successor and reverse the predecessor.
- The database owns worker leases, attempt fencing, chunk receipts and period
  holds. A lost response replays its receipt without new voucher numbers.
- Chunks commit independently. Dashboard balances remain readable with an
  incomplete-import notice. Close/lock, dependent imports, matching and document
  attachment enforce the hold in the database.
- Ledger-derived downloads and filings acquire a company-wide read lease before
  reading and validate it before returning. This includes REST/MCP reports,
  SIE/archive exports, VAT submission, live annual-report PDF/iXBRL and creation
  or finalization of annual-report versions. Saved annual-report versions,
  payroll-only AGI/KU, audit logs and processing history remain available.
- Annual-report versions persist the captured model only after the complete read
  lease validates successfully. An expired read saves no snapshot. Persistence
  and signature setup do not reread financial balances.
- A read pays two RPCs. Acquisition takes shared fiscal-period row locks briefly
  and inserts a lease; the HTTP rendering interval retains the lease row, not
  those transaction locks. Ordinary observer operations can share the locks;
  import admission remains excluded. Measure report latency under real load.
- A paused import still represents an incomplete ledger, so financial exports
  remain blocked until resume or retained-history undo finishes. Never clear a
  hold by hand to force a report through.
- Undo retains original vouchers, corrections, dimensions, documents and receipts.
  Real-company destructive reset refuses durable import history even after undo;
  use the owner-only archive/start-fresh flow. Verified disposable sandbox cleanup
  has a separate, service-only teardown path.
- Importing an earlier year leaves an existing next-year opening voucher unchanged
  and flags it for owner/admin review. Acknowledgment checks the current review
  token; undo renews it. This advisory is distinct from an unfinished-import hold.

Limits: 50 MiB per file, 50,000 vouchers, 2,000 lines per voucher, 200 vouchers
and 1 MiB per chunk. Claims are capped at two globally and one per company.
The global notice polls every five seconds during a visible active import,
once a minute while idle, and refreshes on navigation/focus. Hidden tabs do not poll.

## Flags and recovery

| Setting | Default | Purpose |
| --- | --- | --- |
| `SIE_IMPORT_JOBS` | false | Admit new executions. Turning it off still allows existing work to drain. |
| `SIE_IMPORT_WORKER_PAUSED` | false | Stop worker claims and continuation for an emergency investigation. |
| `SIE_IMPORT_CHUNK_AUDIT` | false | Opt new jobs into compact audit only after separate compliance approval. Existing jobs retain their pinned mode. |

Hosted recovery: `/api/import/sie/worker/cron` every minute, authenticated with
the cron-secret guard. Recovery takes lease expiry plus actual cron delivery;
one-minute recovery is not guaranteed. The weekly invariant endpoint is
`/api/import/sie/invariants/cron`. Self-hosted cron entries are included.

After three consecutive failures a job pauses and emits an alert. Inspect the
job's error and receipts, correct the cause, then resume from the job screen.
If abandoning it, request undo and verify its terminal state and retained
storno trail. Do not resubmit a changed file as an identical retry.

For suspected bad worker code, disable admission and pause workers. Deploy a
compatible fix, reconcile the recorded attempt/receipts, resume workers, then
restore admission. Do not restore the one-shot writer, drop uniqueness, delete
receipts or bypass retention. Keep status and diagnostic downloads available.

## Production cutover

All development migrations and mutation tests use only the designated staging
branch `metjnjrhvujscngnpzdv`. Production is `pwxtzglxptnnvjrpixpg`.
Production DDL, configuration activation and any synthetic production import
must receive Emil's specific approval before execution. Do not use `.env.local`
for acceptance tests. Do not start a local database or Docker.

Before scheduling:

1. Verify the current PR commit's full CI, staging regression tests and provider
   acceptance. Reconcile every production migration version with repository
   files immediately before cutover; preserve the exact applied SQL bytes.
2. Confirm a production operator can edit Vercel environment variables, deploy
   compatible application code, apply approved DDL and inspect cron/log delivery.
   Obtain a maintenance window and an explicit database lock/time budget.
3. Rehearse the initial DDL against production-sized staging data. The initial
   migration adds validated CHECK/FK constraints and two regular partial unique
   indexes on `journal_entries`. These are blocking operations, even when the
   new indexed columns are null. Later migrations cannot remove locks already
   taken by that first migration. Do not edit previously applied migrations.
4. Run `scripts/sie-import/cutover-preflight.sql` read-only. Review relation sizes,
   old transactions and lock waiters without exposing SQL text/customer data.
   On 2026-09-13 production had about 483,000 journal entries, a 107 MiB heap
   and 327 MiB including indexes. This is sizing evidence, not a DDL-duration
   measurement. The production-sized DDL rehearsal is still outstanding.

During the approved window:

1. Pause legacy import intake and confirm no import/undo/replace RPC remains in
   flight. Arrange a quiet write window for the initial blocking DDL. Confirm
   migration-session lock and statement timeouts are set to the approved budget;
   stop on budget exhaustion instead of leaving a lock request queued.
2. Apply the exact reviewed migrations and deploy the compatible application
   within the same window. Keep `SIE_IMPORT_JOBS=false` and
   `SIE_IMPORT_WORKER_PAUSED=true` until both are verified. Keep compact audit off.
3. Verify new RPC availability, retired RPC denial and financial report leases.
   Set `SIE_IMPORT_WORKER_PAUSED=false`, activate that configuration and observe
   an authenticated cron invocation. Then set `SIE_IMPORT_JOBS=true` and activate
   the deployment using it. Verify the effective behavior, not only saved flags.
4. On an explicitly approved synthetic company, complete a small import, check
   status, balances, numbering, source archive and audit history, then verify
   bounded undo. Check a normal report and the paused-import conflict path.
5. Observe queue age, paused jobs, report latency/error rate, worker recovery,
   WAL and disk metrics. Keep concurrency at two until sustained load evidence
   supports a change. Verify `alert: true` failures reach the configured pager;
   a log line alone does not establish alert delivery.

The initial migration requires a maintenance decision. PostgreSQL documents
regular index builds as blocking writes and constraint validation as scanning
existing rows: [CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html),
[ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html).

## Repeatable verification

Use explicit staging credentials in ignored `.env.sie.*.local` files:

```sh
node scripts/sie-import/test-staging.mjs src/lib/import/__tests__/sie-job.pg.test.ts tests/pg/sie-report-lease-concurrency.pg.test.ts tests/pg/sie-sandbox-cleanup.pg.test.ts
node scripts/sie-import/test-staging.mjs tests/pg/sie-duplicate-repair.pg.test.ts tests/pg/sie-repair-race.pg.test.ts
node --import tsx scripts/sie-import/acceptance-providers-staging.ts
node --import tsx scripts/sie-import/acceptance-staging.ts
node --import tsx scripts/sie-import/acceptance-manual-review.ts
node scripts/sie-import/run-next-staging.mjs build
```

Provider acceptance runs seven synthetic cases through real staging Storage,
admission, workers and Postgres: Fortnox UTF-8/CP437 across two years, Visma
Administration CP437, Visma eEkonomi Latin-1 and Bokio UTF-8. Each has 205 vouchers
and crosses a chunk boundary. It checks balances, sequential numbering,
dimensions, retained bytes, retry identity and adjacent-year opening continuity.
Fortnox fixtures use its real client/fetcher with synthetic HTTP responses;
this does not verify live OAuth or a customer provider account. Visma and Bokio
ledger history enters through SIE upload; their entity APIs are separate.

`acceptance-staging.ts` tests concurrent 6,000-voucher jobs, real worker process
termination, takeover, stale-attempt rejection, lost-response replay, draining
with admission disabled and undo retaining native work. It accelerates only a
synthetic expired lease. Process-kill acceptance is an explicit staging runner,
not part of normal CI. PG tests cover transactional fencing and replay in CI.

Route tests cover the signed-upload authorization/validation boundary and live
annual-report holds versus saved snapshots. PG tests cover report/posting lock
orderings, real import exclusion, sandbox cleanup and real-company refusal.
Retired deletion tests were replaced with storno, dimension/document retention,
replacement handoff, actor authorization and old-RPC denial assertions.

Record final test counts and commit identity in the PR, not as a rolling session
log here. Live provider authentication, production activation and sustained
production-sized load remain separate acceptance requirements.

## Reviewed historical repair

Historical repair is separate from enabling new imports. Keep pairing and linked
record fingerprints in a private review artifact. Only explicitly selected exact
matches can enter repair; differing source-key collisions require accounting review.

- `repair-preview.sql`: read-only complete-content pairing.
- `repair-links.sql`: read-only linked-record identities and hashes.
- `build-repair-review.mjs`: offline keep/reverse choices and excluded mismatches.
- `execute-reviewed-repair.ts`: dry run by default, never reads `.env.local`.

```sh
node --import tsx scripts/sie-import/execute-reviewed-repair.ts --review REVIEW.json
```

Execution requires separate approval of the exact digest, company, owner/admin
actor and project, then `--execute --approved-review-hash HASH --company UUID
--actor UUID --project REF --env REPAIR_ENV`. Refresh fingerprints before running.
Keep documents linked to retained originals; release bank anchors via the worker.
Do not change old provenance or invoke period-wide delete.

Stop on changed fingerprints or unsupported dependencies. `--stop-job UUID
--reason "Reviewed reason"` with the same approved digest waits for the current
chunk, preserves completed reversal receipts and cancels remaining targets.
A new reviewed digest can claim cancelled targets, never completed reversals.
Stopped repairs have `job_state=completed`, `job_result.repairOutcome=stopped`.

Historical uniqueness broadening requires all collisions resolved first. Keep
`journal_import_source_owned_idx` until its full-history successor is valid.
Customer notices, historical repair, legacy reconciliation and compact audit
each require their own review and authorization.

## IO measurement

`benchmark-staging.mjs --compare-audit` measured 6,000 vouchers/12,000 lines on
staging Micro: full audit used 13.39 WAL MiB per 1,000 vouchers and 32.84 seconds
writer time; compact used 7.50 MiB and 30.43 seconds. WAL deltas can include
background writes and do not establish physical amplification or outage cause.
Compact remains off pending compliance review and Emil's decision.

`io-snapshot.sql` records index definitions/use, sizes and reset times. Collect
at least a week including month/year-end query plans before index pruning.
Zero scans alone do not justify dropping an index. Production-sized DDL timing,
sustained load and alert delivery still need operator verification.
