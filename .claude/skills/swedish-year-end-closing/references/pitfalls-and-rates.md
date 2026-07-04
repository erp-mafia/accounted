# Common Mistakes, Compliance Pitfalls, and Reference Rates

## Common mistakes

### 1. Failure to reverse prior-year accruals
Interimsposter booked at year-end must be reversed on day 1 of new fiscal year. Without auto-reversal, costs/revenues are double-counted. Software should auto-generate reversal entries.

### 2. Incorrect periodiseringsfond calculations
- Wrong percentage: 25% for AB, 30% for EF
- Missing mandatory 6-year reversal
- Forgetting **gross-up rule** for funds created before 2019 (at old 22% rate, requiring 103-106% uppräkning on reversal)

### 3. Missing schablonintäkt on periodiseringsfonder
Affects AB companies. SLR × total funds at year-start. Is a skattemässig justering, NEVER booked. Many systems incorrectly try to record it as journal entry.

### 4. Confusing bokföringsmässigt and skattemässigt resultat
The reconciliation from book result to taxable result (INK2S logic) must be implemented as separate calculation layer.

### 5. Failing to close 2099 to 2091 correctly
- **2099** (Årets resultat) must move to **2098** at year-start
- Then to **2091** after bolagsstämma decides on disposition
- 2099 should ONLY ever contain current year's result

### 6. Kontrollbalansräkning requirement
Triggers when eget kapital falls below **50% of registrerat aktiekapital** (ABL 25 kap).

In kontrollbalansräkning:
- Obeskattade reserver split: 79.4% equity / 20.6% tax
- Assets may be revalued to net realizable value

If confirmed:
1. Board calls first kontrollstämma
2. Must restore full aktiekapital within 8 months
3. Board members face **personal liability** if not followed

Software should flag when equity approaches this threshold.

### 7. Forgetting SLP on pension provisions
Särskild löneskatt 24.26% on pension costs must be booked same period:
Debit 7533 / Credit 2514. Frequently missed.

### 8. Incorrect inventory valuation
- Forgetting 3% inkuransavdrag (97% schablon rule)
- Applying it to excluded types (real estate, securities)
- Affects both balance sheet and tax calculation

### 9. Not reconciling överavskrivningar
Mismatch between plan depreciation (78xx) and tax depreciation creates incorrect obeskattade reserver (2150 series), cascading into wrong tax and potential kontrollbalansräkning trigger.

### 10. Booking items that should only exist in declaration
For enskild firma: periodiseringsfond, expansionsfond, räntefördelning, egenavgifter schablonavdrag should NEVER appear as journal entries.

---

## Key reference rates and thresholds

| Parameter | 2025 | 2026 |
|-----------|------|------|
| Bolagsskatt | 20.6% | 20.6% |
| Statslåneränta (SLR, Nov 30 prior year) | 1.96% | 2.55% |
| Schablonintäkt periodiseringsfond (AB) | 1.96% (floor 0.5%) | 2.55% (floor 0.5%) |
| Positiv räntefördelning | 7.96% (SLR+6) | 8.55% (SLR+6) |
| Negativ räntefördelning | 2.96% (SLR+1) | 3.55% (SLR+1) |
| Egenavgifter (full, 7 karensdagar) | 28.97% | 28.97% |
| Schablonavdrag egenavgifter (active) | 25% | 25% |
| Särskild löneskatt (SLP) | 24.26% | 24.26% |
| Expansionsfondsskatt | 20.6% | 20.6% |
| Expansionsfond max | 125.94% of kapitalunderlag | 125.94% |
| Periodiseringsfond AB max | 25% of skattemässigt resultat | 25% |
| Periodiseringsfond EF max | 30% of result | 30% |
| Arbetsgivaravgifter (standard) | 31.42% | 31.42% |
| Prisbasbelopp | 58,800 SEK | 59,200 SEK |
| K2 accrual threshold | 5,000 SEK/item | 5,000 SEK/item |
| Inkuransavdrag (inventory) | 3% (97% rule) | 3% (97% rule) |
| Kontrollbalansräkning trigger | <50% of aktiekapital | <50% |
| Neg. räntefördelning threshold | -500,000 SEK | -500,000 SEK |
| Revisor opt-out thresholds | >3 emp, >1.5M BS, >3M rev (2/3) | Same |