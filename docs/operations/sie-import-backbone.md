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
- A year imported on top of the year before books one more verifikat when its
  opening balance differs from the file's #IB only by last year's result, which
  the file has moved off 2099 to 2098 or 2091: the year-end's omföring
  (`result-appropriation-service`), dated the year's first day, onto the file's
  account, named in the import result (`src/lib/import/sie-result-transfer.ts`).
  Undo leaves it, as it leaves the close's; the next import of the year finds it
  and books none. Any other difference stays a warning.

Limits: 50 MiB per file, 150,000 vouchers, 2,000 lines per voucher, 200 vouchers
and 1 MiB per chunk. Claims are capped at two globally and one per company.
Vouchers take source ordinals 0 to 149,999. The IB and the migration adjustment
follow at 50,000 and 50,001, or at 1,000,000 and 1,000,001 for a file of more
than 50,000 vouchers; the manifest's `finalOrdinals` records the pair
(`sieFinalOrdinals`). The vouchers stay below 150,000 because an undo receipt is
numbered by the lowest ordinal it reverses and the name and VAT restore receipts
start there.
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
Each check runs on its own statement budget, the duplicate-voucher check 500
companies per call. The endpoint answers 503 when a check found a violation
and 500 when a check did not finish; the body names the checks that finished
and how many companies the duplicate check reached, the run log the errors.

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
