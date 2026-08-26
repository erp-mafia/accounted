# Settlement account remediation

Use this runbook to review journal entries that may have been posted against a
different settlement account than the cash account linked to their source bank
transaction. It covers historical entries created before and around the fixes
for issues #985, #986, and #987.

The audit is intentionally broader than a list of confirmed errors. A current
`cash_account_id` does not prove that the transaction had that link when the
entry was posted. Never correct an entry from query output alone.

## Invariants

- Never edit or delete a posted journal entry.
- Correct a confirmed error with storno plus a replacement entry through
  `gnubok_correct_entry`.
- Keep every replacement line balanced and preserve the original line metadata.
- Do not write directly to `journal_entries` or `journal_entry_lines`.
- Do not correct a locked or closed period without a separately reviewed and
  explicitly approved unlock or reopening workflow.
- Never run a production correction without explicit approval for the exact
  company, vouchers, and replacement lines.

## Detect candidates

Run [`scripts/audit-settlement-account-mismatches.sql`](../scripts/audit-settlement-account-mismatches.sql)
against the intended database. The query is read-only and returns current
posted entries whose exact directional settlement leg differs from
`cash_accounts.ledger_account`.

Treat `review_priority` only as an ordering aid:

- `high_review_priority_hardcoded_1930_signature` matches the known historical
  failure shape, but still needs evidence review.
- `manual_review_payment_aware_correction_required` identifies a payment flow with a
  mismatching account. Detection is supported, but the generic correction
  procedure below is not. Stop and use a payment-aware correction path.
- Every `manual_review_*` result may be a later cash-account link, a manual
  reconciliation, or another legitimate accounting shape.

## Review each candidate

1. Confirm the transaction belongs to the reported cash account using the
   original bank feed or statement and the bank connection metadata.
2. Confirm that the cash-account link existed when the journal entry was
   posted. `transaction_updated_at` close to `committed_at` is supporting
   evidence, not proof.
3. Fetch the current journal entry and all lines. Stop if the entry was already
   reversed, corrected, or linked manually after posting.
4. Confirm there is exactly one settlement leg and that its direction and SEK
   amount match the bank transaction.
5. Confirm the only required accounting change is replacing the observed
   settlement account with `expected_settlement_account`.
6. Check `effective_lock_status`. Both the fiscal period's `is_closed` and
   `locked_at` fields and the company-wide `bookkeeping_locked_through` date
   are authoritative lock layers. Any result other than `open` is a hard stop
   for the ordinary correction flow. If VAT has already been filed, determine
   whether an omprövning is required before reopening anything.
7. Stop when `booking_flow` is `customer_invoice_payment` or
   `supplier_invoice_payment`. The generic correction service does not relink
   all invoice-payment references from the reversed entry. A payment-aware,
   tested correction procedure is required for those candidates.

Keep the reviewed candidate set, evidence, proposed replacement lines, and
reviewer identity together as the correction record.

## Stage the correction

For a confirmed candidate in an open and unlocked period:

1. Re-run the audit query immediately before staging and retain its
   `original_lines` value. It includes currency amounts, exchange rates, tax
   codes, dimensions, cost centers, and projects that the ordinary journal
   query does not return.
2. Re-fetch the entry with `gnubok_query_journal` to confirm that its status,
   voucher, amounts, and visible lines still match the fresh audit result.
3. Copy every object from `original_lines` into the `lines` input for
   `gnubok_correct_entry`.
4. On the one confirmed settlement line, replace only `account_number` with
   `expected_settlement_account`.
5. Preserve debit and credit amounts, line descriptions, currency metadata,
   tax codes, dimensions, cost centers, and projects exactly as recorded.
6. Verify that total debits equal total credits and both totals are positive.
7. Stage `gnubok_correct_entry` using the voucher reference or freshly fetched
   entry UUID. Review its original and correction previews line by line.
   The preview must show the preserved currency, tax, and dimension metadata.
8. Approve the staged operation with `gnubok_approve_pending_operation` only
   after the exact operation has explicit authorization. High-risk approval
   requires `confirmed: true`.

Do not use `gnubok_reverse_journal_entry` by itself for this case. The business
event remains valid; only its settlement account is being corrected.

## Verify after approval

1. Confirm the original entry is retained with status `reversed`.
2. Confirm a posted storno and a posted corrected entry were created in the
   intended fiscal period.
3. Confirm the bank transaction now links to the posted corrected entry.
4. Confirm the corrected settlement leg uses the expected account and amount.
5. Run `gnubok_get_general_ledger` for both the observed and expected accounts.
6. Re-run the audit query. The corrected transaction must no longer appear.
7. Record the new voucher references and verification evidence with the
   reviewed candidate set.
