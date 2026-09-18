import type { Skill } from './types'

const body = `# VAT Review: Accounted

Prepare and reconcile momsdeklaration (SKV 4700) for the company's registered period. The historical skill slug is quarterly-vat-review; the controls also apply to monthly and annual filers.

## When to use

- Before preparing or correcting a VAT return
- After completing the bookkeeping for the actual liability/reporting period
- When reconciling reverse-charge bases, input deductions or tax-account movements

## Workflow

### Step 1: Establish the obligation and completeness

Read the registered accounting method, VAT cadence, liability start and exact period. Annual VAT does not permit annual bookkeeping. Reconcile issued and received invoices, credits, unpaid receivables/payables, owner-paid purchases, advances and non-cash adjustments as well as every bank/card account. An empty uncategorized queue is not proof of completeness.

For quarterly VAT, the ordinary deadlines are 12 May, **12 August**, 12 November and 12 February of the following year, subject to the authority calendar and holiday rules. Do not borrow monthly filers' August extension. Annual VAT with EU trade is due on the 26th of the second month after the period (27th in December); annual filers without EU trade can follow a different timetable. Confirm the actual authority obligation. Payment must be booked on skattekontot by its deadline, not merely initiated.

### Step 2: Generate and independently reconcile the report

Call \`gnubok_get_vat_report\` with the supported period arguments matching the registration. Verify the returned start and end; do not silently substitute the fiscal year for a shorter liability period.

Inspect the live response schema. Summary tools may omit purchase-basis fields: an absent box is not zero. Reconcile the full declaration/readiness projection against the complete journal, including reversal originals and their correction entries.

Use the company's chart and current VAT mappings, not a fixed account subset. At 25%, common purchase bases are 4515 for EU goods (box 20), 4535 for EU services (box 21), and 4531 for non-EU services (box 22). Verify the actual supplier establishment and supply, not the brand alone. Include domestic reverse-charge and goods-import boxes when applicable.

### Step 3: Review tax and deduction separately

- Reconcile output boxes 10, 11, 12, 30, 31, 32, 60, 61 and 62.
- Reconcile deductible input VAT in box 48 against all relevant input accounts, including 2647 where applicable.
- **Box 49 = (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - 48.** Positive means payable, negative refundable.
- Reverse-charge output VAT must be reported even when input deduction is restricted. Book deductible input VAT separately only to the extent supported by taxable use and evidence; the two amounts need not be equal.
- For mixed/exempt/private use, determine the applicable deduction method from actual purchases and activities. VAT registration alone does not establish full deduction.
- For representation meals, the 300 SEK excluding VAT limit is a deduction basis per person and occasion, not an all-or-nothing denial when a meal costs more. Verify eligibility, current rates and calculation.
- From 1 April 2026, qualifying food goods are temporarily 6%; restaurant/catering services remain 12%. Verify the supply and applicable date rather than reclassifying all food-related expenditure.

### Step 4: Resolve corrections before sign-off

Separate a bookkeeping correction from a correction of an already-filed VAT return. For an error in a filed Swedish VAT return, prepare a complete corrected return for the **original reporting period**. A locked ledger does not authorize moving that tax error to the current return. Preserve the original record, correction linkage, reason and reviewer approval. Verify the supported accounting correction path independently.

### Step 5: File and reconcile payment evidence

Present the exact reconciled return through \`gnubok_vat_review_widget\` or the supported review surface. Submission, receipt and payment are separate completion states and approvals. Retain the authority receipt; exporting a file or approving a preview is not filing.

For an AB using a tax-account ledger, distinguish bank funding (1630 against the actual 19xx bank account) from the VAT debit/credit on skattekontot (2650 against 1630), with directions following the actual payment or refund. Do not book a bank payment merely because a return was prepared. Reconcile the tax-account statement and actual settlement once, including any interest or other taxes separately.

## Sources

- [VAT deadlines](https://www.skatteverket.se/foretag/moms/deklareramoms/narskajagdeklareramoms.4.6d02084411db6e252fe80008988.html)
- [VAT return fields and deductible input VAT](https://www.skatteverket.se/foretag/moms/deklareramoms/fyllaimomsdeklarationen.4.3a2a542410ab40a421c80004214.html)
- [Correcting a filed return](https://www.skatteverket.se/foretag/moms/deklareramoms/rattaenmomsdeklaration.4.3684199413c956649b552c4.html)
- [Food goods versus restaurant VAT](https://www.skatteverket.se/omoss/pressochmedia/nyheter/2026/nyheter/livsmedelsmomsensankstill6procent.5.70685bee19c85dd5dd0a3f.html)

## Tools

- \`gnubok_get_vat_report\`: supported-period report; verify boundaries and field coverage
- \`gnubok_vat_review_widget\`: review before separately authorized filing
- \`gnubok_get_general_ledger\`: reconcile bases and tax accounts
- \`gnubok_list_uncategorized_transactions\`: one completeness signal, not the entire books
- \`gnubok_get_reconciliation_status\`: reconcile the requested cash account and date range
`

export const quarterlyVatReviewSkill: Skill = {
  slug: 'quarterly-vat-review',
  name: 'VAT Review',
  summary: 'Cadence-aware VAT review: exact periods, complete bases and tax boxes, deduction eligibility, original-period corrections and filing/payment evidence.',
  tags: ['vat', 'quarterly', 'monthly', 'yearly', 'compliance', 'skatteverket'],
  body,
  tier: 'workflow',
  applicability: { entity_type: 'both', requires: ['vat_registered'] },
}
