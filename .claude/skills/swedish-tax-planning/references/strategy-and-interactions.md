# Strategy, Interactions, and Optimization

<!-- toc -->
**Contents**

- [Year-end decision sequence](#year-end-decision-sequence)
- [Lön vs utdelning: the fundamental trade-off](#lön-vs-utdelning-the-fundamental-trade-off)
- [Interaction matrix](#interaction-matrix)
- [Obeskattade reserver: balance sheet effects](#obeskattade-reserver-balance-sheet-effects)
- [Skatteverket audit triggers](#skatteverket-audit-triggers)
- [Skatteflyktslagen (Lag 1995:575)](#skatteflyktslagen-lag-1995575)
- [Documentation requirements](#documentation-requirements)
- [Multi-year planning horizon](#multi-year-planning-horizon)
- [Bolagsskatt and rule changes (status September 2026)](#bolagsskatt-and-rule-changes-status-september-2026)

<!-- /toc -->

## Year-end decision sequence

Follow this order for optimal tax planning:

1. **Överavskrivningar**: Calculate max under 30-regeln and 20-regeln. Limited by asset base, so do this first.
2. **Periodiseringsfond**: Calculate remaining taxable income, set aside up to 25%. Remember any återföring in the same year increases the base.
3. **Koncernbidrag**: Equalize remaining profits and losses across the group. Requires bolagsstämmobeslut.
4. **Löneuttag**: Verify owner salary meets lönekrav for 3:12 purposes (through inkomstår 2025). December bonuses are common but draw Skatteverket attention.
5. **Utdelning**: Plan within available gränsbelopp.
6. **Ränteavdragsbegränsningar**: Verify compliance. Periodiseringsfond avsättning increases EBITDA (good), koncernbidrag decreases it (bad for giver).

## Lön vs utdelning: the fundamental trade-off

### Effective combined tax burdens

| Extraction method | Combined burden (company + owner) |
|-------------------|-----------------------------------|
| Utdelning within gränsbelopp | ~36.5% (1 - 0.794 x 0.80) |
| Lön below brytpunkt (no statlig skatt) | ~47-52% (incl. arbetsgivaravgifter 31.42%) |
| Lön above brytpunkt | ~58-63% |
| Utdelning above gränsbelopp (tjänstebeskattning) | ~52-58% |

### Optimal strategy for most fåmansbolagsägare

1. Take lön up to pension ceiling: 8.07 x IBB = ~673,000 kr (2026). This secures SGI and pensionsrätt.
2. Ensure lönekravet is met for 3:12 (through inkomstår 2025)
3. Distribute remaining profits as utdelning within gränsbelopp
4. Excess profits: retain in company, invest via kapitalförsäkring, or use periodiseringsfond to defer

### When lön is preferable despite higher tax
- Building SGI (sjukpenninggrundande inkomst) for social insurance benefits
- Maximizing allmän pension
- When the company has no accumulated gränsbelopp
- When löneunderlag needs to be built (owner's lön feeds into the calculation)

## Interaction matrix

| Tool A | Affects Tool B | How |
|--------|---------------|-----|
| Periodiseringsfond avsättning | EBITDA | Increases avdragsunderlag (beneficial) |
| Periodiseringsfond återföring | EBITDA | Decreases avdragsunderlag (harmful) |
| Koncernbidrag (lämnat) | EBITDA | Decreases avdragsunderlag (harmful for giver) |
| Koncernbidrag (mottaget) | EBITDA | Increases avdragsunderlag (beneficial for receiver) |
| Löneuttag | 3:12 gränsbelopp | Meets lönekrav AND feeds löneunderlag |
| Löneuttag | Company cost | Avdragsgill, reduces taxable income |
| Löneuttag | Arbetsgivaravgifter | 31.42% additional company cost |
| Överavskrivningar | Periodiseringsfond | Reduces taxable income, lowering max avsättning |
| Överavskrivningar | EBITDA | Added back, increases avdragsunderlag |

## Obeskattade reserver: balance sheet effects

Both periodiseringsfonder and ackumulerade överavskrivningar appear as obeskattade reserver:
- ~79.4% equity component
- ~20.6% latent tax component

For bank credit assessments (soliditet), these components are typically split. In K3 consolidated accounts, the split is explicit (uppskjuten skatteskuld and eget kapital).

## Skatteverket audit triggers

Common patterns that invite scrutiny:
1. Discrepancies between momsdeklaration and INK2 turnover
2. Unusually large avdrag for representation, leasing, consulting fees
3. Owner salary patterns that appear primarily tax-motivated (e.g., large December bonuses to meet lönevillkoret)
4. Placing kvalificerade andelar in kapitalförsäkring
5. "Samma eller likartad verksamhet" when activity is split between related companies
6. Rapid corporate restructuring before significant transactions
7. Koncernbidrag patterns lacking business substance
8. Transfer pricing in intra-group transactions without documentation

## Skatteflyktslagen (Lag 1995:575)

Applies when four cumulative conditions are met:
1. Väsentlig skatteförmån
2. Taxpayer participation (directly or indirectly)
3. Tax benefit was the predominant reason
4. Taxation based on the arrangement would contravene the law's purpose

## Documentation requirements

Essential documentation that must be in order:
- Periodiseringsfond: corresponding obeskattade reserver in räkenskaperna
- Koncernbidrag: formal bolagsstämmobeslut
- K10: filed annually (even without dividend)
- Transfer pricing: arm's-length documentation for intra-group transactions
- Löneunderlag: lönespecifikationer supporting the K10 calculation

Missing any of these creates both skattetillägg risk and potential loss of deduction rights.

## Multi-year planning horizon

The most valuable long-term strategy for a fåmansbolagsägare:
1. Maximize sparat utdelningsutrymme through consistent K10 filing
2. Optimize löneunderlag annually (company wages directly feed gränsbelopp growth)
3. Compound growth of the 20%-taxed dividend space reduces lifetime tax burden far more than any single-year maneuver
4. Use periodiseringsfond strategically against anticipated loss years
5. Time major asset acquisitions to maximize överavskrivningar in the acquisition year

## Bolagsskatt and rule changes (status September 2026)

**Bolagsskatt is 20.6%** (IL 65 kap. 10 §). A cut to 20% has not been enacted; plan with 20.6% for 2026. A future rate cut would again raise the question of uppräkning of older periodiseringsfonder.

### Enacted

- **Skattereduktion för gåvor från juridiska personer** (IL 67 kap. 21, 23 and 24 a-26 a §§, SFS 2025:1361; gåvor lämnade efter 2025-12-31): gifts of money of at least **2 000 kr** per gåvotillfälle to a godkänd gåvomottagare (social hjälpverksamhet or vetenskaplig forskning) give a skattereduktion of **20.6%** of the gift. The underlag is capped at **800 000 kr per kalenderår** (max reduction 164 800 kr). Requested in the first income tax return due after the end of the calendar year of the gift. The gift is not taxed as intäkt or utdelning for the owners (IL 11 kap. 49 §, 42 kap. 12 a §).
- **Ränteavdrag on intra-group debt to EES lenders** (IL 24 kap. 19 a §, prop. 2025/26:20): from beskattningsår beginning after 2025-12-31, deduction is denied only for a konstlat upplägg. See `ranteavdragsbegransningar.md`.
- **3:12 steg 2**: four-year periods in 57 kap. 3-5 §§ from inkomstår 2027. See `312-regler.md`.

### Proposed, not enacted

- Förenklingsregeln for ränteavdrag raised from 5 to 25 MSEK (IL 24 kap. 24 § still says 5 MSEK).