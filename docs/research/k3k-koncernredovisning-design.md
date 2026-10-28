# Koncernredovisning under K3 (K3K): design

Status: design only, 2026-10-26 (K3 build, phase 4 item 10, accounted#111). Nothing here is built. The primary sources are BFN's K3 vägledning consolidated 2025-12-15 (BFNAR 2012:1 with BFNAR 2025:3), ÅRL 7 kap. and the K3 taxonomy guide 2021 with the taxonomy package `docs/reference/bokslut/taxonomi/taxonomi-paket-2024-09-12_rev20250312.zip`. Re-verify each rule before building.

## 1. When a group must consolidate

- ÅRL 7 kap. 1 §: a moderföretag prepares a koncernredovisning each year. 7 kap. 2 § exempts a moderföretag that is itself a subsidiary when its parent consolidates it (on the conditions there), 7 kap. 3 § a moderföretag in a mindre koncern, and 7 kap. 3 a § further cases. A moderföretag that does not consolidate says so in a note (K3 kapitel 9, lagtext under 9.1).
- Control (bestämmande inflytande, ÅRL 1 kap. 4 §, K3 9.2): more than half the votes, or the right to appoint a majority of the board, or a controlling agreement, including potential voting rights.
- Accounted's customers today are almost all mindre aktiebolag; a holding company with one or two operating subsidiaries is the realistic first K3K customer, and most of those are exempt as a mindre koncern. The first product step is therefore the exemption test and the note, not consolidation.

## 2. What a koncernredovisning contains

ÅRL 7 kap. 4 §: koncernresultaträkning, koncernbalansräkning, kassaflödesanalys for the group, specification of changes in equity, noter, and a förvaltningsberättelse for the group (which may be combined with the parent's). K3 kapitel 9 governs consolidation, kapitel 19 rörelseförvärv and goodwill, kapitel 7 the group kassaflödesanalys (the K3 7.4 koncernkonto and 7.19 restricted cash rules apply at group level), kapitel 30 translation of foreign subsidiaries.

## 3. Consolidation (K3 kapitel 9, 19)

1. **Uniform policies and balance dates** (ÅRL 7 kap. 12 § and 10 §; K3 kapitel 9): every subsidiary's books are adjusted to the group's principles. The legal-entity reliefs (obeskattade reserver gross, 20.29 leasing, färdigställandemetoden 23.31) are reversed in the group: obeskattade reserver split into deferred tax and equity (29.37 does not apply to the group), finansiell leasing capitalised, construction contracts by successiv vinstavräkning.
2. **Acquisition method** (förvärvsmetoden, kapitel 19): förvärvsanalys at the acquisition date: identifiable assets and liabilities at fair value, deferred tax on the differences, goodwill as the residual, amortised over its useful life, negative goodwill as kapitel 19 sets out. Minority interest measured per kapitel 9 and 19.
3. **Eliminations** (ÅRL 7 kap. 13 §, and 7 kap. 18 § onwards for the andelar under the acquisition method): the parent's andelar against the subsidiaries' equity at acquisition; intra-group receivables and liabilities; intra-group revenue and costs; internvinster in assets still held in the group (inventory, fixed assets); intra-group dividends and koncernbidrag (koncernbidrag, a bokslutsdisposition in each legal entity under K3 6.6, eliminates against itself).
4. **Innehav utan bestämmande inflytande** (ÅRL 7 kap. 9 §; K3 9.5A-9.7): separately in equity and in the result (5.3, 9.6), with the negative-equity rule of 9.7.
5. **Foreign subsidiaries** (kapitel 30): dagskursmetoden, translation differences in equity (6.3 c), recycled on disposal.
6. **Acquisitions and disposals during the year** (9.5, kapitel 19): included from the acquisition date to the disposal date; disposal result at group level differs from the parent's.

## 4. Data model it would take in Accounted

Accounted is one company per ledger. A group is a set of companies, which `teams` already group for consultants but which carry no ownership facts.

- `company_groups` (the koncern: parent company, balance date, presentation currency) and `company_group_members` (subsidiary, ownership and voting share per date, acquisition date and cost, minority share, disposal date). Ownership history matters for 9.5 and for minority measurement.
- `group_acquisition_analyses` (förvärvsanalys per acquisition: fair-value adjustments per post, deferred tax on them, goodwill and its useful life) with their amortisation schedules: they live only in the group, never in a legal entity's ledger.
- `group_eliminations`: per year, generated proposals (intra-group balances matched on counterpart, koncernbidrag, dividends) and manual entries (internvinst), each with its basis. These are consolidation journal entries, not verifikat under BFL: they must not enter any legal entity's journal or voucher series. A separate consolidation ledger keyed by group and year, with its own immutability once the koncernredovisning is signed.
- Intra-group counterpart tagging: BAS has koncern accounts (1660-1663, 2860-2863, 3x6x koncern sales where used, 8010-8087, 8260-8263, 8360-8363, 8460-8463), but matching needs the counterpart company. A dimension "motpart" on those accounts, or a match table, is the prerequisite for automated eliminations.
- Read model: the consolidated trial balance = sum of member trial balances (statutory scope, `exclude-final`) after policy adjustments + acquisition-analysis entries + eliminations, per year, with comparatives.

## 5. Reports and filing

- The K3 document for a group: the parent's årsredovisning (K3 taxonomy, entry point risbs/rfibs) plus the koncernredovisning (K3K taxonomy). The guide: K3K covers only aktiebolag; it has no concepts for signatures or the revisorspåteckning, which come from the K3 årsredovisning taxonomy; the instance references two schemas, one per report (guide 2.3.2).
- K3K entry points in the package: `se/fr/gaap/k3k/risbs/{2020-12-01,2021-10-31}` (kostnadsslagsindelad RR) and `se/fr/gaap/k3k/rfibs/{2020-12-01,2021-10-31}` (funktionsindelad RR), forms `se-k3k-fbs`, `fcd`, `fcf`, `fdisc`, `fdr`, `fisbf`, `fisbn`, `fscie`, extension namespace `se-k3k-ext`. taxonomier.se lists a 2026-08-31 K3 revision; check whether K3K moved with it before building.
- No förkortad RR or BR for K3K (guide 2.1.3); kassaflödesanalys indirect method only in the taxonomy.
- Bolagsverket accepts digital K3K filings for aktiebolag since February 2021 (guide 1.2); Accounted's connected filing is off for every company today (extension not enabled), so paper is the first path.

## 6. What it would take, in order

1. **Exemption test and note (S)**: group size from member companies' figures (ÅRL 7 kap. 3 §), the parent subsidiary exemption, and the note. Most customers stop here.
2. **Group model and ownership (M)**: the two group tables, membership history, UI to define a group from companies the user already has.
3. **Consolidated trial balance without eliminations (M)**: aggregation across members in the statutory scope, comparatives, policy adjustments for the legal-entity reliefs (obeskattade reserver to deferred tax and equity first).
4. **Acquisition analysis and goodwill (L)**: förvärvsanalys at acquisition, amortisation, minority interest, deferred tax on surplus values.
5. **Eliminations (L)**: counterpart tagging on koncern accounts, matched proposals, internvinst entries, the consolidation ledger and its lock.
6. **K3K document (L)**: group RR, BR, KFA (reusing the K3 chapter 7 statement, `src/lib/reports/kassaflodesanalys-statement.ts`), equity specification, notes, förvaltningsberättelse; PDF for paper.
7. **K3K iXBRL (M, after P3's K3 iXBRL)**: K3K registry from the presentation linkbases, two-schema instance, Arelle fixtures.
8. **Foreign subsidiaries (M)**: translation, equity reserve, recycling.

Prerequisites outside this work: the K3 årsredovisning lockable and fileable for the parent (P1), deferred tax (P2), and connected filing live for K3 (P3).

## 7. Open questions for the founder

- Is a holding-plus-operating group a target segment, or is the exemption note enough for now? The answer decides whether steps 2-8 are worth a quarter of work.
- Consolidation ledger inside Accounted, or an export to a consolidation tool for the few groups that must consolidate?
