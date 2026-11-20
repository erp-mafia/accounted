# Provider migration jobs

The wizard now submits customers, suppliers, sales invoices and supplier invoices
as one persisted job. It restores unfinished jobs when reopened and offers the
latest completed result. The existing company-information, asset, SIE and document
flows retain their own paths. Direct integrations using the legacy `/migrate`
register flags must adopt the job API to obtain resumable execution.

## Execution and limits

- `POST /api/extensions/ext/arcim-migration/migration-jobs` accepts `consentId`
  and a `resources` array. Company, actor and imported fiscal years come from the
  authenticated context and database. It responds `202` with `data.jobId`.
- `GET` on that path, optionally with `?jobId=...`, returns persisted progress.
  Without an ID it returns the latest job for the active company.
- `POST .../run` nudges a job. `POST .../retry` resumes records needing attention.
  Both take `jobId`. Retry can also take a renewed `consentId`; the source account
  must match. These routes use the extension dispatcher’s normal authorization.
- A finished job whose records did not all succeed stops for review: phase
  `completed`, state `needs_attention`. The wizard lists each record with its
  reason, read from the record's own snapshot and receipt. `POST .../accept`
  (`jobId`) finishes it through `accept_provider_migration_job`: the job becomes
  `completed`, `review_accepted_at`/`review_accepted_by` say who accepted it, and
  the records keep their state and code, so the result keeps listing them.
  Retry re-queues only the failed records and notes each one's code in
  `receipt.previous_error_code`; once every record fails again the same way the
  wizard stops offering it. A review lists at most 500 records and says so;
  with more, the codes of all of them are read once the listed ones repeated,
  so a long review stops offering the retry too. A listed record that reached
  Accounted opens its own page (`target_id`), where its payment is linked to a
  verifikat or marked by hand. A job paused mid-run is resumed, never accepted.
- The authenticated worker cron runs every minute in the hosted and generated
  self-hosted schedules. Each invocation stops at a 210-second budget. Its
  five-minute lease is reclaimed after a crash. Each record write is fenced by
  the current worker and attempt inside the transaction.
- Visma discovery requests 1,000 records per page. Other providers keep their
  native page contracts. Discovery persists segments of at most 250 records and
  750 kB. Import and follow-up work uses at most 10 records per batch. Individual
  invoices over 2,000 lines or the payload bound are reported for review.
- One active job per company. Retry preserves successful records. Source identity
  includes company, provider, provider account, resource and provider record ID;
  display invoice numbers do not serve as retry keys.
- Party matching uses provider IDs or an organization identity, never a display
  name alone. When neither is available, the placeholder is scoped to its source
  invoice rather than silently merging different people with the same name.
- Transient provider failures back off. Exhausted detail failures and malformed
  records get explicit attention outcomes while healthy records continue.
  Authorization failures pause the job and expose reconnect in the wizard.
- Snapshot encryption uses `PERSONNUMMER_ENCRYPTION_KEY`. All workers sharing a
  database must use the same configured key. Every runtime refuses to
  work without it; test harnesses explicitly supply their own fixture key.
  Job state is operational; source-ID mappings are included in the
  company archive alongside the imported registers.

## Accounting and retention boundaries

The provider worker imports registers and links existing posted vouchers; it
does not create journal entries. VAT and FX warnings are stored in receipts and
shown in the result. The unlinked-credit count is derived from the invoice rows
instead (`provider_migration_counts`, migration 20260920190600): a credit note
counts as unlinked when its provider sent no reference, or when its link phase
has run and `credited_invoice_id` is still NULL because the invoice it names is
not among the imported ones. These warnings do not by themselves put
every record into `needs_attention` and must be reviewed before later accounting
actions. The existing mapper is reused without changing its VAT rules.

A foreign-currency invoice is converted at import with our own rate index, but
the source booked its verifikat at its own rate (crm#1039). When the verifikat
its reference singles out books within 10% of the invoice's SEK total on
151x/244x, the invoice links and takes that amount: `exchange_rate` becomes the
SEK total over the invoice total (the source's rate), `exchange_rate_date` the
verifikat's date, and the `*_sek` columns follow. The reskontra then agrees with
1510/2440, and a payment clears them exactly with the kursdifferens on
3960/7960. The worker commits such a batch through
`commit_provider_migration_source_rate_links` (migration 20261005230200), which
writes the amounts only onto invoices the followup linked; the receipt keeps
the previous values in `registration.sourceRate`. Further apart than 10%, the
record stays in review as an amount mismatch.

A supplier credit note (#2838) is stored the way Kreditera writes one: the
magnitudes of the invoice it reverses beside `is_credit_note`, status `credited`,
nothing paid and nothing remaining, whatever sign the provider states. It is
paired through `supplier_invoices.credited_invoice_id` only when the provider
names the credited invoice (Fortnox `CreditReference`) and that invoice is an
ordinary invoice of the same supplier, in the same currency, not smaller than
the credit; never by amount. The registration link corroborates a credit note
against the NEGATED total, because its verifikat debits 2440. A supplier credit
note the company already holds in the shape written before #2838 (the provider's
negative total on an unflagged row) is skipped with reason
`creditNoteInOldShape` instead of being inserted a second time; rewriting those
rows is a separate, approved repair.

There is no snapshot purge or TTL job. A pending or failed snapshot remains
available for retry. The archive includes customers, suppliers, invoices, their
items and payments, and source-ID mappings; operational jobs and encrypted
replay payloads are excluded. Source documents keep their separate import and
retention flow.

Historical invoice numbers are preserved. This worker does not change the
company's invoice prefix or next number and does not create a separate number
namespace. An imported number that already exists in another spelling (`012`
next to `12`) is refused like a taken number and lands in the review list. When
the imported numbers stand above the company's next number, Accounted refuses
to issue the next invoice under them (`INVOICE_NUMBER_SERIES_BEHIND`, migration
20261012161600) and the first issue asks where the series continues: the number
after the highest imported one, or a new prefix. Nothing is used up meanwhile.

## ROT, RUT and grön teknik on Visma invoices

The import has no slot for a household deduction, and Visma's SIE keeps the
whole invoice on 1510. An open Visma invoice issued under fakturamodellen
therefore arrives reading as owed in full by the buyer, and cannot be requested
from Skatteverket in Accounted. Visma's detail payload carries the deduction
(`RotReducedInvoicingType`, `RotReducedInvoicingAmount`, `Persons`, the property
fields, `TaxDeductionStatus`, per row `IsWorkCost`, `WorkCostType`, `WorkHours`,
`GreenTechnologyType`); the mapper reads it into `SalesInvoiceDto.householdDeduction`
and `SalesInvoiceLineDto.householdWork`, and `src/lib/providers/visma/housework.ts`
maps `WorkCostType` to Skatteverket's arbetstypskod. The importer itself still
writes no deduction: moving it onto 1513 needs a voucher.

That is the post-migration step on `/import` (card "ROT- och RUT-avdrag från
Visma", `POST /api/extensions/ext/arcim-migration/deduction-backfill` with
`mode` `preview` or `apply`, runner `src/extensions/general/arcim-migration/lib/deduction-backfill.ts`). It finds the
imported invoices through `migration_source_records`, fetches each open one's
detail from Visma, and plans it (`src/lib/invoices/migrated-deduction-plan.ts`):

| Visma `TaxDeductionStatus` | Buyer has paid | Result |
|---|---|---|
| 0/1, not requested | nothing | deduction applied, status unchanged |
| 0/1 | part of their share | applied, `partially_paid` |
| 0/1 | their whole share | applied, `paid` on Visma's `PaymentDate`; review if Visma's remaining differs from ours or that payment year's deadline (31 January after) has passed |
| 2, requested from Visma | any | not applied: Skatteverket's payout is matched on 1510 as an ordinary payment; a part-paid invoice is repaired to `partially_paid` |
| 3, refused | any | not applied: the buyer owes it, already on 1510; same status repair |

Review instead of apply: more than one buyer (#3314), a missing or invalid
personnummer, a work type with no element in the begäran schema (heat pumps,
boilers), rows that differ from the stored items, missing hours, ROT without a
property, a deduction above the open amount or not in whole kronor, a non-SEK
invoice. Paid invoices are never touched.

Apply books, per invoice and dated the run day, a `rot_rut_reclassification`
voucher through the engine (debit 1513, credit 1510; one live voucher per
invoice by partial unique index) after a dry run of
`apply_migrated_invoice_deduction`, then the RPC itself
(migration 20261015001000): it refuses any drift from what the plan saw,
checks the voucher moved exactly the deduction, derives `remaining_amount` and
status with `rot_rut_customer_outstanding`, writes the header and work rows,
and logs `InvoiceDeductionMigrated` in `processing_history`. 1510 and 1513 share
SRU 7251: no balance sheet, INK2 or VAT figure moves. A run that stops (Visma's
600 requests a minute, an expired token, a locked period, the 10-minute budget)
continues on the next call: applied invoices are skipped and a posted voucher
is reused. Reversing the voucher reverts the invoice
(`revert_migrated_invoice_deduction`); the storno is refused while a begäran
made in Accounted holds the invoice. The preview also lists invoices applied
here that Visma has since marked as requested: those must not be requested
again from Accounted.

The new mapper also gives a part-paid sales invoice of any provider
`partially_paid` (payment date empty, as on a native partial payment) instead
of `sent`.
