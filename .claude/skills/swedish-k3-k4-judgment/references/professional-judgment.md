# Professional judgment areas

For each area: the rule, what the agent may do, and when a human (the client, a revisor or an auktoriserad redovisningskonsult) must decide.

## Contents
1. Choosing K2 or K3
2. Timing of a framework switch and comparatives
3. Borderline större/mindre företag
4. Materiality and error correction
5. Estimates
6. Fortsatt drift and kontrollbalansräkning (ABL 25 kap.)
7. Revisionsplikt
8. Sambandet mellan redovisning och beskattning
9. Documentation
10. Writing a judgment memo

---

## 1. Choosing K2 or K3

**Decision steps.**
1. Is the company a större företag, a parent preparing koncernredovisning, or caught by K2 1.1A-1.1C (see SKILL.md section 2)? → K3 (or K4) is mandatory.
2. Would K2 fail to give a rättvisande bild? Signals: significant development work, buildings with very different component lives, large temporary differences (deferred tax), significant financial instruments, long fixed-price contracts. → Choose K3.
3. Otherwise K2 is permitted.

**Switching.** K2→K3 is always allowed. K3→K2 is allowed only for a mindre företag that is not caught by the 2026 triggers.

**Why companies choose K3 voluntarily.** Capitalising development (raises equity, can matter for the kontrollbalansräkning test and lender covenants), expected growth past the större företag thresholds, lender or investor demands, group policy.

**Agent may:** run the trigger and threshold tests and present the facts. **Escalate:** the decision itself.

## 2. Timing of a framework switch and comparatives

- A switch takes effect from the start of a financial year.
- Larger companies restate comparatives (ÅRL 3 kap. 5 §); the transition date is the start of the comparative year.
- Smaller companies may skip restatement but must disclose the lack of comparability; the transition date is the start of the first K3 year.
- Collect component and deferred tax data during the year before the switch (see `k3-transition`).

## 3. Borderline större/mindre företag

- Större företag (ÅRL 1 kap. 3 §): exceeds more than one of >50 anställda (average), >40 MSEK balansomslutning, >80 MSEK nettoomsättning in **each of the two latest financial years**. Companies with listed securities are always större.
- One year above the thresholds does not change the category.
- Track all three metrics each year and warn the client in advance when the second year may tip the category (consequences: K3 mandatory, kassaflödesanalys, more notes, comparatives restated, revisionsplikt follows separately).
- First financial year has no history: escalate.
- Cross-check the current figures in `swedish-financial-reporting` before stating them; SOU 2026:59 proposals are not law.

## 4. Materiality and error correction

- Document the materiality thresholds used for the close.
- Never apply materiality to: legally required disclosures, related-party information, fraud indicators, ABL capital rules (kontrollbalansräkning, förbjudna lån, värdeöverföringar), or tax returns.
- Material errors in earlier years are corrected retroactively via comparatives and opening equity (10.12). Smaller companies may instead adjust the opening balance of the current year and disclose it (10.14).
- After an årsredovisning is registered, Bolagsverket does not reopen it for figure errors; correct in the next year's report under kapitel 10.

**Escalate:** any material prior-year error.

## 5. Estimates

| Estimate | Agent may | Escalate |
|---|---|---|
| Useful lives, residual values | Apply the approved plan; flag indications of change | New or changed plans; buildings |
| Impairment | Flag indicators with evidence | Any calculation and the amount |
| Provisions | Contract-based accruals | Litigation, restructuring, warranties beyond historical experience |
| Doubtful receivables | Ageing per approved policy | Large, group or related-party balances |
| Inventory obsolescence | Apply approved policy | Policy changes, large write-downs |
| Stage of completion | Compute from approved inputs | Revised total estimates, loss contracts |
| Deferred tax assets | Compute temporary differences | Recognition on tax losses |

Changes in estimates are prospective (kapitel 10). Changes in accounting principle are retroactive; do not mislabel one as the other.

## 6. Fortsatt drift and kontrollbalansräkning

**Fortsatt drift.** ÅRL 2 kap. 4 § presumes the company will continue. If there is material uncertainty, it must be disclosed (förvaltningsberättelse/note). Signals: negative or declining equity, liquidity gaps, overdue tax or employer contributions, lost financing, key customer loss, events after the balance sheet date.

**Kontrollbalansräkning (ABL 25 kap.).**
- **Trigger (25:13).** The board must "genast" prepare a kontrollbalansräkning, and have it audited if the company has a revisor, when there is reason to believe eget kapital is below half the registered aktiekapital, or when enforcement finds the company lacks attachable assets.
- **Adjustments (25:14).** When testing, assets may be revalued to net realisable value and other adjustments made consistent with god redovisningssed (see BFN's letter on kontrollbalansräkning and FAR RedR 2).
- **First kontrollstämma.** If the kontrollbalansräkning shows a shortfall, the board calls a kontrollstämma "snarast möjligt".
- **Restoration.** Within eight months of the first stämma, the **full** aktiekapital must be restored and verified in a new kontrollbalansräkning presented at a second kontrollstämma; otherwise the company must go into likvidation.
- **Liability.** Failure to act creates joint and several personal liability for the board (and those acting on the company's behalf) for obligations arising meanwhile.
- **Example.** Aktiekapital 25 000 → threshold 12 500.

**Agent rule.**
- At every close, compute eget kapital (2081-2099 plus the year-to-date result) and compare with 50 % of 2081.
- If it is below or close to the threshold, alert the human contact immediately and recommend involving a revisor or konsult. Note that obeskattade reserver (21xx) are not part of eget kapital in the books, but 79.4 % of them may be counted in the test; the human professional decides.
- Never conclude or sign off a kontrollbalansräkning.

**Status.** SOU 2023:34 proposed abolishing the kontrollbalansräkning rules for private AB (25 kap. 13-20 a §§) from 2025-07-01. No enactment has been found and BFN and FAR still describe the rules as applicable: treat them as **in force**.

## 7. Revisionsplikt

- **Rule (ABL 9 kap. 1 §).** A private AB needs a revisor if it exceeded more than one of >3 anställda, >1.5 MSEK balansomslutning, >3 MSEK nettoomsättning in each of the last two financial years.
- Always required for publika AB and for parents of groups above the thresholds. Bostadsrättsföreningar are always audited. Ekonomiska föreningar have their own rules.
- The same thresholds drive the K2 lättnadsregel, so one calculation serves both.
- SOU 2026:59 does **not** change revisionsplikt.

**Escalate:** first or short financial years, group parents, threshold crossings (a revisor must be elected and registered), requirements in the bolagsordning, ekonomiska föreningar.

## 8. Sambandet mellan redovisning och beskattning

**Material link (IL 14 kap. 2 §).** Taxable income is computed according to god redovisningssed unless tax law says otherwise. Where several alternatives are within god redovisningssed, the company's choice is followed. Skatteverket carries the burden of showing that the accounts deviate from god redovisningssed.

**Formal link.** These tax dispositions are only allowed if booked:
- periodiseringsfond (IL 30 kap.; Dr 8811 / Cr 2110-2129)
- överavskrivningar on inventarier (IL 18 kap.; Dr 8850 / Cr 2150)
- koncernbidrag (IL 35 kap.)
- ersättningsfonder

**No link (tax has its own rule):** building depreciation (IL 19 kap.), pensions (IL 28 kap.), näringsbetingade andelar (IL 24-25 a kap.), non-deductible costs, ränteavdragsbegränsningar (IL 24 kap.), deferred tax, uppskrivningar, many provisions (IL 16 kap.), the 97 % inventory schablon.

**Agent rule.** For every K3 choice that differs from K2 or from established tax practice, check the INK2 adjustment and the deferred tax effect, and note both in the judgment memo.

## 9. Documentation

**BFL 5 kap.**
- Every business event and every bokslutstransaktion needs a verifikation (5 kap. 6-7 §§).
- Systemdokumentation and behandlingshistorik (5 kap. 11 §; BFNAR 2013:2 kapitel 9) must describe the verification chain, processing rules and data flows. For API/MCP agents this means logging posting rules, mapping rules, parameter and version changes, and keeping the audit trail for staged and approved operations.

**BFL 7 kap. (SFS 2024:342, from 2024-07-01).**
- Räkenskapsinformation is kept for seven years after the end of the calendar year in which the financial year ended.
- After digitisation, paper originals need not be kept; this also applies to material digitised before 2024-07-01.
- BFN updated vägledning Bokföring on 16 September 2024.

**Bokslut.** Specify every balance sheet account in sidoordnad bokföring (avstämningar, specifikationer). Attach judgment memos to the relevant verifikationer.

## 10. Writing a judgment memo

Attach one to the voucher for every K3 judgment item. Keep it short and factual:

```
Judgment memo: <company>, <financial year>, <area, e.g. komponentindelning byggnad Storgatan 1>
Rule: <K3 point / ÅRL / IL reference>
Data: <sources, figures, dates>
Method: <how the figure was derived>
Alternatives considered: <and why rejected>
Tax effect: <INK2 adjustment, deferred tax>
Conclusion (proposed): <amount / treatment>
Status: proposed by agent; approved by <name, role> on <date>
```

An agent writes "proposed by agent" and leaves the approval line for the human. A memo without an approver is a draft, not a conclusion.
