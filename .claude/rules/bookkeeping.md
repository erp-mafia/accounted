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

For Swedish accounting-law questions, use the domain skills (`swedish-vat`, `swedish-accounting-compliance`, `swedish-year-end-closing`, etc.). The Hard Rules in the root `CLAUDE.md` always apply.

## Core Services (`src/lib/core/`)

- `bookkeeping/period-service.ts`: Fiscal period lifecycle management (open, close, lock)
- `bookkeeping/year-end-service.ts`: Year-end closing procedures
- `bookkeeping/storno-service.ts`: Reversal/correction entry generation
- `audit/audit-service.ts`: Audit trail and compliance logging
- `documents/document-service.ts`: Document attachment lifecycle (WORM storage with version chains)

## Key BAS Accounts

`1510` Accounts receivable | `1930` Business bank account | `2013` Private withdrawals (EF) | `2440` Accounts payable | `2611`/`2621`/`2631` Output VAT 25%/12%/6% | `2641` Input VAT | `2645` Calculated input VAT (EU) | `2893` Shareholder loan (AB) | `3001`/`3002`/`3003` Revenue 25%/12%/6% | `3305`/`3308` Export/EU service revenue

BAS data (`src/lib/bookkeeping/bas-data/`): full BAS 2026 chart by class (1-8) + SRU mapping. Account numbers are **strings** (`'1930'`, never `1930`).

## VAT Treatments

`standard_25`, `reduced_12`, `reduced_6`, `reverse_charge`, `export`, `exempt`

Invoice items support individual `vat_rate` values (mixed-rate invoices). Both helpers live in `src/lib/invoices/vat-rules.ts` and are not interchangeable: `getAvailableVatRates(customerType, vatNumberValidated)` is the DEFAULT a picker offers or a line starts on (a single locked 0% for a foreign business); `getPermittedVatRates(...)` is the LAWFUL set every validation gate must use, because the ML 6 kap. supplies taxed where they are performed carry Swedish VAT even to a foreign business. VIES validation via `src/lib/vat/vies-client.ts`.

## VAT Declaration Rutor (SKV 4700)

Ruta assignment is driven by **BAS account number**, never by a per-line tax code: `ACCOUNT_RUTA` in `src/lib/reports/vat-declaration.ts` is the source of truth, mirrored by `ACCOUNT_TO_BOX` in `src/lib/vat/moms-box-mapping.ts` (a regression test asserts the two agree). `journal_entry_lines.tax_code` is a free-text tag that nothing reads; there is no `tax_codes` table (migration 012 is a placeholder for a design that was never deployed).

`VatDeclarationRutor` type maps to momsdeklaration:
- **Ruta 05**: Domestic taxable sales (3001+3002+3003)
- **Ruta 06/07**: Unused, always 0
- **Ruta 10/11/12**: Output VAT 25%/12%/6% (2611/2621/2631)
- **Ruta 39/40**: EU services / Export (3308/3305)
- **Ruta 48**: Input VAT (2641/2645)
- **Ruta 49**: Moms att betala/återfå = (10+11+12+30+31+32+60+61+62) − 48
