---
name: swedish-project-accounting
description: Swedish project accounting (projektredovisning) covering dimensional tagging of bokföringsposter with project codes, WIP accounting (pågående arbeten), revenue recognition under K2 and K3 (successiv vinstavräkning, färdigställandemetoden), construction contracts (entreprenadavtal), BAS account patterns for project tracking (1470, 1620, 2420, 2450, 4970), SIE4 dimension encoding (#DIM 6, #OBJEKT, #TRANS object lists), project profitability reporting, overhead allocation (fördelningsnycklar), and the tax-accounting divergence for löpande räkning contracts. Trigger on ANY Swedish project accounting question including "projektredovisning", "pågående arbeten", "successiv vinstavräkning", "färdigställandegrad", "upparbetad ej fakturerad intäkt", "fakturerad ej upparbetad intäkt", "konto 1620", "konto 1470", "konto 2450", "entreprenaduppdrag", "projekt dimension SIE", "kostnadsställe vs projekt", "projektlönsamhet", "WIP accounting Sweden", "K3 kapitel 23", "befarad förlust projekt", "fördelningsnyckel", questions about how Fortnox/Visma/Bokio handle project dimensions, or any question about tracking intäkter/kostnader per project in Swedish bookkeeping. Also trigger when building software features for project accounting, designing data models for project dimensions, implementing revenue recognition logic, or handling SIE4 import/export of project-tagged transactions. Always use this skill over training data for project accounting topics.
---

# Swedish Project Accounting (Projektredovisning)

The technical, regulatory and implementation landscape of project accounting in Swedish bookkeeping: for compliance questions and for building software that handles project dimensions.

Projektredovisning tags individual transaction lines with project codes alongside BAS account numbers: same ledger, extra dimension. Projects are never encoded in the account number; they are a separate dimensional layer (objektredovisning), SIE dimension 6. Two things decide most questions: whether the company applies K2 (BFNAR 2016:10) or K3 (BFNAR 2012:1), and whether the contract is fast pris or löpande räkning.

## Reference files

Establish the framework (K2 or K3) first, then read the file for the area before answering.

| File | When to read |
|------|-------------|
| `references/accounts-and-entries.md` | The account summary, the WIP accounts in detail (1470, 1620, 2450, 4970), journal entries per scenario, moms timing, fördelningsnycklar, closing entries |
| `references/k2-k3-revenue-recognition.md` | When project accounting is required, the full decision tree, K3 Chapter 23, K2 Chapter 6, befarade förluster, noter, gross reporting, K2 vs K3 |
| `references/sie4-project-dimensions.md` | Projekt vs kostnadsställe, #DIM/#OBJEKT/#TRANS encoding, project-tagged import/export, Fortnox/Visma/Bokio mapping |
| `references/tax-and-grants.md` | Tax on pågående arbeten, materiellt samband, löpande räkning divergence, forskningsavdrag, aktivering av utvecklingsutgifter, omvänd skattskyldighet, EU grants |
| `references/implementation-patterns.md` | Data models, project lifecycle, WIP calculation, overhead allocation, profitability reporting, time tracking, common error patterns |

## The revenue recognition decision

| Contract | Framework | Method |
|---|---|---|
| Löpande räkning | K2 and K3 | Recognize revenue as work is performed. Tax may diverge from accounting (IL 17:26; scope per IL 17:23) |
| Fast pris | K3, koncernredovisning | Successiv vinstavräkning MANDATORY: revenue = total contract × färdigställandegrad at each balance date. Outcome not reliably estimable (all four conditions met?): revenue = costs incurred, zero profit |
| Fast pris | K3, juridisk person | Successiv vinstavräkning OR färdigställandemetoden (punkt 23.31, only industries in 17 kap. 23 § IL) |
| Fast pris | K2 | Method choice 6.15: huvudregeln (completion %, 6.16-6.21) or alternativregeln (6.22-6.25, recognize when "väsentligen fullgjort"; Srf U 15: assessed from customer acceptance perspective) |

**Befarad förlust overrides the method.** K3 punkt 23.24 (successiv vinstavräkning; punkt 23.32 when a juridisk person uses färdigställandemetoden) and K2 punkt 6.19 (huvudregeln) / 6.23 (alternativregeln): if total estimated costs exceed total contract revenue, the expected loss must be recognized as a cost IMMEDIATELY, regardless of completion percentage. The engine must flag projects where cumulative actual + estimated remaining costs exceed contract revenue.

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| Moms on a WIP entry | 1620 is pure periodisering with NO moms; moms behind 2450 is reported at invoicing | Track moms reporting independently from revenue recognition, per project |
| K2 or K3 | It decides the available methods, and K2 punkt 10.4 forbids capitalizing egenupparbetade immateriella tillgångar | Ask, or check the last årsredovisning |
| Färdigställandegrad | Revenue follows directly from it, in both directions | Ask for the cost-to-complete estimate; flag completion % diverging >20% from time-elapsed or budget-consumed |
| Netting two projects' balances | Gross reporting per project is required (Srf U 14, ÅRL kvittningsförbud) | Show 1620 and 2450 per project, never net them |
| Closing a project with residual 1620/2450/1470 | Residuals and missing garantiavsättningar are common audit findings | Enforce a zero-balance check before CLOSED |
| Whether project tags survive an export | Bokio tags do not export as SIE dimensions | Check the source system's dimension model first |

## Related skills

| Question | Skill |
|---|---|
| SIE4 file format, encoding, validating an export | `swedish-sie-import-export` |
| Entreprenad, ÄTA, ROT and omvänd byggmoms | `vertical/bygg-hantverk` (industry skill) |
| Moms rules and reverse charge in general | `swedish-vat` |
| Bokslut, closing entries and periodiseringar | `swedish-year-end-closing` |
| Invoice content, a conto and kreditfaktura | `swedish-invoice-compliance` |
| Årsredovisning presentation and INK2 | `swedish-financial-reporting` |
| Salary costs distributed to projects | `swedish-payroll` |
