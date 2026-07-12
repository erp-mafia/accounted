export const COOKBOOK_PAYROLL_AGI_MD = `# Cookbook: run payroll and generate the AGI XML

> Drive a Swedish salary run from draft to booked, then generate the arbetsgivardeklaration på individnivå (AGI) XML for manual submission to Skatteverket. Five-step lifecycle, every state transition idempotent and dry-runnable (generate-agi is idempotent but not dry-runnable).

This is the operational companion to the [Salary-runs reference](/docs/api/reference/salary-runs). Most of the payroll lifecycle is API-callable, but one step is still dashboard-only: **attaching employees to a run** (the \`/salary-runs/{id}/employees\` v1 endpoint is forthcoming), so a run can't yet be populated end-to-end from the public API. Everything after that — calculate, approve, mark paid, book, generate AGI — is.

## What you'll need

- A test API key with \`payroll:read\` AND \`payroll:write\` scopes. \`payroll:write\` is required for every state transition; \`payroll:read\` covers the read paths plus the elevated-scope gate on the webhook \`salary_run.*\` subscription.
- At least one employee on file with the payroll fields set (\`monthly_salary\` or \`hourly_rate\`, \`tax_table_number\`, \`tax_column\`, \`f_skatt_status\`). \`GET /employees\` masks personnummer to \`ÅÅÅÅMMDDXXXX\`; \`GET /employees/{id}\` returns the full value (deliberate drill-in, GDPR Art.5(1)(c)).
- An open fiscal period covering the salary date.

## 1. Create a salary run (draft)

\`POST /salary-runs\` opens an **empty** run in \`draft\` status: it takes only the period + payment metadata (\`period_year\`, \`period_month\`, \`payment_date\`, optional \`voucher_series\` and \`notes\`). Employees are attached in a separate step (via the dashboard, or the forthcoming \`/salary-runs/{id}/employees\` surface) before you \`:calculate\`.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "period_year": 2026,
    "period_month": 5,
    "payment_date": "2026-05-25",
    "voucher_series": "L"
  }'
\`\`\`

Response:

\`\`\`json
{
  "data": {
    "id": "run_...",
    "status": "draft",
    "period_year": 2026,
    "period_month": 5,
    "payment_date": "2026-05-25",
    "voucher_series": "L",
    "total_gross": 0,
    "total_tax": 0,
    "total_net": 0,
    "total_avgifter": 0,
    "total_employer_cost": 0
  }
}
\`\`\`

Totals are 0 until you calculate.

## 2. Calculate (math + draft → review)

\`POST /salary-runs/{id}/calculate\` runs the full Swedish tax engine: skattetabell lookup per employee, sociala avgifter at the current rate (31.42% for 2026), age-adjusted reductions per Prop. 2025/26:66 (the youth-reduction band is **18-22 years old at the start of 2026**: i.e. employees **born 2003-2007** for the 2026 income year, NOT a blanket "under-25"; the elder reduction applies at **67+ from 2026**, not 66+), förmånsbeskattning, semesterlöneskuld, OB-tillägg, traktamente.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/calculate" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response transitions \`draft → review\`:

\`\`\`json
{
  "data": {
    "id": "run_...",
    "status": "review",
    "period_year": 2026,
    "period_month": 5,
    "total_gross":          80000.00,
    "total_tax":            24300.00,
    "total_net":            55700.00,
    "total_avgifter":       25136.00,
    "total_employer_cost": 105136.00,
    "warnings": []
  }
}
\`\`\`

The \`warnings\` array surfaces non-blocking issues (Skatteverket tax-table fallback, läkarintyg day-8 / Försäkringskassan day-15 transitions, F-skatt \`not_verified\` employees); the run still advances to \`review\`. Per-employee figures are not returned inline: read them from the run detail or the salary-journal report.

The \`review\` status is a soft hold: the math is done but no journal entries are posted yet. Treat this as the human-review step.

## 3. Approve (review → approved)

\`POST /salary-runs/{id}/approve\` validates and locks the run for payment. \`PATCH\` on a salary run is **draft-only** (\`SALARY_RUN_PATCH_NOT_DRAFT\`): once a run leaves \`draft\` it can no longer be edited, and there is no \`:unapprove\`. Correcting a booked run is done via the forthcoming \`:correct\` verb (storno-then-rebook).

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/approve" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response shows \`status: 'approved'\` plus a \`warnings\` array. The endpoint validates every employee on the run and returns **all** problems at once (not just the first):
- Bank details present: \`clearing_number\` AND \`bank_account_number\` (required for the transfer)
- \`calculation_breakdown\` populated (proves \`:calculate\` has run)

Missing email is a **non-blocking warning** (lönebesked can't be sent automatically) and does not fail approval. Validation failures return \`SALARY_RUN_APPROVE_VALIDATION_FAILED\` with the full \`issues\` list (and any \`warnings\`) in \`details\`. A non-\`review\` run returns \`SALARY_RUN_APPROVE_NOT_REVIEW\`.

## 4. Mark paid (approved → paid)

After the bank transfer settles (or you mark it on the same day for cash-method shops), tell Accounted:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/mark-paid" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

This step records the payment event but does NOT post the journal entry yet: that's step 5. The split is deliberate: the \`mark-paid\` step gives integrators a hook to confirm the bank-side leg landed before locking the GL side. It is a **bodyless POST**: \`paid_at\` is stamped server-side to the current UTC timestamp (the API does not accept a body-supplied date, to keep the BFL audit trail clean).

## 5. Book (paid → booked)

\`POST /salary-runs/{id}/book\` is the engine-touching step. It posts **2-4 verifikationer** atomically — always the salary and avgifter entries, plus a semesterlöneskuld-accrual entry and/or a löneväxling-pension entry when those apply:

- Verifikation 1: Bruttolön: debit → 7210 / 7220 / 7240 (Löner tjänstemän / företagsledare / styrelsearvoden, by \`employment_type\`), credit → 2710 (Personalskatt, avdragen skatt) + 1930 (utbetalning)
- Verifikation 2: Arbetsgivaravgifter: debit → 7510 (Lagstadgade sociala avgifter), credit → 2731 (Avräkning sociala avgifter: payable to Skatteverket, cleared when arbetsgivardeklarationen is paid)
- Verifikation 3 (if semesterlöneskuld): debit → 7290 (Förändring semesterlöneskuld) + 7519 (sociala avgifter på semester), credit → 2920 (Upplupna semesterlöner) + 2940 (Upplupna sociala avgifter)
- Verifikation 4 (if löneväxling): debit → 7410 (Pensionsförsäkringspremier) + 7533 (Särskild löneskatt på pensionskostnader), credit → 2740 (Skuld pensionsförsäkringar) + 2514 (Beräknad särskild löneskatt); pension = löneväxling × 1.058

The 2731 series is the **employer-contributions-payable** liability per BAS 2026: not to be confused with 2615 (utgående moms vid import, unrelated to payroll). The arbetsgivardeklaration cycle posts the payable on book day and clears it via 1930 when the bank transfer to Skatteverket settles.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/book" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response:

\`\`\`json
{
  "data": {
    "id": "run_...",
    "status": "booked",
    "booked_at": "2026-05-26T09:15:00Z",
    "booked_by": "user_...",
    "salary_entry_id": "je_salary...",
    "avgifter_entry_id": "je_avg...",
    "vacation_entry_id": "je_vac...",
    "pension_entry_id": null,
    "entry_ids": ["je_salary...", "je_avg...", "je_vac..."]
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12",
    "audit": {
      "voucher_number": "L2026-0023",
      "voucher_url": "/api/v1/companies/.../journal-entries/je_salary...",
      "immutable_at": "2026-05-26T09:15:00Z"
    }
  }
}
\`\`\`

If \`book\` fails partway (e.g. period locked while waiting for the bank-side confirmation), the route is strict-mode v1: no partial commits. The state stays at \`paid\` and the response carries the \`PERIOD_LOCKED\` error code with the offending period.

## 6. Generate the AGI XML

\`POST /salary-runs/{id}/generate-agi\` produces the arbetsgivardeklaration på individnivå XML for the period. Skatteverket requires AGI monthly; the XML is embedded in the JSON response: no separate file endpoint.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/generate-agi" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response:

\`\`\`json
{
  "data": {
    "agi_declaration_id": "agi_...",
    "period_year": 2026,
    "period_month": 5,
    "employee_count": 2,
    "is_correction": false,
    "totals": {
      "totalTax": 24300.00,
      "totalAvgifterBasis": 80000.00,
      "totalAvgifterAmount": 25136.00,
      "totalSjuklonekostnad": 0,
      "avgifterByCategory": { "standard": { "basis": 80000.00, "amount": 25136.00 } }
    },
    "xml": "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?><Skatteverket omrade=\\"Arbetsgivardeklaration\\">…</Skatteverket>",
    "xml_filename": "AGI_5566778899_202605.xml"
  }
}
\`\`\`

Save the XML to disk and upload it to **Skatteverket Mina Sidor → Tjänster → Arbetsgivardeklaration**. Mina Sidor accepts the file directly; no manual transcription needed. (Direct API submission requires BankID and goes through the \`skatteverket\` extension, not the public REST API.)

Generating the XML stamps \`agi_generated_at\` on the salary run and emits an \`agi.generated\` event. There is no public endpoint to store a Skatteverket confirmation number back on the run: track the submission reference in your own system.

## State machine summary

\`\`\`
draft ──calculate──► review ──approve──► approved ──mark-paid──► paid ──book──► booked ──generate-agi──► (AGI XML)
\`\`\`

Each transition is idempotent on \`Idempotency-Key\`. Retrying a transition that has already completed returns the same response with \`Idempotent-Replayed: true\`. Failed transitions don't advance the state: fix and retry.

## Förmånsbeskattning

When an employee has bilförmån / fri kost / friskvård, the förmånsvärde is configured on the employee's benefit records: it is **not** passed on the run-creation request (\`POST /salary-runs\` takes only period + payment metadata). When you \`:calculate\`, the engine adds the förmånsvärde to bruttolön for the avgifts-basis (2731) and produces a separate förmåner line on the AGI. \`bilförmån_värde\` follows Skatteverkets schablon for 2026; supply the figure directly: the API does not compute it from car make / model / year.

## Common pitfalls

- **\`PATCH\`/\`DELETE\` are draft-only.** Both require \`draft\` status (\`SALARY_RUN_PATCH_NOT_DRAFT\` / \`SALARY_RUN_DELETE_NOT_DRAFT\`). There is no revert-to-draft and no \`:unapprove\`; a booked run is corrected via the forthcoming \`:correct\` verb (storno-then-rebook), not by editing or deleting.
- **AGI period vs run period.** The AGI declaration covers \`(period_year, period_month)\`: the same period as the run, not the payment date. A run paid on 2026-06-02 for May still files as the May AGI.
- **F-skatt verification is the integrator's job.** The API trusts \`employee.f_skatt_status\` (\`a_skatt\` | \`f_skatt\` | \`fa_skatt\` | \`not_verified\`) to be in sync with the employee's live Skatteverket registration. A wrong status produces a non-compliant AGI; check the F-skattsedel before payroll runs. \`not_verified\` employees are surfaced as a non-blocking warning on \`:calculate\` (30% skatteavdrag and full avgifter are applied until verified).
- **Sociala avgifter age reduction.** Per Prop. 2025/26:66, employees who are **18-22 years old at the start of the 2026 income year (born 2003-2007)** AND employees who **have turned 67 at the start of the income year (1 January 2026)** get reduced satser. The "at the start of" boundary matters: a 66-year-old whose 67th birthday falls in February 2026 does NOT qualify for the elder reduction in 2026. The engine derives age from the employee's personnummer (the leading birthdate digits: there is no separate \`birthdate\` field) and applies the correct sats automatically: don't override unless you've consulted [Skatteverkets table](https://www.skatteverket.se/foretagochorganisationer/skatter/arbetsgivareochinkomstuppgifter/arbetsgivaravgifteroch_skatteavdrag.4.18e1b10334ebe8bc80003392.html). The old "under 26" rule from 2024 does NOT apply for 2026 and later.
- **Bruttolöneavdrag vs nettolöneavdrag order.** Bruttolöneavdrag reduces both lön och avgifter; nettolöneavdrag only affects the employee's payout. Pass either explicitly in the run; don't mix them.

## Next steps

- **[Set up webhooks](/docs/api/cookbook/webhooks)**: subscribe to \`salary_run.booked\` and \`agi.generated\` events to drive downstream payroll integrations.
- **[Year-end closing](/docs/api/cookbook/year-end-closing)**: payroll's annual cap is the kontrolluppgift season (january of the following year).
- **[Salary-runs reference](/docs/api/reference/salary-runs)**: every parameter, every error code.
`
