---
paths:
  - "src/lib/bookkeeping/**"
  - "src/lib/core/**"
  - "src/lib/reports/**"
  - "src/lib/vat/**"
  - "src/lib/invoices/**"
  - "src/lib/salary/**"
---

# Bookkeeping Domain Reference

BAS data (`lib/bookkeeping/bas-data/`): the full BAS 2026 chart by class (1-8) with its SRU mapping.

## VAT Treatments

`standard_25`, `reduced_12`, `reduced_6`, `reverse_charge`, `export`, `exempt`

Invoice items support individual `vat_rate` values (mixed-rate invoices). Both helpers live in `lib/invoices/vat-rules.ts` and are not interchangeable: `getAvailableVatRates(customerType, vatNumberValidated)` is the DEFAULT a picker offers or a line starts on (a single locked 0% for a foreign business); `getPermittedVatRates(...)` is the LAWFUL set every validation gate must use, because the ML 6 kap. supplies taxed where they are performed carry Swedish VAT even to a foreign business. VIES validation via `lib/vat/vies-client.ts`.

## VAT Declaration Rutor (SKV 4700)

Ruta assignment is driven by **BAS account number**, never by a per-line tax code: `ACCOUNT_RUTA` in `lib/reports/vat-declaration.ts` is the source of truth, mirrored by `ACCOUNT_TO_BOX` in `lib/vat/moms-box-mapping.ts` (a regression test asserts the two agree). `journal_entry_lines.tax_code` is a free-text tag that nothing reads; there is no `tax_codes` table (migration 012 is a placeholder for a design that was never deployed).
