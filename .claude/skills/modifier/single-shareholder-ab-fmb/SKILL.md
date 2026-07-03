---
id: modifier/single-shareholder-ab-fmb
tier: modifier
title: "Aktiebolag med en aktieägare (fåmansbolag)"
description: >
  Aktiebolag där en fysisk person äger > 50% av kapitalet (eller där < 4 personer
  tillsammans äger > 50%) klassas som fåmansbolag och omfattas av 3:12-reglerna.
  Den enskilda ägaren är samtidigt anställd ("verksam i betydande omfattning") och
  styr själv balansen mellan lön och utdelning. Avgörande för ekonomin men trivialt
  i löpande bokföring — modifern flaggar för agenten att 3:12, gränsbelopp, K10
  och löneunderlagsregeln måste vara med i rådgivningen.
trigger_signals:
  ownership: "single_shareholder"
  bas_account_patterns: ["2898", "2899", "2091", "2098", "2099"]
version: 1
---

> **POC test content.** Replace with deep research material before relying on
> this for production-quality advice.

# Single-shareholder AB (fåmansbolag)

## When this applies

The active company is an aktiebolag where one natural person owns > 50% of
the shares. This is the most common form among Accounted's AB users. The owner
is typically also a full-time anställd in the company and "verksam i betydande
omfattning" — which triggers 3:12-reglerna (53 kap. IL).

This modifier composes with:
- [[horizontal/swedish-tax-planning]] — for 3:12, gränsbelopp, löneunderlag detail
- [[horizontal/swedish-payroll]] — for owner-as-employee salary mechanics
- [[horizontal/swedish-year-end-closing]] — for resultatdisposition (lön vs. utdelning)
- [[horizontal/swedish-financial-reporting]] — för K2/K3-årsredovisning

## Implications

1. **Lön vs. utdelning**: ägaren styr själv. Under gränsbeloppet beskattas
   utdelning som kapital (20%). Över gränsbeloppet beskattas det överskjutande
   som tjänsteinkomst (kommunal + statlig + arbetsgivaravgifter — högsta marginalskatt).
   Lön ger socialförsäkringsrätt och pension; utdelning gör det inte.
2. **Löneunderlagsregeln** (3:12-reglernas favorit): genom att ägaren tar ut
   minst en viss årslön (cirka 6 IBB + 5% av total löneunderlag, max 9,6 IBB)
   adderas en stor del av bolagets totala lönesumma till gränsbeloppet.
3. **K10**: ägaren ska lämna K10-blankett varje år där gränsbelopp,
   sparade utdelningsutrymmen och utdelningen själv redovisas.
4. **2026-års 3:12-reform**: vissa parametrar är reviderade (löneunderlag,
   förenklingsregel). Verifiera mot aktuell version av swedish-tax-planning innan
   konkret rådgivning.

## BAS-konton

| Konto | Användning |
|-------|------------|
| 2091  | Balanserad vinst eller förlust (utdelningsutrymme efter bokslut) |
| 2098  | Vinst eller förlust föregående år (innan resultatdisposition) |
| 2099  | Årets resultat (innan bokslutsdisposition) |
| 2898  | Outtagen vinstutdelning till delägare |
| 2899  | Övriga skulder till delägare (t.ex. revers från ägartillskott) |
| 7210  | Lön till företagsledare (ofta separat från andra löner för K10-spår) |
| 7510  | Arbetsgivaravgifter på 7210 |

## Regulatoriska kantfall

- **Förbjudet lån från bolaget** (21 kap. ABL): ägaren får inte låna pengar
  av bolaget. Bryts förbudet beskattas hela lånet som tjänsteinkomst (53 kap. IL).
- **Stoppregler för uthyrning av bostad till eget bolag**: marknadshyra och
  saklig grund krävs.
- **Karens vid avstämning av karensbolag**: när bolaget vilar måste det vila
  i 5 hela kalenderår innan ägaren kan ta ut ackumulerade gränsbelopp som
  kapitalinkomst utan tjänstebeskattning.
- **Närståendetransaktioner**: utdelning till barn/make beräknas mot ägarens
  K10, inte mottagarens.

## References

- Planned reference (not yet authored): a step-by-step K10 walkthrough example.
- Planned reference (not yet authored): the 2026 reformed löneunderlag parameters.
