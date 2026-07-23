# Supabase staging migration evidence: 2026-07-22

Classification: Confidential

Environment: `erpbase` Supabase staging branch

The isolated, history-hydrated CLI dry run listed exactly these migrations,
and remote migration history confirmed both versions after application:

- `20260722190000_invoice_email_cc_bcc.sql`
  - SHA-256: `3485F7E6D4E03ED9688BD99C3E2736BD6BED0C3C48E8BDA0D6EE813F1E49B99A`
- `20260722191000_invoice_payment_accounts_by_currency.sql`
  - SHA-256: `B72FAFCCC29EA1B5FE4853F1053C1E6D46F8DEDFB67010A79882FE50D005C46A`

This file records deployment evidence only. Architectural rationale remains in
`DECISIONS.md`.
