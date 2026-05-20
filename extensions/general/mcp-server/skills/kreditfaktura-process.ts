import type { Skill } from './types'

const body = `# Kreditfaktura (Credit Note) Process — gnubok

When a sent invoice needs to be partially or fully reversed, Swedish law
(BFL 5 kap. 6-7 §, ML 17 kap. 30 §) requires a kreditfaktura — not a delete,
not an in-place edit. This skill covers when to issue one, how, and the
common mistakes.

## When to use

- "Kreditera fakturan / Refund the customer"
- "The customer disputed the invoice"
- "We invoiced the wrong amount / wrong items"
- "The customer returned the goods"
- "Make a credit note"

## Decision: kreditfaktura vs correct vs reverse

These three tools sound similar but solve different problems:

| Situation | Tool | Why |
|---|---|---|
| Invoice was sent to customer; needs partial/full reversal | \`gnubok_credit_invoice\` | Creates a KR-prefixed mirror invoice + reverses the original JE. Customer gets a kreditfaktura PDF. |
| Internal verifikation that has wrong account/amount but no customer-facing invoice involved | \`gnubok_correct_entry\` | Storno + new posted entry. No invoice document changes. Stays inside BFL 5 kap. 5 §. |
| Internal verifikation that should never have existed (duplicate, ghost) | \`gnubok_reverse_journal_entry\` | Pure storno — original stays visible, no replacement posted. |

**If a customer received an invoice, you must use credit_invoice.** The other
two leave the original invoice document intact, which makes the books and
the customer's records disagree.

## Legal framework

- **BFL 5 kap. 6-7 §**: rättelser must preserve audit trail (storno + new entry; never in-place edit; never gap in löpnummer).
- **ML 17 kap. 30 §**: a kreditfaktura is a new invoice referencing the original. Both must be archived for 7 years.
- **BFL 5 kap. 5 §**: löpnummer must be gap-free. The original invoice's number is *not reused* — the kreditfaktura gets its own KR-prefixed number from the credit series.
- **VAT timing (faktureringsmetoden)**: the credit lands in the period the kreditfaktura is *issued*, not the period of the original invoice. This is correct — Skatteverket files VAT period-by-period and each filing stands alone. Don't try to "back-date" the credit into the original period.

## Workflow

### Step 1 — Verify the original

\`gnubok_list_invoices(status='sent')\` or \`status='overdue'\` to find the invoice.
The invoice must be in one of: \`sent\`, \`paid\`, or \`overdue\`. You cannot credit:

- A draft (just edit/delete the draft before sending)
- An already-credited invoice (it has status \`credited\`)
- A proforma (use \`gnubok_convert_invoice\` first if needed, but proformas don't post to VAT/AR — usually you just cancel them)

### Step 2 — Stage the kreditfaktura

\`gnubok_credit_invoice({ invoice_id, reason?: 'Felaktigt belopp' })\`.

The \`reason\` is optional but shows on the credit note PDF — fill it in for
auditability and customer clarity. The tool will:

1. Generate a KR-prefixed invoice number (e.g. \`KR-2026-0042\`).
2. Mirror the original line items with negative effects.
3. Reverse the original JE via storno (so the AR balance returns to zero and VAT is reversed in the current period).
4. Mark the original invoice as \`credited\` so it can't be credited again.

This stages a pending_operation — the user approves before any DB write.

### Step 3 — Refund the customer (if money already received)

If the original invoice was already paid:

- The credit posts to 1510 (kundfordring) — the customer balance is now negative (we owe them).
- Issue an outbound bank payment for the refund amount. When the bank shows
  the outgoing transaction, categorize it via \`gnubok_categorize_transaction\`
  to debit 1510 and clear the customer balance.

If the original was unpaid, no refund — the credit just zeroes the AR balance.

### Step 4 — Send the credit note to the customer

\`gnubok_send_invoice({ invoice_id: <kreditfaktura_id> })\`.

The customer receives a PDF marked "KREDITFAKTURA" with reference to the
original invoice number. ML 17 kap. 30 § requires the kreditfaktura to
reference the document being credited — gnubok does this automatically.

### Step 5 — Verify

- \`gnubok_get_ar_ledger\` — customer balance should reflect the credit.
- \`gnubok_get_vat_report(period_type='monthly', year, period)\` — the credit reduces ruta 05 + ruta 10/11/12 (output VAT) in the current period.
- \`gnubok_get_general_ledger(account_number='1510')\` (or 3xxx revenue accounts) — confirm the storno hit.

## Partial credits

If only part of the invoice should be credited (e.g. one of three items was
defective), the current \`gnubok_credit_invoice\` always credits the FULL
original. For partial credits, the current workaround:

1. Credit the full invoice with \`gnubok_credit_invoice\`.
2. Issue a new invoice for the items that ARE still owed via \`gnubok_create_invoice\`.

This produces a clean audit trail with three documents (original, kreditfaktura,
correction-invoice) instead of a partial credit document. Skatteverket and
auditors prefer this — partial credit documents are notoriously easy to
misread.

## Common errors

- *"Fakturan har redan krediterats"* — the invoice is already in status \`credited\`. There's nothing to do; if you need to reverse the kreditfaktura itself, that's a separate (rare) operation.
- *"Endast skickade, betalda eller förfallna fakturor kan krediteras"* — the invoice is a draft. Either send it first (then credit) or just edit the draft.
- *"Credit notes can only be created from standard invoices"* — caller tried to credit a proforma. Proformas have no VAT/AR effect; cancel them instead.

## Tools

- \`gnubok_list_invoices\` — find the original
- \`gnubok_credit_invoice\` — the main tool, stages the kreditfaktura
- \`gnubok_send_invoice\` — deliver the credit note to the customer
- \`gnubok_categorize_transaction\` / \`gnubok_match_transaction_to_invoice\` — book the refund payment (if any)
- \`gnubok_get_ar_ledger\` / \`gnubok_get_vat_report\` — verification
`

export const kreditfakturaProcessSkill: Skill = {
  slug: 'kreditfaktura-process',
  name: 'Kreditfaktura (Credit Note) Process',
  summary: 'When and how to credit a sent invoice: kreditfaktura vs correct vs reverse, BFL/ML rules, refund flow, partial credits.',
  tags: ['invoicing', 'kreditfaktura', 'vat', 'compliance'],
  body,
  tier: 'workflow',
  applicability: { entity_type: 'both' },
}
