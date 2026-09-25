# K2 vs K3: Implementation Differences for Year-End Closing

<!-- toc -->
**Contents**

- [Component depreciation](#component-depreciation)
- [Deferred tax (uppskjuten skatt)](#deferred-tax-uppskjuten-skatt)
- [Internally developed intangible assets](#internally-developed-intangible-assets)
- [Fair value measurement](#fair-value-measurement)
- [Leasing classification](#leasing-classification)
- [Income statement format](#income-statement-format)
- [Depreciation simplifications](#depreciation-simplifications)
- [Accrual threshold](#accrual-threshold)
- [Notes requirements](#notes-requirements)
- [Accounts to hide/disable in K2 mode](#accounts-to-hidedisable-in-k2-mode)
- [K2 changes from BFNAR 2025:2 (FY beginning after 2025-12-31)](#k2-changes-from-bfnar-20252-fy-beginning-after-2025-12-31)
- [Summary table](#summary-table)

<!-- /toc -->

## Component depreciation

**K3**: Mandatory. Assets with significant components having materially different useful lives must be split and depreciated separately. Buildings decomposed into roof, HVAC, facade, frame, etc. Software must support multiple components per asset with independent useful lives, residual values, and schedules.

**K2**: Forbidden. Each asset treated as single unit.

## Deferred tax (uppskjuten skatt)

**K3**: Required using balance sheet approach on all temporary differences.
- **1370** Uppskjuten skattefordran
- **2240** Avsättningar för uppskjutna skatter
- **8940** Uppskjuten skatt
- All marked **[Ej K2]** in BAS kontoplan
- Obeskattade reserver analytically split: 79.4% equity / 20.6% latent skatteskuld

**K2**: Never recognized. These accounts must be hidden/disabled.

## Internally developed intangible assets

**K3**: May be capitalized using **1010-1019** (Utvecklingsutgifter), also [Ej K2].

**K2**: All development costs must be expensed immediately. Only acquired intangibles may be recognized.

## Fair value measurement

**K3**: Available for certain financial instruments and investment properties.

**K2**: Only historical cost (anskaffningsvärde). Försiktighetsprincip enforced strictly.

## Leasing classification

**K3**: Distinguishes financial and operational leases. Financial leases capitalized:
- **1217** Finansiellt leasade maskiner / **1227** Finansiellt leasade inventarier [Ej K2]
- **1219** / **1229** Ackumulerade avskrivningar [Ej K2] (BAS 2026 has no 1269; 1260 is a free account)

**K2**: All leases treated as operational.

## Income statement format

**K2**: Kostnadsslagsindelad only.
**K3**: Both kostnadsslagsindelad and funktionsindelad allowed.

## Depreciation simplifications

**K2**: May always set inventarier useful life to 5 years. May use tax depreciation rates directly for buildings, potentially avoiding separate bokslutsdispositioner for överavskrivningar.

**K3**: Individually assessed useful lives and residual values required for every asset.

## Accrual threshold

**K2** (FY beginning after 2025-12-31, BFNAR 2025:2) has separate rules:
- **2.4**: inkomster and utgifter each below **7,000 SEK** (5,000 SEK for FY beginning before 2026-01-01) need not be accrued. Income and costs, tested per invoice/avtal, not on the accrual amount.
- **2.4A**: received or paid förskott below 7,000 SEK may go directly to income/cost.
- **7.9**: recurring costs of the same kind (not personnel costs) that vary at most 20% between years, with one annual cost per year, may be expensed when invoiced. No amount limit.
- **2.4B**: none of these may be used to the extent the combined effect is material.

**K3**: No blanket threshold. Individual materiality assessment.

## Notes requirements

**K2**: Simplified, template-based. Sufficient to state framework applied, depreciation periods, employees, pledges, contingencies.

**K3**: Extensive: deferred tax analysis, critical judgments, estimation uncertainty, component depreciation details, segment reporting (if applicable).

## Accounts to hide/disable in K2 mode

The following BAS accounts are marked [Ej K2] and should be hidden or disabled:
- **1010-1019** (Utvecklingsutgifter)
- **1081** (Pågående projekt, immateriella)
- **1217** / **1227** (Finansiellt leasade maskiner respektive inventarier)
- **1219** / **1229** (Ackumulerade avskrivningar)
- **1370** (Uppskjuten skattefordran)
- **2240** (Avsättningar för uppskjutna skatter)
- **8940** (Uppskjuten skatt)

The list above follows BAS 2025. **BAS 2026** marks these accounts with # (not for K2): 1010-1019, 1370, 1518, 2089, 2092, 2096, 2240, 2448, 3940, 7940, 8290-8295, 8320-8325, 8417, 8450-8455, 8480, 8940. In BAS 2026, 1260/1269 are free accounts (finansiellt leasade tillgångar: 1217/1227) and 1081 has no # mark.

## K2 changes from BFNAR 2025:2 (FY beginning after 2025-12-31)

- **Scope (1.1A-1.1C)**: bostadsrättsföreningar and bostadsföreningar may not use K2 regardless of size (1.1A e). Also excluded (1.1A f-i): companies with foreign filialer, companies that acquired goods or services against aktierelaterade ersättningar, companies with issued skuldebrev that can be settled with egetkapitalinstrument or similar sammansatta finansiella instrument (e.g. convertibles), and companies holding kryptotillgångar (occasional use as payment excepted). 1.1B excludes companies with a material uppskjuten skatteskuld and companies whose buildings generate at least 75% of nettoomsättningen, but 1.1C lifts 1.1B for companies that exceed at most one of: >3 employees, >1.5 MSEK balansomslutning, >3 MSEK nettoomsättning (each of the last two years), and for companies that applied K2 the previous year and are not normally covered by 1.1B.
- **Accruals**: 7,000 SEK limit (2.4, 2.4A) and aggregate materiality (2.4B), see above.
- **Balance sheet**: new post *Övriga immateriella anläggningstillgångar* (acquired tomträtter); *Kontokredit* replaces *Checkräkningskredit*.
- **Tilläggsköpeskilling** on sale of inkråm (6.32A) or shares (8.4B): income in the year the amount is fixed.
- **Kapitalförsäkring**: on a withdrawal, the part corresponding to the policy's increase in value is income (8.4C); the carrying amount is reduced only by the part of the withdrawal that takes the policy's value below the carrying amount (11.13A).
- **Rent and leasing price reductions** received because use of the object is restricted: recognised in the period the restriction relates to (7.10).
- **Error correction (2.12)**: correct in the next årsredovisning by restating the opening balance of assets, liabilities and equity; alternatively the effect may be taken to the income statement (or the balance sheet if only balance-sheet items are affected).
- **Pågående arbete, alternativregeln (6.24)**: balance per contract; positive balances are an asset, negative balances a liability. Under huvudregeln and löpande räkning, asset and liability balances may be netted only for contracts with the same customer relating to the same periods.
- A company that must leave K2 because of the new exclusions may apply K3 chapter 35 (first-time adoption) without the 35.1 restriction (BFNAR 2025:3, transition rule 2).

**K3 (BFNAR 2025:3/2025:4)**: same effective date. Bostadsrättsföreningar apply K3 with the new chapter 38 (supplementary rules, mainly förvaltningsberättelse disclosures).

**Årsbokslut (BFNAR 2017:3 as amended by BFNAR 2026:1)**: brings e.g. the 7,000 SEK accrual limit (2.4/2.4A) to årsbokslut. Applies to FY beginning after 2026-12-31; may be applied earlier to a FY that ends 2026-12-31 or later.

## Summary table

| Feature | K2 | K3 |
|---------|-----|-----|
| Component depreciation | Forbidden | Mandatory |
| Deferred tax | Forbidden | Required |
| Capitalize dev costs | Forbidden | Allowed |
| Fair value | Forbidden | Allowed |
| Financial leases | Not recognized | Capitalized |
| RR format | Kostnadsslagsindelad only | Both |
| Depreciation | Schablonmässig OK | Individual assessment |
| Accrual threshold | 7,000 SEK per item (2.4/2.4A; 5,000 SEK before 2026) + 7.9 recurring costs, capped by 2.4B | No threshold |
| Notes | Simplified | Extensive |