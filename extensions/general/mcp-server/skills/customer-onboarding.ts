import type { Skill } from './types'

const body = `# Customer Onboarding — gnubok

Adding a customer correctly the first time avoids a long tail of wrong-VAT
invoices. This skill covers the decision tree for picking \`customer_type\`,
when to run VIES validation, and which fields are required for each path.

## When to use

- "Lägg till en ny kund / Add a customer"
- "Skapa kund: Acme AB"
- "How do I invoice an EU customer?"
- Before \`gnubok_create_invoice\` whenever the customer isn't found in \`gnubok_list_customers\`

## Decision tree: which customer_type?

The customer_type drives **the VAT treatment** on every invoice you send them.
Getting it wrong means re-issuing invoices and amending VAT declarations
later — much cheaper to ask the customer once at onboarding.

| Customer | customer_type | Required fields | VAT treatment |
|---|---|---|---|
| Swedish private person | \`individual\` | name | 25/12/6 % standard, no reverse charge |
| Swedish AB / HB / KB / EF | \`swedish_business\` | name, org_number | 25/12/6 % standard |
| EU company (VAT-registered) | \`eu_business\` | name, vat_number (validated) | Reverse charge (varor + tjänster) — invoice has 0 % VAT, customer pays VAT in their country |
| EU company (no VAT number) | \`eu_business\` | name, country | Treated as individual — 25 % charged, no reverse charge |
| Non-EU company | \`non_eu_business\` | name, country | Export 0 % (varor) or reverse charge per service rules |
| Non-EU private person | \`individual\` | name, country | 25 % standard for goods; export rules can apply for services |

**Special cases:**

- **B2G (Swedish municipality/agency)**: still \`swedish_business\`, but the invoice must be Peppol-formatted (legal requirement since 2019-04-01). gnubok handles Peppol when the customer record has a Peppol endpoint configured.
- **Consumer customer in another EU country (B2C distance sale)**: \`eu_business\` does NOT apply. Charge Swedish VAT (25/12/6 %) below the OSS threshold; above the threshold the company must register for OSS. This is rare for sole traders — flag the user if turnover suggests they're approaching the threshold.

## Workflow

### Step 1 — Check if the customer already exists

\`gnubok_list_customers\` returns all customers. Search by name client-side.
If a customer with the same org_number or vat_number exists, USE THAT ONE.
Duplicate customers fragment the AR ledger and confuse aging reports.

### Step 2 — Decide customer_type

Ask the user the minimum questions needed for the decision tree above. Don't
ask "which customer_type?" — ask "is this a private person or a company?
Swedish or EU? Do they have a VAT number?". Map the answers to a
customer_type yourself.

### Step 3 — Validate VAT number (EU business only)

For \`eu_business\` customers, **VIES validation is critical**. If VIES says
the VAT number is invalid (or unverifiable), reverse charge does NOT apply —
you must charge Swedish VAT instead. The wrong call here means you under-collect
VAT and Skatteverket charges interest + penalty later.

gnubok's \`gnubok_create_customer\` runs VIES automatically when \`vat_number\`
is provided. The result is stored in \`vat_number_validated\` on the customer.
Subsequent invoices read this field via \`getAvailableVatRates\` to determine
which VAT rates are legal.

If VIES is temporarily down (intermittent), gnubok marks the customer as
\`vat_number_validated = false\` and you'll see standard 25 % rates instead
of reverse charge. Re-validate by updating the customer once VIES is back.

### Step 4 — Stage the customer

\`gnubok_create_customer({
  name: 'Acme GmbH',
  customer_type: 'eu_business',
  vat_number: 'DE123456789',
  email: 'invoicing@acme.de',
  country: 'Germany',
  payment_terms: 30,
})\`

Stages a pending operation for user approval. After approval, the customer
appears in \`gnubok_list_customers\` and can be invoiced via \`gnubok_create_invoice\`.

### Step 5 — Sanity-check before first invoice

\`gnubok_list_customers\` — confirm the customer appears, customer_type is right.
Read \`vat_number_validated\` (for EU); if false, double-check the VAT number.

When you eventually call \`gnubok_create_invoice\`, gnubok uses the
\`getAvailableVatRates\` helper to constrain the dropdown of legal rates per
customer type. If you see "VAT rate X% is not allowed for customer type Y",
the customer_type is wrong — re-onboard correctly via the agent flow, do NOT
hand-pick a different rate.

## Common errors

- *"VAT rate 25% is not allowed for customer type eu_business"*: the customer's VAT number is validated → reverse charge required. Use 0 % on line items, and gnubok will add the "Omvänd betalningsskyldighet" notation automatically.
- *"VAT rate 0% is not allowed for customer type swedish_business"*: domestic customers always get 25/12/6 %. Pick the right rate.
- *"Customer not found"* on \`gnubok_create_invoice\`: the customer wasn't created (or its pending_operation wasn't approved). Run \`gnubok_list_customers\` to confirm.

## ROT/RUT-eligible customers (Swedish individuals)

ROT/RUT-avdrag applies to physical persons receiving home-services
(byggtjänster, städ, snöskottning, etc.). The customer's personnummer is
required on the invoice. Update the customer record with:

- \`fastighetsbeteckning\` (property identifier — for ROT)
- \`personnummer\` (encrypted at rest)

Then create the invoice with ROT/RUT flag set. See the \`invoicing-rules\` skill
for the booking details (BAS accounts 1513 + 3740).

## Tools

- \`gnubok_list_customers\` — check for existing customers
- \`gnubok_create_customer\` — stage the new customer
- \`gnubok_create_invoice\` — uses the customer_type for VAT-rate validation
- (Helper, not a tool but referenced) \`getAvailableVatRates(customer_type, vat_number_validated)\` — drives the legal-rates check
`

export const customerOnboardingSkill: Skill = {
  slug: 'customer-onboarding',
  name: 'Customer Onboarding',
  summary: 'Decision tree for customer_type (individual/swedish_business/eu_business/non_eu_business), VIES validation, ROT/RUT setup.',
  tags: ['onboarding', 'customer', 'vat', 'eu', 'rot-rut'],
  body,
  tier: 'workflow',
  applicability: { entity_type: 'both' },
}
