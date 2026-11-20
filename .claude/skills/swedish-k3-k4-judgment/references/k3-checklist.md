# K3 årsredovisning checklist and common errors

## Checklist (legal entity, aktiebolag)

1. **Framework and category.** Confirm the framework and K3 version by financial year start. Confirm the större/mindre category, revisionsplikt and whether a kassaflödesanalys is required.
2. **First K3 year.** Ingångsbalansräkning, component split from carrying amount (35.18), deferred tax, relief choices, disclosures (35.31 / 35.33 / 35.33A). See `k3-transition`.
3. **Reconciliations.** Reconcile and specify every balance sheet account; a verifikation for every closing entry.
4. **Fixed assets.** Components and depreciation per plan, impairment indicators, 2089 Fond för utvecklingsutgifter for capitalised development.
5. **Working capital.** Inventory (count attendance, FIFO or average, lägsta värdets princip), osäkra kundfordringar (1515/1519), pågående arbeten (method, loss contracts).
6. **Accruals and provisions.** Förutbetalda/upplupna (17xx/29xx), avsättningar (22xx), eventualförpliktelser and ställda säkerheter.
7. **Tax.** Current tax (Dr 8910 / Cr 2510), deferred tax (2240/1370/8940), obeskattade reserver gross, INK2 adjustments.
8. **Leasing, pensions and FX.** 20.29 policy and disclosures, pension costs with särskild löneskatt (7533/2514), closing-rate revaluation.
9. **Related parties and going concern.** Related-party transactions, loans to board/CEO and förbjudna lån, events after the balance sheet date, fortsatt drift, kontrollbalansräkning trigger.
10. **Statements and notes.** Balance sheet and income statement per ÅRL bilagor; equity specification; kassaflödesanalys if required; notes with comparatives for larger companies (3.5); förvaltningsberättelse per ÅRL 6 kap. (for brf, 38.2-38.12).
11. **Sign-off.** Signatures and dates from all board members and the CEO; revisionsberättelse dated after the årsredovisning is signed; årsstämma within six months of year end (ABL 7 kap. 10 §).
12. **Filing.** Fastställelseintyg (ÅRL 8 kap. 3 §) attached; file with Bolagsverket within seven months of year end.

## What Bolagsverket rejects

Bolagsverket checks form, not figures. Its own (old, 2012) defect statistics rank the top three as: missing revisionsberättelse, unsigned årsredovisning, missing fastställelseintyg. Use the ranking, not the numbers. Common rejection grounds:
- Fastställelseintyg missing, unsigned or not an original. It must be signed by a board member or the CEO, be in Swedish, state the date of the årsstämma and that the balance sheet and income statement were adopted, and state the stämma's decision on the disposition of profit.
- Missing signatures or signing dates on the årsredovisning.
- Missing revisionsberättelse when the company has a revisor.
- Wrong date order: the stämma must come after the revisionsberättelse.
- A stämmoprotokoll filed instead of the fastställelseintyg.
- A digital filing left uncompleted after signing.

**Late filing.** For financial years beginning 2025-01-01 or later, a private AB pays a förseningsavgift of 7 500 kr (15 000 kr for a publikt AB) if the report is not received within seven months of year end, with further charges after two and four more months. A company with no complete report within eleven months risks a föreläggande om likvidation. Details in `swedish-financial-reporting`.

## Common substantive errors

**From FAR quality control 2025 (published July 2026)**: 88 % of revisors passed (87.5 % in 2024). Recurring deficiencies: related-party transactions and documentation.

**From Revisorsinspektionen decisions 2025-2026:**
- inventory not verified (no count attendance)
- revenue completeness not tested
- prohibited loans to owners or board not detected
- reliance on oral statements without documentation
- revisionsberättelser issued before all board members had signed
- duplicate revisionsberättelser
- false statements about restored equity after a kontrollbalansräkning

**K3 switchers in 2026:**
- no deferred tax in the ingångsbalansräkning
- building depreciation recalculated retroactively (contrary to 35.18)
- previously expensed development capitalised (contrary to 35.16)
- missing first-time-application disclosures
- forgotten 2089 Fond för utvecklingsutgifter
