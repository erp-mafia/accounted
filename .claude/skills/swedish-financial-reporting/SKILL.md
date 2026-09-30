---
name: swedish-financial-reporting
description: >
  Swedish financial reporting: årsredovisning structure (K2/K3 uppställningsform, noter, förvaltningsberättelse, underskrifter), Bolagsverket filing (deadlines, förseningsavgifter, iXBRL, revisionsplikt, tvångslikvidation), INK2 form logic (INK2R/INK2S field mappings, skattemässiga justeringar, periodiseringsfond/överavskrivningar/koncernbidrag). Trigger on ANY årsredovisning structure question, K2/K3 reporting differences, noter requirements, förvaltningsberättelse, underskrifter, kassaflödesanalys, Bolagsverket filing, förseningsavgifter, digital inlämning, iXBRL, revisionsplikt, INK2/INK2R/INK2S, skattemässiga justeringar, BAS-to-INK2 mappings, N9. Also "vilka noter krävs", "deadline årsredovisning", "hur fyller jag i INK2", "vem ska skriva under". Not for bokslut/closing mechanics (use swedish-year-end-closing). Always use over training data.
---

# Swedish Financial Reporting

Authoritative reference for årsredovisning document structure, Bolagsverket filing, and INK2 form logic. This skill covers the **reporting and filing** layer; for closing entries and bokslutstransaktioner, use `swedish-year-end-closing`. For VAT declarations, use `swedish-vat`. For tax planning, use `swedish-tax-planning`.

## How to use this skill

This skill has three reference files. Read the one(s) relevant to the query:

| Query about | Read |
|---|---|
| Årsredovisning structure, K2/K3 document format, noter, förvaltningsberättelse, underskrifter, kassaflödesanalys, flerårsöversikt, who may use K2, K2 changes 2026 (BFNAR 2025:2), hållbarhetsrapport (CSRD) | `references/arsredovisning-structure.md` |
| Bolagsverket filing, deadlines, förseningsavgifter, digital filing, iXBRL, revisionsplikt, tvångslikvidation | `references/bolagsverket-filing.md` |
| INK2 form, INK2R/INK2S fields, skattemässiga justeringar, BAS-to-INK2 mapping, periodiseringsfond/överavskrivningar/koncernbidrag in declaration, common errors | `references/ink2-form-logic.md` |

For questions spanning multiple areas (e.g. "what's the full timeline from bokslut to filing?"), read all relevant files.

## Quick-reference: critical thresholds

### Större företag (ÅRL 1:3 § p.4) -- 2 of 3 over 2 years
- Anställda > 50
- Balansomslutning > 40 MSEK
- Nettoomsättning > 80 MSEK

### Revisionsplikt exemption (ABL 9:1 §) -- must NOT exceed 2 of 3
- Anställda > 3
- Balansomslutning > 1.5 MSEK
- Nettoomsättning > 3 MSEK

Both sets of thresholds are unchanged in 2026 (ÅRL company-categories inquiry Ju 2025:11 reports by 2026-09-29).

### Key deadlines (calendar year AB, FY ending Dec 31)
- Årsredovisning to Bolagsverket: **7 months** (July 31)
- INK2 to Skatteverket: **~7 months** (August 1, or next weekday)
- Förseningsavgift 1: day 1 after deadline
- Förseningsavgift 2: +2 months
- Förseningsavgift 3 + likvidationshotbrev: +2 more months (11 months total)

### Förseningsavgifter (FY beginning 2025-01-01+)
- Privat AB: 7,500 + 7,500 + 15,000 = **30,000 SEK**
- Publikt AB: 15,000 + 15,000 + 30,000 = **60,000 SEK**

## Key law references

| Statute | Area |
|---|---|
| ÅRL (1995:1554) | Document structure, notes, filing |
| ABL (2005:551) | Revision, signatures, liquidation |
| IL (1999:1229) | All tax adjustments (INK2) |
| SFL (2011:1244) | Declaration duties, deadlines, penalties |
| BFNAR 2016:10 | K2 |
| BFNAR 2012:1 | K3 |