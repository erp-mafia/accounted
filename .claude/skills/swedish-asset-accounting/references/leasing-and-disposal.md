# Leasing Treatment & Asset Disposal

## Leasing Across Frameworks

### K2 (BFNAR 2016:10)

ALL leases treated as operating. No exceptions.

**Booking:** Expense directly:
- 5210: Hyra av anläggningstillgångar
- 5220: Hyra av inventarier och verktyg
- 5615: Leasing av personbilar

**Förhöjd förstagångshyra (first enhanced payment):** Prepaid via **1720 Förutbetalda leasingavgifter**, allocated linearly over lease term.

No assets or liabilities appear on balance sheet.

### K3 (BFNAR 2012:1, Chapter 20)

Classifies leases as **financial** or **operating** using IAS 17 criteria:
1. Transfer of ownership at end of term
2. Bargain purchase option
3. Lease covers major part of economic life
4. Present value of payments ≈ fair value
5. Specialized asset

**Financial leases are capitalized:**
- Asset: **1260 Leasade tillgångar** (depreciated via 7836 / 1269)
- Liability: **2391** (short-term) / **2350** (long-term leasingskuld)
- Payments split: interest (8410) + amortization via effective interest method

**K3 point 20.29 exemption:** In the **juridisk person** (legal entity), financial leases MAY be accounted for as operating. This preserves the tax connection. In **consolidated accounts**, financial leases MUST go on balance sheet.

**Operating leases under K3:** Same as K2 treatment, expensed directly.

### IFRS 16

All leases on balance sheet via right-of-use model:

**Recognition:**
- **Nyttjanderättstillgång (ROU asset):** 1260, at PV of lease payments
- **Leasingskuld:** 2350 (long-term) / 2391 (short-term)
- Discount rate: implicit rate in lease, or marginal borrowing rate

**Two exemptions only:**
1. Short-term leases (≤ 12 months) - expense directly
2. Low-value assets (< ~USD 5,000 when new) - expense directly

**RFR 2 exemption:** In the juridisk person, IFRS 16 need NOT be applied. Lease payments recorded as straight-line expense, preserving tax connection.

### Tax Treatment of Leasing

Swedish tax law follows **legal form**, not accounting classification:
- **Lessee:** Deducts lease payments
- **Lessor:** Claims depreciation as legal owner

Regardless of whether the lease is capitalized in accounting.

**Key 2024 ruling:** Capitalizing financial leases does NOT forfeit the right to räkenskapsenlig avskrivning on owned assets, provided adjustments are made in the tax return (INK2/INK4).

**VAT on financial leasing (2024 Skatteverket ställningstagande):** Financial leases may be classified as supply of goods rather than services. For **personbilar** this triggers the **full VAT deduction prohibition** on purchases, instead of the usual 50% deduction available for lease services.

### Leasing Summary Table

| Feature | K2 | K3 (juridisk person) | K3 (koncern) | IFRS 16 (koncern) | IFRS 16 (JP via RFR 2) |
|---|---|---|---|---|---|
| Financial on BS | Never | Optional (20.29) | Mandatory | Mandatory | Not required |
| Operating treatment | All leases | All (if 20.29 used) | Operating only | Short-term + low-value only | All (expense) |
| Asset account | N/A | 1260 | 1260 | 1260 | N/A |
| Depreciation account | N/A | 7836 | 7836 | 7836 | N/A |

---

## Avyttring (Disposal/Sale)

### Book Value at Disposal

`Bokfört värde = Anskaffningsvärde − Ackumulerade avskrivningar`

Asset must be depreciated up to the disposal date before calculating gain/loss.

### Booking Pattern

Use one balanced entry after depreciation through the disposal date. The gain
or loss equals `försäljningspris ex moms − bokfört restvärde`.

```
Debit  1510 Kundfordran                 [gross proceeds]
Debit  1229 Ack. avskr. inventarier     [accumulated depreciation]
Debit  7973 Förlust vid avyttring       [only for a loss]
Credit 1221 Inventarier                 [original acquisition cost]
Credit 2611 Utgående moms 25%           [output VAT]
Credit 3973 Vinst vid avyttring         [only for a gain]
```

### Gain/Loss Accounts

| Account | Direction | Description |
|---|---|---|
| 3971 | Credit (gain) | Vinst avyttring immateriella |
| 3972 | Credit (gain) | Vinst avyttring byggnader/mark |
| 3973 | Credit (gain) | Vinst avyttring maskiner/inventarier |
| 7971 | Debit (loss) | Förlust avyttring immateriella |
| 7972 | Debit (loss) | Förlust avyttring byggnader/mark |
| 7973 | Debit (loss) | Förlust avyttring maskiner/inventarier |

### Practical Example: Sale at Profit

Asset: anskaffningsvärde 50,000 kr, ack. avskr. 10,000 kr (book value 40,000 kr).
Sold for 56,000 kr ex VAT.

```
Debit  1510  70,000  (gross proceeds)
Debit  1229  10,000  (remove accumulated depreciation)
Credit 1221  50,000  (remove asset at cost)
Credit 2611  14,000  (25% output VAT)
Credit 3973  16,000  (gain: 56,000 − 40,000)
```

Debits and credits are both 80,000. The 16,000 credit is the complete income
statement effect of the disposal.

---

## Utrangering (Scrapping)

Same as disposal with zero sale proceeds. Remaining book value written off entirely.

**K2 (7.14):** Recognized when asset can no longer be used AND company does not intend to repair or sell.

### Booking Pattern

```
Debit  1229 Ack. avskr.    [accumulated depreciation]
Debit  7973 Förlust         [remaining book value]
Credit 1221 Inventarier     [original acquisition cost]
```

**Fully depreciated assets:** No income statement effect.
```
Debit  1229  [full amount]
Credit 1221  [full amount]
```

---

## VAT on Asset Disposal

**General rule:** 25% moms on sale of movable business assets.

### Exceptions

1. **Verksamhetsöverlåtelse (business transfer, ML 5 kap. 38 §):** No VAT when transferring entire business or independent branch.
2. **No original input VAT deduction (ML 10 kap. 37 §):** The exemption applies only when no part of the input VAT was deductible, including VAT on significant later additions to the asset.
3. **Real property (fastighet):** Generally VAT-exempt sales.

### Jämkning (VAT Adjustment Rules, ML 15 kap.)

Applies to investment goods based on total original input VAT, whether or not
the full amount was deducted:

| Asset type | Adjustment period | Threshold (input VAT) |
|---|---|---|
| Byggnader | 10 years | ≥ 100,000 kr |
| Maskiner/inventarier | 5 years | ≥ 50,000 kr |

The acquisition or completion tax year counts as year 1. The disposal tax year
also counts. A one-time adjustment uses:

`original input VAT × change in deduction percentage × remaining years / total years`

No adjustment is made when the change is less than 5 percentage points. A
positive adjustment on a taxable sale of movable property is capped at 25% of
the sale price excluding VAT. In a qualifying business transfer under ML 5
kap. 38 §, the acquirer takes over the adjustment rights and obligations when
the statutory conditions are met. An adjustment document with the information
required by ML 15 kap. 28-31 §§ must be prepared and retained.

---

## Tax Treatment of Disposal (IL)

### Räkenskapsenlig avskrivning - Huvudregeln (IL 18 kap. 15 §)

A **särskilt avdrag** equal to sale proceeds offsets income, reducing the avskrivningsunderlag. The sold asset's cost is removed from the pool.

### Kompletteringsregeln

No särskilt avdrag. The disposed asset's cost is simply removed from the lowest-permitted-value calculation.

### Buildings (IL 26 kap. 2 §)

Disposal triggers reversal of prior värdeminskningsavdrag. Difference between sale price and tax book value is taxable.

### Restvärdeavskrivning

Sale proceeds reduce the skattemässigt restvärde directly.
