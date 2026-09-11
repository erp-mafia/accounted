# SIE import backbone

Implementation of the 2026-09-11 incident plan, revision 4. The work lives on
`feat/sie-import-backbone`, based on `91ab339a8`, in a separate worktree.
No production repair, customer notification, deployment or PR publication has
been performed by this implementation session.

## Contract

- A file is archived before admission. Identical retries reuse the execution and
  its prepared chunks. A corrected replacement creates a successor, reverses
  the predecessor and hands its period hold to the successor atomically.
- The database owns worker leases, attempts, progress receipts and holds. A
  lost HTTP response is reconciled under the same company lock as the writer.
  A stale worker cannot write. `after()` accelerates work; cron recovers it.
- Every new imported voucher has immutable batch, ordinal and content hash.
  Uniqueness protects the batch position and the posted source voucher identity.
  Conflicting content stops the job. A replay returns its committed receipt.
- Chunks commit independently. Dashboard reports remain readable with a global
  incomplete-import notice. Period close/lock, dependent imports, document
  attachment and matching are held in the database. Filings and financial
  downloads, including REST and MCP financial reports, use read leases and
  refuse incomplete data. A read lease is checked again before returning data.
- Undo uses storno and retains original vouchers, dimensions, documents and
  receipts. It restores imported account metadata only if it still matches the
  import's recorded write, preserving subsequent user changes.
- Files are limited to 50 MiB and 50,000 vouchers. One voucher may contain at
  most 2,000 lines and fit the 1 MiB chunk budget. A chunk also has a 200-voucher
  limit. Preparation checkpoints mapped output and metadata; source parsing is
  repeated from the immutable, size-limited archive when preparation resumes.
  Finalize requests, metadata checkpoints and undo blocks are bounded too.
- The wizard persists its job URL and polls actual progress. The v1 operation
  is durable. MCP commit returns a job and status tool. Migration extensions
  wait for each fiscal year to complete before submitting the next one.

## Flags and recovery

| Setting | Default | Meaning |
| --- | --- | --- |
| `SIE_IMPORT_JOBS` | disabled | `true` admits new executions. Disabling admission leaves recovery running. |
| `SIE_IMPORT_WORKER_PAUSED` | disabled | `true` stops worker claims/continuation for an emergency investigation. Holds and receipts remain. |
| `SIE_IMPORT_CHUNK_AUDIT` | disabled | `true` opts newly prepared jobs into compact audit, after separate compliance approval. Existing jobs retain their pinned mode. |

Hosted recovery runs at `/api/import/sie/worker/cron` every minute, with the
existing cron-secret guard. The weekly invariant check is
`/api/import/sie/invariants/cron`. Self-hosted cron entries are included.
Recovery latency is lease expiry plus actual cron delivery, not a one-minute
guarantee. Claims are capped at two across the platform and one per company.
Failed chunks back off; three consecutive failures pause and emit an alert.

The operational switch for suspected bad worker code is to pause workers as
well as admission. Admission-off alone intentionally drains existing jobs and
is not an emergency stop. Resume after deploying a compatible fix. Never
restore the old one-shot writer or drop uniqueness as a rollback technique.
Never clear an import hold manually to make a report or filing go through.

## Production rollout

The migrations have been applied only to the designated erp-base staging branch
`metjnjrhvujscngnpzdv`. They are recorded under the exact applied versions in
`supabase/migrations/`. Do not run them against a local database or Docker.

1. Review the database and application changes together. This branch is a
   coordinated cutover: the first provenance guard makes old one-shot writes
   fail closed, and later migrations revoke the old import/undo/replace RPCs.
   Reverting application code alone is not a database rollback.
2. Get Emil's specific approval
   for production DDL. Schedule the cutover, pause import intake, and verify
   no legacy import/undo/replace call remains in flight. Do not guess from an
   HTTP timeout that the database finished.
3. Reconcile migration history with production immediately before publishing.
   Ship the compatible application and migrations in the same cutover window,
   with admission and workers disabled until both are present. Verify report
   read leases and the new RPCs before admitting a file.
4. Start workers, verify a real authenticated cron invocation, then enable new
   admission. Verify one small import, its operation and audit trail, and a
   bounded undo on an approved synthetic production company if authorized.
5. Monitor ordinary report latency, error rate, queued age, paused jobs, lease
   recovery, WAL and disk metrics before raising concurrency above two.

Logs emit `alert: true` for slow steps, worker failures and invariant failures.
Configure the production log drain/pager for those events and Supabase disk IO
budget below 30 percent. Verify an alert reaches its destination. A log line
alone is not evidence that paging is configured. No production alert rule or
scheduled delivery has been enabled or observed in this session.

## Reviewed historical repair

Production pairing and linked-record fingerprints belong in a private review
artifact. The preview identifies exact matches separately from source-key
collisions whose accounting content differs. Only explicitly selected exact
pairs enter the repair job. Record and approve the generated SHA-256 digest
before execution, then refresh fingerprints if the underlying data changes.

Tools in `scripts/sie-import/`:

- `repair-preview.sql`: read-only complete-content pairing.
- `repair-links.sql`: read-only dependent-record identities and hashes.
- `build-repair-review.mjs`: offline review builder, including explicit
  keep/reverse choices and excluded mismatches.
- `execute-reviewed-repair.ts`: dry run by default. Execution requires the
  exact review digest, explicit company/actor/project and a separate environment
  file. It never reads `.env.local`.

Example dry review:

```sh
node --import tsx scripts/sie-import/execute-reviewed-repair.ts --review REVIEW.json
```

After specific production approval, execute one company at a time with
`--execute --approved-review-hash HASH --company UUID --actor UUID --project REF
--env REPAIR_ENV`. The actor must be a company owner/admin. The script stages
immutable keep/reverse IDs and runs the same leased worker used for imports.
It never changes old voucher provenance and never invokes period-wide delete.
Documents stay linked to retained originals; bank anchors are released.

If a fingerprint changed or an unsupported dependency appears, stop and review.
The same command accepts `--stop-job UUID --reason "Reviewed reason"` with the
same exact approved digest and explicit execution arguments. Stop waits behind
the current chunk, preserves completed reversal receipts, cancels only pending
targets and releases the hold. A fresh reviewed digest can claim cancelled
targets. It cannot revive completed reversals. Stopped repairs have terminal
`job_state=completed` and `job_result.repairOutcome=stopped`; they are displayed
as stopped repairs, never successful imports. Ordinary undo/replace rejects
repair jobs.

Customer notices must be reviewed and sent before the approved repair. No
messages have been sent. Unmatched source-key collisions require individual
accounting review. The old stranded pending execution likewise requires evidence
of its actual posted rows before any terminal status is assigned.

New jobs are protected immediately by the owned-source unique index and period
gate. Broadening the source index to all historical posted imports is a
separate, reviewed migration after every historical collision is resolved.
Do not apply that index until the preview confirms no historical collisions remain.
Keep `journal_import_source_owned_idx` until the full index is valid. Historical
batch-scoped undo/replacement requires reviewed provenance; ambiguous legacy
imports fail closed instead of guessing which period entries belong to them.

## IO and audit

Staging is currently Micro, not Large. The controlled 6,000-voucher/12,000-line
benchmark measured the following after removing redundant explicit commit
timestamp assignments:

| Audit mode | WAL MiB per 1,000 vouchers | Total writer time | Slowest chunk |
| --- | ---: | ---: | ---: |
| Full, default | 13.39 | 32.84 s | 1.764 s |
| Compact, opt-in | 7.50 | 30.43 s | 1.721 s |

The observed WAL reduction is about 44 percent. WAL-LSN deltas can include
background writes; EXPLAIN WAL/buffer output and Supabase disk metrics must be
read together. These numbers do not prove physical write amplification or the
cause of the original instance outage. The old RPC baseline could not run on
current staging because it inserts posted headers before their lines; no legal
trigger was disabled to make that benchmark run.

Compact audit retains an immutable source archive, mapping/options manifest,
chunk hashes, exact entry receipts and rendered processing-history records.
Ordinary bookkeeping, corrections and storno keep full audit. Enable compact
mode only after accounting-compliance review and Emil's decision. This session
has not authorized or enabled it in production.

`io-snapshot.sql` captures index definitions, uniqueness/constraint use, sizes,
scan counters and reset time. A read-only production baseline was saved on
2026-09-11. Recheck after at least a full week and include infrequent month-end
and year-end plans. Zero scans alone is not grounds to drop an index. No index
pruning or trigger shortcut is included before that evidence exists.

## Verification

Repeatable runners use explicit staging credentials in ignored files:

```sh
node scripts/sie-import/test-staging.mjs lib/import/__tests__/sie-job.pg.test.ts
node scripts/sie-import/test-staging.mjs tests/pg/sie-duplicate-repair.pg.test.ts tests/pg/sie-repair-race.pg.test.ts
node --import tsx scripts/sie-import/acceptance-manual-review.ts
node --import tsx scripts/sie-import/acceptance-staging.ts
node scripts/sie-import/benchmark-staging.mjs --compare-audit
node scripts/sie-import/run-next-staging.mjs build
```

The HTTP acceptance has passed concurrent 6,000-voucher imports, identical
concurrent submission, worker kill/recovery, lost-response receipt replay,
stale-attempt rejection, admission-off draining, exact numbering, native
posting during an import period lock, and batch undo preserving native work.
The repeated run measured a maximum chunk HTTP request of 1.67 seconds on staging Micro.
An authenticated balance-sheet endpoint for a separate company remained responsive:
12 baseline requests had median 477 ms and p95 845 ms; 53 requests during the
concurrent import/recovery/undo run had median 438 ms and p95 609 ms. This short
run showed no regression; it is not a Large-tier sustained-capacity result.
Browser verification passed a real 205-voucher upload through completion,
URL reload recovery and a 390 px mobile result screen.

Real Postgres tests additionally cover tenant boundaries, invalid source year,
unbalanced rollback, finalize, replacement handoff, account metadata undo,
document/dimension retention, optional audit, read leases, exact repair,
changed review fingerprints, repair stop/reapproval and both orderings of the
stage-versus-bank-match race. Retired period-delete tests were replaced with
rejection and retained-history tests; core writer regression cases exercise the
new private writer.

The final follow-up passed 53 real-Postgres tests covering the job protocol and
both reset flows, and 49 archive tests. The manual-review HTTP acceptance
confirmed unchanged adjacent-year header/lines through completion and undo,
review renewal after undo, and stale-token rejection in 45 ms on the repeated
run. Browser verification also passed review acknowledgment, retained-history
reset refusal, navigation to the existing archive flow and both dialogs at
390 px without horizontal overflow. No automatic cross-year bookkeeping write
is made.

The full unit run encountered Windows path/line-ending failures and
shell-check loader failures. All seven remaining failing files were reproduced
on a clean detached checkout of base commit `91ab339a8`: nine failed tests and
four loader errors. The touched processing-history newline assertion was fixed.
The core affected-area run passed 4,255 tests in 312 files. The final follow-up
run passed 4,188 tests in 253 files; two tests were skipped in each run. These
overlapping runs must not be added together. Production build, lint, the type
error ratchet and API guards passed after the follow-up. Broader staging tests
also expose missing party and
account-erasure schema/functions, auth-schema DDL restrictions, and older
ledger-key/consent-erasure implementations unrelated to this branch. Record final check results with the PR; do not label these suites green
without resolving or demonstrating their baseline status.

## Approved follow-up choices

- Emil chose manual review of the adjacent year's existing opening balance.
  Import completion atomically records the review in the result and manifest,
  marks the adjacent period, and leaves its vouchers unchanged. Settings and the
  global notice expose the review. Owner/admin acknowledgment records who and
  when, checks the review token and current entry, and changes no journal data.
  Source undo renews the review token; a stale acknowledgment returns a conflict.
  This is an advisory review, separate from the unfinished-import hold.
- For reset, Emil delegated the retention choice. Years containing durable
  imports or reviewed repairs refuse destructive reset, including after storno.
  Owners are directed to the existing whole-company archive/start-fresh flow;
  administrators are told that the owner must act. The archive's eligibility
  and execution reject unresolved durable imports and undos. The retained-source
  download now includes all fiscal-period reports, current SIE exports and
  linked documents, as well as source files and processing history. Existing
  owner/reset-link authorization and download size limits remain in force.
- This preserves original records and their corrections together, consistent
  with BFNAR 2013:2 points 2.17-2.18 and the retention guidance in
  [BFN's bookkeeping guidance](https://www.bfn.se/wp-content/uploads/vl13-2-bokforing.pdf).

## Work requiring elapsed time or production approval
- Production repair, historical source-key uniqueness, legacy reconciliation,
  customer notices, compact-audit enablement and alert delivery are not live.
- Index pruning needs a week of data; sustained Large-tier load still needs
  its production-sized acceptance measurement.
- Bank-file/provider/MCP bulk-book reuse follows a proven SIE production
  lifecycle, as the plan requires. This branch changes provider SIE sequencing,
  but does not prematurely replace independent bank and bulk-book writers.
