# Swedish Invoice Compliance: Decision Trees

<!-- toc -->
**Contents**

- [1. Is this invoice valid?](#1-is-this-invoice-valid)
- [2. Can a simplified invoice be used?](#2-can-a-simplified-invoice-be-used)
- [3. Which reverse charge scenario?](#3-which-reverse-charge-scenario)
- [4. ROT or RUT invoice?](#4-rot-or-rut-invoice)
- [5. Credit note checklist](#5-credit-note-checklist)
- [6. Common error patterns](#6-common-error-patterns)

<!-- /toc -->

## 1. Is this invoice valid?

```
1. Has fakturadatum?                          → ML 17:24 p.1
2. Has unique löpnummer from a series?        → ML 17:24 p.2
3. Seller's momsreg.nr (SE+10+01)?            → ML 17:24 p.3
4. Buyer's momsreg.nr (if RC or intra-EU)?    → ML 17:24 p.4
5. Seller's full name+address?                → ML 17:24 p.5
6. Buyer's full name+address?                 → ML 17:24 p.6
7. Description: quantity+nature of goods/svc? → ML 17:24 p.7
8. Delivery/prepayment date (if ≠ inv. date)? → ML 17:24 p.8
9. Tax base per rate, unit price excl VAT?    → ML 17:24 p.9
10. VAT rate stated (25/12/6%)?               → ML 17:24 p.10
11. VAT amount (also in SEK)?                 → ML 17:24 p.11, 17:29
12. Special notations where required?
    - Self-billing   → "Självfakturering"             (p.12)
    - Exempt         → ML/Directive reference         (p.13)
    - Reverse charge → "Omvänd betalningsskyldighet"  (p.14)
    - New means of transport to EU → vehicle details  (p.15)
    - Margin scheme  → "Vinstmarginalbeskattning ..." (p.16-17)
```

Missing any of 1-11 = non-compliant. Missing 12 when applicable = non-compliant.
When the buyer is liable for the VAT, p.9-11 may be omitted if the invoice instead states the tax base with reference to the p.7 details (ML 17:25).
Prepayments and a conto payments must also be invoiced (ML 17:14).

## 2. Can a simplified invoice be used?

```
Total incl. VAT ≤ SEK 4,000?
  AND NOT intra-EU / distance sale / cross-border RC?
    → Yes: förenklad faktura per ML 17:26-28, SKVFS 2024:16
    → No:  full invoice required

Seller applies the small-business VAT exemption (ML 18 kap, ≤ SEK 120,000)?
    → Förenklad faktura at any amount (ML 17:26 p.4)
    → No VAT on the invoice (ML 18:41)
    → State that the supply is VAT-exempt under ML 18:4 (ML 17:28 p.6)
```

## 3. Which reverse charge scenario?

```
Domestic byggtjänster?
  → ML 16:13, seller Box 41, buyer Box 24/30/48, accounts 3231/2614/2647

EU services (B2B main rule)?
  → ML 16:9 + 6:33, buyer Box 21/30-32/48, accounts 4535/2614/2645

Intra-EU goods?
  → ML 10:42, buyer Box 20/30-32/48, accounts 4515/2614/2645

Electronics >100k SEK/invoice?
  → ML 16:16, same treatment as byggtjänster
```

## 4. ROT or RUT invoice?

```
1. Company has F-skatt?                         → Required
2. Invoice shows arbetskostnad separately?      → Required
3. Customer personnummer on invoice?            → Required
4. ROT: fastighetsbeteckning included?          → Required
5. Skattereduktion amount calculated correctly?
   ROT: 30% of labor incl. moms (50% May-Dec 2025)
   RUT: 50% of labor incl. moms
6. Combined max per person/year:
   Standard: ROT 50k + RUT 75k, combined cap 75k
   2024 H2 temporary: ROT 75k + RUT 75k, separate caps
7. Customer paying electronically?              → Required since 2020
8. AR split: 1511 (customer) + 1513 (SKV)       → Required
```

## 5. Credit note checklist

```
1. Own unique fakturanummer + fakturadatum?      → Required
2. Reference to original invoice number?         → Required (ML 17:22-23)
3. Negative amounts with VAT per original rate?  → Required
4. "Er tillgodo" instead of "Att betala"?        → Convention
5. Seller reduces utgående moms this period?     → Required
6. Buyer reduces ingående moms this period?      → Required
```

## 6. Common error patterns

High-frequency findings in Accounted invoice validation.

| Error | Consequence | Fix |
|---|---|---|
| Missing delivery date when ≠ invoice date | Buyer's VAT deduction at risk | Always populate if dates differ |
| Löpnummer gaps or duplicates | BFL 5:6 violation, audit red flag | Enforce sequential numbering in DB |
| No "Omvänd betalningsskyldighet" text on RC invoice | Buyer cannot self-assess VAT | Add text + buyer VAT ID, charge 0% VAT |
| Seller charges VAT when RC applies | Buyer CANNOT deduct the incorrectly charged VAT | Credit note required, then reissue without VAT |
| Kreditfaktura missing reference to original | Invalid credit note per ML 17:22 | Include original löpnummer |
| ROT invoice missing fastighetsbeteckning | SKV will deny claim | Require field when ROT flag is set |
| ROT/RUT not separating labor from materials | Deduction calculated on wrong base | Separate line items: arbetskostnad vs material |
| Foreign currency invoice without SEK VAT | Non-compliant per ML 17:29 | Always show VAT amount in SEK |
| VAT amount only, no tax base per rate | Incomplete per ML 17:24 p.9 | Show beskattningsunderlag per skattesats |
| Self-billing without "Självfakturering" text | Invoice invalid per ML 17:24 p.12 (conditions in 17:15) | Add notation |
