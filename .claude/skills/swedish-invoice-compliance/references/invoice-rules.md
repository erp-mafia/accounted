# Swedish Invoice Compliance: Full Reference

<!-- toc -->
**Contents**

- [1. Mandatory invoice fields (ML 17 kap 24§)](#1-mandatory-invoice-fields-ml-17-kap-24)
- [2. Förenklad faktura (simplified invoice)](#2-förenklad-faktura-simplified-invoice)
- [3. Time limits for issuing invoices](#3-time-limits-for-issuing-invoices)
- [4. Electronic vs paper equivalence](#4-electronic-vs-paper-equivalence)
- [5. Kreditfaktura / ändringsfaktura](#5-kreditfaktura--ändringsfaktura)
- [6. Självfakturering (self-billing)](#6-självfakturering-self-billing)
- [7. Peppol / e-faktura](#7-peppol--e-faktura)
- [8. ROT/RUT invoicing](#8-rotrut-invoicing)
- [9. Reverse charge notation](#9-reverse-charge-notation)
- [10. Currency handling](#10-currency-handling)
- [11. OCR / Bankgirot](#11-ocr--bankgirot)
- [12. Autogiro](#12-autogiro)
- [13. Penalties](#13-penalties)
- [14. BAS kontoplan mapping](#14-bas-kontoplan-mapping)
- [15. Key law references](#15-key-law-references)
- [16. Time-dependent parameters](#16-time-dependent-parameters)

<!-- /toc -->

## 1. Mandatory invoice fields (ML 17 kap 24§)

A fullständig faktura must contain all fields per **17 kap 24§ ML (2023:200)**, implementing EU VAT Directive Article 226.

| # | Field (Swedish) | Field (English) | ML ref |
|---|---|---|---|
| 1 | Fakturadatum | Invoice issue date | 17:24 p.1 |
| 2 | Löpnummer (unique sequential from one or more series) | Invoice number | 17:24 p.2 |
| 3 | Säljarens momsregistreringsnummer (SE + 10 digits + 01) | Seller VAT ID | 17:24 p.3 |
| 4 | Köparens momsregistreringsnummer (when RC or intra-EU) | Buyer VAT ID | 17:24 p.4 |
| 5 | Säljarens fullständiga namn och adress | Seller name and address | 17:24 p.5 |
| 6 | Köparens fullständiga namn och adress | Buyer name and address | 17:24 p.6 |
| 7 | Varornas mängd och art / tjänsternas omfattning och art | Quantity and nature | 17:24 p.7 |
| 8 | Leveransdatum/tillhandahållandedatum, or date of förskotts-/a conto-betalning (if ≠ invoice date) | Delivery or prepayment date | 17:24 p.8 |
| 9 | Beskattningsunderlag per skattesats eller undantag, enhetspris exkl. moms, rabatter | Tax base per rate | 17:24 p.9 |
| 10 | Mervärdesskattesats (25%, 12%, or 6%) | VAT rate | 17:24 p.10 |
| 11 | Mervärdesskattebelopp | VAT amount | 17:24 p.11 |
| 12 | "Självfakturering" (if self-billing) | Self-billing text | 17:24 p.12 |
| 13 | ML/Directive reference or other statement (if VAT-exempt) | Exemption ref | 17:24 p.13 |
| 14 | "Omvänd betalningsskyldighet" (if reverse charge) | RC notation | 17:24 p.14 |
| 15 | Transport media details (new means of transport to another EU country) | Vehicle specifics | 17:24 p.15 |
| 16 | "Vinstmarginalbeskattning för resebyråer" | Travel agency margin scheme | 17:24 p.16 |
| 17 | "Vinstmarginalbeskattning för begagnade varor / konstverk / samlarföremål och antikviteter" | Second-hand margin scheme | 17:24 p.17 |

**Förskotts- och a conto-betalningar:** must be invoiced too (17 kap 14§); the payment date goes in p.8.

**Reverse charge:** p.9-11 may be omitted if the invoice instead states the tax base with reference to the p.7 details (17 kap 25§).

**Löpnummerserie:** Must enable detection of missing invoices. Multiple series permitted (per unit, POS, etc.). Also required by BFL 5 kap 6§. Gaps or duplicates are a compliance red flag.

## 2. Förenklad faktura (simplified invoice)

**ML 17 kap 26-28§**, **SKVFS 2024:16**.

Threshold: total **≤ SEK 4,000 including VAT**.

Also permitted when trade/technical conditions make full invoicing impractical (vending machines, fuel pumps, parking meters).

Reduced content: date, seller ID (VAT/org number), description of goods/services, VAT amount or data to calculate it.

**Cannot** be used for: intra-EU transactions, distance sales, cross-border reverse charge.

**Small-business VAT exemption (18 kap ML, from 1 January 2025):** A seller covered by the exemption may issue a förenklad faktura at any amount (17 kap 26§ p.4). The invoice must not show VAT (18 kap 41§) and must state that the supply is exempt under 18 kap 4§ (17 kap 28§ p.6).

## 3. Time limits for issuing invoices

- Domestic: no hard statutory deadline; "without undue delay" per god affärssed.
- Intra-EU goods/services (main rule): **15th of month following delivery/performance** (17 kap 17-18§§).
- Construction services: **end of second month after performance** (17 kap 16§).

## 4. Electronic vs paper equivalence

Electronic invoices = identical legal standing (2 kap 9-10§ ML). E-invoicing requires buyer consent (17 kap 20§). PDF by email is a legal faktura but not a structured e-faktura. Archive for **7 years** (BFL 7 kap). Since July 2024, paper originals may be destroyed immediately after digital transfer (amended 7 kap 6§ BFL).

No specific language requirement in ML. VAT amounts must be in SEK if accounting currency is SEK. Skatteverket may request translations.

## 5. Kreditfaktura / ändringsfaktura

Term in ML (2023:200): **ändringsfaktura**. Business terms "kreditfaktura" and "kreditnota" remain in use.

### When to issue

Incorrect original, goods returned, price reduction post-invoicing, partial/full cancellation, erroneous VAT correction.

### Governing law

**17 kap 22-23§ ML (2023:200)**.

### Mandatory content

1. The specific change to the original invoice
2. Specific and unambiguous reference to the original invoice (typically löpnummer)
3. What has been changed
4. Own unique fakturanummer and fakturadatum
5. Amounts shown as negative values
6. VAT specified per momssats from the original

Notation: "Er tillgodo" replaces "Att betala".

When citing specific original is impractical (volume rebates): customer number + date range + description is accepted.

### Partial credits

Fully permitted. Must specify which items credited, partial negative amount, proportional VAT per skattesats.

### VAT adjustment mechanics

Seller reduces utgående moms in the credit note period. Buyer must reduce ingående moms in the same period. For felaktigt debiterad mervärdesskatt, a valid kreditfaktura is a prerequisite before seller can adjust VAT return.

### BAS journal entries

**Seller issuing credit note (25% example):**

| Account | Debit | Credit |
|---|---|---|
| 3011 Försäljning tjänster 25% | X | |
| 2611 Utgående moms 25% | X | |
| 1510 Kundfordringar | | X |

12%: 3002/2621. 6%: 3003/2631. Mirror reversal of original.

**Buyer receiving credit note:**
Debit 2440 Leverantörsskulder, Credit purchase account (40xx), Credit 2641 Ingående moms.

## 6. Självfakturering (self-billing)

**ML 17 kap 15§** (old 11 kap 4§).

### Three cumulative conditions

1. **Pre-existing agreement (avtal i förväg).** Written recommended, oral technically sufficient. Should specify scope, transactions, format, approval, duration, termination.
2. **Approval procedure (godkännandeförfarande).** Passive approval accepted: silence within agreed timeframe = approval, provided seller can review and object.
3. **"Självfakturering" notation** on every invoice.

Seller remains responsible for VAT reporting. Both parties archive 7 years per BFL 7 kap 2§.

Peppol: `InvoiceTypeCode` **389**.

## 7. Peppol / e-faktura

### Legal framework

**Lag (2018:1277) om elektroniska fakturor till följd av offentlig upphandling** transposed EU Directive 2014/55/EU. Mandatory for B2G since **1 April 2019**. Format: **EN 16931**, Swedish implementation = **Peppol BIS Billing 3.0**. DIGG is Sweden's Peppol Authority. Over 95% of Swedish public entities registered.

**MDFFS 2019:1** mandates public entities to register as Peppol receivers. SFTI phased out EDIFACT ESAP 6 from recommended formats (July 2025).

### BIS Billing 3.0 format

UBL 2.1 XML. Current version: 3.0.20.

TypeCodes: **380** = invoice, **381** = credit note, **389** = self-billing.

Required identification strings:
```xml
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
```

Mandatory header: `cbc:ID`, `cbc:IssueDate`, `cbc:InvoiceTypeCode` (380/381/389), `cbc:DocumentCurrencyCode`, `cac:AccountingSupplierParty`, `cac:AccountingCustomerParty`, `cac:TaxTotal`, `cac:LegalMonetaryTotal`, ≥1 `cac:InvoiceLine`. Either `BuyerReference` (BT-10) or `OrderReference` (BT-13) required.

### Sweden-specific validation rules

| Rule | Requirement |
|---|---|
| SE-R-001 | Swedish VAT numbers must be 14 characters (SE + 10 digits + 01) |
| SE-R-005 | SE sellers must include "Godkänd för F-skatt" |
| SE-R-006 | Valid VAT rates for SE sellers: 6%, 12%, 25% with category S |
| SE-R-009 | Bankgiro Account ID: 7-8 characters |
| SE-R-011 | Bankgiro uses PaymentMeansCode=30 |
| SE-R-012 | Plusgiro uses PaymentMeansCode=30 |

### Identifiers

Swedish orgs: prefix **0007** + 10-digit organisationsnummer (e.g., `0007:5567321707`).
GLN: prefix **0088** + 13 digits.
VAT in UBL: `cac:PartyTaxScheme/cbc:CompanyID` = `SE556732170701`.

### ML 17 kap → Peppol UBL field mapping

| ML requirement | EN 16931 BT | UBL element |
|---|---|---|
| Fakturadatum | BT-2 | `cbc:IssueDate` |
| Löpnummer | BT-1 | `cbc:ID` |
| Säljarens moms-nr | BT-31 | `cac:AccountingSupplierParty/.../cbc:CompanyID` |
| Köparens moms-nr | BT-48 | `cac:AccountingCustomerParty/.../cbc:CompanyID` |
| Namn+adress (säljare) | BT-27, BT-35-39 | `cac:AccountingSupplierParty` |
| Varornas mängd+art | BT-129, BT-153 | `cac:InvoiceLine/cbc:InvoicedQuantity` + `cac:Item/cbc:Name` |
| Leveransdatum | BT-72 | `cac:InvoicePeriod/cbc:StartDate` or `cbc:TaxPointDate` (BT-7) |
| Beskattningsunderlag per skattesats | BT-116 | `cac:TaxSubtotal/cbc:TaxableAmount` |
| Momssats | BT-119 | `cac:TaxCategory/cbc:Percent` |
| Momsbelopp | BT-110 | `cac:TaxTotal/cbc:TaxAmount` |
| "Omvänd betalningsskyldighet" | BT-121 | `cbc:TaxExemptionReason` + TaxCategory code AE |
| "Självfakturering" | BT-3 | `cbc:InvoiceTypeCode` = 389 |

### B2B e-invoicing timeline

B2B voluntary as of September 2026; no domestic B2B mandate has been decided. Ministry of Finance launched formal inquiry (Dir. 2026:9) **5 February 2026**, report due **30 November 2027**. EU ViDA directive (Directive (EU) 2025/516, adopted 11 March 2025) allows member states to mandate domestic B2B e-invoicing without EU approval. ViDA timeline: single VAT registration from **1 July 2028**; platform deemed-supplier rules from 1 July 2028 at the earliest and 1 January 2030 at the latest; mandatory e-invoicing plus digital reporting for intra-EU B2B from **1 July 2030** (replaces periodisk sammanställning).

## 8. ROT/RUT invoicing

### Fakturamodellen

Company invoices full amount, shows ROT/RUT deduction, reduces "att betala." Customer pays reduced amount **electronically** (cash disqualified since 1 Jan 2020). Company applies to Skatteverket via "Rot och rut: företag." SKV pays company directly (~10 days). **F-skatt required** per HUSFL 6-9§§.

### Required invoice fields

1. Company name + F-skatt statement
2. Customer personnummer (ÅÅÅÅMMDD-XXXX)
3. Type of work performed
4. Where and when work performed
5. ROT: fastighetsbeteckning or BRF orgnr + lägenhetsnummer
6. Separate line items: arbetskostnad, materialkostnad, övriga kostnader
7. Total excl/incl moms with moms amount
8. Calculated skattereduktion amount

### Deduction rates and caps (2024-2026)

| Parameter | ROT | RUT |
|---|---|---|
| Standard % | 30% of labor incl. moms | 50% of labor incl. moms |
| Standard max/person/year | 50,000 SEK | 75,000 SEK |
| Standard combined max | 75,000 SEK (ROT capped at 50k within) | |
| 2024 H2 (Jul-Dec) | Max raised to 75k, caps separated, total possible 150k | |
| 2025 (12 May-31 Dec) | ROT % raised to **50%** (Betänkande 2024/25:FiU32) | 50% unchanged |
| 2026 | Standard 30%/50% rules resume | |

### BAS journal entries

Example: 18,000 SEK arbetskostnad = 22,500 inkl. moms (25%), ROT 30% = 6,750 SEK.

**Invoice issued:**

| Account | Debit | Credit |
|---|---|---|
| 1511 Kundfordringar (customer portion) | 23,875 | |
| 1513 Kundfordringar: delad faktura (SKV) | 6,750 | |
| 3010 Försäljning | | 24,500 |
| 2610 Utgående moms 25% | | 6,125 |

Customer pays: Debit 1930, Credit 1511.
SKV pays: Debit 1930, Credit 1513.
SKV denies: Debit 1510, Credit 1513 (re-invoice customer).

Account 1513 exists in BAS Kontoplan 1 but not Kontoplan 2. Alternative: 1600 Övriga kortfristiga fordringar.

### Application deadline

**31 January of the year following the payment year.** Payment date (not invoice or work date) determines tax year.

## 9. Reverse charge notation

### Invoice requirements

Per **17 kap 24§ punkt 14 ML**: when buyer is liable for VAT, invoice must include notation. Three accepted forms:
- Swedish: "Omvänd betalningsskyldighet"
- English: "Reverse charge"
- Reference to ML paragraph or EU Directive article

Invoice must include buyer's VAT number and charge **no VAT**.

### Scenario reference

**Domestic construction (byggtjänster): ML 16 kap 13§:**
Applies when buyer is taxable person who not only temporarily provides construction services.
Seller: Box 41. Buyer: Box 24, output VAT Box 30, input VAT Box 48.

**EU services (B2B main rule): ML 16 kap 9§ + 6 kap 33§:**
Swedish business buys services from EU seller under main rule.
Buyer: Box 21, output VAT Box 30-32, input VAT Box 48. Seller: Box 39 + periodisk sammanställning.

**Intra-EU goods: ML 10 kap 42§:**
Text: "Unionsintern leverans" or ref to Article 138 Directive 2006/112/EC. Both VAT numbers required.
Seller: Box 35 + periodisk sammanställning. Buyer: Box 20, output VAT Box 30-32, input VAT Box 48.

**Electronics >100k SEK: ML 16 kap 16§:**
Mobile phones, integrated circuits, game consoles, tablets, laptops when invoice excl. VAT > SEK 100,000. In effect since 1 April 2021.

**Other:** Scrap metal/waste (16:14), CO₂ allowances (16:15), gold (16:11-12). Full scope: 16 kap 6-17§§.

### BAS accounts for reverse charge

| Account | Purpose |
|---|---|
| 2614 | Utgående moms, omvänd betalningsskyldighet 25% |
| 2624 | Utgående moms, omvänd betalningsskyldighet 12% |
| 2634 | Utgående moms, omvänd betalningsskyldighet 6% |
| 2647 | Ingående moms omvänd betalningsskyldighet varor och tjänster i Sverige (domestic) |
| 2645 | Beräknad ingående moms på förvärv från utlandet |
| 4425 | Inköp av tjänster i Sverige, omvänd betalningsskyldighet, 25% (e.g. byggtjänster; momsdeklaration ruta 24) |
| 4515 | Inköp av råvaror och material från annat EU-land, 25% |
| 4535 | Inköp av tjänster från annat EU-land, 25% |
| 4545 | Import av råvaror och material, 25% (non-EU imports, not EU purchases) |
| 3231 | Försäljning byggsektorn, omvänd betalningsskyldighet |
| 3308 | Försäljning tjänster till annat EU-land |

## 10. Currency handling

### Rules

Invoicing in any currency is permitted. Per **ML 17 kap 29§**: VAT amount must be in the company's redovisningsvaluta. For SEK companies: VAT in **both invoice currency and SEK**.

### Exchange rate sources (ML 8 kap 21-23§)

Two permitted sources (choose one consistently):
1. Mid-rate (mittkurs) from **Nasdaq OMX Stockholm AB** (published on Riksbanken's website)
2. Latest published **ECB rate**

Rate to use: **at time of taxable event** (delivery/supply date or advance payment date, not invoice date unless same). Continuous supplies: last delivery day of invoiced period. Two non-euro currencies via ECB: route through EUR (8 kap 22§).

### Exchange rate differences

No VAT impact. VAT locked at original transaction rate. Differences are P&L items only. Revalue monetary items to balance sheet date per 4 kap 13§ ÅRL and K2/K3.

### BAS accounts

| Account | Purpose |
|---|---|
| 3960 | Valutakursvinster, rörelsefordringar/-skulder |
| 7960 | Valutakursförluster, rörelsefordringar/-skulder |
| 8230 | Valutakursdifferenser, långfristiga fordringar |
| 8330 | Valutakursdifferenser, kortfristiga fordringar/placeringar |
| 8430 | Valutakursdifferenser, skulder (long-term loans) |

Decision: customer receivables (1510) and supplier payables (2440) → 3960/7960. Financial instruments/loans → 8230/8330/8430. Per K3 Ch. 30: recognize in income statement in the period they arise.

## 11. OCR / Bankgirot

### OCR format

2-25 digit numeric reference. Last digit = check digit via **Luhn algorithm (Modulus 10)**. Recommended length: 5-15 digits. Typically encodes invoice number and/or customer number.

### Control levels

| Level | Behavior |
|---|---|
| OCR 1 | Soft: warning only |
| OCR 2 | Hard: payment rejected if wrong |
| OCR 3 | Hard + variable length control |
| OCR 4 | Hard + fixed length |

Hard control → ~100% auto-match rate. Requires bank agreement for "Bankgiro Inbetalningar" with OCR-referenskontroll. Sweden transitioning to ISO 20022 in 2026; file-initiated payments with incorrect OCR will be rejected.

## 12. Autogiro

Direct debit via Bankgirot. Business signs agreement with bank linking Bankgiro number. Customer grants **medgivande** (mandate) via BG600P/BG600F, internet bank, or BankID. Activation: up to 2 banking days.

Business submits payment files to Bankgirot. Customer right to request repayment within **8 weeks** per Betaltjänstlagen if amount unknown or unreasonably high. Business must notify customers in advance of amounts and dates.

## 13. Penalties

### Denied VAT deductions

Skatteverket can deny avdragsrätt when invoices lack mandatory fields per 17 kap 24-28§. Per EU case law (C-272/13): purely formal defects are correctable ("healable"). Material requirements (goods/services in VAT-liable business) are primary; formal are secondary but necessary. Missing VAT amount entirely → new corrected invoice required, deduction only from corrected invoice period.

### Skattetillägg (SFL 49 kap)

| Situation | Rate |
|---|---|
| Oriktig uppgift: income tax | 40% |
| Oriktig uppgift: VAT/employer contributions | 20% |
| Periodization error: income tax | 10% |
| Periodization error: VAT (≤4 months, ≤3-month periods) | 2% |
| Periodization error: VAT (annual or >4 months) | 5% |

Deducting ingående moms on non-compliant invoices: **20% skattetillägg**. Felaktigt debiterad moms: buyer gets no deduction; 20% reduced to 1/4 if seller reported and paid. Voluntary correction before investigation normally avoids skattetillägg.

### Criminal consequences

BFL: all transactions require verifikationer (5 kap 7§), archived 7 years (7 kap).
Bokföringsbrott (11 kap 5§ BrB): up to 2 years, grovt 6 months-6 years.
False invoices: skattebrott (Skattebrottslagen) up to 2 years, grovt 6 months-6 years, plus potential penningtvättsbrott.

## 14. BAS kontoplan mapping

### Accounts receivable (15xx)

| Account | Name |
|---|---|
| 1510 | Kundfordringar (main/group) |
| 1511 | Kundfordringar (sub / customer portion split) |
| 1512 | Belånade kundfordringar (factoring) |
| 1513 | Kundfordringar: delad faktura (ROT/RUT SKV) |
| 1516 | Tvistiga kundfordringar |
| 1516 | Tvistiga kundfordringar |
| 1518 | Ej reskontraförda kundfordringar |
| 1519 | Nedskrivning av kundfordringar (contra, credit balance) |

(BAS 2026 has no 1515; older charts used it for osäkra kundfordringar.)

### Revenue (30xx-34xx)

| Account | Name |
|---|---|
| 3001 | Försäljning Sverige 25% |
| 3002 | Försäljning Sverige 12% |
| 3003 | Försäljning Sverige 6% |
| 3004 | Försäljning Sverige momsfri |
| 3105 | Export varor utanför EU |
| 3108 | Varor till annat EU-land, momsfri |
| 3231 | Byggsektorn omvänd betalningsskyldighet |
| 3305 | Tjänster utanför EU |
| 3308 | Tjänster till annat EU-land |
| 3950 | Återvunna avskrivna kundfordringar |

### VAT (26xx)

| Account | Name |
|---|---|
| 2610/2611 | Utgående moms 25% |
| 2612 | Utgående moms egna uttag 25% |
| 2614 | Utgående moms omvänd skattskyldighet 25% |
| 2615 | Utgående moms import varor 25% |
| 2620/2621 | Utgående moms 12% |
| 2630/2631 | Utgående moms 6% |
| 2640 | Ingående moms (group) |
| 2645 | Beräknad ingående moms utlandet |
| 2647 | Ingående moms omvänd betalningsskyldighet Sverige |
| 2650 | Redovisningskonto moms (settlement) |

### Bad debts flow

1. Befarad förlust: Debit **6352** (befarade förluster), Credit **1519** (nedskrivning, contra to 1510). The receivable stays on 1510; move it to **1516** only if it is disputed.
2. Konstaterad förlust: Debit **6351** (konstaterade förluster) and Credit **1510**; reverse the provision Debit **1519** Credit **6352**; recover the VAT by debiting 2610/2620/2630
3. Later payment of a written-off receivable: book it back through 3950 (återvunna kundfordringar)

VAT recovery on bad debts permitted under **ML 7 kap 43§** when loss is konstaterad (bankruptcy, failed enforcement, acknowledged insolvency).

### Invoice extras

| Item | Account | VAT |
|---|---|---|
| Faktureringsavgift | 3540 | 25% VAT |
| Öresavrundning | 3740 | No VAT |
| Påminnelseavgift | No dedicated BAS 2026 account: **3540** Faktureringsavgifter or a free account in group 39 | No VAT |
| Dröjsmålsränta | 8313/8310 | No VAT (financial income) |

Påminnelseavgift (no VAT): BAS 2026 has no dedicated account: use **3540** Faktureringsavgifter or a free account in group 39.

## 15. Key law references

| Topic | Current law | Old law |
|---|---|---|
| Invoice content | ML 17 kap 24§ (2023:200) | ML 11 kap 8§ (1994:200) |
| Simplified invoice | ML 17 kap 26-28§ | ML 11 kap 9§ |
| Small-business exemption invoice | ML 18 kap 41§, 17 kap 26§ p.4, 28§ p.6 | - |
| Credit note | ML 17 kap 22-23§ | ML 11 kap 10§ |
| Self-billing | ML 17 kap 15§ | ML 11 kap 4§ |
| Reverse charge | ML 16 kap 6-17§§ | ML 1 kap 2§ st.4 |
| Currency conversion | ML 8 kap 21-23§ | ML 7 kap 7a§ |
| E-invoice B2G | Lag (2018:1277) | - |
| ROT/RUT | HUSFL (2009:194) 6-9§§ | - |
| Invoice archiving | BFL 7 kap | - |
| Skattetillägg | SFL 49 kap | - |

## 16. Time-dependent parameters

These values change. Always verify against the sections above or search current rates:

- Förenklad faktura threshold: **SEK 4,000** (SKVFS 2024:16)
- ROT deduction %: 30% standard, 50% May-Dec 2025
- RUT deduction %: 50%
- ROT max/person/year: 50,000 SEK (75,000 in 2024 H2)
- RUT max/person/year: 75,000 SEK
- Combined max: 75,000 SEK (separated in 2024 H2)
- Electronics RC threshold: 100,000 SEK excl. VAT per invoice
- Skattetillägg VAT: 20% (periodization: 2-5%)
- Archive retention: 7 years (BFL 7 kap)
