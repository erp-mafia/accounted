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
permitted. Two tracks exist:

1. **Särskild rättelsepost** (storno + correcting verifikation referencing the
   original). Always allowed, and the **only** track once the period is
   locked/closed or the bokföring has been relied upon (filed momsdeklaration,
   bokslut).
2. **Rättelse in the same verifikat** (strike-and-replace with the struck lines
   still readable). Only in open, unlocked periods.

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
- Any `effective_lock_status` other than `open` is a hard stop for the ordinary
  flow.
- Never run a production correction without explicit approval for the exact
  company, vouchers and replacement lines.
- No automated bulk mutation. Ever.

## Detect candidates

Run [`scripts/audit-template-misbookings.sql`](../scripts/audit-template-misbookings.sql)
against the intended database. It is read-only, creates nothing, and returns
only posted entries.

**Output is diagnostic, never a verdict.** There is no provenance link from a
posted entry back to the template that produced it (`template_id` lives on
`mapping_rules`, not on journal entries), so candidates are matched by account
signature, and both signatures have legitimate shapes:

- `5820` is the **correct** account for actual car hire.
- Representation at 25% is lawful when the underlag carries 25% VAT.

Read `review_priority` as an ordering aid only:

| Priority | Meaning |
|---|---|
| `high_hotel_counterparty_on_car_hire_account` | A `5820` line with a hotel-shaped counterparty. The strongest signal, still needs evidence. |
| `medium_12pct_vat_on_car_hire_account` | `5820` with 12% VAT beside it. Car hire is 25%, so this is suggestive. |
| `high_vat_is_25pct_of_6072_cost` | Representation whose input VAT is 25% of the cost leg. |
| `manual_review_*` | No corroborating signal. Most likely legitimate. |

The classifier is verified against seeded probes: a hotel booked to `5820`
ranks high, a genuine car hire on `5820` falls to manual review, a 25%
representation ranks high, and a correct 12% representation does not appear at
all.

## Review each candidate

1. Open the underlag (kvitto/faktura) and confirm what was actually purchased.
   A hotel night and a rental car are both plausible on `5820`.
2. For the VAT defect, confirm the rate the supplier actually charged. 12% is
   the restaurang/servering rate; a supplier who charged 25% was right to, and
   the entry is then correct.
3. Fetch the entry and all lines. Stop if it was already reversed or corrected.
4. Check `effective_lock_status`. Anything other than `open` is a hard stop.
5. For the VAT defect, establish whether the period's momsdeklaration has been
   filed. If so, an omprövning is in scope and the ledger correction alone is
   not sufficient.
6. Decide materiality. A 40 kr VAT difference on one lunch two years ago in a
   closed period is unlikely to warrant reopening anything; a systematic error
   across a year is different. Record the decision either way.

Keep the reviewed set, the evidence, the proposed replacement lines and the
reviewer identity together as the correction record.

## Stage the correction

Follow the identical procedure in
[`SETTLEMENT_ACCOUNT_REMEDIATION.md`](./SETTLEMENT_ACCOUNT_REMEDIATION.md#stage-the-correction):
copy every original line, change only what is wrong, preserve all currency, tax
and dimension metadata, verify the replacement balances, stage
`gnubok_correct_entry`, and approve only with explicit authorisation.

For the hotel defect, the only change is `account_number` on the cost line,
`5820` to `5830`.

For the VAT defect, both the cost leg and the VAT leg change, because the split
of a fixed gross total moves: at 12% the cost is `total/1.12` and the VAT is the
remainder. The gross and the settlement leg are unchanged.

## Verify after approval

1. The original is retained with status `reversed`.
2. A posted storno and a posted corrected entry exist in the intended period.
3. The corrected leg uses the expected account and amount.
4. Re-run the audit query: the corrected entry no longer appears.
5. For the VAT defect, re-run the momsdeklaration for the period and confirm
   ruta 48 moves by the expected amount.
6. Record the new voucher references with the correction record.
