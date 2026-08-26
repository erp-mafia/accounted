# Template mis-booking remediation

Use this runbook to review posted entries that a defective booking template may
have mis-classified, and to correct the confirmed ones lawfully.

Companion to [`SETTLEMENT_ACCOUNT_REMEDIATION.md`](./SETTLEMENT_ACCOUNT_REMEDIATION.md),
which covers the same class of problem for settlement legs. The invariants and
the correction mechanics are identical; only the detection differs.

## Which defects this covers

Two templates produced postings that **succeeded** and are therefore sitting in
customers' huvudböcker today:

| Defect | Was | Should be | Fixed in |
|---|---|---|---|
| `travel_hotel` debited car hire | `5820` Hyrbilskostnader | `5830` Kost och logi | #1397 |
| Representation over-deducted VAT | 25% input VAT | 12% (restaurang/servering) | #1396 |

**Deliberately not covered:** `vehicle_parking` (`5614`) and `it_cloud_hosting`
(`5421`) named accounts that never existed in BAS 2026. `account-backfill.ts`
only seeds accounts present in `BAS_REFERENCE`, so those templates failed with
`AccountsNotInChartError` every time and **nothing was ever posted through
them**. There is nothing to remediate.

## What the law requires

BFL 5 kap 5 §: a rättelse must leave both the original and the correction
visible, and record when it was made and by whom. Silent overwriting is never
permitted. A manual book may use a readable strike-and-replace correction while
the bookkeeping is still open. This runbook is for Accounted's computerized
bookkeeping and supports only a **särskild rättelsepost**: storno plus a
correcting verifikation linked to the original through `gnubok_correct_entry`.

There is **no numeric materiality threshold in BFL**. Materiality governs
whether a historical correction is worth making, not whether the law permits a
silent one: it never does.

For the VAT defect specifically, if the affected period's momsdeklaration has
already been filed, an over-deducted input VAT means an **omprövning** to
Skatteverket, not merely a ledger correction. Establish that before touching
anything.

## Invariants

- Never edit or delete a posted journal entry.
- Correct a confirmed error with storno plus a replacement through
  `gnubok_correct_entry`. Never `gnubok_reverse_journal_entry` alone: the
  business event remains valid, only its classification is wrong.
- Do not write directly to `journal_entries` or `journal_entry_lines`.
- Any `effective_lock_status` other than `open` is a hard stop for the current
  `gnubok_correct_entry` path. Never unlock, reopen or edit the original merely
  to make a correction possible. A locked-period correction requires a
  separately reviewed and tested path that records a storno and replacement in
  an open period, references the original, and preserves who corrected it and
  when. If a declaration or closing relied on the locked period, establish the
  required omprövning or closing consequences before requesting approval.
- Never run a production correction without explicit approval for the exact
  company, vouchers and replacement lines.
- No automated bulk mutation. Ever.

## Detect candidates

Run [`scripts/audit-template-misbookings.sql`](../scripts/audit-template-misbookings.sql)
against the intended database. It is read-only, creates nothing, and returns
only posted entries.

The audit now separates the broad signature from the evidence classification.
There is no direct template id on a journal entry, but `source_type`, exact line
shape, transaction context and linked underlag can rule candidates in or out.
Both signatures still have legitimate shapes:

- `5820` is the **correct** account for actual car hire.
- Representation at 25% is lawful only when the supply is actually subject to
  25% VAT and the supplier invoice is correct.

Read `evidence_classification` as the remediation queue:

| Classification | Meaning |
|---|---|
| `confirmed_correction` | Exact defective shape plus corroborating evidence. Review the underlag, then stage `gnubok_correct_entry` and request explicit approval for the exact voucher and replacement lines. |
| `insufficient_evidence` | The shape matches, but the underlag or provenance is not decisive. Obtain evidence before proposing any write. |
| `false_positive` | Not attributable to either defective live template. This is not a general verdict that every aspect of the voucher is correct. |

`source_type` values `import` and `correction` are false positives for this
template-remediation audit because neither live template generated them. Keep
any independent accounting concern outside this remediation batch.

Linked underlag is resolved from direct journal-entry and journal-line links,
transactions and supplier invoices. Document identifiers and extracted VAT
signals are returned, but storage paths and file names are not. A decisive 25%
extraction on a representation voucher rules out the defective 12% restaurant
template signature. It does not by itself prove that the representation cap,
participant record or business purpose was handled correctly.

Every representation row therefore carries
`independent_representation_review = participants_purpose_and_300_sek_vat_base_cap_required`.
`observed_6072_cost_exceeds_300_sek` is a triage signal only: the statutory cap
is per person and occasion, so the number of participants and the underlag are
still required.

Read `review_priority` as a supporting ordering aid:

| Priority | Meaning |
|---|---|
| `high_hotel_counterparty_on_car_hire_account` | A `5820` line with a hotel-shaped counterparty. The strongest signal, still needs evidence. |
| `medium_12pct_vat_on_car_hire_account` | `5820` with 12% VAT beside it. Car hire is 25%, so this is suggestive. |
| `high_vat_is_25pct_of_6072_cost` | Representation whose input VAT is 25% of the cost leg. |
| `manual_review_5820_no_corroborating_signal` | A `5820` entry with no hotel-shaped text or 12% VAT ratio. Most likely legitimate car hire. |
| `manual_review_6072_with_vat` | A `6072` entry with `2641` VAT whose aggregate ratio is not exactly 25%. It may be correct or may be a mixed voucher masking the defective representation leg. |

The classifier is verified against read-only probes for confirmed, insufficient
and false-positive outcomes. The audit aggregates multiple `6072` and `2641`
lines per entry and returns one candidate instead of a many-to-many set of line
pairs. Mixed representation vouchers without decisive underlag remain
`insufficient_evidence`; they are never cleared merely because their aggregate
VAT ratio differs from the exact defective 25% signature.

Treat lock and VAT-return impact as overlays, not evidence classes:

- `effective_lock_status` identifies candidates that the current correction
  service cannot handle. Never unlock or reopen merely to permit a correction.
- `vat_return_impact = potential_if_confirmed` means a representation candidate
  could affect ruta 48. Determine the filing status before requesting approval.
- `vat_reporting_period`, `vat_deadline_statuses` and `vat_filing_status`
  surface the in-app filing record. `not_proven_by_in_app_records` is unknown,
  not proof that no declaration was filed externally.
- Keep exact company and voucher identifiers in an access-controlled approval
  manifest. Public issue updates should use aggregate batches unless disclosure
  has been explicitly approved.

## Review each candidate

1. Open the underlag (kvitto/faktura) and confirm what was actually purchased.
   A hotel night and a rental car are both plausible on `5820`.
2. For the VAT defect, classify the actual supply and determine the legally
   applicable rate; do not accept the invoice rate as proof. Restaurant and
   catering supplies are normally 12%, while alcohol and some mixed supplies
   can include 25%. If the supplier charged an inapplicable rate, request a
   corrected invoice before treating any input VAT as deductible or clearing
   the candidate.
3. Fetch the entry and all lines. Stop if it was already reversed or corrected.
4. Check `effective_lock_status`. Anything other than `open` is a hard stop.
5. For the VAT defect, establish whether the period's momsdeklaration has been
   filed. If so, an omprövning is in scope and the ledger correction alone is
   not sufficient.
6. Decide materiality. A 40 kr VAT difference on one lunch two years ago in a
   closed period may not warrant a separate correction in an open period; a
   systematic error across a year is different. Record the decision either way.

Keep the reviewed set, the evidence, the proposed replacement lines and the
reviewer identity together as the correction record.

## Stage the correction

Follow the identical procedure in
[`SETTLEMENT_ACCOUNT_REMEDIATION.md`](./SETTLEMENT_ACCOUNT_REMEDIATION.md#stage-the-correction):
retain `original_lines`, copy every original line, change only what is wrong,
verify the replacement balances, stage
`gnubok_correct_entry`, and approve only with explicit authorisation.

`gnubok_correct_entry` routes through `correctEntry()` in
`lib/core/bookkeeping/storno-service.ts`. It retains the original, creates a
posted storno with `reverses_id`, creates the replacement with
`correction_of_id`, and records the acting user and timestamps. Never replace
this audited envelope with direct journal-table writes.

For the hotel defect, the only change is `account_number` on the cost line,
`5820` to `5830`.

For the VAT defect, the cost and VAT amounts change while accounts `6072` and
`2641`, the gross total, and the settlement leg remain unchanged. Calculate the
deductible VAT from the corrected invoice and the representation rules,
including the 300 SEK base per person and occasion. Do not blindly divide the
gross by 1.12 when the receipt mixes rates or exceeds the deduction cap;
non-deductible VAT remains on `6072`.

Journal lines have no `vat_rate` field. `tax_code` is a free-text tag and does
not drive the VAT return, but if it explicitly encodes the obsolete 25% rate,
update or clear it so the corrected entry is not misleading. Preserve currency,
`amount_in_currency`, `exchange_rate`, descriptions, dimensions, cost centers,
projects, and unrelated tax metadata exactly as recorded.

## Verify after approval

1. The original is retained with status `reversed`.
2. A posted storno and a posted corrected entry exist in the intended period.
3. The corrected leg uses the expected account and amount.
4. Re-run the audit query: the corrected entry no longer appears.
5. For the VAT defect, re-run the momsdeklaration for the period and confirm
   ruta 48 moves by the expected amount.
6. Record the new voucher references with the correction record.
