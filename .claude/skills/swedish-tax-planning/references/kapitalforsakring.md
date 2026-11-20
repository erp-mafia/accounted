# Kapitalförsäkring i bolagskontext

## Key rule: AB cannot open ISK

Investeringssparkonto is restricted to fysiska personer. Kapitalförsäkring (KF) is the sole schablonbeskattad sparform available to AB.

## Tax mechanism for Swedish KF held by AB

The AB does **NOT** report or pay avkastningsskatt. For a Swedish KF, the **livförsäkringsföretaget** (insurance company) is the skattskyldige entity under §2 first paragraph, Lag (1990:661) om avkastningsskatt på pensionsmedel (AvPL).

The insurance company calculates and deducts avkastningsskatt internally, reducing the KF's value. The AB's books reflect only insättningar and uttag. Individual transactions within the KF are invisible to the AB's accounting.

## Avkastningsskatt calculation

1. Kapitalunderlag = KF value January 1 + 100% of premiums Jan-Jun + 50% of premiums Jul-Dec
2. Skatteunderlag = Kapitalunderlag x (SLR + 1 procentenhet), minimum **1.25%**
3. Avkastningsskatt = Skatteunderlag x **30%**

For 2026: effective annual tax = (2.55% + 1%) x 30% = **1.065%** of kapitalunderlag.

Properties:
- No tax on realized gains, dividends, or fund switches within KF
- Uttag (withdrawals) are skattefria (IL 8 kap. 14 §); any uttag booked as intäkt (see below) is deducted on INK2S punkt 4.5c
- Insättningar are NOT avdragsgilla

## Utländsk KF

For KF issued by non-Swedish insurance company without fast driftställe in Sweden: the **AB itself becomes skattskyldig** for avkastningsskatt (§2 first paragraph 6-7 AvPL). Must be declared in income declaration. The avkastningsskatt is not avdragsgill.

## BAS accounts

| Account | Use |
|---------|-----|
| 1385 | Värde av kapitalförsäkring (financial asset) |
| 8220 | Resultat vid försäljning (vinst/förlust at uttag) |

Insättning: Debit 1385 / Credit 1930 (bank)

### Uttag (K2 punkt 8.4C and 11.13A, BFNAR 2025:2)

Applies to räkenskapsår beginning after 2025-12-31. Determine the försäkringens värde at uttagstillfället and compare it with the redovisat värde on 1385:
- The part of the uttag covered by the unrecognised värdeökning (value at uttag − redovisat värde) is **intäkt**: Debit 1930 / Credit 8220. 1385 is unchanged.
- Only the part of the uttag that exceeds the värdeökning reduces the redovisat värde: Credit 1385.
- If the KF has been nedskriven earlier, reverse the nedskrivning first (K2 punkt 11.23).

Example: redovisat värde 100 000 kr, value at uttag 130 000 kr, uttag 20 000 kr. Värdeökning 30 000 kr ≥ uttag, so the whole 20 000 kr is intäkt (Debit 1930 20 000 / Credit 8220 20 000) and 1385 stays at 100 000 kr. With an uttag of 50 000 kr instead: 30 000 kr intäkt and 20 000 kr Credit 1385 (redovisat värde 80 000 kr).

The same rule is in Årsbokslut (BFNAR 2017:3, punkt 7.4C/10.12A, räkenskapsår beginning after 2026-12-31). K3 (BFNAR 2012:1) has no corresponding punkt.

## When KF beats direktägande

At 2026 SLR, breakeven annual return is approximately **5.2%**. Above this, KF's flat ~1.065% tax beats 20.6% bolagsskatt on realized gains in a depå.

Additional KF advantages:
- No per-transaction bookkeeping
- Tax-free rebalancing
- Administrative simplicity

## When KF is WRONG

- **Näringsbetingade andelar** (IL 24 kap. 32-34 §): dividends and capital gains are entirely skattefria when held directly. KF would impose unnecessary tax.
- Never use KF for unquoted holdings
- Never use KF for listed shares where AB holds ≥10% of votes for at least one year
- KF losses are **not avdragsgilla**, making it disadvantageous in declining markets
- Placing kvalificerade andelar in KF is actively challenged by Skatteverket as skatteflykt

## Skattefri grundnivå för ISK/KF: gäller bara fysiska personer

Beslutad lag (IL 42 kap. 45-49 §§): **150 000 kr för 2025** (SFS 2024:1131) och **300 000 kr från 2026** (SFS 2024:1132).

- **Mekanism: avdrag i inkomstslaget kapital för fysiska personer.** Avdraget = schablonintäkten på ISK + underlaget för KF/PEPP (värde vid årets ingång + premier, premier under andra halvåret till halva värdet) × (SLR + 1 procentenhet, lägst 1,25 %). Avdraget får högst uppgå till 150 000 kr (2025) respektive 300 000 kr (2026-) × samma procentsats. ISK dras av i första hand.
- För KF tar försäkringsbolaget fortfarande ut avkastningsskatt på hela kapitalunderlaget; lättnaden kommer som avdrag i innehavarens inkomstdeklaration.
- **Juridiska personer har ingen grundnivå.** AB-ägd KF beskattas enligt ovan (~1,065 % vid SLR 2,55 %) från första kronan. Dödsbon får avdraget bara för dödsåret (42:47).
- För en privatperson blir sparande i ISK/KF upp till grundnivån i praktiken skattefritt, vilket påverkar jämförelsen med direktägt sparande privat men inte AB:ets kalkyl.

Källa: IL 42 kap. 45-49 §§.