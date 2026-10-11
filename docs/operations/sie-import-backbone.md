# SIE import operations

SIE files import as resumable jobs: a worker posts each file in chunks and the
database owns the job state. The jobs replaced the one-shot import writer on
2026-09-14; the migrations retired the old import, undo and replacement RPCs,
so an application-only rollback cannot restore the old writer.

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
| `SIE_IMPORT_JOBS` | false on hosted, true when `NEXT_PUBLIC_SELF_HOSTED=true` | Admit new executions. Turning it off still allows existing work to drain. |
| `SIE_IMPORT_WORKER_PAUSED` | false | Stop worker claims and continuation for an emergency investigation. |
| `SIE_IMPORT_CHUNK_AUDIT` | false | Opt new jobs into compact audit only after separate compliance approval. Existing jobs retain their pinned mode. |

A self-hosted install has no cutover to stage (migrations, application and
the worker cron ship together), so there admission is on unless the operator
sets `SIE_IMPORT_JOBS=false`; the refusal then names the setting. Hosted stays
off unless the flag is `true`.

Hosted recovery: `/api/import/sie/worker/cron` every minute, authenticated with
the cron-secret guard. Recovery takes lease expiry plus actual cron delivery;
one-minute recovery is not guaranteed. The weekly invariant endpoint is
`/api/import/sie/invariants/cron`. Self-hosted cron entries are included.

After three consecutive failures a job pauses and emits an alert. Inspect the
job's error and receipts, correct the cause, then resume from the job screen.
If abandoning it, request undo and verify its terminal state and retained
storno trail. Do not resubmit a changed file as an identical retry.

Stornos carry the dates of the vouchers they reverse. Undo, resume of an undo
and replacement refuse a closed or locked fiscal year, or a company lock date
on or after the first date they write, before anything is queued
(`SIE_IMPORT_PERIOD_LOCKED`; the sentence names the range). While a year is
held, only a lock date that locks more waits; moving it back or removing it
is always allowed. An undo that a lock date stopped continues from its last
receipt once the user moves the lock date back and resumes it (crm#1022).

For suspected bad worker code, disable admission and pause workers. Deploy a
compatible fix, reconcile the recorded attempt/receipts, resume workers, then
restore admission. Do not restore the one-shot writer, drop uniqueness, delete
receipts or bypass retention. Keep status and diagnostic downloads available.

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
