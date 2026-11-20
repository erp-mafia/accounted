# Step-by-Step Closing Process with BAS Account Numbers

The closing process (bokslutsarbete) proceeds in eight phases, each depending on prior phases.

<!-- toc -->
**Contents**

- [Phase 1: Reconciliations (avstämningar)](#phase-1-reconciliations-avstämningar)
- [Phase 2: Accruals and deferrals (periodiseringar)](#phase-2-accruals-and-deferrals-periodiseringar)
- [Phase 3: Depreciation (avskrivningar)](#phase-3-depreciation-avskrivningar)
- [Phase 4: Inventory valuation (lagervärdering)](#phase-4-inventory-valuation-lagervärdering)
- [Phase 5: Untaxed reserves (obeskattade reserver)](#phase-5-untaxed-reserves-obeskattade-reserver)
- [Phase 6: Provisions and tax (avsättningar, skatt)](#phase-6-provisions-and-tax-avsättningar-skatt)
- [Phase 7-8: Equity handling and result closing](#phase-7-8-equity-handling-and-result-closing)

<!-- /toc -->

## Phase 1: Reconciliations (avstämningar)

Every balance sheet account must be reconciled against external documentation.

| What | Account(s) | Reconcile against |
|------|-----------|-------------------|
| Bank | **1920** Plusgiro, **1930** Företagskonto | Bank statements |
| Cash | **1910** Kassa | Physical count |
| Skattekonto | **1630** Avräkning för skatter och avgifter | Skatteverket kontoutdrag |
| Moms | **2610-2650** | Declared and transferred amounts to 1630 |
| Kundfordringar | **1510** | Kundreskontra (open invoices) |
| Leverantörsskulder | **2440** | Leverantörsreskontra |
| Doubtful receivables | **1519** Nedskrivning / **6352** Befarade förluster | Assessment of collectability |

## Phase 2: Accruals and deferrals (periodiseringar)

### Interimsfordringar (assets, 17xx)

| Account | Description |
|---------|-------------|
| **1710** | Förutbetalda hyreskostnader |
| **1720** | Förutbetalda leasingavgifter |
| **1730** | Förutbetalda försäkringspremier |
| **1740** | Förutbetalda räntekostnader |
| **1750** | Upplupna hyresintäkter |
| **1760** | Upplupna ränteintäkter |
| **1790** | Övriga förutbetalda kostnader och upplupna intäkter |

### Interimsskulder (liabilities, 29xx)

| Account | Description |
|---------|-------------|
| **2910** | Upplupna löner |
| **2920** | Upplupna semesterlöner |
| **2940** | Beräknade upplupna sociala avgifter |
| **2943** | Beräknad upplupen SLP |
| **2960** | Upplupna räntekostnader |
| **2970** | Förutbetalda intäkter |
| **2991** | Beräknat arvode för bokslut |
| **2992** | Beräknat arvode för revision |
| **2990** | Övriga upplupna kostnader |

### K2 simplifications (BFNAR 2016:10 as amended by BFNAR 2025:2, FY beginning after 2025-12-31)
These are separate rules:
- **2.4**: Inkomster and utgifter that each are below **7,000 SEK** need not be accrued (5,000 SEK for FY beginning before 2026-01-01). Applies to both income and costs (including interest). The test is the amount on each invoice, avtal or similar document, not the size of the accrual; an invoice split into several invoices is summed.
- **2.4A**: A received or paid förskott for goods or services below **7,000 SEK** may be recognised directly as income or cost.
- **7.9**: The same kind of cost recurring every year (not personnel costs) may be expensed in the year the invoice normally arrives, if it can be expected to vary at most **20%** between years and each year carries one annual cost. No amount limit.
- **2.4B**: 2.4, 2.4A and 7.9 may not be applied to the extent that they, alone or together, materially affect income, costs or financial position.

K3 has no such blanket thresholds; materiality is assessed case by case.

## Phase 3: Depreciation (avskrivningar)

| Asset type | Cost account | Accumulated depreciation |
|------------|-------------|------------------------|
| Immateriella tillgångar | **7810-7819** | **1019, 1029** etc. |
| Byggnader | **7821** | **1119** |
| Markanläggningar | **7824** | **1129** |
| Maskiner | **7831** | **1219** |
| Inventarier (1220) | **7832** | **1229** |
| Bilar/transportmedel, ej för produktion (1226) | **7832** | **1229** |
| Datorer, ej för produktion (1224) | **7832** | **1229** |

BAS 2026 splits kontogrupp 12 by production use, not by asset kind: every 122x asset (1220 inventarier, 1224 datorer, 1226 bilar, 1227 finansiellt leasade inventarier) accumulates on 1229 and depreciates through 7832; a car or computer used for production sits on 1216/1214 with 1219 and 7831. 7833/7834 are not BAS accounts, and 1230, 1240/1249, 1250/1259, 1260/1269 are free accounts with no prescribed meaning. See the swedish-asset-accounting skill, references/accounts-and-registry.md.

Books still on BAS 2025 used 7833 installationer, 7834 bilar/transportmedel (1249) and 7835 datorer (1259); map these to 7831/7832 when migrating.

### K2 vs K3 depreciation
- **K2**: Schablonmässiga nyttjandeperioder allowed (5 years for inventarier, tax rates for buildings). Component depreciation FORBIDDEN.
- **K3**: Individual assessment of useful life and residual value required. **Component depreciation mandatory** for assets with significant components having different consumption patterns.

## Phase 4: Inventory valuation (lagervärdering)

Physical inventory count at balance date required. Valuation: **lägsta värdets princip (LVP)** using FIFO.

Alternative: **97% schablon rule** (3% inkuransavdrag).

| Account | Description |
|---------|-------------|
| **1410** | Råvaror |
| **1440** | Produkter i arbete |
| **1450** | Färdiga varor |
| **1460** | Lager av handelsvaror |
| **4960** | Förändring av lager av handelsvaror (råvaror **4910**, förnödenheter **4920**, färdiga varor **4950**; 4990 is not a BAS account) |

K1: inventory with a total value of at most half a prisbasbelopp (29,600 SEK for 2026) need not be recognised (K1 6.47; IL 17:4a).
K3: indirect manufacturing overhead must be included when material. K2: optional.

## Phase 5: Untaxed reserves (obeskattade reserver)

### Periodiseringsfonder (AB only, booked)

AB can defer up to **25%** of skattemässigt resultat for up to 6 years.

| Account | Description |
|---------|-------------|
| **2110-2129** | Periodiseringsfond per year (e.g. 2125 = tax year 2025) |
| **8811** | Avsättning till periodiseringsfond |
| **8819** | Återföring från periodiseringsfond |

Entry: Debit 8811 / Credit 21xx (avsättning). Debit 21xx / Credit 8819 (återföring).

**Enskild firma**: 30% periodiseringsfond, handled ONLY in NE-bilaga (R34 avsättning / R32 återföring), NEVER booked.

### Överavskrivningar

Excess of tax-allowed depreciation over planned depreciation.

| Account | Description |
|---------|-------------|
| **8850** (or 8851-8853) | Förändring av överavskrivningar |
| **2150** (or 2151-2153) | Ackumulerade överavskrivningar |

Two methods: **30-rule** (declining balance on pool) and **20-rule** (straight-line per asset over 5 years). Use whichever produces lowest allowable residual value.

## Phase 6: Provisions and tax (avsättningar, skatt)

### Provisions
| Account | Description |
|---------|-------------|
| **2210** | Avsättningar för pensioner |
| **2220** | Avsättningar för garantier |
| **2230, 2250** | Other provisions |
| **7533** | Särskild löneskatt on pensions |
| **2514** | Beräknad SLP |

SLP rate: **24.26%** on pension costs. Entry: Debit 7533 / Credit 2514.

### Tax provision (AB only)
| Account | Description |
|---------|-------------|
| **8910** | Skatt på årets resultat |
| **2512** | Beräknad inkomstskatt |
| **2518** | Betald F-skatt (debit balance during year) |

Entry: Debit 8910 / Credit 2512. Net 2518 against 2510/2512 at year-end.

**Enskild firma does NOT book any tax**: owner taxed personally via NE-bilaga.

### Deferred tax (K3 only)
| Account | Description |
|---------|-------------|
| **8940** | Uppskjuten skatt |
| **2240** | Avsättningar för uppskjutna skatter |
| **1370** | Uppskjuten skattefordran |

All marked **[Ej K2]** in BAS kontoplan. K2 must NEVER recognize deferred tax.

## Phase 7-8: Equity handling and result closing

All P&L accounts (classes 3-8) net to **8999** (Årets resultat).

### AB equity flow
1. Year-end: Debit 8999 / Credit **2099** (Årets resultat) for profit
2. New year start: 2099 → **2098** (Vinst/förlust från föregående år)
3. After bolagsstämma: 2098 → **2091** (Balanserad vinst eller förlust)
4. Declared dividend: 2098 → **2898** (Outtagen vinstutdelning)

### Enskild firma equity flow
1. Year-end: Debit 8999 / Credit **2019** (Årets resultat, delägare 1)
2. New year start: Zero all sub-accounts (**2011** egna varuuttag, **2013** övriga egna uttag inklusive ägarens egna skatter, **2017** årets kapitaltillskott, **2018** övriga egna insättningar, **2019** årets resultat) → net into **2010** (Eget kapital). Note: some programs (Visma, Bokio) add a non-standard **2012** "Avräkning för skatter och avgifter" for owner taxes; official BAS has no 2012, and Accounted books owner taxes on 2013.
3. No bolagsstämma required