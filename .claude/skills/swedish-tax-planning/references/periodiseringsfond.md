# Periodiseringsfond (Tax Allocation Reserve)

## Legal basis
IL 30 kap (Inkomstskattelagen 1999:1229)

## Core rules for AB

- Max avsättning: **25% of skattemässigt överskott** (taxable income before the deduction)
- Each year's fund is tracked separately
- Up to **6 parallel funds** at any time
- Each fund must be reversed no later than the **6th tax year** after the avsättning year (30 kap. 7 §)
- Reversal follows **FIFO** (oldest first)
- The avsättning **must be booked in räkenskaperna** as obeskattad reserv (formellt samband, 30 kap. 3 §). Without the booking, the deduction is invalid for AB.

## Schablonintäkt (30 kap. 6a §)

AB must declare a schablonintäkt annually:
- Formula: SLR (per Nov 30 prior year) x total periodiseringsfonder at tax year start
- Minimum SLR floor: **0.5%**
- Reported only on **INK2S punkt 4.6a** (not booked in accounting)
- Annual cost of the tax credit at SLR 2.55%: approximately 2.55% x 20.6% = **0.53%** of fund balance

## Transition uppräkning

Funds set aside at a higher bolagsskatt are grossed up when reversed in a tax year beginning after 2020-12-31, preventing arbitrage from the rate cuts (övergångsbestämmelser p. 5 till SFS 2018:1206; juridiska personer only):

| Fund set aside in tax year beginning | Bolagsskatt then | Reversed at |
|---|---|---|
| Before 2019-01-01 | 22% | **106%** |
| 2019-2020 | 21.4% | **104%** |
| 2021 or later | 20.6% | **100%** (no uppräkning) |

The uppräkning is reported on INK2S punkt 4.6d.

## BAS accounts

| Account | Name | Use |
|---------|------|-----|
| 2110-2139 | Periodiseringsfonder (year-specific) | Balance sheet, obeskattade reserver |
| 8810 | Förändring av periodiseringsfond (group) | Income statement, bokslutsdispositioner |
| 8811 | Avsättning till periodiseringsfond | Debit 8811 / Credit 21XX |
| 8819 | Återföring från periodiseringsfond | Debit 21XX / Credit 8819 |

**CRITICAL**: Account 2150 is NOT periodiseringsfond. It is ackumulerade överavskrivningar. This is one of the most common bookkeeping errors.

## Planning considerations

- **Loss absorption**: When reversed against a loss year, the originally deferred tax becomes a permanent saving, not merely a deferral. This makes periodiseringsfond especially valuable for cyclical businesses.
- **Cash flow**: The deferred tax remains in the company as working capital. If the company earns a return exceeding the SLR before tax on the retained cash, the fund is net beneficial.
- **Year-end sequence**: Calculate periodiseringsfond AFTER maximizing överavskrivningar, since both reduce taxable income.
- **Interaction with EBITDA**: Avsättning to periodiseringsfond INCREASES the skattemässigt EBITDA (avdragsunderlag) for ränteavdragsbegränsningar purposes (IL 24 kap. 25 §). This is beneficial when interest deductions are constrained.

## Common pitfalls

1. Forgetting mandatory 6-year reversal (Skatteverket corrects automatically, plus skattetillägg risk)
2. Neglecting schablonintäkt in the deklaration
3. Failing to book in räkenskaperna (invalidates the deduction for AB)
4. Consuming the cash without reserving for future tax liability upon reversal
5. Not tracking individual funds separately (each has its own 6-year clock)

## Example

AB with 1,000,000 kr taxable income in 2025:
- Max avsättning: 25% x 1,000,000 = 250,000 kr
- Booking: Debit 8811 / Credit 2125
- Taxable income falls to 750,000 kr
- Tax saved in current year: 51,500 kr
- 2026 schablonintäkt: 250,000 x 2.55% = 6,375 kr -> extra tax 1,313 kr