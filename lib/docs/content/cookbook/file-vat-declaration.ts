export const COOKBOOK_VAT_DECLARATION_MD = `# Cookbook — compute and review a VAT declaration

> Compute the Swedish momsdeklaration rutor 05–49 from your committed transactions, reconcile against the general ledger, and prepare the numbers for manual submission to Skatteverket.

This is the operational companion to the [Reports reference](/docs/api/reference/reports) and the [Skatteverket integration notes](/docs/api/webhooks#operation-events). v1 does NOT submit the declaration to Skatteverket directly — that path exists via the BankID-gated Skatteverket extension, not the public REST API. v1 produces the numbers and the receipt-quality JSON for manual submission via Skatteverket Mina Sidor.

## What you'll need

- A test API key with \`reports:read\` scope.
- All transactions for the period categorised and posted (see [ingest-bank-transactions cookbook](/docs/api/cookbook/ingest-bank-transactions)).
- The company's \`moms_redovisning\` cycle configured — monthly (kvartalsvis is supported for small companies with omsättning ≤ 1M SEK; the API doesn't dictate cadence, your bookkeeping does).

## 1. Compute the declaration

\`GET /reports/vat-declaration\` returns rutor 05–62 plus the reconciliation block:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/reports/vat-declaration?period=2026-04" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

Response (abbreviated):

\`\`\`json
{
  "data": {
    "period": { "year": 2026, "month": 4, "label": "april 2026" },
    "company": { "org_number": "556677-8899", "vat_registration_no": "SE556677889901" },
    "rutor": {
      "05": { "label": "Momspliktig försäljning",                  "amount":  124300.00 },
      "06": { "label": "Momspliktig försäljning som inte ingår i ruta 05", "amount":   0.00 },
      "07": { "label": "Momspliktig inköp omv. skattskyldighet",   "amount":       0.00 },
      "10": { "label": "Utgående moms 25% (på ruta 05)",           "amount":   31075.00 },
      "11": { "label": "Utgående moms 12%",                         "amount":     720.00 },
      "12": { "label": "Utgående moms 6%",                          "amount":     180.00 },
      "30": { "label": "Inköp av varor från EU (omv. skatt)",      "amount":       0.00 },
      "31": { "label": "Inköp av tjänster från EU (omv. skatt)",   "amount":    5200.00 },
      "32": { "label": "Inköp utanför EU (omv. skatt)",            "amount":       0.00 },
      "39": { "label": "Försäljning tjänster EU",                  "amount":    3450.00 },
      "40": { "label": "Export utanför EU",                         "amount":       0.00 },
      "48": { "label": "Ingående moms (avdragsgill)",              "amount":   12347.00 },
      "49": { "label": "Moms att betala (+) eller återfå (−)",     "amount":   19628.00 }
    },
    "reconciliation": {
      "gl_balance_2611": 31075.00,
      "gl_balance_2614":     0.00,
      "gl_balance_2615":     0.00,
      "gl_balance_2621":   720.00,
      "gl_balance_2631":   180.00,
      "gl_balance_2641": 12347.00,
      "gl_balance_2645":     0.00,
      "rutor_match_gl": true
    },
    "warnings": []
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

Ruta 49 = (utgående moms 10+11+12 + utländsk omv. 30+31+32 + utländsk försäljning 60+61+62) − ingående moms (ruta 48). Positive → moms att betala. Negative → moms att återfå.

## 2. Reconcile against the GL

The \`reconciliation\` block compares the rutor against the actual general-ledger balances on the moms accounts:

- \`2611\` — Utgående moms 25% (matches ruta 10)
- \`2614\` — Utgående moms vid omvänd skattskyldighet (matches ruta 30 / reverse-charge output)
- \`2615\` — Utgående moms vid import (matches ruta 60)
- \`2621\` — Utgående moms 12% (matches ruta 11)
- \`2631\` — Utgående moms 6% (matches ruta 12)
- \`2641\` — Ingående moms (matches ruta 48)
- \`2645\` — Beräknad ingående moms vid EU-förvärv (rolls into rutor 30/31/32 → ruta 48)

\`rutor_match_gl: true\` means every figure on the declaration ties to the GL — the declaration is self-consistent. \`false\` triggers a per-rate \`warnings\` entry pointing at the offending account; investigate before submitting.

## 3. The 2026-04-01 livsmedel rate change

**Important compliance moment in April 2026.** The VAT rate on livsmedel (groceries) drops from 12% → 6% effective 2026-04-01 under the regeringens vårproposition 2025. The decisive date under ML (2023:200) 1 kap 3 § is the *tidpunkt för skattskyldighetens inträde* — for goods this is the **supply date** (delivery), not the invoice date.

- **Always pass \`delivery_date\` explicitly when it differs from \`invoice_date\`.** The engine routes the booking by supply date: food delivered ≥ 2026-04-01 books to \`2631\` (6%), food delivered before that books to \`2621\` (12%), regardless of when the invoice was issued. For continuous or subscription food supplies (e.g. a weekly grocery box), the trigger point is the date when each individual delivery's skattskyldighet inträder — confirm against ML 1 kap 3 § rather than assuming the rule equals a single delivery date.
- The classic edge case: food delivered in March, invoiced in April. Without an explicit \`delivery_date\` the engine falls back to \`invoice_date\` and would mis-book at 6%. **Set \`delivery_date\` for every food-line item in March-April 2026 invoices** — the cost of explicit data is zero; the cost of a mis-booked verifikation is a manual rectification + a momsdeklaration adjustment.
- When \`delivery_date\` is omitted, the engine uses \`invoice_date\` as the fallback supply date. This is correct for **one-off** service supplies where delivery and invoice coincide; long-running service contracts (subscriptions, ongoing maintenance) have per-delprestation skattskyldighet under ML 1 kap 3 § and require an explicit \`delivery_date\` per billing cycle. Goods that straddle the cutover always need an explicit \`delivery_date\`.

The VAT declaration for April 2026 onwards will show split balances on rutor 11/12: pre-2026-04-01 food sales remain on ruta 11 (12%), post-cutover food sales appear on ruta 12 (6%). The reconciliation block surfaces both; warnings flag any post-cutover transaction still booked at 12%.

## 4. Pre-flight: voucher gaps

BFNAR 2013:2 kap 6–7 §§ requires every voucher gap to have a documented explanation. Skatteverket may ask why \`F-2026-0042\` exists when no \`F-2026-0041\` is on the books. Check before declaring:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/compliance/check?type=voucher_gaps&period=2026-04" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

If gaps exist, file an explanation via \`POST /voucher-gap-explanations\` BEFORE submitting the declaration — gaps without explanations are a compliance audit finding.

## 5. Pre-flight: locked period

The declaration is computed from posted entries in the period. If the period is still open and you have draft entries that should be in this declaration, commit them before declaring. After declaring, lock the period:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/fiscal-periods/$PERIOD_ID/lock" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Locking is reversible (via \`PATCH /fiscal-periods/{id}\` with a clear reason in the audit log). Closing the period is irreversible per BFL 5 kap 8 §; only close after the declaration is submitted AND any audit-period grace window has passed.

## 6. Manual submission to Skatteverket

v1 does not submit the declaration. The receipt-quality JSON above is what you transcribe into Skatteverket Mina Sidor (or feed into your own Skatteverket-integration tooling, gated by BankID — handled by the optional \`skatteverket\` extension, not the public REST API).

For audit-trail completeness, capture the submission confirmation number from Skatteverket and store it on the period via \`PATCH /fiscal-periods/{id}\`:

\`\`\`bash
curl -X PATCH "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/fiscal-periods/$PERIOD_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "submission_reference": "SKV-2026-04-AB123456" }'
\`\`\`

## EU and reverse-charge handling

Sales of services to other EU businesses (\`vat_treatment: 'reverse_charge_eu'\`) appear on ruta 39 and bypass the output-moms accounts (no entry on 26xx). The customer accounts for moms in their own country.

Purchases of services from other EU businesses (supplier_invoice with \`vat_treatment: 'reverse_charge_eu'\`) appear on ruta 31. The engine books both an output-moms entry on 2614 (calculated 25% reverse) AND an input-moms entry on 2645 — net zero impact on cash flow when full avdragsrätt applies, full traceability on the declaration. **For blandad verksamhet (mixed-activity companies with partial avdragsrätt per HFD 2023 ref. 45),** the \`2645\` leg must be proportionally restricted before it reaches ruta 48 — set \`company_settings.vat_deduction_percent\` so the engine applies the correct restriction automatically; otherwise the input-moms reaches ruta 48 unrestricted and over-declares the deduction.

Imports from outside EU (\`vat_treatment: 'import'\`) book through a customs-clearance flow — the customs invoice is what posts the moms, not the supplier invoice itself. Coverage of this is in the [Supplier invoices reference](/docs/api/reference/supplier-invoices).

## Common pitfalls

- **Decimals vs hela kronor — truncate öre, do not round.** The API returns rutor as decimal numbers (öre preserved). Skatteverket Mina Sidor and SRU filings accept only hela kronor; the rule per SFL 22 kap 1 § is **truncation** (drop öre), NOT half-up rounding. Use \`Math.floor\` for positive amounts when transcribing. Truncate at the rendering / submission boundary, not in storage.
- **Don't compute mid-month.** The figures are only meaningful for a complete month; calling \`?period=2026-04\` mid-April returns the partial state. The endpoint doesn't refuse partial periods, so this is on the integrator.
- **Mixed-rate invoices.** A single invoice with both 25% and 12% items lands on both \`2611\` and \`2621\`. The declaration handles this correctly because the per-line VAT rate is preserved in the engine; integrations that flatten to a single header rate will mis-declare.
- **Reverse-charge invoices in the wrong ruta.** A B2B sale to an EU customer with a missing/unvalidated VAT number does NOT qualify for reverse charge — those go to ruta 05 with normal 25% moms. Validate via \`POST /vat/validate\` (VIES) before issuing the invoice.

## Next steps

- **[Year-end closing](/docs/api/cookbook/year-end-closing)** — once all 12 monthly declarations are filed, close the fiscal year.
- **[Run payroll](/docs/api/cookbook/run-payroll-and-agi)** — moms and AGI are independent; both need to be filed monthly.
- **[Reports reference](/docs/api/reference/reports)** — every report, every parameter.
`
