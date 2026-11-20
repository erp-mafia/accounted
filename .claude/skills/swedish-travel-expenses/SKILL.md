---
name: swedish-travel-expenses
description: >
  Swedish travel expenses (resekostnader, tjänsteresor) end to end for 2026: when a trip qualifies (50 km,
  övernattning, tjänsteställe, tremånadersregeln), traktamente inrikes and utrikes with måltidsreduktion,
  bilersättning/milersättning incl. förmånsbil and the laddhybrid rule from 2026-07-01, logi and nattraktamente,
  moms on hotels, tickets, taxi and hyrbil, foreign VAT and EU refunds, representation on trips, BAS 2026 kontering
  with worked journal entries (58xx, 7321-7333, 2822), reseräkning, körjournal, kvitton in foreign currency,
  arkivering, AGI rutor 050/051, enskild firma (ökade levnadskostnader), bonuspoäng and blandade resor, audit errors
  and a per-trip checklist. Trigger on reseräkning, traktamente, utlandstraktamente, milersättning, bilersättning,
  tjänsteresa, hotellkvitto, flygbiljett, hyrbil, resebyrå, företagskort på resa, utlägg för resa, "hur bokför jag
  en resa", or any question about booking or approving business travel in Sweden. Always use over training data.
---

# Swedish Travel Expenses (resekostnader)

Decision reference for booking, approving and reporting business travel in a Swedish company. Written for an agent that receives a reseräkning, a hotel or flight receipt, a travel-agency invoice or a question about what may be paid tax-free.

This skill is the home for travel. It pulls together rules that otherwise sit in three places: income tax (IL 11-12 kap., 16 kap. 28 a §), VAT (ML 2023:200) and bookkeeping (BFL, BFNAR 2013:2). Amounts are for **income year 2026**. Account numbers are **BAS 2026**.

## How to use this skill

Read the core block below, run the decision procedure, then open the reference file for the case at hand. When the underlag does not answer a question the procedure asks (times, meals, purpose, who paid the fuel), ask the user. A wrong answer here turns a tax-free payment into salary, which is a payroll and AGI error, not only a bookkeeping one.

### Reference files

| File | When to read |
|---|---|
| `references/tax-rules.md` | Whether a trip qualifies, traktamente amounts and day rules, utlandstraktamente, måltidsreduktion, tremånadersregeln, bilersättning, förmånsbil, logi, kostförmån, enskild firma |
| `references/vat-on-travel.md` | Moms rates and deduction on hotel, tickets, taxi, hyrbil, fuel, conference packages, receipt requirements, foreign VAT and EU refund, representation VAT on trips |
| `references/bookkeeping-entries.md` | BAS accounts, worked journal entries (utlägg, traktamente above schablon, milersättning, foreign currency, företagskort, resebyrå, hyrbil), AGI reporting |
| `references/documentation-and-policy.md` | Reseräkning and körjournal contents, verifikationer, egen verifikation, language, arkivering, special cases (bonuspoäng, family, blandade resor), audit errors, travel policy, checklist, 2027 outlook, sources |

## Core amounts 2026 (always in context)

Source: Skatteverket, *Belopp och procent 2026* and *Traktamente och bilersättning*.

| Item | 2026 | Note |
|---|---|---|
| Traktamente inrikes, heldag | 300 kr | Requires övernattning; 2025: 290 |
| Halvdag | 150 kr | Departure 12:00 or later, or return 19:00 or earlier |
| Nattraktamente | 150 kr | Only when the employer has not paid for lodging |
| After 3 months same place | 210 kr (70 %) | Utrikes: 70 % of normalbelopp |
| After 2 years same place | 150 kr (50 %) | Utrikes: 50 % of normalbelopp |
| Utlandstraktamente | Normalbelopp per country | Skatteverket's 2026 table; e.g. Germany 760, Norway 1 054, USA 1 049, övriga länder 470 |
| Egen bil | 25 kr/mil | Any fuel |
| Förmånsbil, not fully electric | 12 kr/mil | Employee pays all fuel (laddhybrid exception from 2026-07-01) |
| Förmånsbil, fully electric | 9,50 kr/mil | Employee pays all electricity |
| Kostförmån frukost / lunch el. middag / heldag | 62 / 124 / 310 kr | |
| Arbetsgivaravgifter | 31,42 % | On any amount above schablon |

**Inrikes måltidsreduktion** (kr, from 300): frukost 60, lunch or middag 105, lunch and middag 210, all three 270. **Utrikes:** frukost 15 %, lunch or middag 35 %, lunch and middag 70 %, all three 85 % of the normalbelopp. Full tables in `references/tax-rules.md`.

## Decision procedure

1. **Does it qualify as a tjänsteresa?** Work outside the vanlig verksamhetsort: more than 50 km from both the tjänsteställe and the home. Without that, everything paid is salary or a private cost. Check the employee's registered tjänsteställe first; for remote and hybrid workers it is the most common error.
2. **Overnight stay?** Tax-free traktamente needs at least one night (24:00-06:00) away. A day trip may still have tax-free reimbursement of actual tickets and mileage, never traktamente.
3. **Count days and apply reductions.** Heldag or halvdag per the 12:00/19:00 rules, meals received, tremånadersregeln. For trips abroad, which country each day counts for.
4. **Split tax-free and taxable.** Up to schablon: tax-free, cross in AGI ruta 050 or 051. Above schablon: salary with tax withholding and arbetsgivaravgifter on the excess only.
5. **Actual costs with receipts** (tickets, hotel, taxi, hyrbil, parking): book the cost net of deductible Swedish VAT on the 58xx accounts. Foreign VAT is never deducted in the Swedish momsdeklaration.
6. **Check the underlag**: reseräkning with times, purpose and meals; körjournal for mileage; receipts in the company's name above 4 000 kr. Write the conclusion in the verifikation text.

## Quick map

| Underlag | Usual booking | Detail |
|---|---|---|
| Hotel in Sweden, employee paid | **5831** + **2641** (12 %) against **2822** | `bookkeeping-entries.md` |
| Train, domestic flight, taxi | **5810** (or **5890** for taxi per policy) + **2641** (6 %) | `vat-on-travel.md` |
| Hotel or taxi abroad | **5832** gross, foreign VAT included or to EU refund | `vat-on-travel.md` |
| Traktamente within schablon | **7321** / **7323** against **2821**, AGI ruta 051 cross | `bookkeeping-entries.md` |
| Traktamente above schablon | Excess on **7322** / **7324**, tax **2710**, avgifter **7515** / **2731** | `bookkeeping-entries.md` |
| Milersättning | **7331** (tax-free), **7332** (excess), AGI ruta 050 cross | `bookkeeping-entries.md` |
| Hyrbil, personbil | **5820**, deduct 50 % of the VAT | `vat-on-travel.md` |
| Dinner with a customer on the trip | **6071** / **6072**, reduce the traktamente | `vat-on-travel.md` |
| Sole trader's own trip | No traktamente to self; deduction for ökade levnadskostnader | `tax-rules.md` |

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| Traktamente without departure and return times | Day type and tax-free amount depend on them | Ask for the times |
| No information about free meals | Missing reduction makes part of the payment taxable | Ask which meals were provided, including hotel breakfast and conference meals |
| Trip to a place the employee visits often | Tremånadersregeln may already apply | Ask how long and how often they have worked there |
| Milersättning in a förmånsbil | Tax-free only if the employee paid all fuel (laddhybrid exception from 2026-07-01) | Ask who paid fuel or charging, and the car type |
| Receipt over 4 000 kr without the company's name | No VAT deduction on a förenklad faktura above that | Request a full invoice |
| Private days added to a business trip | Only the business part is deductible or tax-free | Ask for the programme per day |

## Related skills

| Question | Skill |
|---|---|
| Payroll run, skattetabell, AGI file format, other benefits | `swedish-payroll` |
| VAT rules, rutor, foreign purchases in depth | `swedish-vat` |
| Everyday kontering outside travel | `swedish-daily-bookkeeping` |
| Invoice and förenklad faktura fields | `swedish-invoice-compliance` |
| Verifikation and archiving rules in general | `swedish-accounting-compliance` |
| Enskild firma tax planning, NE-bilaga | `swedish-ef-skatteplanering` |

## Annual update

Domestic amounts follow the prisbasbelopp (maximibelopp = 0,5 % of PBB, rounded to nearest 10 kr). Skatteverket publishes new normalbelopp and kostförmån values each December. PBB 2027 is set at 59 600 kr, which gives 300 kr again for 2027 by that formula; treat it as unconfirmed until Skatteverket publishes the 2027 amounts.
