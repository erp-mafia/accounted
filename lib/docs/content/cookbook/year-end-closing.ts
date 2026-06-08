export const COOKBOOK_YEAR_END_MD = `# Cookbook — year-end closing (bokslut)

> Lock a Swedish fiscal year, run the year-end procedures, set opening balances for the new year. Built around BFL 5 kap and 7 kap requirements (verifikationskedja, balanskontinuitet, 7-year retention).

This is the operational companion to the [Fiscal-periods reference](/docs/api/reference/fiscal-periods). Year-end is the single most consequential lifecycle event in a Swedish bookkeeping system — closing is irreversible per BFL 5 kap 8 §. Treat the steps below as a checklist, not a script to copy-paste.

## What you'll need

- A test API key with \`bookkeeping:write\`, \`bookkeeping:read\`, and \`reports:read\` scopes.
- All transactions for the year posted (no drafts).
- All VAT declarations for the year filed (12 monthly, 4 quarterly, or 1 annual — see the [VAT cookbook](/docs/api/cookbook/file-vat-declaration)).
- All AGI declarations filed and kontrolluppgift (KU) generated.
- The bokslut date — usually 31 december for calendar-year companies (kalenderår), or the last day of the räkenskapsår for off-calendar (brutet räkenskapsår).

## 1. Pre-flight: continuity check (IB/UB per BFL 5 kap)

Before locking anything, verify the period's continuity. BFL 5 kap requires that the closing balance (UB) of year N equals the opening balance (IB) of year N+1 on every BAS 1xxx, 2xxx account.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/continuity-check?from=2025-01-01&to=2025-12-31" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

Response:

\`\`\`json
{
  "data": {
    "checks": [
      { "account": "1930", "year_end_ub": 156432.00, "next_year_ib": 156432.00, "match": true },
      { "account": "1510", "year_end_ub":  47100.00, "next_year_ib":  47100.00, "match": true },
      { "account": "2440", "year_end_ub":  -8200.00, "next_year_ib":  -8200.00, "match": true },
      ...
    ],
    "ib_ub_continuity_holds": true,
    "discrepancy_count": 0
  }
}
\`\`\`

\`ib_ub_continuity_holds: false\` is a BFL violation — investigate before proceeding. A discrepancy on \`1930\` (bank) usually means a missed reconciliation; on \`2611-2641\` (moms) means a VAT declaration disagrees with the GL.

## 2. Pre-flight: voucher gaps (BFNAR 2013:2)

BFNAR 2013:2 kap 6–7 §§ requires explanations for missing voucher numbers. Run the check:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/compliance/check?type=voucher_gaps&period=2025" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

For every gap returned, file an explanation via \`POST /voucher-gap-explanations\` before the year is closed. Skatteverket can ask for these years later under the 7-year retention rule.

## 3. Pre-flight: missing documents on posted entries

For aktiebolag, BFL 7 kap requires every verifikation to have its underlag (receipt, faktura, kontrakt) attached. The check:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/compliance/check?type=unmatched_documents&period=2025" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

Attach missing documents via \`POST /journal-entries/{id}/documents\` before locking. After locking, the document-immutability trigger prevents detaching but allows attaching (first-link is treated as completing the audit trail, not modifying it).

## 4. Lock the period

\`POST /fiscal-periods/{id}/lock\` blocks all writes to the period while leaving it reversible. Use this when the year's books are "done" but you may still need to add a year-end accrual entry under supervision.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/fiscal-periods/$PERIOD_ID/lock" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Locked periods can be unlocked via \`PATCH\` with a clear reason that lands in the audit log. After year-end procedures are complete (step 6), close instead — closing is irreversible.

## 5. Run year-end procedures

\`POST /fiscal-periods/{id}/year-end\` is the engine-touching step. It:

1. Posts the resultatdisposition — closes every 3xxx, 7xxx, 8xxx account into \`8910\` (årets resultat), then transfers to \`2099\` (årets resultat in equity).
2. Posts the periodiseringsfond adjustment if \`company_settings.use_periodiseringsfond\` is true.
3. Posts överavskrivningar för fastigheter och inventarier if the depreciation differential exists.
4. Computes bolagsskatten on the taxable result (currently 20.6% for 2026) and posts the \`8811\` (skatt på årets resultat) ↔ \`2512\` (beräknad skatt) entry.
5. Generates the opening-balance journal for year N+1 in a single atomic batch — every IB entry on the new period referencing the UB of the closing period.

This is an async operation:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/fiscal-periods/$PERIOD_ID/year-end" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "next_period_id": "fp_...",
    "result_disposition": {
      "to_periodiseringsfond": 120000,
      "to_balanserat_resultat": 380000
    }
  }'
\`\`\`

Response is a 202 with an operation handle (year-end can take minutes for large books):

\`\`\`json
{
  "data": {
    "operation_id": "op_...",
    "status": "queued",
    "poll_url": "/api/v1/operations/op_...",
    "webhook_event": "operation.completed"
  }
}
\`\`\`

Poll the operation; on \`succeeded\` the result block lists every voucher posted:

\`\`\`json
{
  "data": {
    "operation_id": "op_...",
    "status": "succeeded",
    "result": {
      "year_end_voucher_numbers": ["A-2025-9001", "A-2025-9002", "A-2025-9003"],
      "opening_balance_voucher_number": "A-2026-0001",
      "årets_resultat_amount": 580000.00,
      "bolagsskatt_amount": 119480.00,
      "periodiseringsfond_set_aside": 120000.00
    }
  }
}
\`\`\`

## 6. Verify opening balances on the new year

After year-end runs, the new period (\`next_period_id\`) has IB on every balance-sheet account matching the prior period's UB. Verify:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/trial-balance?period=2026" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

The \`opening_balance\` column on every 1xxx/2xxx row should equal the \`closing_balance\` on the same row for 2025. \`3xxx-8xxx\` accounts have zero opening balance — the year-end procedure cleared them into \`2099\`.

If opening balances are wrong (rare; the engine validates before posting), use \`POST /fiscal-periods/{id}/opening-balances\` with explicit values — but this is a backstop, not a routine path. The year-end procedure should produce correct IB without manual intervention.

## 7. Close the period (irreversible)

After the declaration, the auditor's review (if applicable), and any year-end accruals are settled, close the period. **BFL 5 kap 8 §: closing is irreversible.** No code path can re-open a closed period.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/fiscal-periods/$PERIOD_ID/close" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "confirmation_phrase": "close period 2025 irrevocably" }'
\`\`\`

The \`confirmation_phrase\` is a forced typed acknowledgment. The request fails with \`VALIDATION_ERROR\` unless the literal phrase matches.

## 8. Generate the årsredovisning (aktiebolag only)

For an AB, the annual report (årsredovisning) is filed with Bolagsverket within 7 months of the fiscal-year end. v1 produces the K2/K3-formatted source data; you typeset it externally and submit via Bolagsverket Mina Sidor.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/annual-report?year=2025" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

The response carries the resultaträkning, balansräkning, kassaflödesanalys (K3 only), the noter pre-populated from the GL, and the förvaltningsberättelse template. The signing flow (every styrelseledamot must sign) is outside the API surface.

## 9. Generate INK2 / NE for the tax declaration

The tax declaration (INK2 for AB, NE-bilaga for enskild firma) is due in March/May depending on entity type and fiscal-year shape. The endpoints:

\`\`\`bash
# Aktiebolag — INK2
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/ink2?year=2025" \\
  -H "Authorization: Bearer gnubok_sk_test_..."

# Enskild firma — NE-bilaga
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/ne-bilaga?year=2025" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

These produce **two files** — \`INFO.SRU\` (metadata header) plus \`BLANKETTER.SRU\` (the declaration body) — uploaded together as a single submission to Skatteverket. **The SRU format is plain text encoded in ISO 8859-1 (NOT XML)** — a tagged record-line shape per Skatteverket's SRU specification. A single-file upload is rejected by Skatteverket's validation. This is a separate artefact from Bolagsverket's digital årsredovisning filing, which uses **iXBRL** (an XML-based standard). SRU goes to Skatteverket for INK2/INK2R/INK2S declarations; iXBRL goes to Bolagsverket for the public annual report. Don't conflate them.

> **Note:** \`/reports/ink2\` and \`/reports/ne-bilaga\` are queued as deferred endpoints — see the API changelog for current availability. Until they ship, generate the inputs via \`/reports/trial-balance?year=...\` and feed your tax-software of choice.

## Brutet räkenskapsår (off-calendar year)

For a company on a non-calendar fiscal year (e.g. 2024-07-01 → 2025-06-30), the entire flow is identical — substitute the actual period dates everywhere. The IB/UB continuity check, the year-end procedure, and the lock/close lifecycle all operate on the period regardless of its alignment with the calendar.

The one exception: the VAT declaration cadence is monthly/kvartalsvis/årlig regardless of the räkenskapsår shape, so a brutet räkenskapsår company files moms on calendar months while closing books on its own fiscal calendar.

## Common pitfalls

- **Don't year-end before the last month's moms is declared.** The year-end procedure expects every moms-account balance to reconcile. A pending declaration leaves dangling balances on 2611-2641.
- **Periodiseringsfond reserve cap.** Per IL 30 kap 5 § and 30 kap 6 a §, AB can set aside max 25% of the **taxable profit AFTER schablonintäkt has been added back and BEFORE the periodiseringsfond deduction itself**. The schablonintäkt rate is **(SLR + 1%) × outstanding prior-year periodiseringsfonder balance**, where SLR is Skatteverket's statslåneränta as published on 30 November of the preceding income year — for 2026 SLR is 2.55%, so the rate is **3.55%**. The engine reads the canonical rate from \`tax_rates\` and surfaces both the schablonintäkt amount and the resulting cap on the year-end result block; pass \`to_periodiseringsfond\` as the desired set-aside amount and the engine returns \`VALIDATION_ERROR\` with the maximum allowed value if it exceeds the cap. Note: under BFL/BFNAR 2016:10 kap 13 (materiellt samband for AB), periodiseringsfond is BOOKED as an obeskattad reserv on accounts 2110–2139, not just declared on INK2 — the engine posts the booking automatically as part of the year-end procedure.
- **Don't unlock a period after the AB's annual report is filed.** The signed annual report is a public document at Bolagsverket; unlocking and changing the books afterwards creates a discrepancy with the filed report (which is itself an audit finding). Use storno (\`POST /journal-entries/{id}/reverse\`) to correct in the current open period instead.
- **Year-end is async.** The operation can take minutes; don't block your request loop on it. Subscribe to \`operation.completed\` or poll \`GET /operations/{id}\` with reasonable backoff (every 5–10s).
- **The closing-period confirmation phrase is locale-sensitive.** It must match exactly. If you localise the prompt to Swedish ("stäng period 2025 oåterkalleligt"), document the exact string your UI requires — the API requires the English version above.

## Next steps

- **[VAT declaration cookbook](/docs/api/cookbook/file-vat-declaration)** — covers each monthly cycle within the year.
- **[Payroll cookbook](/docs/api/cookbook/run-payroll-and-agi)** — kontrolluppgift season (jan of year N+1) follows naturally after year-end.
- **[Fiscal-periods reference](/docs/api/reference/fiscal-periods)** — every parameter, every state transition.
`
