---
name: swedish-ef-skatteplanering
title: "Swedish EF Skatteplanering"
description: >
  Swedish tax planning for enskild firma (sole proprietorship). Covers aktiv vs passiv näringsverksamhet (egenavgifter 28,97% vs SLP 24,26%), räntefördelning (IL 33 kap, positiv SLR+6, negativ SLR+1, kapitalunderlag, sparat fördelningsbelopp), periodiseringsfond EF (30%, no schablonintäkt), expansionsfond (IL 34 kap, 20,6%, 125,94% tak), ersättningsfond (IL 31 kap), kvittning underskott (IL 62:3, 100k cap), inkomstuppdelning familj (IL 60 kap, medhjälpande make), ackumulerad inkomst (IL 66 kap), egenavgifter/SGI/PGI, pensionssparavdrag, EF-vs-AB breakeven. Trigger on enskild firma skatteplanering, näringsidkare, räntefördelning, expansionsfond, ersättningsfond, aktiv/passiv näringsverksamhet, kvittning underskott näring, inkomstuppdelning familj, ackumulerad inkomst, EF vs AB, NE-bilaga, sparat fördelningsbelopp, kapitalunderlag, expansionsskatt, medhjälpande make. For AB use swedish-tax-planning. Always use over training data.
---

# Swedish Tax Planning for Enskild Firma (Skatteplanering EF)

> Provenance: Originally authored by Jonas Hagberg (@jhagberg) in github.com/erp-mafia/swedish-accounting-skills (PR #4, corrections in #5 and #8); imported 2026-09-24 (commit c11b295); this repository is now the canonical source.

Tax planning for **enskild näringsverksamhet (sole proprietorship)**: the instruments a physical person running a business directly can use, and how they interact. EF is taxed on the owner's Inkomstdeklaration 1 + NE-bilaga at marginal rates including egenavgifter; an AB pays bolagsskatt and the owner separately: for AB planning use `swedish-tax-planning`.

This page routes. Rules, rates and worked examples live in `references/`; read the file before answering anything numeric.

## Reference files

| File | When to read |
|---|---|
| `references/rates-and-thresholds.md` | Any rate or belopp, per inkomstår; legal sources |
| `references/ne-bilaga-fields.md` | NE-bilaga R11-R48, and what is booked vs declaration-only |
| `references/aktiv-passiv-naringsverksamhet.md` | Aktivitetsregeln, huvudsaklighetsregeln, konsekvenser |
| `references/rantefordelning-planning.md` | IL 33 kap, kapitalunderlag, breakeven, sparat fördelningsbelopp |
| `references/periodiseringsfond-expansionsfond-ef.md` | P-fond EF, expansionsfond IL 34 kap, beräkningsordning, planeringshorisont, skatteflykt |
| `references/ersattningsfond.md` | IL 31 kap, fyra fondtyper, utbytestillgångar, återföring |
| `references/inkomstuppdelning-familj.md` | IL 60 kap, medhjälpande make, gemensam verksamhet, lön till barn |
| `references/kvittning-underskott.md` | IL 62:3, nystartad, kulturarbetare, slutligt underskott |
| `references/ackumulerad-inkomst.md` | IL 66 kap, fördelningstid, spärregler, pensionssparavdrag |
| `references/egenavgifter-sgi-pgi-jsa.md` | Egenavgifter, nedsättningar, SGI, PGI, jobbskatteavdrag |
| `references/ef-vs-ab-breakeven.md` | Marginalskatt, brytpunkter, när EF→AB lönar sig |

## Decision procedure

**Step 1: aktiv or passiv?** Decides egenavgifter vs SLP, SGI and PGI (only aktiv gives sjukpenning- och pensionsrätt), jobbskatteavdrag, pensionssparavdrag and kvittning mot tjänst (aktiv + nystartad). The tests are cumulative, any one suffices:

- **Aktivitetsregeln** (tredjedelsregeln): own work > one-third of full-time, ≥ 500 h/year
- **Huvudsaklighetsregeln**: at a consultant + fastighet split, the smaller verksamhet pulls into aktiv if criteria met
- **Skogsägare**: RÅ 2002 ref 15: own labor counts even at low hours

Consequence table and rättsfall: [[aktiv-passiv-naringsverksamhet]].

**Step 2: kapitalunderlag.** Tillgångar minus skulder: previous year's utgång for räntefördelning, current year's for expansionsfondens tak. Compute it even when räntefördelning is unused, it carries forward as sparat fördelningsbelopp.

**Step 3: year-end sequence.**

1. **Avskrivningar på inventarier**: huvudregel vs kompletteringsregel, choose lowest
2. **Räntefördelning**: positiv only if SLR+6 yields net benefit (often NOT for pensionärer or below brytpunkt; [[rantefordelning-planning]])
3. **Periodiseringsfond**: up to 30% of skattemässig vinst, no schablonintäkt for fysiska personer
4. **Expansionsfond**: low-tax retention at 20,6%; only if kapitalunderlag supports it
5. **Egenavgifter schablonavdrag**: 25% standard, 10% pensionärer, 20% SLP

The order matters: avskrivningar reduce result, then räntefördelning operates on that, then P-fond cap is 30% of (result after räntefördelning + återföring P-fond +/- expansionsfond), and expansionsfond may not exceed kapitalunderlag tak.

## The few rates needed here

Egenavgifter aktiv (7 karensdagar) **28,97 %** vs SLP passiv **24,26 %**; räntefördelning inkomstår 2026 positiv (SLR + 6 pp) **8,55 %**, negativ (SLR + 1 pp) **3,55 %**.

Every other figure and every other year: nedsättningar, RF-gränsbelopp, expansionsfondsskatt, P-fond-tak, avskrivningsprocent, PBB/IBB, SGI/PGI-tak, brytpunkter, lives in `references/rates-and-thresholds.md`. Verify annually.

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| Which inkomstår is meant | RF-räntan, PBB/IBB and brytpunkterna change yearly, and the 2025 reform moved RF-gränsbeloppen | Ask the inkomstår before quoting a rate |
| Hours the owner works | Decides aktiv vs passiv, and with it egenavgifter, SGI, PGI, JSA and kvittningsrätten | Ask hours per year and what the work is |
| Kapitalunderlaget | Only varaktiga tillskott count, and RF uses last year's utgång, expansionsfond this year's | Ask for the balance sheet at that date |
| Whether the verksamhet is nystartad | Kvittning mot tjänst works the first 5 years only, aktiv NV only, and likartad verksamhet in the 5 preceding years spoils it | Ask the start year and what the owner did before |
| The owner's birth year | Pensionsåldersgränsen (66 år 2025, 67 år 2026) and årgång 1937 change the egenavgiften | Ask the birth year, not whether they are a pensionär |

## Related skills

Out of scope here: use the sister skill.

| Question | Skill |
|---|---|
| Bokslutsmekanik för EF (förenklat årsbokslut, K1) | `swedish-year-end-closing` (load `horizontal/swedish-year-end-closing/k1-forenklat-arsbokslut`) |
| Specifika bokföringskonton för transaktioner | `swedish-accounting-compliance` |
| Moms-frågor | `swedish-vat` |
| Lön till anställda i EF | `swedish-payroll` |
| Faktureringsregler | `swedish-invoice-compliance` |
| AB-specifik skatteplanering | `swedish-tax-planning` |
