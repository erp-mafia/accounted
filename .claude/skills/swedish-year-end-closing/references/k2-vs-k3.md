# K2 vs K3: Implementation Differences for Year-End Closing

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
- **1260** Leasade tillgångar [Ej K2]
- **1269** Ack. avskrivningar [Ej K2]

**K2**: All leases treated as operational.

## Income statement format

**K2**: Kostnadsslagsindelad only.
**K3**: Both kostnadsslagsindelad and funktionsindelad allowed.

## Depreciation simplifications

**K2**: May always set inventarier useful life to 5 years. May use tax depreciation rates directly for buildings, potentially avoiding separate bokslutsdispositioner for överavskrivningar.

**K3**: Individually assessed useful lives and residual values required for every asset.

## Accrual threshold

**K2**: Individual recurring costs below 5,000 SEK (not fluctuating >20%) need not be accrued (except personnel costs).

**K3**: No blanket threshold. Individual materiality assessment.

## Notes requirements

**K2**: Simplified, template-based. Sufficient to state framework applied, depreciation periods, employees, pledges, contingencies.

**K3**: Extensive: deferred tax analysis, critical judgments, estimation uncertainty, component depreciation details, segment reporting (if applicable).

## Accounts to hide/disable in K2 mode

The following BAS accounts are marked [Ej K2] and should be hidden or disabled:
- **1010-1019** (Utvecklingsutgifter)
- **1081** (Pågående projekt, immateriella)
- **1260** (Leasade tillgångar)
- **1269** (Ack. avskrivningar leasade tillgångar)
- **1370** (Uppskjuten skattefordran)
- **2240** (Avsättningar för uppskjutna skatter)
- **8940** (Uppskjuten skatt)

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
| Accrual threshold | 5,000 SEK | No threshold |
| Notes | Simplified | Extensive |