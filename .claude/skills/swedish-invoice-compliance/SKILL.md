---
name: swedish-invoice-compliance
description: "Swedish invoice compliance (fakturering) reference. Covers mandatory invoice fields per ML 17 kap 24§ (2023:200), förenklad faktura, kreditfaktura/ändringsfaktura, självfakturering, Peppol BIS 3.0 e-faktura for B2G/B2B, ROT/RUT-avdrag invoicing with fakturamodellen and BAS accounts (1513, 3740), reverse charge notation per scenario (byggtjänster, EU, electronics), currency/VAT conversion, OCR/Bankgirot, autogiro, skattetillägg, and BAS mapping for AR/revenue/VAT/bad debts. Trigger on ANY Swedish invoice question, faktura validation, kreditfaktura, självfakturering, Peppol, e-faktura, ROT/RUT fakturering, omvänd betalningsskyldighet, faktureringsvaluta, OCR-nummer, ML 17 kap, fakturamodellen, or creating/validating/booking Swedish invoices. Always use over training data -- ML 2023:200 replaced ML 1994:200 on 1 July 2023, moving invoice rules from old Chapter 11 to Chapter 17."
---

# Swedish Invoice Compliance (Fakturering)

## Critical: ML chapter renumbering

**Invoicing rules moved from Chapter 11 (ML 1994:200) to Chapter 17 (ML 2023:200) on 1 July 2023.**
Every legacy reference to "ML 11 kap" maps to ML 17 kap in current law. Always cite ML (2023:200).

## How to use this skill

This SKILL.md contains the decision logic, quick-reference tables, and common error patterns.
For deep detail on any topic, read the corresponding section in:

→ `references/invoice-rules.md`: Full reference (~600 lines) with all law paragraphs, BAS accounts, Peppol field mappings, ROT/RUT thresholds, reverse charge scenarios, currency conversion rules, OCR format specs, and penalty rates.

**Table of contents for references/invoice-rules.md:**
1. Mandatory invoice fields (ML 17 kap 24§): 16 required fields table
2. Förenklad faktura: SEK 4,000 threshold, SKVFS 2024:16
3. Time limits for issuing invoices
4. Electronic vs paper equivalence
5. Kreditfaktura / ändringsfaktura: ML 17 kap 22-23§, BAS entries
6. Självfakturering: ML 17 kap 15§, three conditions
7. Peppol / e-faktura: Lag 2018:1277, BIS 3.0 format, ML→UBL mapping, SE-R rules
8. ROT/RUT invoicing: fakturamodellen, deduction rates 2024-2026, BAS 1513
9. Reverse charge notation: all scenarios with ML refs and momsdeklaration boxes
10. Currency handling: ML 8 kap 21-23§, exchange rate sources, BAS 3960/7960
11. OCR / Bankgirot: format, Luhn check digit, control levels
12. Autogiro: mandate process, repayment rights
13. Penalties: skattetillägg rates, denied deductions, bokföringsbrott
14. BAS kontoplan mapping: AR, revenue, VAT, bad debts, fees, rounding

---

## Quick decision trees

### Is this invoice valid?

```
1. Has fakturadatum?                          → ML 17:24 p.1
2. Has unique löpnummer from a series?        → ML 17:24 p.2
3. Seller's momsreg.nr (SE+10+01)?            → ML 17:24 p.3
4. Buyer's momsreg.nr (if RC or intra-EU)?    → ML 17:24 p.4
5. Full name+address, both parties?            → ML 17:24 p.5
6. Description: quantity+nature of goods/svc?  → ML 17:24 p.6
7. Delivery date (if ≠ invoice date)?          → ML 17:24 p.7
8. Tax base per rate, unit price excl VAT?     → ML 17:24 p.8
9. VAT rate stated (25/12/6%)?                 → ML 17:24 p.9
10. VAT amount in SEK?                         → ML 17:24 p.10
11. Special notations where required?
    - Reverse charge → "Omvänd betalningsskyldighet"
    - Self-billing   → "Självfakturering"
    - Exempt         → ML/Directive reference
    - Margin scheme  → Scheme notation
```

Missing any of 1-10 = non-compliant. Missing 11 when applicable = non-compliant.

### Can a simplified invoice be used?

```
Total incl. VAT ≤ SEK 4,000?
  AND NOT intra-EU / distance sale / cross-border RC?
    → Yes: förenklad faktura per ML 17:26-28, SKVFS 2024:16
    → No:  full invoice required
```

### Which reverse charge scenario?

```
Domestic byggtjänster?
  → ML 16:13, seller Box 41, buyer Box 24/30/48, accounts 3231/2614/2647

EU services (B2B main rule)?
  → ML 16:6 + 6:33-37, buyer Box 21/30-32/48, accounts 4545/2614/2645

Intra-EU goods?
  → ML 10:42, buyer Box 20/30-32/48, accounts 4535/2614/2645

Electronics >100k SEK/invoice?
  → ML 16:17, same treatment as byggtjänster
```

### ROT or RUT invoice?

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

### Credit note checklist

```
1. Own unique fakturanummer + fakturadatum?      → Required
2. Reference to original invoice number?         → Required (ML 17:22-23)
3. Negative amounts with VAT per original rate?  → Required
4. "Er tillgodo" instead of "Att betala"?        → Convention
5. Seller reduces utgående moms this period?     → Required
6. Buyer reduces ingående moms this period?      → Required
```

---

## Common error patterns (high-frequency in Accounted validation)

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
| VAT amount only, no tax base per rate | Incomplete per ML 17:24 p.8 | Show beskattningsunderlag per skattesats |
| Self-billing without "Självfakturering" text | Invoice invalid per ML 17:15 | Add notation |

---

## BAS account quick reference

### Accounts receivable
- **1510** Kundfordringar (main)
- **1513** Kundfordringar, delad faktura (ROT/RUT SKV portion)
- **1515** Osäkra kundfordringar
- **1519** Nedskrivning av kundfordringar (contra)

### Revenue
- **3001/3002/3003/3004** Domestic sales 25%/12%/6%/exempt
- **3105** Export goods, **3108** EU goods
- **3231** Byggsektorn omvänd betalningsskyldighet
- **3305** Export services, **3308** EU services

### VAT
- **2610-2615** Utgående moms 25% (domestic/RC/import)
- **2620-2624** Utgående moms 12%
- **2630-2634** Utgående moms 6%
- **2640** Ingående moms, **2645** Beräknad ingående moms utlandet
- **2647** Ingående moms omvänd betalningsskyldighet Sverige

### Currency differences
- **3960** Valutakursvinster rörelsefordringar/-skulder
- **7960** Valutakursförluster rörelsefordringar/-skulder

### Invoice extras
- **3540** Faktureringsavgift (25% VAT)
- **3740** Öresavrundning (no VAT)
- **3930** Påminnelseavgift (no VAT)
- **8313** Dröjsmålsränta (no VAT, financial income)

---

## Peppol essentials (for Accounted e-invoice generation)

Format: UBL 2.1 XML, profile Peppol BIS Billing 3.0.
TypeCodes: **380** = invoice, **381** = credit note, **389** = self-billing.
Swedish org ID scheme: **0007** + 10-digit orgnr.
SE validation rules: SE-R-001 (VAT ID 14 chars), SE-R-005 (F-skatt text), SE-R-006 (valid rates), SE-R-009 (Bankgiro 7-8 chars).

Required header: `CustomizationID` + `ProfileID` (exact URNs in reference file).
Required: either `BuyerReference` (BT-10) or `OrderReference` (BT-13).

**B2G mandatory since April 2019.** B2B voluntary; formal inquiry launched Feb 2026, report due Nov 2027. ViDA mandates cross-border B2B e-invoicing by July 2030.

---

## Key law references

| Topic | Current law | Old law |
|---|---|---|
| Invoice content | ML 17 kap 24§ (2023:200) | ML 11 kap 8§ (1994:200) |
| Simplified invoice | ML 17 kap 26-28§ | ML 11 kap 9§ |
| Credit note | ML 17 kap 22-23§ | ML 11 kap 10§ |
| Self-billing | ML 17 kap 15§ | ML 11 kap 4§ |
| Reverse charge | ML 16 kap 6-22§§ | ML 1 kap 2§ st.4 |
| Currency conversion | ML 8 kap 21-23§ | ML 7 kap 7a§ |
| E-invoice B2G | Lag (2018:1277) | - |
| ROT/RUT | HUSFL (2009:194) 6-9§§ | - |
| Invoice archiving | BFL 7 kap | - |
| Skattetillägg | SFL 49 kap | - |

---

## Time-dependent parameters

These values change. Always verify against the reference file or search current rates:

- Förenklad faktura threshold: **SEK 4,000** (SKVFS 2024:16)
- ROT deduction %: 30% standard, 50% May-Dec 2025
- RUT deduction %: 50%
- ROT max/person/year: 50,000 SEK (75,000 in 2024 H2)
- RUT max/person/year: 75,000 SEK
- Combined max: 75,000 SEK (separated in 2024 H2)
- Electronics RC threshold: 100,000 SEK excl. VAT per invoice
- Skattetillägg VAT: 20% (periodization: 2-5%)
- Archive retention: 7 years (BFL 7 kap)