export const COOKBOOK_VAT_DECLARATION_MD = `# Cookbook: compute and review a VAT declaration

> Compute the Swedish momsdeklaration rutor 05-62 from your posted general-ledger entries and prepare the numbers for manual submission to Skatteverket.

This is the operational companion to the [Reports reference](/docs/api/reference/reports). v1 does NOT submit the declaration to Skatteverket directly: that path exists via the BankID-gated Skatteverket extension, not the public REST API. v1 produces the numbers and the receipt-quality JSON for manual submission via Skatteverket Mina Sidor.

## What you'll need

- A test API key with \`reports:read\` scope.
- All transactions for the period categorised and posted (see [ingest-bank-transactions cookbook](/docs/api/cookbook/ingest-bank-transactions)).
- The company's \`moms_redovisning\` cycle configured: monthly (kvartalsvis is supported for small companies with omsättning ≤ 1M SEK; the API doesn't dictate cadence, your bookkeeping does).

## 1. Compute the declaration

\`GET /reports/vat-declaration\` returns all the rutor plus supporting counts and a per-source breakdown. The period is selected with three **required** params — \`period_type\` (monthly|quarterly|yearly), \`year\`, and \`period\` (monthly 1-12, quarterly 1-4, yearly 1) — plus an optional \`accounting_method\` (accrual|cash, default accrual):

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/vat-declaration?period_type=monthly&year=2026&period=4" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

Response (abbreviated):

\`\`\`json
{
  "data": {
    "period": { "type": "monthly", "year": 2026, "period": 4, "start": "2026-04-01", "end": "2026-04-30" },
    "rutor": {
      "ruta05": 133300.00,
      "ruta06":      0.00,
      "ruta10":  31075.00,
      "ruta11":    720.00,
      "ruta12":    180.00,
      "ruta20":      0.00,
      "ruta21":  20800.00,
      "ruta22":      0.00,
      "ruta23":      0.00,
      "ruta24":      0.00,
      "ruta30":   5200.00,
      "ruta31":      0.00,
      "ruta32":      0.00,
      "ruta39":   3450.00,
      "ruta40":      0.00,
      "ruta48":  17547.00,
      "ruta50":      0.00,
      "ruta60":      0.00,
      "ruta61":      0.00,
      "ruta62":      0.00,
      "ruta49":  19628.00
    },
    "invoiceCount": 42,
    "transactionCount": 15,
    "breakdown": {
      "invoices": {
        "ruta05": 133300.00, "ruta06": 0.00, "ruta07": 0.00,
        "ruta10": 31075.00, "ruta11": 720.00, "ruta12": 180.00,
        "ruta39": 3450.00, "ruta40": 0.00,
        "base25": 124300.00, "base12": 6000.00, "base6": 3000.00
      },
      "transactions": { "ruta48": 17547.00 },
      "receipts": { "ruta48": 0.00 },
      "reverseCharge": {
        "ruta20": 0.00, "ruta21": 20800.00, "ruta22": 0.00, "ruta23": 0.00, "ruta24": 0.00,
        "ruta30": 5200.00, "ruta31": 0.00, "ruta32": 0.00
      }
    }
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

Ruta 49 = (utgående moms 10+11+12 + omvänd skattskyldighet 30+31+32 + utgående moms vid import 60+61+62) − ingående moms (ruta 48). Positive → moms att betala. Negative → moms att återfå.

## 2. Trace the numbers back to the ledger

The declaration is a **pure projection of the general ledger**: every ruta is the aggregated balance of its BAS accounts over the period. There is no separate reconciliation object in the response — the rutor *are* the ledger balances. The account → ruta mapping (SKV 4700) is:

- \`2611\`: Utgående moms 25% → ruta 10
- \`2614\`: Utgående moms vid omvänd skattskyldighet → ruta 30
- \`2615\`: Utgående moms vid import → ruta 60
- \`2621\`: Utgående moms 12% → ruta 11
- \`2631\`: Utgående moms 6% → ruta 12
- \`2641\`: Ingående moms → ruta 48
- \`2645\`: Ingående moms på utländska förvärv → ruta 48

To sanity-check the figures, use the supporting fields the response already returns:

- \`invoiceCount\` / \`transactionCount\`: how many posted entries fed the period.
- \`breakdown.invoices\`: the sales-side rutor (05/06/07/10/11/12/39/40) plus per-rate bases (\`base25\`/\`base12\`/\`base6\`).
- \`breakdown.transactions.ruta48\` / \`breakdown.receipts.ruta48\`: where the input VAT in ruta 48 came from (\`breakdown.transactions.ruta48\` mirrors the full \`rutor.ruta48\`).
- \`breakdown.reverseCharge\`: the reverse-charge purchase bases (ruta 20-24) and the self-assessed output VAT (ruta 30-32).

For a byte-level tie-out against raw account balances, pull the [general ledger report](/docs/api/reference/reports) filtered to the 26xx accounts and compare each account against the mapping above.

## 3. The 2026-04-01 livsmedel rate change

**Important compliance moment in April 2026.** The VAT rate on livsmedel (groceries) drops from 12% → 6% effective 2026-04-01 (Prop. 2025/26:55). The decisive date under ML (2023:200) is the *tidpunkt för skattskyldighetens inträde*, whose timing rules live in **7 kap. 3–13 §§**. The general rule for goods is the **supply date** (delivery), not the invoice date — **but** a *förskott* (advance payment) received before delivery triggers the VAT point, and pins the rate, at the time of that payment for the amount paid. So a food förskott paid in March for an April delivery is taxed at 12%, even though delivery is after the cutover. Drive the treatment off the taxable event (delivery, or earlier advance payment), not the delivery date alone.

- **Choose the VAT treatment from the supply date, and record \`delivery_date\` when it differs from \`invoice_date\`.** You set the rate per line via \`vat_treatment\`: \`reduced_6\` books to \`2631\` (6%) and \`reduced_12\` books to \`2621\` (12%). The engine does **not** infer the rate from \`delivery_date\` — it books to the account implied by the treatment you send — so for food supplied ≥ 2026-04-01 send \`reduced_6\`, and \`reduced_12\` for food supplied before the cutover, regardless of when the invoice was issued. For continuous or subscription food supplies (e.g. a weekly grocery box), the trigger point is the date when each individual delivery's skattskyldighet inträder: confirm against ML 1 kap 3 § rather than assuming the rule equals a single delivery date.
- The classic edge case: food delivered in March, invoiced in April. The supply date (March) governs, so the line must be booked at 12% (\`reduced_12\`) even though the invoice is dated April. Drive the treatment off the supply date — not the invoice date — and record \`delivery_date\` on the invoice for the audit trail. **Do this for every food-line item in March-April 2026 invoices**: the cost of explicit data is zero; the cost of a mis-booked verifikation is a manual rectification + a momsdeklaration adjustment.
- If you omit \`delivery_date\`, the invoice carries no explicit supply date and you are implicitly treating the invoice date as the supply date — fine for **one-off** service supplies where delivery and invoice coincide. Long-running service contracts (subscriptions, ongoing maintenance) have per-delprestation skattskyldighet under ML 1 kap 3 § and need an explicit \`delivery_date\` per billing cycle. Goods that straddle the cutover always need an explicit \`delivery_date\`.

The VAT declaration for April 2026 onwards will show split balances on rutor 11/12: pre-2026-04-01 food sales remain on ruta 11 (12%), post-cutover food sales appear on ruta 12 (6%). The \`breakdown.invoices\` per-rate bases (\`base12\` / \`base6\`) let you see the split, so you can catch any post-cutover line still booked at 12% before you submit.

## 4. Pre-flight: voucher gaps

BFNAR 2013:2 kap 6-7 §§ requires every voucher gap to have a documented explanation. Skatteverket may ask why \`F-2026-0042\` exists when no \`F-2026-0041\` is on the books. Check before declaring:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/compliance/check?type=voucher_gaps&fiscal_period_id=$FISCAL_PERIOD_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

The check takes the period's UUID as \`fiscal_period_id\` (not a \`YYYY-MM\` string); get it from \`GET /fiscal-periods\`. Supported \`type\` values are \`voucher_gaps\` and \`year_end_readiness\`. If gaps exist, file an explanation via \`POST /voucher-gap-explanations\` BEFORE submitting the declaration: gaps without explanations are a compliance audit finding.

## 5. Pre-flight: locked period

The declaration is computed from posted entries in the period. If the period is still open and you have draft entries that should be in this declaration, commit them before declaring. After declaring, lock the period:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/fiscal-periods/$PERIOD_ID/lock" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Locking is reversible until you close the period, but the unlock endpoint is not exposed in v1: reverse a lock from the dashboard. Closing the period is irreversible per BFL 5 kap 8 §; only close after the declaration is submitted AND any audit-period grace window has passed.

## 6. Manual submission to Skatteverket

v1 does not submit the declaration. The receipt-quality JSON above is what you transcribe into Skatteverket Mina Sidor (or feed into your own Skatteverket-integration tooling, gated by BankID: handled by the optional \`skatteverket\` extension, not the public REST API).

For audit-trail completeness, capture the submission confirmation number from Skatteverket. v1 does not expose a field for a Skatteverket submission reference on the fiscal period, so record it in your own system of record (or your integration's audit log) alongside the period it belongs to.

## EU and reverse-charge handling

Sales of services to other EU businesses (\`vat_treatment: 'reverse_charge'\`) book to account 3308 and appear on ruta 39, bypassing the output-moms accounts (no entry on 26xx). The customer accounts for moms in their own country. (Use \`export\` instead — account 3305, ruta 40 — for services sold outside the EU.)

Purchases of services from other EU businesses (supplier_invoice with \`vat_treatment: 'reverse_charge'\`) put the **purchase base** on ruta 21 (tjänster från EU). The engine books a calculated 25% reverse-charge output on account 2614 (→ ruta 30) AND an input-moms entry on 2645 (→ ruta 48): net zero impact on cash flow when full avdragsrätt applies, full traceability on the declaration. **For blandad verksamhet (mixed-activity companies with partial avdragsrätt per HFD 2023 ref. 45),** the deductible portion of the \`2645\` leg must be restricted at booking time (e.g. by splitting the non-deductible share onto account 2649, blandad verksamhet) — there is no company-level deduction-percent setting that does this for you; otherwise the full input-moms reaches ruta 48 and over-declares the deduction.

Imports from outside EU book through a customs-clearance flow — there is no \`import\` \`vat_treatment\` value; the customs (Tullverket) invoice is what posts the moms, not the supplier invoice itself. The beskattningsunderlag lands on ruta 50 and the calculated import output VAT on rutor 60/61/62 (25/12/6%). Coverage of this is in the [Supplier invoices reference](/docs/api/reference/supplier-invoices).

## Common pitfalls

- **Decimals vs hela kronor: truncate öre, do not round.** The API returns rutor as decimal numbers (öre preserved). Skatteverket Mina Sidor and SRU filings accept only hela kronor; the rule per SFL 22 kap 1 § is **truncation** (drop öre), NOT half-up rounding. Use \`Math.floor\` for positive amounts when transcribing. Truncate at the rendering / submission boundary, not in storage.
- **Don't compute mid-month.** The figures are only meaningful for a complete month; calling with \`period_type=monthly&year=2026&period=4\` mid-April returns the partial state. The endpoint doesn't refuse partial periods, so this is on the integrator.
- **Mixed-rate invoices.** A single invoice with both 25% and 12% items lands on both \`2611\` and \`2621\`. The declaration handles this correctly because the per-line VAT rate is preserved in the engine; integrations that flatten to a single header rate will mis-declare.
- **Reverse-charge invoices in the wrong ruta.** A B2B sale to an EU customer with a missing/unvalidated VAT number does NOT qualify for reverse charge: those go to ruta 05 with normal 25% moms. Validate the customer's VAT number against VIES before issuing the invoice — note that VAT-number validation is a dashboard feature and is **not** exposed as a public v1 endpoint, so do the VIES check in your own flow.

## Next steps

- **[Year-end closing](/docs/api/cookbook/year-end-closing)**: once all 12 monthly declarations are filed, close the fiscal year.
- **[Run payroll](/docs/api/cookbook/run-payroll-and-agi)**: moms and AGI are independent; both need to be filed monthly.
- **[Reports reference](/docs/api/reference/reports)**: every report, every parameter.
`
