import type { Skill } from '../types'

const body = `# Fakturera rätt: Accounted

How to get one correct Swedish kundfaktura (or offert) from "I need to invoice X" to sent, the way an experienced consultant would: orient first, ask the few questions that decide the invoice, stage, and let the user approve. The user is a business owner, not an accountant: you carry the rules, they carry the facts.

## When to use

- "Skicka faktura till [kund]" / "Invoice [customer] for [amount]"
- "Make an offert", "turn the offert into an invoice"
- "How do I invoice an EU customer?", "Do I add moms?"
- A draft invoice that needs editing, or should wait before it is sent

Not here (load the sibling skill instead):

- New customer setup and the customer_type decision tree: \`customer-onboarding\`
- Credit notes, or a sent invoice that is wrong: \`kreditfaktura-process\`
- Matching a month of incoming payments against the bank feed: \`bank-reconciliation\`

## Step 0: Orient before acting

Answer each of these with a tool, not with an assumption:

| Question | Tool | Why it matters |
|---|---|---|
| Which company? | \`gnubok_list_companies\` | Several companies: ask which one, then pass that \`company_id\` on every call, including approval. Never guess. |
| Legal form and method | \`gnubok_get_agent_briefing\` | \`entity_type\` (aktiebolag / enskild_firma) and \`accounting_method\` (accrual = faktureringsmetoden, cash = kontantmetoden). Decides what happens at send and at payment. |
| VAT registered? | \`gnubok_list_skills\` (\`company_context.vat_registered\`) | A non-registered company charges no moms at all (see below). |
| Payment details on the invoice | \`gnubok_get_company_settings\` | Bankgiro, plusgiro, Swish or bank account for SEK, IBAN for other currencies. Missing means no PDF and no send. |
| Is the invoice date's period open? | \`gnubok_list_fiscal_periods\` | active = open, locked = no new entries, closed = year-end done. Under faktureringsmetoden, sending books a verifikat on the invoice date. |
| Existing drafts or quotes for this customer | \`gnubok_list_invoices\` (\`status\`, \`document_type\`) | Avoid a duplicate; an open offert may be the thing to convert. |

## Questions to ask before creating an invoice

Ask them together, in one short message, with what you already found filled in. Only ask what the tools could not tell you.

1. **Customer**: who exactly (legal name, org number or VAT number)? Look them up first with \`gnubok_list_customers\`.
2. **What was delivered**: goods or services, quantity, unit (st, tim, dag, mån), price excl. moms. If the company has an artikelregister, try \`gnubok_list_articles({ query })\` first.
3. **Dates**: invoice date (default today), and the delivery date when it differs from the invoice date (a mandatory field then). Payment terms if the customer's default does not apply.
4. **VAT treatment**: only when it is not obvious from the customer type (see the table below). Never ask "which VAT code"; ask the fact: "Was the work done in Sweden or at the customer's site abroad?", "Is this food, hotel, transport or books?".
5. **ROT/RUT**: only for a private person buying household services or construction work at their home: "Should the customer get ROT or RUT deduction on this?".
6. **Reference**: Er referens (the buyer's contact or order reference), Vår referens, and fakturamärkning if the buyer requires a PO label. Public-sector buyers always require Er referens.
7. **Send now or keep as draft?** Ask before staging the send.

Good question: "Last time Acme AB was invoiced 1 250 kr per hour + moms for consulting. Same price, 8 hours, delivered 1-15 September?" Bad question: "What should the invoice contain?".

## Customer is missing, or a number is missing

- **Customer not found** in \`gnubok_list_customers\`: load \`customer-onboarding\` and stage \`gnubok_create_customer\` (\`name\`, \`customer_type\`; plus \`org_number\`, \`vat_number\`, \`email\`, \`address\`, \`postal_code\`, \`city\`, \`country\` as known). For a Swedish company, \`gnubok_lookup_company({ org_number })\` fetches name, address and VAT status from the public registry so the user confirms instead of types. The customer exists only after approval: \`gnubok_create_invoice\` returns "Customer not found" until then.
- **Customer exists but lacks a field**: stage \`gnubok_update_customer\` (partial update). An EU \`vat_number\` is revalidated with VIES at approval.
- **No email on the customer**: \`gnubok_send_invoice\` refuses. Ask for the invoicing email and update the customer, or let the user deliver the PDF another way and use \`gnubok_mark_invoice_as_sent\`.
- **EU company without a VAT number**: ask for it. Without a validated number the invoice gets Swedish moms (the customer is treated as a consumer). Never invent a number or copy one from elsewhere.
- **The company's own VAT number is missing** (\`INVOICE_SEND_VAT_NUMBER_MISSING\`): a VAT-registered seller must show it (ML 17 kap. 24 §). The user adds it under Inställningar > Skatt; you cannot fix it.
- **Payment details missing** (\`INVOICE_SEND_PAYMENT_ACCOUNT_MISSING\`): the user adds bankgiro, Swish, bank account or IBAN under Inställningar > Fakturering.

## VAT treatment

The customer's \`customer_type\` and VIES status drive the default rate; Accounted refuses any rate other than 0, 6, 12 or 25 %. Override per line with \`vat_rate\` only when you know why.

| Customer | Treatment | Rate |
|---|---|---|
| Swedish person or company | standard | 25 %, or 12 % / 6 % by what is sold |
| EU business, VIES-validated VAT number | reverse charge | 0 % with "Omvänd betalningsskyldighet" (added automatically) |
| EU business, number missing or not validated | treated as consumer | Swedish moms |
| Business outside the EU | export | 0 % |

Reduced rates: 6 % for books, newspapers, passenger transport, cultural and sports events, and livsmedel sold as goods from 1 April 2026 (grocery, takeaway from a retailer); 12 % for hotel and for restaurang och servering (stays 12 % after 1 April 2026). A hotel room is 12 %, the on-site restaurant is restaurang (12 %), a minibar is goods. Classify the supply; do not default one rate for "hotel/restaurant".

### EU customers and VIES

- Reverse charge needs a valid VAT number checked in VIES. Accounted runs VIES when the customer is created or updated with \`vat_number\`, and stores the result. When \`gnubok_create_invoice\` returns \`vat_warnings\`, read them to the user: they say which reverse-charge condition failed.
- VIES down or number invalid: the invoice falls back to Swedish moms. Do not override to 0 % to "fix" it. Ask the user to confirm the number, stage \`gnubok_update_customer\` to revalidate, and invoice once it validates.
- Issue the invoice for an intra-EU sale by the 15th of the month after delivery (ML 17 kap. 19 §). EU sales also go in the periodisk sammanställning; \`quarterly-vat-review\` covers that.
- Goods to an EU company are zero-rated only if they physically leave Sweden and the transport can be proven. If the user cannot say how the goods were shipped, stop and hand over.
- Some services are taxed where performed even for a foreign buyer (hotel night, event admission, work on Swedish property): then a Swedish rate is correct and must be set on the line explicitly. Unsure: ask, or stop.
- A private person in another EU country is not \`eu_business\`. Swedish moms applies below the EU distance-sales threshold (EUR 10,000 per year across the EU); above it OSS applies. If the user's EU consumer sales are near that level, hand over.

### A company that is not VAT registered

When \`vat_registered\` is false, Accounted zeroes every line rate and books the sale as momsfri; no moms line appears. Do not add moms, do not show a VAT number, and do not tell the user to register based on this invoice. An exempt invoice should carry a reference to the exemption: ask the user for the wording they use (or were given by their accountant) and put it in \`notes\`. If the user thinks the company should be registered, that is their settings decision, not something to change here.

## Workflow

### Step 1: Customer and articles ready

\`gnubok_list_customers\` gives the \`customer_id\`. Articles: \`gnubok_list_articles\`. If the user sells the same thing repeatedly and wants it saved, stage \`gnubok_create_article({ name, price_excl_vat, unit, type: 'vara' | 'tjanst', vat_rate })\`; this is optional, never a prerequisite.

### Step 2: Stage the invoice

\`gnubok_create_invoice({ customer_id, items: [{ description, quantity, unit, unit_price, vat_rate?, discount_percent?, article_id? }], invoice_date?, due_date?, currency?, your_reference?, our_reference?, invoice_marking?, notes? })\`

- With \`article_id\`, the article prefills description, unit, price and revenue account; values on the line win. Without it, description, unit and unit_price are required.
- An article's stored \`vat_rate\` is a domestic rate: a reverse-charge or export customer keeps 0 % unless the line sets \`vat_rate\` explicitly.
- Prices are excl. moms. If the user gives a price incl. moms, convert with dividing by 1.25 and rounding to whole öre (or the right rate) and show both numbers before staging. Never invent an amount.
- Currency: SEK by default; EUR, USD, GBP, NOK, DKK possible. The verifikat is always in SEK.
- Show the staged preview (lines, moms, total, \`vat_warnings\`) to the user.

Approval creates a **draft**: no number and no verifikat yet. The F-number is allocated when the invoice is sent or marked as sent, atomically and gap-free.

### Step 3: Edit the draft (delivery date, ROT/RUT, corrections)

\`gnubok_create_invoice\` has no delivery-date or ROT/RUT fields; set them on the draft:

1. \`gnubok_call_tool({ tool: "gnubok_get_invoice", arguments: { invoice_id } })\` (a search-only read, reached through \`gnubok_call_tool\`). Check \`editable_draft\`.
2. \`gnubok_update_invoice({ invoice_id, delivery_date?, your_reference?, items? })\`. \`items\` is a FULL REPLACE: pass every line back verbatim, with its \`article_id\`, account and ROT/RUT fields, or they are lost.

**ROT/RUT (fakturamodellen)**: the customer pays the reduced amount and the company claims the rest from Skatteverket. Required before staging:

- F-skatt on the company; the customer is a private person (\`individual\`) with \`personal_number\` on file (add it via \`gnubok_update_customer\`).
- Labour on its own line(s) with \`deduction_type: 'rot' | 'rut'\`, \`labor_hours\` and \`work_type\` (Skatteverket arbetstypskod); material on separate lines without a deduction.
- ROT: \`housing_designation\` (fastighetsbeteckning), or \`apartment_number\` + \`brf_org_number\` for a bostadsrätt, on the first deduction line.
- Rates per the rule pack: RUT 50 % of labour incl. moms; ROT 30 % standard (50 % May-Dec 2025); ceilings ROT 50 000, RUT 75 000, combined 75 000 kr per person and year. Accounted computes the deduction; do not calculate it yourself. If you cannot verify the rate for the invoice date, ask the user to confirm it with Skatteverket before sending.
- The Skatteverket share sits on 1513 until paid out; the claim file comes from \`gnubok_generate_rot_rut_file\`. Whether the customer already used their yearly ceiling elsewhere only the customer knows: ask.

### A draft that should not be sent yet

- Leave it as a draft: nothing is numbered, booked or declared. Tell the user it is waiting in the invoice list with status draft.
- Change it with Step 3. Only drafts are editable; a sent invoice is changed with a kreditfaktura (\`kreditfaktura-process\`).
- Remove it only when the user asks: \`gnubok_delete_draft_invoice({ invoice_id })\` stages it. An unnumbered draft is deleted; a numbered one is makulerad (cancelled, number kept so the series stays gap-free). Never delete on your own initiative.

### Step 4: Send

\`gnubok_send_invoice({ invoice_id })\` stages emailing the PDF. After approval it allocates the F-number, emails the customer and marks the invoice sent. It needs a customer email and the email service configured.

If the user delivered the invoice another way (printed, uploaded to the buyer's portal, sent through an external e-invoice provider), use \`gnubok_mark_invoice_as_sent({ invoice_id })\` instead: same numbering and booking effect, no email. Draft only.

If the customer requires an e-invoice (public sector, or a buyer asking for Peppol), read "E-invoicing via Peppol" below before sending anything: it is sent from the invoice page in the dashboard or staged with \`gnubok_send_invoice_peppol\`.

### What happens after sending

- **Faktureringsmetoden** (\`accrual\`): the verifikat is posted on the invoice date (1510 kundfordran against revenue and utgående moms). The moms belongs to the period of the invoice date, paid or not. If the company has deferred invoice booking switched on, the invoice is booked later from the invoice page instead.
- **Kontantmetoden** (\`cash\`): nothing is booked at send. Revenue and moms are booked when the payment is registered.
- Either way the invoice is now locked: corrections go through a kreditfaktura only.

### Step 5: Record payment

- Money in the bank feed: \`gnubok_match_transaction_to_invoice({ transaction_id, invoice_id })\`. Partial payments are supported. For a whole month, use \`bank-reconciliation\`.
- Paid but not in the feed yet: \`gnubok_mark_invoice_as_paid({ invoice_id, payment_date })\`. Status must be sent or overdue. If it refuses because a bank transaction already looks like the payment, match that transaction instead; set \`allow_duplicate\` only after the user confirms it is a different payment.
- Kontantmetoden: a partial payment on an invoice not yet booked is refused (\`INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED\`). Stop and tell the user; do not split the invoice.

## E-invoicing via Peppol (including B2G)

Accounted sends Peppol BIS Billing 3 e-invoices from the invoice page in the dashboard. Peppol sending is gated per company: the user requests access under Inställningar > Fakturering (Settings > Invoicing) and Accounted's operators enable it; a grant may carry a send cap, and when it is used up the dashboard says so and support raises it. Restrictions: the sending company must be an aktiebolag (enskild firma is refused until GLN identifiers are supported), standard invoices only (no credit notes, no self-billed invoices), the customer must be a Swedish business or organization whose org number is not a personnummer (an enskild firma customer is refused until GLN identifiers are supported), and the invoice must be in SEK with taxable Swedish VAT at 6, 12 or 25 % (no reverse charge, no VAT-exempt sales, no ROT/RUT deductions) and carry Er referens. An agent can send it too: check \`gnubok_get_invoice_peppol_readiness\` first, then stage \`gnubok_send_invoice_peppol\` (a person approves; v1: POST /invoices/{id}/send-peppol). The same access grant, send cap and restrictions apply. Never tell a user that Accounted lacks Peppol sending; say it is gated per company. A successful dashboard Peppol send issues the invoice itself (number, status, and the verifikat under faktureringsmetoden), so do not mark it as sent afterwards. If the dashboard reports that the invoice was sent via Peppol but could not be marked as sent, call \`gnubok_mark_invoice_as_sent\` on the still-draft invoice to complete the issuance; a number already allocated is reused, never consumed twice. If that invoice already shows as sent, the number and the verifikat exist and only the invoice's link to the verifikat needs repair: do not mark it as sent again (it returns 409), leave the repair to support. If the company has no Peppol access, or is an enskild firma, and the customer requires an e-invoice, deliver it through an external e-invoice provider, then use \`gnubok_mark_invoice_as_sent\` to record the delivery and apply the same booking effect without sending another email.

## Offert (quotes)

An offert is \`document_type: 'quote'\` on \`gnubok_create_invoice\` with a required \`valid_until\`. It is numbered in its own OF-series at approval, never touches the F-series and never books anything; it reads as expired after \`valid_until\` (derived). Record the customer's answer with \`gnubok_set_quote_status({ invoice_id, status: 'open' | 'accepted' | 'declined', valid_until? })\`, a direct write, so confirm with the user first. \`gnubok_convert_invoice({ invoice_id })\` stages the faktura from an open or accepted quote and leaves the quote as accepted; a declined quote must be re-accepted first, and a quote can be invoiced only once. \`target: 'order'\` creates a draft kundorder instead.

## When a tool call fails

- **Validation** ("VAT rate X% is not allowed", missing description/unit/price, bad date): fix the argument from the message and restage once. If you do not understand why, ask the user; never resend the same payload.
- **Not found** ("Customer not found", "Invoice not found"): the customer or draft was never approved, or the id belongs to another company. Check \`gnubok_list_pending_operations\` and the \`company_id\` you passed.
- **Period locked or closed** (\`PERIOD_LOCKED\`, \`PERIOD_ALREADY_CLOSED\`): the invoice date falls in a locked period. Ask the user whether the invoice date is right. Never move the date just to get past the lock, and never unlock a period as part of invoicing: that is the user's decision.
- **Conflict / 409** (\`INVOICE_ALREADY_SENT\`, "Only draft invoices can be marked as sent", quote already invoiced): the state has moved on. Re-read with \`gnubok_list_invoices\` or \`gnubok_get_invoice\` and report what you see; do not repeat the write.
- **Staged for approval**: that is success, not an error. Nothing exists until the user approves.
- **Capability or settings gate** (no email service, missing payment details or VAT number, Peppol not granted, legal form): the user fixes it in Inställningar. Say exactly which setting, then stop that step.

## Approval discipline

- Every write here stages a pending operation (except \`gnubok_set_quote_status\`). The user approves in Accounted (Granskning), or on a clear yes in chat you call \`gnubok_approve_pending_operation({ operation_id })\`. A widget-capable client can open the approval widget with \`gnubok_list_pending_operations({ render_ui: true })\`; this is optional, and ChatGPT, Grok and terminal agents list the staged items in text instead.
- Stage the invoice and the send as two separate approvals unless the user said "send it" up front. Never approve without an explicit yes.
- Never delete an invoice the user did not ask to delete, never edit a sent invoice, never skip or set an invoice number, never invent an amount, a date or a VAT number.
- Round money to whole öre (two decimals), never with toFixed. Account numbers are strings ('1510', '3001').

## Stop and hand over

Say "this needs a human: here is what I found", with the facts, when:

- The VAT treatment depends on something the user cannot answer (EU goods without proof of transport, a service that may be taxed abroad, a mixed supply, construction services that may fall under omvänd betalningsskyldighet inom Sverige).
- ROT/RUT eligibility is unclear (is it the customer's home, is the work type covered, is the ceiling already used).
- The invoice would land in a closed year or a locked period.
- The user wants to change something already sent or paid (hand over to \`kreditfaktura-process\`).
- The answer is not in this skill or in Accounted's messages. Do not answer Swedish tax questions from memory.

## Report format

End with short groups, in the user's language:

- **Done**: what exists now (draft, quote, sent invoice with its number).
- **Staged for approval**: each operation with customer, total incl. moms and what approving does.
- **Needs your answer**: the precise open questions.
- **Could not do**: what, and the setting or rule that blocked it.
- **Next step**: send, wait for payment, match the payment, or which skill to load.

## Tools

- \`gnubok_list_companies\`, \`gnubok_get_agent_briefing\`, \`gnubok_list_skills\`, \`gnubok_get_company_settings\`, \`gnubok_list_fiscal_periods\`: orientation (read)
- \`gnubok_list_customers\`, \`gnubok_lookup_company\`: find the customer (read)
- \`gnubok_create_customer\` / \`gnubok_update_customer\`: customer setup and missing fields (staged)
- \`gnubok_list_articles\` (read) / \`gnubok_create_article\` (staged): artikelregister
- \`gnubok_create_invoice\`: stage new invoice, or a quote with \`document_type: 'quote'\` + \`valid_until\`
- \`gnubok_list_invoices\`: find existing invoices and quotes (\`document_type\`, \`quote_status\` incl. \`expired\`)
- \`gnubok_get_invoice\` (via \`gnubok_call_tool\`): one invoice with its lines; read it before editing
- \`gnubok_update_invoice\`: edit a draft; \`items\` is a FULL REPLACE, so pass every line back (with \`article_id\`) from \`gnubok_get_invoice\`
- \`gnubok_delete_draft_invoice\`: remove a draft, only on the user's request (staged)
- \`gnubok_send_invoice\`: email PDF (staged)
- \`gnubok_mark_invoice_as_sent\`: manual delivery (also the recovery when a dashboard Peppol send could not mark the invoice as sent)
- \`gnubok_set_quote_status\`: record the customer decision on a quote (direct write)
- \`gnubok_convert_invoice\`: proforma or quote to real invoice, or to a kundorder
- \`gnubok_mark_invoice_as_paid\`: manual payment
- \`gnubok_match_transaction_to_invoice\`: link bank payment
- \`gnubok_credit_invoice\`: kreditfaktura (legal undo; see \`kreditfaktura-process\`)
- \`gnubok_generate_rot_rut_file\`: ROT/RUT claim file for Skatteverket
- \`gnubok_list_pending_operations\`, \`gnubok_approve_pending_operation\`: approval
`

export const invoicingRulesSkill: Skill = {
  slug: 'invoicing-rules',
  name: 'Fakturera rätt',
  summary: 'Invoice or quote end to end: what to ask, VAT and VIES, ROT/RUT, drafts, send, kontant vs faktureringsmetoden, Peppol (gated per company).',
  tags: ['invoicing', 'vat', 'compliance', 'eu', 'rot-rut', 'quotes'],
  body,
  tier: 'workflow',
  // Universal: both AB and EF send invoices.
  applicability: { entity_type: 'both' },
}
