export const COOKBOOK_YEAR_END_MD = `# Cookbook: year-end closing (bokslut)

> Run the year-end procedures for a Swedish fiscal year — the engine locks and closes it and sets the opening balances for the new year. Built around BFL 5 kap and 7 kap requirements (verifikationskedja, balanskontinuitet, 7-year retention).

This is the operational companion to the [Fiscal-periods reference](/docs/api/reference/fiscal-periods). Year-end is the single most consequential lifecycle event in a Swedish bookkeeping system: closing is irreversible per BFL 5 kap 8 §. Treat the steps below as a checklist, not a script to copy-paste.

## What you'll need

- A test API key with \`bookkeeping:write\`, \`bookkeeping:read\`, \`reports:read\`, \`compliance:read\`, \`documents:write\`, and \`operations:read\` scopes.
- All transactions for the year posted (no drafts).
- All VAT declarations for the year filed (12 monthly, 4 quarterly, or 1 annual: see the [VAT cookbook](/docs/api/cookbook/file-vat-declaration)).
- All AGI declarations for the year filed. (Employment income reported through monthly AGI is **not** re-reported on an annual kontrolluppgift — KU remains only for the specific payment types AGI doesn't cover, e.g. certain ränta/utdelning; it is not a blanket year-end step.)
- The bokslut date: usually 31 december for calendar-year companies (kalenderår), or the last day of the räkenskapsår for off-calendar (brutet räkenskapsår).

## 1. Pre-flight: continuity check (IB/UB per BFL 5 kap)

Before you run year-end, verify the period's continuity. BFL 5 kap (with the SIE4 invariant) requires that a period's opening balance (IB) equals the previous period's closing balance (UB) on every BAS 1xxx, 2xxx account. The check takes the fiscal-period UUID and compares that period's IB against its predecessor's UB.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/continuity-check?period_id=$PERIOD_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

Response (a passing check returns \`valid: true\` with an empty \`discrepancies\` array):

\`\`\`json
{
  "data": {
    "valid": true,
    "period_name": "FY 2025",
    "previous_period_name": "FY 2024",
    "discrepancies": [],
    "checked_accounts": 42
  }
}
\`\`\`

When a mismatch exists \`valid\` is \`false\` and each offending account appears in \`discrepancies\`:

\`\`\`json
{
  "account_number": "1930",
  "account_name": "Företagskonto",
  "previous_ub_net": 156432.00,
  "current_ib_net": 156430.00,
  "difference": 2.00
}
\`\`\`

\`valid: false\` is a BFL violation: the previous period's closing balance (UB) was not carried into this period as the opening balance (IB). This is always a carry-forward problem — a missing/incorrect opening-balance entry, or a post-close mutation of the prior period — not a missed bank reconciliation or a VAT-vs-GL disagreement. Investigate the opening-balance entry for the flagged account before proceeding.

## 2. Pre-flight: voucher gaps (BFNAR 2013:2)

BFNAR 2013:2 kap 6-7 §§ requires explanations for missing voucher numbers. Run the check:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/compliance/check?type=voucher_gaps&fiscal_period_id=$PERIOD_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

The check returns a \`findings\` array; each unexplained gap is a \`blocker\` (code \`VOUCHER_GAP_UNEXPLAINED\`). For every gap, file an explanation via \`POST /voucher-gap-explanations\` before the year is closed. Skatteverket can ask for these years later under the 7-year retention rule.

## 3. Pre-flight: missing documents on posted entries

For aktiebolag, BFL 7 kap requires every verifikation to have its underlag (receipt, faktura, kontrakt) attached. The v1 \`compliance/check\` endpoint does **not** gate on documents — its only supported types are \`year_end_readiness\` and \`voucher_gaps\` — so surface missing underlag through the MCP tools instead:

\`\`\`
gnubok_list_verifikat_without_documents
gnubok_list_transactions_without_documents
\`\`\`

Attach an already-uploaded document to its verifikation via \`POST /documents/{id}/link\`, passing the target entry in the body:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/documents/$DOCUMENT_ID/link" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "journal_entry_id": "a8f1c2d3-..." }'
\`\`\`

The first link to a verifikation is allowed even after the period is locked (it completes the audit trail rather than modifying the entry). Re-linking a document that is already attached to a *posted* entry is refused with \`CONFLICT\` (\`document_already_linked_to_posted_entry\`) per BFL 5 kap 5 §.

## 4. Locking is handled by year-end (do NOT pre-lock)

The year-end run in step 5 locks the fiscal year itself as part of its flow. **Do not call \`/lock\` on the year you are about to close first**: \`executeYearEndClosing\` locks the period internally, and a period that is already locked makes the run fail with \`Period is already locked\`.

The standalone \`POST /fiscal-periods/{id}/lock\` endpoint (synchronous, returns \`200\` with the updated period) is for *interim* locking, e.g. freezing a finished month you are not year-end-closing. It refuses if uncategorised affärstransaktioner remain in the period (\`PERIOD_HAS_UNBOOKED_TRANSACTIONS\`).

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/fiscal-periods/$PERIOD_ID/lock" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Unlocking a locked period is not exposed in v1 (dashboard only). A closed period can never be unlocked: closing is irreversible per BFL 5 kap 8 §.

## 5. Run year-end

\`POST /fiscal-periods/{id}/year-end\` is the single engine-touching step. It takes **no request body** (only the mandatory \`Idempotency-Key\` header); the next fiscal period is resolved automatically — an existing next period is reused, otherwise one is created. In order, \`executeYearEndClosing\`:

1. Re-validates readiness (no drafts, no unexplained voucher gaps, trial balance balanced). Preview it first with \`GET /compliance/check?type=year_end_readiness&fiscal_period_id=$PERIOD_ID\`.
2. Runs currency revaluation, posting FX gains/losses to \`3960\`/\`7960\` **before** the closing entry so they get swept into the result.
3. Posts one closing entry (\`source_type=year_end\`, series A, "Årsbokslut …"): it zeros every result account in BAS class 3-8 and books the net result **directly** onto \`2099\` "Årets resultat" (aktiebolag) — or \`2010\` "Eget kapital" for enskild firma. There is no \`8910\` intermediate step.
4. Locks, then closes the period (irreversible per BFL 5 kap 8 §).
5. Generates the opening-balance verifikat in the next period: every BAS class 1-2 account's UB becomes its IB, as a single balanced entry.
6. Re-validates IB/UB continuity (rolling back on failure), then — for aktiebolag — omför föregående års resultat from \`2099\` to \`2098\` in the new period as a separate verifikat.

The engine does **not** compute or post income tax (bolagsskatt), periodiseringsfond, or överavskrivningar. Book any bokslutsdispositioner and the tax entry yourself as ordinary verifikationer **before** running year-end — the tax entry debits \`8910\` against \`2512\`; a periodiseringsfond avsättning debits \`8811\` against an obeskattad reserv in \`21xx\` — so the closing entry sweeps their class-8 legs into the result.

This is an async operation. It takes no body:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/fiscal-periods/$PERIOD_ID/year-end" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response is a \`202\` with an operation handle (operation ids are UUIDs):

\`\`\`json
{
  "data": {
    "operation_id": "0e9c1f2a-8b3d-4f6a-9c21-1a2b3c4d5e6f",
    "type": "fiscal_periods.year_end",
    "status": "queued",
    "poll_url": "/api/v1/operations/0e9c1f2a-8b3d-4f6a-9c21-1a2b3c4d5e6f",
    "webhook_event": "operation.completed"
  }
}
\`\`\`

Poll \`GET /operations/{id}\`; on \`succeeded\` the \`result\` block carries the ids of the entries the engine posted and the next period it opened:

\`\`\`json
{
  "data": {
    "operation_id": "0e9c1f2a-8b3d-4f6a-9c21-1a2b3c4d5e6f",
    "type": "fiscal_periods.year_end",
    "status": "succeeded",
    "result": {
      "closing_entry_id": "a8f1c2d3-...",
      "revaluation_entry_id": "b7e2d3c4-...",
      "opening_balance_entry_id": "c6d3e4f5-...",
      "next_period_id": "d5c4b3a2-..."
    },
    "error": null,
    "poll_url": "/api/v1/operations/0e9c1f2a-8b3d-4f6a-9c21-1a2b3c4d5e6f",
    "webhook_event": "operation.completed"
  }
}
\`\`\`

(\`revaluation_entry_id\` is \`null\` when there were no open foreign-currency items to revalue.)

## 6. Verify opening balances on the new year

After year-end runs, the new period (\`next_period_id\` from the operation result) has IB on every balance-sheet account matching the prior period's UB. Pass that period's UUID as \`period_id\`:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/trial-balance?period_id=$NEXT_PERIOD_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

The \`opening_balance\` column on every 1xxx/2xxx row should equal the \`closing_balance\` on the same row for the closed year. \`3xxx-8xxx\` accounts have zero opening balance: the year-end procedure cleared them into \`2099\`.

You normally never touch \`POST /fiscal-periods/{id}/opening-balances\`: year-end already generates the IB, and this endpoint returns \`CONFLICT\` (\`opening_balance_already_posted\`) once an IB entry exists in the target period. It exists only to generate the IB in isolation — its body is \`{ "next_period_id": "<uuid>" }\` and it computes balances from the closed period's UB (no explicit values are accepted). To correct a wrong IB, post a storno/manual entry instead.

## 7. The period is already closed (\`/close\` is recovery-only)

Step 5 already locked **and** closed the period — \`executeYearEndClosing\` runs \`closePeriod\` as its final bookkeeping step. **BFL 5 kap 8 §: closing is irreversible.** No code path can re-open a closed period, so in the normal flow you never call \`/close\` yourself.

\`POST /fiscal-periods/{id}/close\` exists only as a recovery path: it finalizes a year-end that posted its closing entry and locked the period but did not reach the close step (a rare mid-flow failure). It reads **no body** — only the mandatory \`Idempotency-Key\` header:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/fiscal-periods/$PERIOD_ID/close" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

It returns \`CONFLICT\` (\`already_closed\`) if the period is already closed, \`PERIOD_NOT_LOCKED\` if it was never locked, and \`CONFLICT\` (\`year_end_not_executed\`) if no closing entry exists yet.

## 8. Assemble the årsredovisning (aktiebolag only)

For an AB, the annual report (årsredovisning) is filed with Bolagsverket within 7 months of the fiscal-year end. A single \`/reports/annual-report\` endpoint is **not yet exposed in v1**: assemble the K2/K3 source figures from the report endpoints that do exist, then typeset and submit via Bolagsverket Mina Sidor.

\`\`\`bash
# Resultaträkning
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/income-statement?period_id=$PERIOD_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..."

# Balansräkning
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/balance-sheet?period_id=$PERIOD_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

The resultaträkning and balansräkning come from those two reports; the noter and förvaltningsberättelse are assembled from the GL on your side. The signing flow (every styrelseledamot must sign) is outside the API surface.

## 9. Generate INK2 / NE for the tax declaration

The tax declaration (INK2 for AB, NE-bilaga for enskild firma) is due in March/May depending on entity type and fiscal-year shape. The endpoints:

\`\`\`bash
# Aktiebolag: INK2
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/ink2?year=2025" \\
  -H "Authorization: Bearer gnubok_sk_test_..."

# Enskild firma: NE-bilaga
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/ne-bilaga?year=2025" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

These produce **two files**: \`INFO.SRU\` (metadata header) plus \`BLANKETTER.SRU\` (the declaration body), uploaded together as a single submission to Skatteverket. **The SRU format is plain text encoded in ISO 8859-1 (NOT XML)**: a tagged record-line shape per Skatteverket's SRU specification. A single-file upload is rejected by Skatteverket's validation. This is a separate artefact from Bolagsverket's digital årsredovisning filing, which uses **iXBRL** (an XML-based standard). SRU goes to Skatteverket for INK2/INK2R/INK2S declarations; iXBRL goes to Bolagsverket for the public annual report. Don't conflate them.

> **Note:** \`/reports/ink2\` and \`/reports/ne-bilaga\` are not part of the v1 report surface yet: see the API changelog for current availability. Until they ship, generate the inputs via \`/reports/trial-balance?period_id=<uuid>\` and feed your tax-software of choice.

## Brutet räkenskapsår (off-calendar year)

For a company on a non-calendar fiscal year (e.g. 2024-07-01 → 2025-06-30), the entire flow is identical: substitute the actual period dates everywhere. The IB/UB continuity check, the year-end procedure, and the lock/close lifecycle all operate on the period regardless of its alignment with the calendar.

The one exception: the VAT declaration cadence is monthly/kvartalsvis/årlig regardless of the räkenskapsår shape, so a brutet räkenskapsår company files moms on calendar months while closing books on its own fiscal calendar.

## Common pitfalls

- **Don't year-end before the last month's moms is declared.** The year-end procedure expects every moms-account balance to reconcile. A pending declaration leaves dangling balances on 2611-2641.
- **Periodiseringsfond is your entry, not the engine's.** \`/year-end\` does not accept a set-aside amount and does not post the reserve; it only revalues currency, posts the closing entry (class 3-8 → \`2099\`), and generates the IB. If you set aside a periodiseringsfond, book it yourself as an obeskattad reserv (\`21xx\`, against \`8811\`) **before** running year-end. For sizing it: per IL 30 kap 5 § and 30 kap 6 a §, an AB can set aside max 25% of the **taxable profit AFTER schablonintäkt has been added back and BEFORE the periodiseringsfond deduction itself**. The schablonintäkt is **(SLR + 1%) × outstanding prior-year periodiseringsfonder balance**, where SLR is Skatteverket's statslåneränta as published on 30 November of the preceding income year: for 2026 SLR is 2.55%, so the rate is **3.55%**. Under BFL/BFNAR 2016:10 (materiellt samband for AB), the periodiseringsfond is BOOKED as an obeskattad reserv, not just declared on INK2.
- **Don't unlock a period after the AB's annual report is filed.** The signed annual report is a public document at Bolagsverket; unlocking and changing the books afterwards creates a discrepancy with the filed report (which is itself an audit finding). Use storno (\`POST /journal-entries/{id}/reverse\`) to correct in the current open period instead. (Unlocking is dashboard-only; it is not in v1.)
- **Year-end is async.** Don't block your request loop on it: poll \`GET /operations/{id}\` with reasonable backoff (every 5-10s). If you prefer webhooks, subscribe to \`period.year_closed\` — that is the event the engine emits on completion. (\`operation.completed\`, shown in the operation envelope, is the polling contract, not a separately deliverable subscription event.)

## Next steps

- **[VAT declaration cookbook](/docs/api/cookbook/file-vat-declaration)**: covers each monthly cycle within the year.
- **[Payroll cookbook](/docs/api/cookbook/run-payroll-and-agi)**: the monthly AGI cycle, plus any exception-based kontrolluppgifter (the KU types AGI doesn't cover) filed in January of year N+1.
- **[Fiscal-periods reference](/docs/api/reference/fiscal-periods)**: every parameter, every state transition.
`
