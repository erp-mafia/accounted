# Depreciation Methods & Tax Rules

## Planenlig avskrivning (Book Depreciation)

ÅRL 4 kap. 4 § requires systematic depreciation of all fixed assets with limited useful life.

### Methods

**Linjär (straight-line):** `(anskaffningsvärde − restvärde) / nyttjandeperiod`. Most common.

**Degressiv (declining balance):** Fixed % of remaining book value. Higher charges early. Suitable for vehicles, tech.

**Produktionsberoende (units-of-production):** `(cost − residual) × (units produced / total expected)`. K2 additionally allows progressiv for machinery (never buildings).

### Useful Life

- **K3 (17.16):** Individual assessment per asset. Mandatory reassessment on indicators of change.
- **K2 (10.27):** Permits standardized **5-year useful life** for machinery, inventory, intangibles. Buildings may follow SKV standard rates (industrial 4-5%, offices 2-4%, residential 2%).
- **Goodwill/dev costs:** Default 5 years when life cannot be reliably determined (ÅRL 4 kap. 4 §).

### Residual Value

- **K3 (17.14):** Must estimate and reassess annually.
- **K2 (10.25):** Optional. Forbidden with 5-year rule or for buildings.

### Depreciation Start

- **K2 (10.23):** From year asset is *put into use* (tas i bruk). Full annual amount regardless of partial year.
- **K3 (17.19):** From when asset *can* be used (available for use). Buildings under K2 depreciate even before use.

### Component Depreciation (Komponentavskrivning)

- **K3 (17.4-17.5):** MANDATORY. Decompose into components with materially different useful lives.
- **K2 (10.2):** FORBIDDEN.

Typical building components and lives:

| Component | Years |
|---|---|
| Stomme (structure) | 80-160 |
| Stammar (plumbing) | 40-60 |
| Tak (roof) | 30-50 |
| Fasad (facade) | 30-60 |
| Fönster (windows) | 25-40 |
| Hissar (elevators) | 25-40 |
| VVS/ventilation | 20-30 |
| Styr & övervakning | 10-20 |

When a component is replaced under K3 (17.21-17.22): derecognize old component's remaining book value, capitalize new component separately.

### BAS Expense Accounts (78xx)

- 7810: Avskrivningar immateriella tillgångar
- 7820: Avskrivningar byggnader/markanläggningar (7821 byggnader, 7824 markanläggningar)
- 7830: Avskrivningar maskiner/inventarier (7831-7835 specific types)
- 7836: Avskrivningar leasade tillgångar
- 7840: Avskrivningar förbättringsutgifter annans fastighet

---

## Överavskrivning (Excess Tax Depreciation)

When skattemässig avskrivning > planenlig avskrivning, the difference is an **obeskattad reserv** (untaxed reserve).

### BAS Accounts

**Balance sheet:** 2150 Ackumulerade överavskrivningar
- 2151: Immateriella tillgångar
- 2152: Byggnader
- 2153: Maskiner och inventarier

**Income statement (bokslutsdisposition):** 8850 Förändring av överavskrivningar
- 8851-8853: Matching sub-accounts

### Booking Pattern

- Increase överavskrivning: **Debit 8850 / Credit 2150**
- Decrease överavskrivning: **Debit 2150 / Credit 8850**

### Constraint

Book value must NEVER fall below tax value:
`skattemässigt restvärde = konto 12xx − (konto 12x9 + konto 2150)`

### K2 vs K3

- **K2:** Often eliminates need for överavskrivning entirely. 5-year rule (20%) matches kompletteringsregeln. Building rates can match SKV. No deferred tax permitted.
- **K3:** Strict separation required. Book depreciation must reflect economic consumption. Deferred tax required (ch. 29). In juridisk person, K3 29.37 permits obeskattade reserver at gross. In consolidated accounts: split into equity (79.4%) and uppskjuten skatteskuld (20.6% at current corporate tax rate).

---

## Skattemässig avskrivning (Tax Depreciation)

### Inventarier (IL 18 kap.)

One method for ALL inventory. No mixing.

#### Räkenskapsenlig avskrivning (IL 18 kap. 13-17 §§)

Requirements: ordnad bokföring + årsbokslut + tax depreciation = book depreciation.

**Huvudregeln (30% declining balance):**
- Deduct up to 30% of avskrivningsunderlag annually
- Underlag = book value at year start + acquisitions − sale proceeds for items owned at year start
- Minimum book value = 70% of underlag
- Rate adjusts proportionally for fiscal years ≠ 12 months

**Kompletteringsregeln (20% straight-line):**
- Full depreciation over exactly 5 years at 20%/year on original acquisition cost
- Requires tracking each asset's acquisition year and cost for prior 4 fiscal years
- Can switch between rules each year

**Practical:** Huvudregeln better years 1-2. Kompletteringsregeln superior from year 3 onward.

#### Restvärdeavskrivning (IL 18 kap. 13 § st. 3)

- Max **25% declining balance** on skattemässigt restvärde
- No book/tax match required
- Fallback method when räkenskapsenlig requirements cannot be met
- No supplementary rule: assets theoretically never fully depreciated

| Feature | Räkenskapsenlig | Restvärdeavskrivning |
|---|---|---|
| Legal basis | IL 18:13-17 | IL 18:13 st.3 |
| Max rate | 30% declining / 20% SL | 25% declining |
| Book = tax | Required | Not required |
| Full depr. | Yes (5yr komplettering) | No (asymptotic) |
| Ordnad bokföring | Required | Not required |

### Byggnader (IL 19 kap.)

Straight-line on acquisition cost. SKV standard rates (SKV A 2005:5):

| Building type | Rate |
|---|---|
| Industrial (industri) | 4% |
| Office/residential | 2% |
| Hotel/parking | 3% |
| Kiosk | 5% |

**Primäravdrag (since 2019):** Additional 2%/year for first 6 years on new construction of hyreshus.

**Mark (land):** Never depreciated.

**Missed year:** Cannot be recovered later.