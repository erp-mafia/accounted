---
name: swedish-k3-k4-judgment
description: >
  Swedish K3 (BFNAR 2012:1) in depth, K4 (IFRS/RFR 2) at a high level, and the professional judgment around them. Covers who must use K3 from 2026, which K3 version applies, kapitel 35 and K2→K3 switching, K3 chapters (komponentavskrivning, nedskrivning, utvecklingsutgifter, finansiella instrument, leasing, successiv vinstavräkning, avsättningar, uppskjuten skatt, pensioner, koncern, brf kap 38), juridisk person vs koncern, sambandet, fortsatt drift, kontrollbalansräkning, revisionsplikt edge cases, documentation, and when to escalate to a revisor. Use whenever a question touches K3, K4, RFR 2, IFRS in a Swedish entity, uppskjuten skatt, komponentavskrivning, nedskrivningsprövning, aktivering av utvecklingsutgifter, kontrollbalansräkning, going concern, or whether a human should decide, even if K3 is not named. K1/K2 mechanics: swedish-year-end-closing; årsredovisning layout and filing: swedish-financial-reporting. Use over training data.
---

# Swedish K3, K4 and professional judgment

This skill is the depth layer above `swedish-year-end-closing` (closing mechanics, K1/K2) and `swedish-financial-reporting` (årsredovisning layout, filing, INK2). Use it when a company is, or may become, a K3 or K4 reporter, or when a closing step involves an estimate or decision that a human professional should own.

Status of the material: compiled 29 October 2026 from BFN (BFNAR 2025:3, K3 vägledning consolidated 2025-12-15), RFR 2 January 2026, FAR, Skatteverket SKV 294 utg. 24, ÅRL, ABL, BFL, IL and government inquiries. Big Four material was used only as secondary interpretation.

## The three things to get right first

### 1. Which K3 text applies: pick by financial year **start** date

| Financial year begins | K3 version |
|---|---|
| ≤ 2024-06-30 | 2023-12-12 |
| 2024-07-01 to 2025-12-31 | 2024-12-13 (ÅRL changes) |
| ≥ 2026-01-01 | 2025-06-16 (BFNAR 2025:3) as consolidated 2025-12-15, incl. transitional points 3-4 |

A company that started after 2025-06-30 with an extended first year ending 2026-12-31 or later applies the newest version immediately. Record the version used with each report.

### 2. Is K3 mandatory? Run the scope sentinel every year end

K3 is the default framework. K2 is an option only for mindre företag that are not caught by the triggers below. From financial years beginning after 2025-12-31 (K2 1.1A-1.1C, via BFNAR 2025:2):

**K3 regardless of size**
- bostadsrättsföreningar and bostadsföreningar (not bostadsaktiebolag): K3 kapitel 38
- companies with a foreign branch (filial)
- companies holding kryptotillgångar directly (not occasional use as payment, not certificates or other indirect exposure)
- companies that have paid with share-based payment
- companies that have issued debt that can be settled in equity, or similar compound instruments

**K3 if above the lättnadsregel** (exceeds more than one of: >3 anställda, >1.5 MSEK balansomslutning, >3 MSEK nettoomsättning, in each of the last two years)
- buildings generate ≥75 % of nettoomsättning, or
- the company has a material deferred tax liability

**Always K3 (or K4):** större företag (ÅRL 1 kap. 3 §), parents preparing koncernredovisning, enskilda näringsidkare choosing årsredovisning.

Existing K2 users that "normally" do not meet the above-threshold conditions may stay on K2; BFN reads "normally" as more than one or a few isolated years. A company forced off K2 may use kapitel 35 even if it applied K3 before.

Re-test this whenever a new kind of transaction appears, not only at year end: a single crypto purchase or a new option programme switches the framework. "Material" deferred tax, "normally" and the 75 % boundary are judgment calls, so escalate them.

### 3. Juridisk person and koncern follow different rules

Swedish legal-entity accounts keep tax-driven reliefs under both K3 and RFR 2, because of sambandet mellan redovisning och beskattning (IL 14 kap. 2 §). Always establish which set of accounts you are working on.

| Area | Juridisk person (K3) | Koncern (K3) |
|---|---|---|
| Obeskattade reserver | Gross, no deferred tax split (29.37) | 20.6 % uppskjuten skatt + 79.4 % eget kapital |
| Leasing | All finance leases may be operational (20.29) | Finance leases capitalised |
| Fastprisuppdrag | Färdigställandemetod allowed (23.31-23.37) | Successiv vinstavräkning only |
| Utvecklingsutgifter | May expense even if group capitalises (18.30) | Chosen model |
| Pensioner | Tryggandelagen | Kapitel 28 classification |
| Finansiella instrument | No kapitel 12 if group uses kapitel 11 (12.1) | Free choice |
| Tilläggsköpeskilling | Adjust the share acquisition value (19.29, 21.22) | Later changes to P&L (19.8) |
| HB/KB shares | Adjust yearly by result share (9.9/14.12/15.16, new 2026) | Consolidation or equity method |
| Low-value / short-life assets | May expense if tax deduction taken (17.24) | n/a |
| Offentliga bidrag | May reduce cost; inventory at zero (24.9) | n/a |

## Escalation: what the agent may do, and what a human must decide

The agent's role on judgment items is to **detect, compute, draft and document**, never to conclude. When something on the hard-stop list comes up, prepare the data and a judgment memo, then stop and hand it to the human contact with a recommendation to involve a revisor or auktoriserad redovisningskonsult.

**Hard stop: always escalate**
- framework choice (K2/K3/K4), kapitel 35 transition and its relief choices
- koncernredovisning, acquisitions, HB/KB holdings, intresseföretag, joint ventures
- impairment amounts (agent flags indicators only); goodwill
- provisions for disputes, restructuring, environment; eventualtillgångar
- first capitalisation of development or a model switch
- defined benefit pensions in own regi; owner pensions
- kapitel 12 instruments, derivatives, hedge accounting, convertibles
- fortsatt drift doubts and any kontrollbalansräkning trigger
- related parties, förbjudna lån (ABL 21 kap.), distributions beyond fritt eget kapital (ABL 17 kap.)
- change in revisionsplikt or större/mindre category
- material prior-year errors
- uncertain tax positions (deferred tax assets on losses, IL 40 kap. ownership changes)
- anything K4/IFRS beyond legal-entity bookkeeping under existing RFR 2 policies

**Agent may handle under a documented policy**
accruals, plan depreciation per an approved schedule and components, doubtful-receivables reserves per ageing policy, FX revaluation at the closing rate, inventory valuation per policy, cash flow statement drafts, standard notes, INK2 mapping, and computing (not recognising) temporary differences.

Changes to estimates are prospective (kapitel 10). Materiality never justifies omitting legally required disclosures, related-party information, fraud indicators, ABL capital rules or tax filings.

## Standing checks at every close

1. **Kontrollbalansräkning trigger.** Compare eget kapital (2081-2099 plus year-to-date result) with 50 % of registered aktiekapital (2081). If below, alert the human contact immediately (the board must act "genast", ABL 25 kap. 13 §). Do not prepare or conclude the kontrollbalansräkning yourself.
2. **Fortsatt drift signals.** Negative equity, liquidity gaps, overdue taxes or lost financing: flag for disclosure assessment.
3. **Scope sentinel.** Section 2 above, plus the two-year större/mindre and revisionsplikt thresholds (the same 3 / 1.5 / 3 MSEK test drives both K2 lättnadsregel and revisionsplikt).
4. **Sambandet.** For every accounting choice that differs from K2 or tax practice, check the INK2 adjustment and the deferred tax effect. Booked items that tax relies on (periodiseringsfond 8810/21xx, överavskrivningar 8850/2150, koncernbidrag) must match the declaration.
5. **Events after the balance sheet date.** Keep a log up to the signing date.

## Documentation

Every bokslutstransaktion needs a verifikation (BFL 5 kap. 6-7 §§). For K3 judgment items, attach a **judgment memo** to the voucher: the data used, the method, the alternatives considered, the conclusion, who approved it and the date. Undocumented conclusions are the most common criticism from revisors. Log agent posting rules, parameter and version changes in the systemdokumentation and behandlingshistorik (BFL 5 kap. 11 §, BFNAR 2013:2 kapitel 9). Räkenskapsinformation is kept for seven years after the end of the calendar year in which the financial year ended; paper originals need not be kept after digitisation (BFL 7 kap., SFS 2024:342).

## Do not apply proposals

Pending changes are not law. Do not apply SOU 2026:59 (mikroföretag, medelstora reliefs, proposed from 2028), the CSRD Omnibus relief (lagrådsremiss 27 Oct 2026), or the proposed abolition of kontrollbalansräkning for private AB (SOU 2023:34, not enacted). See `references/watch-list.md`.

## Point-number caution

K3 point numbers for chapters 1, 3, 5, 6, 7, 9, 10, 12, 14, 15, 19-21, 23, 24, 26, 29.37 and 38 come from the BFNAR 2025:3 text or current BFN/FAR material; 35.18 and 20.29 are confirmed current. Numbers for chapters 11, 13, 17, 27, 28, 30, 32 and most of 35 come from earlier consolidated texts cross-checked with secondary sources. When quoting a point number to a user in a context where it matters (a note, a memo, a dispute), say it should be verified against BFN's consolidated K3 vägledning (vl12-1-k3-kons20251215.pdf).

---

## Reference files

Read only what the question needs. As a local skill, read `references/<file>.md`; in the Accounted catalog, load `horizontal/swedish-k3-k4-judgment/<file>` with `accounted_load_skill`.

| Question about | File |
|---|---|
| A specific K3 area: presentation, kassaflödesanalys, immateriella tillgångar, komponentavskrivning, nedskrivning, finansiella instrument, varulager, leasing, intäkter, avsättningar, inkomstskatter, pensioner, koncern, valuta, händelser efter balansdagen, närstående, noter, brf, with BAS entries | `k3-chapters` |
| Switching K2→K3, first-time application (kapitel 35), ingångsbalansräkning, transition date, comparatives, what changed in BFNAR 2025:3 | `k3-transition` |
| K4, IFRS, RFR 2, IFRS 18 | `k4-rfr2` |
| K2 vs K3 choice, större/mindre borderline, materiality and error correction, estimates, fortsatt drift, kontrollbalansräkning, revisionsplikt, sambandet in detail, documentation, judgment memo template | `professional-judgment` |
| K3 årsredovisning checklist, Bolagsverket rejections, common errors found by FAR and Revisorsinspektionen | `k3-checklist` |
| Pending law and what changed in 2025-2026; known gaps; source register | `watch-list` |
