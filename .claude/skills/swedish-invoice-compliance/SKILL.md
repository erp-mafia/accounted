---
name: swedish-invoice-compliance
description: "Swedish invoice compliance (fakturering) reference. Covers mandatory invoice fields per ML 17 kap 24§ (2023:200), förenklad faktura, kreditfaktura/ändringsfaktura, självfakturering, Peppol BIS 3.0 e-faktura for B2G/B2B, ROT/RUT-avdrag invoicing with fakturamodellen and BAS accounts (1513, 3740), reverse charge notation per scenario (byggtjänster, EU, electronics), currency/VAT conversion, OCR/Bankgirot, autogiro, skattetillägg, and BAS mapping for AR/revenue/VAT/bad debts. Trigger on ANY Swedish invoice question, faktura validation, kreditfaktura, självfakturering, Peppol, e-faktura, ROT/RUT fakturering, omvänd betalningsskyldighet, faktureringsvaluta, OCR-nummer, ML 17 kap, fakturamodellen, or creating/validating/booking Swedish invoices. Always use over training data -- ML 2023:200 replaced ML 1994:200 on 1 July 2023, moving invoice rules from old Chapter 11 to Chapter 17."
---

# Swedish Invoice Compliance (Fakturering)

**Invoicing rules moved from Chapter 11 (ML 1994:200) to Chapter 17 (ML 2023:200) on 1 July 2023.** Every legacy reference to "ML 11 kap" maps to ML 17 kap in current law. Always cite ML (2023:200). Account numbers follow **BAS 2026**.

## How to use this skill

| File | When to read |
|---|---|
| `references/decision-trees.md` | Validating or building one invoice: the 17-point ML 17:24 check, whether a förenklad faktura is allowed, which reverse charge scenario applies, ROT/RUT requirements, the credit note checklist, and the common error patterns with their fixes |
| `references/invoice-rules.md` | The rules behind those trees, in 16 numbered sections: mandatory fields, förenklad faktura, time limits, kreditfaktura, självfakturering, Peppol BIS 3.0 and the ML→UBL mapping, ROT/RUT, reverse charge, currency, OCR, autogiro, penalties, BAS mapping, law references, time-dependent parameters |

## Is this invoice valid?

Walk **ML 17 kap 24§** in order. Points 1-11 are always required:

fakturadatum (p.1), unique löpnummer from a series (p.2), seller's and buyer's momsreg.nr (p.3-4, the buyer's only when reverse charge or intra-EU), both parties' name and address (p.5-6), quantity and nature of the goods or services (p.7), delivery or prepayment date when it differs from the invoice date (p.8), beskattningsunderlag per skattesats and unit price excl. VAT (p.9), the VAT rate (p.10), the VAT amount and also in SEK (p.11, 17:29).

Point 12 adds the notation the case calls for: "Självfakturering", an exemption reference, "Omvänd betalningsskyldighet", new-means-of-transport details, or a margin scheme statement.

Missing any of 1-11 = non-compliant. Missing 12 when applicable = non-compliant. Prepayments and a conto payments must also be invoiced (ML 17:14).

The full tree, and the simplified-invoice, reverse-charge, ROT/RUT and credit note trees, are in `references/decision-trees.md`.

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| The ROT percentage for a job | 30 % is standard, but 50 % applied 12 May-31 Dec 2025 and the 2024 H2 caps were separated | Take the payment date, then read the rates table in `invoice-rules.md` §8 |
| Whether the buyer accounts for the VAT | Charging VAT when reverse charge applies leaves the buyer unable to deduct it | Settle the scenario first (`decision-trees.md` §3), then charge 0 % and add the notation |
| Which account a reverse charge posts to | Domestic and foreign acquisitions use different input VAT accounts (2647 vs 2645) | Read the account table in `invoice-rules.md` §9 |
| Whether a customer has ROT/RUT room left | The cap is per person per year across all suppliers, and Skatteverket pays short | Ask the customer, and expect part payments |
| The status of a B2B e-invoicing mandate | B2G is mandatory since April 2019; no domestic B2B mandate has been decided | Read the timeline in `invoice-rules.md` §7 before stating any date |
| An invoice in foreign currency | The rate source and the taxable-event date are both prescribed | Read `invoice-rules.md` §10; always show the VAT amount in SEK |

## Peppol e-invoices in Accounted

Accounted sends Peppol BIS Billing 3 e-invoices from the invoice page in the dashboard (`POST /api/invoices/{id}/peppol/send`, Access Point: Qvalia). Sending is gated per company: access is requested under Inställningar > Fakturering (Settings > Invoicing) and enabled by Accounted's operators; a grant may carry a send cap, and when it is used up the dashboard says so and support raises it. Restrictions: aktiebolag senders only (enskild firma needs a GLN, not yet supported), standard invoices only (no credit notes, no self-billing), Swedish org-number buyers (scheme 0007; a buyer whose org number is a personnummer, i.e. an enskild firma customer, is refused until GLN identifiers are supported), SEK invoices with taxable Swedish VAT at 6, 12 or 25 % only (no reverse charge, no VAT-exempt sales, no ROT/RUT deductions), and Er referens (BuyerReference) set. Agents send with `gnubok_send_invoice_peppol` (staged, a person approves; check `gnubok_get_invoice_peppol_readiness` first) or v1 `POST /api/v1/companies/{companyId}/invoices/{id}/send-peppol`, under the same grant and restrictions. Never describe Peppol sending as absent; it is gated per company. A successful dashboard Peppol send issues the invoice itself, so do not mark it as sent afterwards. If the dashboard reports that the invoice was sent via Peppol but could not be marked as sent, complete the issuance with `gnubok_mark_invoice_as_sent` on the still-draft invoice (if it already shows as sent, the verifikat exists and only its link to the invoice needs repair: do not mark it as sent again, leave the repair to support). Where access is not granted, or the sender is an enskild firma, use an external e-invoice provider for delivery, then record the delivery with `gnubok_mark_invoice_as_sent`.

Peppol format, identifiers, SE-R validation rules and the ML to UBL mapping: `references/invoice-rules.md` §7.

## Related skills

| Question | Skill |
|---|---|
| VAT rates, rutor, reverse charge and EU trade in depth | `swedish-vat` |
| Byggmoms, ROT in a construction context, ÄTA | `vertical/bygg-hantverk` |
| Distance selling, OSS/IOSS, marketplaces | `vertical/e-handel` |
| Verifikationer, archiving, bookkeeping duty | `swedish-accounting-compliance` |
| Exporting or importing the invoice ledger | `swedish-sie-import-export` |
| Kundfordringar at year end, bad debt provisions | `swedish-year-end-closing` |
| Invoicing against project progress | `swedish-project-accounting` |
