import type { Skill } from './types'

const body = `# Monthly Payroll: Accounted

Salary run + AGI filing for one calendar month.

## When to use

- "Run payroll for [month]"
- "Lönekörning [månad]"
- "Generate AGI"
- Once per month, **before payment_date**

## Statutory deadlines

- **AGI (arbetsgivardeklaration):** 12th of the **next month** (17th in January and August). E.g. payroll for March → file AGI by 12 April.
- **Skatt + sociala avgifter payment:** same deadline as AGI.
- Skattekontot must be in funds by deadline (SFL 62 kap. 3 §).

## Workflow

### Step 1: Verify employees are set up

\`gnubok_list_employees\` returns all active employees. For each, the system needs:

- **Personnummer** (last 4 stored, full encrypted)
- **monthly_salary** (or hourly_rate + estimated hours)
- **employment_degree** (1-100 %)
- **tax_table_number** + **tax_column** (skattetabell + kolumn from Skatteverket)
- **employment_type** (\`tjänsteman\`, \`arbetare\`, etc.): drives BAS account choice (7210 vs 7010)

If anything is missing, the user fixes it in the web UI before running payroll.

### Step 2: Create the salary run

\`gnubok_create_salary_run({ period_year, period_month, payment_date })\`

- Creates a \`salary_runs\` row with status \`draft\`
- Adds **all active employees** with their base salary line (item_type \`monthly_salary\` or \`hourly_salary\`)
- Returns the run ID + employee count
- Idempotent on \`(company_id, period_year, period_month)\`: re-calling errors with "Salary run already exists for this period"

### Step 3: Add OB-tillägg, traktamente, förmåner (if any)

Variable lines (overtime, weekend supplement, milage, traktamente, förmåner) are added in the web UI per-employee. There's no MCP tool yet for these: guide the user there.

### Step 4: Calculate

\`gnubok_calculate_salary_run({ salary_run_id })\`. Computes per employee:

- **Bruttolön** (gross): sum of taxable salary lines
- **Skatteavdrag**: tax-table lookup (skattetabell + kolumn → table column for the gross level)
- **Nettolön** (net): bruttolön − skatteavdrag
- **Sociala avgifter (arbetsgivaravgifter)**: 31.42 % of bruttolön (standard 2025). Reduced rates apply to specific age groups: always check the current statutory rates before relying on these:
  - **Born 1937 or earlier**: **0 %**: no avgifter at all (oldest cohort, never paid into the modern pension system). Easy to miss; the BAS journal entries for 7510/2730 simply don't apply for these employees.
  - **Age 66+ on 1 January of the income year (67+ from income year 2026)**: 10.21 % (only ålderspensionsavgift). The threshold rises with the riktålder; verify the cohort year for the current run rather than hard-coding a birth year.
  - **växa-stöd / temporary youth reduction**: ages 19-23, salary ≤ 25 000 SEK/month, capped duration. The exact rate and window vary year-over-year (e.g. 20.81 % during 1 Apr 2026: 30 Sep 2027 per Prop. 2025/26:34): confirm against Skatteverket's current published table before applying.
- **Semesterlöneskuld** (vacation accrual): 12 % of bruttolön (default). Booked monthly to 2920.
- **Förmåner** (benefits): employer-paid taxable amounts (bilförmån, kostförmån, etc.): added to skattegrundande lön but not to nettolön payment.

Errors at this stage usually mean missing tax-table data: fall back to \`getDefaultTaxColumn(personnummer, year)\` heuristics or prompt user.

### Step 5: Review

\`gnubok_get_salary_run({ salary_run_id })\`: full breakdown including \`calculation_breakdown\` showing step-by-step formulas. The user reviews per-employee in web UI.

\`gnubok_get_salary_journal({ year })\`: annual rollup for sanity check.

### Step 6: Approve & book (web UI)

The user marks the run \`approved\` → \`paid\` → \`booked\` in the web UI. Booking creates the JE:

- Debit **7210** (lön tjänstemän) or **7010** (lön arbetare): bruttolön
- Debit **7510** (sociala avgifter): \`avgift_base × applicable_rate\`: **per employee**, using the rate from Step 4 (default 31.42 %, or a reduced rate when applicable: 10.21 % for 66+, växa-stöd, etc.)
- Credit **2710** (källskatt): skatteavdrag
- Credit **2730** (lagstadgade arbetsgivaravgifter): same amount as the 7510 debit (the avgift cost is the same number as the avgift liability)
- Credit **2920** (semesterlöneskuld): 12 % × bruttolön (debit 7290 to balance)
- Credit **1930** (bank): nettolön (when paid)

When a run mixes full-rate and reduced-rate employees, the 7510/2730 lines are summed across all employees: the *total* avgift line equals \`Σ(per-employee avgift_base × per-employee rate)\`, **not** \`Σ bruttolön × 31.42 %\`. \`gnubok_calculate_salary_run\` already does this aggregation.

### Step 7: Generate AGI

\`gnubok_generate_agi({ salary_run_id })\`. Run must be in \`review\`/\`approved\`/\`paid\`/\`booked\` status (past draft).

Returns \`{ message, period, employee_count, download_url }\`. The XML conforms to Skatteverket's AGI format and is stored 7 years per BFL. Download from \`/api/salary/runs/{id}/agi/xml\` and upload to Skatteverket e-tjänst.

## Critical rules

- **Skatteavdrag is mandatory.** Never pay gross. Skatteverket charges 100% penalty for missing avdrag.
- **Sociala avgifter are 31.42 % even if salary is in EUR.** Convert to SEK at payment date for the avgift base.
- **Semesterlöneskuld** must be reserved monthly, not at year-end. 2920 grows by 12 % of every month's bruttolön.
- **Förmånsbeskattning** (benefit tax) is required even if not in cash. Bilförmån, kostförmån, sjukvårdsförsäkring all count.
- **Karensavdrag** (sick day deduction): first day of sickness is generally without pay; 80 % from day 2. Specific rules: fall through to \`swedish-payroll\` reference if unsure.

## Common errors

- **Run already exists**: idempotency on (company, year, month). Find the existing run with \`gnubok_get_salary_run\`.
- **Tax table column wrong**: defaults to column 1 if not set, which is too high for most employees. Fix on employee record.
- **AGI before booking**: works (status check is past-draft, not booked), but you should book first so the JE matches what AGI reports.

## Tools

- \`gnubok_list_employees\`: verify setup
- \`gnubok_create_salary_run\`: stage new monthly run
- \`gnubok_calculate_salary_run\`: compute tax + avgifter + accrual
- \`gnubok_get_salary_run\`: review breakdown
- \`gnubok_get_salary_journal\`: annual rollup
- \`gnubok_generate_agi\`: produce AGI XML for filing
`

export const payrollMonthlySkill: Skill = {
  slug: 'payroll-monthly',
  name: 'Monthly Payroll',
  summary: 'Monthly salary run + AGI: employee setup, calculation, sociala avgifter, semesterlöneskuld, booking, AGI XML.',
  tags: ['monthly', 'payroll', 'agi', 'compliance'],
  body,
  tier: 'workflow',
  // Only relevant when the company actually has employees. EF without payroll
  // (most sole traders) shouldn't see this in the discovery list.
  applicability: { entity_type: 'both', requires: ['employees'] },
}
