import type { Skill } from './types'

const body = `# Quarterly VAT Review: Accounted

End-to-end review of momsdeklaration (SKV 4700) before filing to Skatteverket.

## When to use

- "Run VAT for Q[N]" / "Moms för kvartal [N]"
- "How much VAT do I owe this quarter?"
- After all transactions in the quarter are booked
- Before the filing deadline (12th of the second month after quarter-end; 17 August for Q2)

## Filing deadlines

| Quarter | Deadline |
|---------|----------|
| Q1 (Jan-Mar) | **12 May** |
| Q2 (Apr-Jun) | **17 August** (vacation rule) |
| Q3 (Jul-Sep) | **12 November** |
| Q4 (Oct-Dec) | **12 February** (next year) |

Weekend/holiday → next business day. Payment must reach Skattekontot by deadline (SFL 62 kap. 3 §).

## Workflow

### Step 1: Verify the quarter is fully booked

Run the month-end-close skill for each month in the quarter. Critically: zero uncategorized business transactions in the date range, and bank reconciliation difference = 0.

### Step 2: Generate the report

\`gnubok_get_vat_report({ period_type: 'quarterly', year: YYYY, period: 1|2|3|4 })\`

Returns all rutor (boxes) plus a summary string.

### Step 3: Visual review

\`gnubok_vat_review_widget(...)\` opens a tabular UI. The user reviews each ruta inline, copies the summary, and confirms before filing.

### Step 4: Drill into anomalies

If any ruta looks wrong, call \`gnubok_get_general_ledger\` filtered to the relevant 26xx account:

- Ruta 10 looks too high? → general ledger for **2611** (output 25%)
- Ruta 48 looks too low? → general ledger for **2641** + **2645** (input + EU calculated)
- Ruta 30 unexpectedly nonzero? → \`2614\` reverse-charge: verify the underlying purchase

### Step 5: File and record payment

File via Skatteverket e-tjänst (or skatteverket extension if enabled). After filing, record the payment journal entry (debit/credit 2650/1930) when the money moves from skattekontot.

## Ruta-by-ruta map (what each box means)

| Ruta | Description | Source accounts |
|------|-------------|-----------------|
| 05 | Momspliktig försäljning (taxable sales, all rates) | 3001-3008, 3041-3048, 3051-3058, 3071-3078 (common BAS taxable revenue accounts) |
| 10 | Utgående moms 25 % | 2611 |
| 11 | Utgående moms 12 % | 2621 |
| 12 | Utgående moms 6 % | 2631 |
| 30 | Utgående moms reverse charge 25 % | 2614 |
| 31 | Utgående moms reverse charge 12 % | 2624 |
| 32 | Utgående moms reverse charge 6 % | 2634 |
| 35 | EU-varuförsäljning, momsfri (intra-community goods supply) | 3108 |
| 39 | EU-tjänsteförsäljning (services to EU B2B) | 3308 |
| 40 | Export (outside EU) | 3305 |
| 48 | Ingående moms (all input VAT) | 2641 + 2645 + 2647 |
| 49 | **Att betala / återfå** | computed |

**Ruta 49 = (10 + 11 + 12 + 30 + 31 + 32) − 48.** Positive = pay. Negative = refund.

## Critical rules

- **Reverse charge: never net silently.** Both the output (2614/2624/2634) and the calculated input (2645) MUST be booked separately. Skatteverket reads both rutor.
- **Representation moms is capped at 300 SEK ex moms per person per occasion** (since 2017). Above the cap, no VAT deduction.
- **Mixed verksamhet:** if the company has both VAT-liable and VAT-exempt revenue, input VAT requires proportional deduction (HFD 2023 ref. 45). Don't deduct full 2641 in that case.
- **Bokslutsmetoden (cash) cap = 3 M SEK omsättning.** Above that, faktureringsmetoden (accrual) is required by law.

## Common errors

- **Forgetting Ruta 39 for EU services.** A Swedish consultant invoicing a German customer at 0% VAT (reverse charge) MUST report the invoice in ruta 39, not just ruta 05. Wrong ruta = penalty risk.
- **Wrong rate on books/transport.** 6% applies (not 12%): books, newspapers, transport, sports admission, repairs. Restaurant food = 12%, drops to 6% from 1 April 2026.
- **Filing late by one day.** Skattetillägg + interest. The system clock matters more than the user thinks.

## Tools

- \`gnubok_get_vat_report\`: generate momsdeklaration data
- \`gnubok_vat_review_widget\`: interactive review widget
- \`gnubok_get_general_ledger\`: drill into 26xx accounts
- \`gnubok_list_uncategorized_transactions\`: verify nothing missing
- \`gnubok_get_reconciliation_status\`: bank vs ledger sanity check
`

export const quarterlyVatReviewSkill: Skill = {
  slug: 'quarterly-vat-review',
  name: 'Quarterly VAT Review',
  summary: 'End-to-end momsdeklaration: deadlines, ruta-by-ruta map, reverse charge rules, common errors, drill-down via general ledger.',
  tags: ['vat', 'quarterly', 'monthly', 'compliance', 'skatteverket'],
  body,
  tier: 'workflow',
  // Only surfaces for VAT-registered companies. Most are; a hobby/below-tröskel
  // EF without VAT registration shouldn't see this in its skill list.
  applicability: { entity_type: 'both', requires: ['vat_registered'] },
}
