## Gotchas (Swedish accounting domain)

Rules a generic REST integration will violate unless told:

- **Account numbers are strings, not numbers.** BAS accounts (`"1930"`,
  `"3001"`) are identifiers; send them as JSON strings. Arithmetic on them,
  zero-stripping, or number coercion corrupts postings.
- **Posted journal entries are immutable by law** (Bokföringslagen). There is
  no PATCH or DELETE on a committed entry, ever. Undo with
  `POST .../journal-entries/{id}/reverse` (storno), fix with
  `POST .../journal-entries/{id}/correct`. Design flows around
  reverse-and-repost, not edit-in-place.
- **Voucher numbers are gapless and server-assigned.** Never assume or
  pre-allocate one; read it from `meta.audit.voucher_number` after commit. A
  legally required gap explanation goes through
  `POST .../voucher-gap-explanations`.
- **Every entry balances.** `sum(debit) === sum(credit)` to the öre, amounts
  are decimal SEK numbers (max 2 decimals). Do rounding with
  round-half-away-from-zero on öre; never float-accumulate line totals
  client-side and "fix" the difference on a random line.
- **Period locks are a feature, not an error to retry.** Writes into a
  locked/closed period return `PERIOD_LOCKED` (with `valid_alternatives`
  pointing at open periods). Retrying the same request cannot succeed; either
  target an open period or surface the lock to the user.
- **Drafts vs posted.** Invoices are created as drafts with
  `invoice_number: null`; the F-series number is assigned atomically on send.
  Journal entries follow draft -> commit. Nothing financial exists in the
  ledger until the commit/send action.
- **Two invoice worlds.** `invoices` = accounts receivable (you bill
  customers); `supplier-invoices` = accounts payable (you receive bills).
  They are different resources with different lifecycles.
- **Swedish user-facing text.** `error.message` is Swedish by design; show it
  to Swedish end users, and use `message_en` for your own logs/logic. Domain
  terms in responses (moms, verifikat, kostnadsställe) are not translatable
  labels but legal concepts.
- **Compliance pre-flight.** Before building your own validation for Swedish
  rules, call `GET .../compliance/check`: it runs the server's own rule set
  (VAT plausibility, sequence integrity, period status) and returns findings.
