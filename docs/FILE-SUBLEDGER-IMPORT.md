# Customer and supplier subledger file import

This implementation adds a register-only import under **Import > CSV/Excel >
Subledger** in hosted Accounted. A source-provider subscription is not required.
The same authenticated session endpoint handles the browser wizard and reviewed
JSON requests: `POST /api/import/subledger`.

## Supported scope

- Outstanding customer and supplier invoices in SEK, under accrual accounting.
- Full or partially settled balances, with original invoice numbers and dates.
- Original registration vouchers already present in Accounted, including SIE
  source series/numbers and invoices from earlier fiscal years.
- Control accounts '1510' and '2440', including opening balances in reconciliation.
- CSV and single-sheet XLSX, maximum 500 invoices and 10 MB per file.
- Existing counterparties. Import customer/supplier master records first.

This imports invoice headers and remaining balances, not invoice lines or PDF
attachments. It does not issue invoices, send emails, create payment records,
post registration/payment vouchers, or reverse existing bookkeeping. The actual
payment date remains unknown. Supplier arrival numbers are internal register
identifiers; original supplier invoice numbers are preserved separately.

Credit notes, settled invoices, foreign currency, cash accounting, alternative
control accounts, mixed VAT treatments, ROT/RUT deductions, and invoices whose
registration vouchers cannot be identified are outside this version. Unsupported
or inconsistent inputs are rejected. Do not remove genuine outstanding credits
from a source report to make it fit: the resulting balance will not reconcile.
PDF-only input must first be transcribed or extracted into the template and
reviewed by the user. Keep the original documents in the normal document archive;
this importer does not replace the original invoice or reconstruct its line items.

## Template

Download the CSV template in the wizard. Column order may vary, but every header
must occur exactly once. CSV accepts semicolons or commas; use quoted values when
a delimiter occurs in a field. Decimal commas or points are accepted, without
thousands separators. Dates must be ISO `YYYY-MM-DD`. Keep identifiers as text in
Excel to preserve leading zeros. A workbook must have exactly one worksheet.

| Column | Meaning |
| --- | --- |
| `counterparty` | Existing record UUID, exact name, organization number, or customer number. Ambiguous matches are rejected. |
| `invoice_number` | Original number, including any leading zeros. |
| `invoice_date` | Original invoice date. |
| `due_date` | Original due date. |
| `currency` | `SEK`. |
| `vat_treatment` | `standard_25`, `reduced_12`, `reduced_6`, `reverse_charge`, `export`, or `exempt`. |
| `total` | Original positive gross amount. |
| `vat_amount` | Original VAT amount, not VAT on the remaining balance. Must agree with the single treatment. |
| `remaining_amount` | Positive outstanding amount at the snapshot date, no greater than total. |
| `voucher_series` | Original registration voucher series, using the SIE source identity when present. |
| `voucher_number` | Original registration voucher number. |
| `voucher_year` | Start year of the voucher's fiscal period. |
| `payment_reference` | Original OCR/reference when supplied; may be blank. Retained in source provenance and on supplier invoices. |

Synthetic example:

```csv
counterparty;invoice_number;invoice_date;due_date;currency;vat_treatment;total;vat_amount;remaining_amount;voucher_series;voucher_number;voucher_year;payment_reference
Example Customer AB;000123;2026-06-01;2026-06-30;SEK;standard_25;1250;250;625;B;17;2026;0012345
```

## Review and reconciliation

1. Confirm the company displayed in the wizard, select the ledger and snapshot
   date, and upload a completed template.
2. Preview resolved counterparties, original totals/VAT, dates and remaining
   amounts. Hover the invoice number to inspect the matched source voucher ref.
3. Compare the file total plus existing outstanding invoices with the posted
   control-account balance. The database uses the same explicit-opening-balance,
   prior-balance fallback and period-activity functions as the trial balance.
4. Import is enabled only when the difference is zero. The final dialog names
   the company, invoice count and total and states that no bookkeeping is created.

The snapshot must cover current posted control-account activity. A later posted
movement blocks an older snapshot; use an updated source report rather than
silently importing stale payment state. Registration references must resolve to
one posted voucher within 31 days of the invoice date, in the specified fiscal
year, with the exact original total on the control account. The same voucher
cannot register multiple invoices through this importer.

## Execution and recovery

`import_file_subledger` is one bounded database transaction. It checks membership
and write role itself, locks fiscal-period observation against SIE imports,
serializes file/provider import attempts, and repeats all identity, voucher,
duplicate and reconciliation checks during execution. The preview token binds the
approved rows, resolved links and balances to the selected company and snapshot.
The browser refuses company changes, and the route also checks the posted company
ID against the active authenticated company.

A successful batch stores its source rows, actor, target IDs and receipt in
`subledger_file_imports`, with company-scoped read access and audit history. Only
the import RPC writes it for session users. Exact retries return the original
receipt without rewriting invoices, even if payments were recorded afterwards.
Changed or overlapping files are rejected on invoice identity instead of
silently overwriting balances. Customer invoice numbers are unique within the company;
supplier invoice numbers are matched within the supplier. Failure rolls back the
whole batch. There is no automatic reversal or deletion action.

## Validation and deployment

Unit tests cover template parsing, identifier preservation, amount/date errors,
authorization, company changes, preview/execute payloads and safe error responses.
`tests/pg/file-subledger-import.pg.test.ts` covers the real database transaction,
company isolation, duplicate rejection, unchanged journal snapshots, partial
balances, stale snapshots and concurrent receipt recovery.

The new migration must be validated in Accounted's permitted staging environment
before merge/deployment. Apply the follow-up
`20260922115437_harden_file_subledger_search_path.sql` as well: it keeps temporary
tables behind public relations in the privileged RPC. The PostgreSQL tests cover
forged temporary membership during preview and execution, plus legitimate owner
access with a temporary shadow present. Local Postgres and the user's self-hosted installation
are not test targets. Deploy the migration and application together through the
project's normal release process; publishing this PR alone does not activate it.

## Customer invoice numbering

The preview shows any advance to the next customer invoice number. Importing
canonical numbers in the company's configured prefix moves the counter past
the highest imported or existing number in that series. Unrelated external
formats retain their original numbers without changing the counter. A higher
configured counter is never lowered. Numbering is locked against normal issuance,
bound into the preview token, and updated in the same transaction as the import;
failed imports and exact retries do not consume numbers.

Apply `20260922121335_file_subledger_invoice_numbering.sql` after both earlier
subledger migrations. This includes the hardened search path.
