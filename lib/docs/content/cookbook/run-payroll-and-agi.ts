export const COOKBOOK_PAYROLL_AGI_MD = `# Cookbook — run payroll and generate the AGI XML

> Drive a Swedish salary run from draft to booked, then generate the arbetsgivardeklaration på individnivå (AGI) XML for manual submission to Skatteverket. Five-step lifecycle, every transition idempotent and dry-runnable.

This is the operational companion to the [Salary-runs reference](/docs/api/reference/salary-runs). The route surface mirrors the dashboard exactly — anything you can do in the UI is callable from the API.

## What you'll need

- A test API key with \`payroll:read\` AND \`payroll:write\` scopes. \`payroll:write\` is required for every state transition; \`payroll:read\` covers the read paths plus the elevated-scope gate on the webhook \`salary_run.*\` subscription.
- At least one employee on file with \`payroll_config\` set (\`grundlön\`, \`skattetabell\`, \`tax_column\`, \`F_skatt\` flag).
- An open fiscal period covering the salary date.

## 1. Create a salary run (draft)

\`POST /salary-runs\` opens a run in \`draft\` status. Personnummer in the response is masked to \`ÅÅÅÅMMDDXXXX\` per GDPR Art.5(1)(c) — the full value only appears on \`GET /employees/{id}\` (deliberate drill-in).

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "period_year": 2026,
    "period_month": 5,
    "payment_date": "2026-05-25",
    "employees": [
      { "employee_id": "emp_...", "grundlön": 38000 },
      { "employee_id": "emp_...", "grundlön": 42000, "övertidstillägg": 2400 }
    ]
  }'
\`\`\`

Response:

\`\`\`json
{
  "data": {
    "id": "sr_...",
    "status": "draft",
    "period_year": 2026,
    "period_month": 5,
    "payment_date": "2026-05-25",
    "employee_count": 2,
    "total_brutto": null,
    "total_avgifter": null,
    "total_netto": null
  }
}
\`\`\`

Totals are null until you calculate.

## 2. Calculate (math + draft → review)

\`POST /salary-runs/{id}/calculate\` runs the full Swedish tax engine: skattetabell lookup per employee, sociala avgifter at the current rate (31.42% for 2026), age-adjusted reductions per Prop. 2025/26:66 (the youth-reduction band is **18–22 years old at the start of 2026** — i.e. employees **born 2003–2007** for the 2026 income year, NOT a blanket "under-25"; the elder reduction applies at **67+ from 2026**, not 66+), förmånsbeskattning, semesterlöneskuld, OB-tillägg, traktamente.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/calculate" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response transitions \`draft → review\`:

\`\`\`json
{
  "data": {
    "id": "sr_...",
    "status": "review",
    "total_brutto":     80000.00,
    "total_skatt":      24300.00,
    "total_avgifter":   25136.00,
    "total_netto":      55700.00,
    "lines": [
      {
        "employee_id": "emp_...",
        "personnummer": "19800401XXXX",
        "brutto": 38000,
        "preliminär_skatt": 11400,
        "arbetsgivaravgifter": 11940,
        "netto": 26600,
        ...
      },
      ...
    ]
  }
}
\`\`\`

The \`review\` status is a soft hold — the math is done but no journal entries are posted yet. Treat this as the human-review step.

## 3. Approve (review → approved)

\`POST /salary-runs/{id}/approve\` validates and locks the math. After this point you can't \`PATCH\` per-employee \`grundlön\` etc. — corrections require reverting to draft (only possible if no payment is recorded).

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/approve" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response shows \`status: 'approved'\`. The engine validates:
- Every employee has a valid \`skattetabell\` reference
- No employee's bank account is missing where required
- Sociala avgifter total matches per-employee sum to the öre
- No double-booking against a prior approved run for the same \`period_year, period_month\`

Failures return \`SALARY_RUN_APPROVE_VALIDATION_FAILED\` with a per-employee breakdown in \`details\`.

## 4. Mark paid (approved → paid)

After the bank transfer settles (or you mark it on the same day for cash-method shops), tell Accounted:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/mark-paid" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "payment_date": "2026-05-25", "settlement_account": "1930" }'
\`\`\`

This step records the payment event but does NOT post the journal entry yet — that's step 5. The split is deliberate: the \`mark-paid\` step gives integrators a hook to confirm the bank-side leg landed before locking the GL side.

## 5. Book (paid → booked)

\`POST /salary-runs/{id}/book\` is the engine-touching step. It generates 2–4 verifikationer atomically (the count depends on whether OB/övertid/traktamente have separate journals):

- Verifikation A: Bruttolön debit → 7010 (or per-employee subkonto), credit → 2710 (preliminärskatt) + 1930 (utbetalning)
- Verifikation B: Arbetsgivaravgifter debit → 7510 (lagstadgade sociala avgifter), credit → 2731 (Avräkning sociala avgifter — payable to Skatteverket, cleared when arbetsgivardeklaration is paid)
- Optional: separate verifikationer for förmånsbeskattning (förmånsvärde → 7385 cost + 2731 avräkning), traktamente (7321 inrikes / 7322 utrikes), löneväxling (1.058 factor on 7390)

The 2731 series is the **employer-contributions-payable** liability per BAS 2026 — not to be confused with 2615 (utgående moms vid import, unrelated to payroll). The arbetsgivardeklaration cycle posts the payable on book day and clears it via 1930 when the bank transfer to Skatteverket settles.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/book" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response:

\`\`\`json
{
  "data": {
    "id": "sr_...",
    "status": "booked",
    "journal_entries": [
      { "id": "je_a", "voucher_number": "L-2026-005", "kind": "bruttolön" },
      { "id": "je_b", "voucher_number": "L-2026-006", "kind": "arbetsgivaravgifter" }
    ]
  },
  "meta": {
    "request_id": "req_...",
    "audit": {
      "voucher_numbers": ["L-2026-005", "L-2026-006"],
      "immutable_at": "2026-05-25T16:00:00Z"
    }
  }
}
\`\`\`

If \`book\` fails partway (e.g. period locked while waiting for the bank-side confirmation), the route is strict-mode v1 — no partial commits. The state stays at \`paid\` and the response carries the \`PERIOD_LOCKED\` error code with the offending period.

## 6. Generate the AGI XML

\`POST /salary-runs/{id}/generate-agi\` produces the arbetsgivardeklaration på individnivå XML for the period. Skatteverket requires AGI monthly; the XML is embedded in the JSON response — no separate file endpoint.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/generate-agi" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response:

\`\`\`json
{
  "data": {
    "agi_xml": "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>\\n<Skatteverket ...>",
    "agi_id": "agi_...",
    "period": { "year": 2026, "month": 5 },
    "total_brutto":  80000.00,
    "total_avgifter": 25136.00,
    "employee_count": 2,
    "generated_at": "2026-05-25T16:02:00Z"
  }
}
\`\`\`

Save the XML to disk and upload it to **Skatteverket Mina Sidor → Tjänster → Arbetsgivardeklaration**. Mina Sidor accepts the file directly; no manual transcription needed. (Direct API submission requires BankID and goes through the \`skatteverket\` extension, not the public REST API.)

After Skatteverket confirms acceptance, store the confirmation number on the AGI:

\`\`\`bash
curl -X PATCH "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$SR_ID/agi" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "submission_reference": "SKV-AGI-2026-05-A1B2C3" }'
\`\`\`

## State machine summary

\`\`\`
draft ──calculate──► review ──approve──► approved ──mark-paid──► paid ──book──► booked ──generate-agi──► (AGI XML)
\`\`\`

Each transition is idempotent on \`Idempotency-Key\`. Retrying a transition that has already completed returns the same response with \`Idempotent-Replayed: true\`. Failed transitions don't advance the state — fix and retry.

## Förmånsbeskattning

When an employee has bilförmån / fri kost / friskvård, declare the förmånsvärde on the run-creation request:

\`\`\`json
{
  "employee_id": "emp_...",
  "grundlön": 42000,
  "förmåner": {
    "bilförmån_värde": 4250,
    "kostförmån_dagar": 12
  }
}
\`\`\`

The engine adds the förmånsvärde to bruttolön for the avgifts-basis (2731) and produces a separate \`förmåner\` line on the AGI. \`bilförmån_värde\` follows Skatteverkets schablon for 2026; pass the figure directly — the API does not compute it from car make/model/year.

## Common pitfalls

- **Don't \`PATCH\` after approve.** PATCH is draft-only. To correct an approved run, revert to draft (only possible before payment) or void the run and create a new one.
- **AGI period vs run period.** The AGI declaration covers \`(period_year, period_month)\` — the same period as the run, not the payment date. A run paid on 2026-06-02 for May still files as the May AGI.
- **F-skatt verification is the integrator's job.** The API trusts \`employee.payroll_config.F_skatt\` to be in sync with the employee's live Skatteverket registration. A wrong flag produces a non-compliant AGI; check the F-skattsedel before payroll runs.
- **Sociala avgifter age reduction.** Per Prop. 2025/26:66, employees who are **18–22 years old at the start of the 2026 income year (born 2003–2007)** AND employees who **have turned 67 at the start of the income year (1 January 2026)** get reduced satser. The "at the start of" boundary matters — a 66-year-old whose 67th birthday falls in February 2026 does NOT qualify for the elder reduction in 2026. The engine reads \`employee.birthdate\` and applies the correct sats automatically — don't override unless you've consulted [Skatteverkets table](https://www.skatteverket.se/foretagochorganisationer/skatter/arbetsgivareochinkomstuppgifter/arbetsgivaravgifteroch_skatteavdrag.4.18e1b10334ebe8bc80003392.html). The old "under 26" rule from 2024 does NOT apply for 2026 and later.
- **Bruttolöneavdrag vs nettolöneavdrag order.** Bruttolöneavdrag reduces both lön och avgifter; nettolöneavdrag only affects the employee's payout. Pass either explicitly in the run; don't mix them.

## Next steps

- **[Set up webhooks](/docs/api/cookbook/webhooks)** — subscribe to \`salary_run.booked\` and \`agi.generated\` events to drive downstream payroll integrations.
- **[Year-end closing](/docs/api/cookbook/year-end-closing)** — payroll's annual cap is the kontrolluppgift season (january of the following year).
- **[Salary-runs reference](/docs/api/reference/salary-runs)** — every parameter, every error code.
`
