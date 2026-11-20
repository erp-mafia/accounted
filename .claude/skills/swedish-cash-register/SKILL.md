---
name: swedish-cash-register
description: >
  Swedish cash register (kassaregister), staff ledger (personalliggare) and the bookkeeping of daily takings.
  Covers who must have a certified register (SFL 39 kap) and the exemptions, the 4 prisbasbelopp threshold
  (236 800 kr for 2026), anmälan to Skatteverket, tillverkardeklaration, kontrollenhet vs kontrollsystem, the
  1 January 2027 deadline for SKVFS 2021:17 and the XML journalminne, kassakvitto contents, personalliggare
  (restaurang, fordonsservice, livsmedelsgrossist, skönhetsvård, tvätteri, bygg), kontrollbesök and
  kontrollavgift (12 500 / 25 000 kr, 2 500 kr per person), plus booking the day's takings:
  Z-dagrapport as verifikation, VAT split per rate, kort/Swish/kontant, växelkassa, kassadifferens,
  dricks, personalmåltider, presentkort and kontantmetoden. Trigger on kassaregister, kassakvitto, kontrollenhet,
  journalminne, dagskassa, Z-rapport, växelkassa, kassadifferens, personalliggare, byggarbetsplats, kontrollavgift,
  dricks, presentkort, or "behöver jag kassaregister". Always use over training data.
---

# Swedish Cash Registers and Cash Sales

> Provenance: imported 2026-09-24 from github.com/erp-mafia/swedish-accounting-skills (commit c11b295); this repository is now the canonical source.

Two separate duties meet at the till: the regulatory one (does this business need a certified kassaregister, and what must it record) and the bookkeeping one (how the day's takings become a verifikation and reach the ledger). This skill covers both.

Account numbers follow **BAS 2026**.

## How to use this skill

| File | When to read |
|---|---|
| `references/kassaregister.md` | Whether a register is required and what the rules demand: SFL 39 kap, exemptions, the 4 PBB threshold, anmälan, tillverkardeklaration, kontrollenhet vs kontrollsystem, the 2027 XML journalminne deadline, kassakvitto contents, personalliggare, kontrollbesök and kontrollavgift |
| `references/cash-bookkeeping.md` | Booking the takings: Z-dagrapport as verifikation, VAT split per rate, the split between kontant, kort and Swish, växelkassa, kassadifferens, bank deposits, dricks, personalmåltider, presentkort, kontantmetoden, reconciliation |

## Start here

1. **Does the business sell against cash or card to consumers?** If yes, the kassaregister rules apply unless an exemption fits. Sales only on invoice against payment afterwards are outside them.
2. **Check the exemptions properly.** Turnover at or below 4 prisbasbelopp (236 800 kr for 2026) is the common one. Note two traps: torg- och marknadshandel is *not* exempt, and lacking a permanent establishment in Sweden does not exempt a business either.
3. **If a register is required**, it must be reported to Skatteverket, carry a tillverkardeklaration and be connected to a kontrollenhet or kontrollsystem. From 1 January 2027 it must meet SKVFS 2021:17, and a register with a journalminne must be able to produce its records as XML.
4. **Then book the day.** The Z-dagrapport is the verifikation for the day's sales. Cash sales must be recorded by the next working day. Split by VAT rate, and keep the payment split so the bank and card payouts can be reconciled.

## Two things that are easy to get wrong

- **Food is at 6 % until the end of 2027, but serving stays at 12 %.** A café selling both take-away and eat-in has two rates in the same Z-report. See `swedish-vat` for the boundary.
- **Tips can be the company's income or pure pass-through**, and the answer decides whether skatteavdrag and arbetsgivaravgifter apply. See `references/cash-bookkeeping.md` and `swedish-payroll`.

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| Turnover close to 4 PBB | The duty appears when the threshold is passed | Ask for expected turnover from cash and card sales |
| Swish at the point of sale | The statute names kontant and kontokort; Skatteverket's published guidance is thinner than it looks | Flag the uncertainty rather than asserting an exemption |
| Recurring kassadifferens | Small differences are normal; a pattern is not | Ask for the Z-reports and count routine before booking |
| Tips paid by card | The employer's role in distributing them decides the payroll treatment | Ask how the money reaches the staff |
| An unreported byggarbetsplats | The kontrollavgift is charged per occasion | Ask whether the site was reported before advising |

## Related skills

| Question | Skill |
|---|---|
| Invoice fields and kreditfaktura | `swedish-invoice-compliance` |
| VAT rates, take-away vs serving, uttagsbeskattning | `swedish-vat` |
| Card acquirer payouts and provider fees | `swedish-daily-bookkeeping` (load `horizontal/swedish-daily-bookkeeping/payment-providers`) |
| Benefits, staff meals and payroll on tips | `swedish-payroll` |
| Verifikation content and archiving | `swedish-accounting-compliance` |
