---
name: swedish-tax-planning
description: >
  Swedish corporate tax planning (skatteplanering AB) for aktiebolag and fåmansbolag. Scope: AB only; for enskild firma tax planning use swedish-ef-skatteplanering. Covers periodiseringsfond, överavskrivningar, koncernbidrag, 3:12-reglerna (gränsbelopp, löneunderlag, K10, 2026 reform), kapitalförsäkring i bolagskontext, ränteavdragsbegränsningar (EBITDA/N9), lön vs utdelning optimization, and tool interaction strategy. Trigger on ANY Swedish corporate tax planning question: "skatteplanering", "periodiseringsfond", "överavskrivningar", "koncernbidrag", "3:12", "fåmansbolag", "gränsbelopp", "K10", "löneunderlag", "kapitalförsäkring i bolaget", "ränteavdrag", "lön eller utdelning", "minimera skatt AB", "obeskattade reserver", "utdelningsutrymme", or questions about minimizing tax in a Swedish AB. Handles planning logic, not year-end booking mechanics (use swedish-year-end-closing for that).
---

# Swedish Tax Planning for Aktiebolag (Skatteplanering AB)

This skill covers the **planning and optimization logic** for Swedish corporate taxation. It is distinct from the year-end closing skill (which handles booking mechanics) and the VAT skill (which handles moms). The focus here is on how to use tax deferral and rate arbitrage tools to minimize the effective tax burden for AB owners.

**Scope**: this skill is **AB-only**. For tax planning in enskild firma (sole proprietorship), including räntefördelning, expansionsfond, EF-specific periodiseringsfond rules (30% / no schablonintäkt / never booked), egenavgifter, kvittning av underskott, inkomstuppdelning i familj, and ackumulerad inkomst, use the sister skill `swedish-ef-skatteplanering`. The mechanisms differ fundamentally between the two entity types, and this skill does not cover EF-specific rules.

## Key base figures (update annually)

| Parameter | 2024 | 2025 | 2026 |
|-----------|------|------|------|
| Bolagsskatt | 20.6% | 20.6% | 20.6% |
| IBB | 76,200 | 80,600 | 83,400 |
| PBB | 57,300 | 58,800 | 59,200 |
| SLR (30 Nov prior year) | 2.62% | 1.96% | 2.55% |
| Arbetsgivaravgifter | 31.42% | 31.42% | 31.42% |

## Reference files

Read the relevant file(s) based on the user's question:

- **`references/periodiseringsfond.md`** -- IL 30 kap, 25% cap, 6-year reversal, schablonintäkt, BAS accounts, pitfalls
- **`references/overavskrivningar.md`** -- IL 18 kap, 30-regeln vs 20-regeln, direktavdrag, BAS accounts, interaction with periodiseringsfond
- **`references/koncernbidrag.md`** -- IL 35 kap, >90% ownership, öppna vs dolda, BAS accounts, underskottsspärr
- **`references/312-regler.md`** -- IL 56-57 kap, fåmansbolag definition, gränsbelopp (förenklingsregeln/huvudregeln), löneunderlag, sparat utdelningsutrymme, K10, 2026 reform
- **`references/kapitalforsakring.md`** -- KF for AB, avkastningsskatt mechanics, BAS accounts, uttag accounting, KF vs direktägande vs näringsbetingade andelar
- **`references/ranteavdragsbegransningar.md`** -- IL 24 kap, EBITDA 30%, förenklingsregeln 5 MSEK, riktade regler, carry-forward, N9-blankett
- **`references/strategy-and-interactions.md`** -- Year-end sequencing, lön vs utdelning optimization, tool interactions, Skatteverket audit triggers, skatteflyktslagen

## How to use this skill

When a user asks a tax planning question:

1. Identify the specific tool(s) involved (periodiseringsfond, 3:12, etc.)
2. Read the relevant reference file(s)
3. Answer with specific IL chapter/section references, BAS accounts, and current thresholds
4. Flag the 2026 3:12 reform changes when relevant to the question
5. Always distinguish between items booked in räkenskaperna vs items only in deklarationen
6. When the question spans multiple tools, read `references/strategy-and-interactions.md` for sequencing and interaction effects

## Critical distinctions

- **Periodiseringsfond for AB** must be booked as obeskattad reserv (formellt samband). For enskild firma, it is only in deklarationen. This skill covers AB.
- **Överavskrivningar** create obeskattade reserver (BAS 2150). Do NOT confuse with periodiseringsfond (BAS 2110-2139).
- **3:12-reglerna** apply to the physical person (delägare), not the company. The K10 is filed with INK1, not INK2.
- **Kapitalförsäkring**: the AB does NOT pay avkastningsskatt on a Swedish KF. The insurance company does. The AB only books insättningar/uttag. Uttag (K2 8.4C/11.13A, räkenskapsår from 2026): intäkt up to the unrecognised värdeökning; only the excess reduces 1385. No skattefri grundnivå for AB (IL 42:45-49 applies to fysiska personer only).
- **Ränteavdragsbegränsningar**: förenklingsregeln 5 MSEK applies per intressegemenskap, not per bolag.

## Boundary with other skills

| Question type | Use this skill | Use other skill |
|--------------|----------------|-----------------|
| "How much periodiseringsfond should I set aside?" | Yes | |
| "How do I book periodiseringsfond?" | | swedish-year-end-closing |
| "Should I take lön or utdelning?" | Yes | |
| "What VAT code for EU services?" | | swedish-vat |
| "What is the deadline for årsredovisning?" | | swedish-year-end-closing |
| "Should my enskild firma use räntefördelning or expansionsfond?" | | swedish-ef-skatteplanering |
| "How do I minimize total tax on 2 MSEK profit?" | Yes | |