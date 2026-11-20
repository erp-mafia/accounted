# Tax rules for business travel (income year 2026)

Income-tax side of travel: what qualifies, what may be paid tax-free, and what becomes salary. VAT is in `vat-on-travel.md`; kontering and AGI in `bookkeeping-entries.md`.

## Contents

1. Definitions: tjänsteresa, vanlig verksamhetsort, tjänsteställe
2. Traktamente: conditions and day rules
3. Utlandstraktamente
4. Måltidsreduktion and kostförmån
5. Tremånadersregeln, tvåårsregeln, dubbel bosättning
6. Bilersättning
7. Logi
8. Enskild näringsidkare and handelsbolag
9. Aktiebolag owner-employees

## 1. Definitions

- **Tjänsteresa** is a trip in the course of employment to work somewhere other than the normal place of work. **Arbetsresa** (home to regular workplace) is private: never reimbursed tax-free. The employee may deduct commuting costs above 15 000 kr in their own return.
- **Vanlig verksamhetsort** is the area within 50 km of the tjänsteställe plus the area within 50 km of the home, measured along the nearest route (IL 12 kap. 7 §). Crossing water or a border does not change the measurement.
- **Tjänsteställe** is where the employee does the main part of the work (IL 12 kap. 8 §). For work done while travelling or at changing sites, it is usually where work materials are picked up and returned or work is prepared and finished. One tjänsteställe per employer. The employer decides it and should document it. Skatteverket has a ställningstagande on employees who may choose to work elsewhere than the workplace; check it for hybrid and remote staff.
- **Övernattning**: tax-free traktamente requires at least one night away (the period 24:00-06:00) outside the vanlig verksamhetsort.

## 2. Traktamente: conditions and day rules

Three conditions for tax-free traktamente (Skatteverket, employer guidance):

1. A tjänsteresa with övernattning more than 50 km from both the tjänsteställe and the home.
2. The amount paid does not exceed the schablon.
3. The employer has underlag, normally a reseräkning.

| Day | 2026 | Rule |
|---|---|---|
| Heldag | 300 kr | Departure day if leaving before 12:00, return day if back after 19:00, and every day in between |
| Halvdag | 150 kr | Departure at 12:00 or later, or return at 19:00 or earlier |
| Nattraktamente | 150 kr | Trip covers 24:00-06:00 and the employer has not paid for lodging |

- **Above schablon:** the excess is salary. Withhold tax and pay arbetsgivaravgifter on the excess only.
- **Below schablon:** allowed. The employee may claim the difference as a deduction in their own return. Still report the cross in AGI ruta 051.
- **Day trips:** traktamente for a trip without övernattning is always taxable salary.

## 3. Utlandstraktamente

- Use Skatteverket's **normalbelopp** for the country (excludes lodging). Half day and night: half the normalbelopp. 70 % after three months, 50 % after two years.
- Skatteverket publishes the table yearly and as CSV/API (Skatteverket's open data portal). Load it into the payroll system rather than typing figures.
- Examples 2026: Denmark 1 226, Norway 1 054 (2025: 1 095), Finland 968, Germany 760, France 850, Italy 802, Spain 635, UK 901, USA 1 049, Switzerland 1 332, Belgium 897. Countries not listed: **övriga länder och områden 470 kr**.
- Which country a day counts for (departure day, return day, transit, several countries in one day) is set out in SKV A 2025:5. The detailed wording was not retrieved for this skill; read the allmänna råd for edge cases rather than guessing.

**Example.** Germany. Leave Monday 06:00, return Wednesday 20:00. Hotel breakfast compulsorily included in the room price Tuesday and Wednesday.

| Day | Calculation | Tax-free |
|---|---|---|
| Monday | Heldag | 760 |
| Tuesday | 760 − 15 % (114) | 646 |
| Wednesday | 760 − 15 % (114) | 646 |
| Total | | **2 052 kr** |

No kostförmån, because breakfast was compulsorily included in the room price.

## 4. Måltidsreduktion and kostförmån

**Inrikes 2026** (kr). The column follows the amount that applies to the day.

| Meals provided | Full (300) | 70 % (210) | Half (150) | 30 % (90)* |
|---|---|---|---|---|
| Frukost, lunch and middag | 270 | 189 | 135 | 81 |
| Lunch and middag | 210 | 147 | 105 | 63 |
| Lunch or middag | 105 | 74 | 53 | 32 |
| Frukost | 60 | 42 | 30 | 18 |

*30 % column: an employee's own deduction for trips longer than three months without traktamente, and dubbel bosättning.

**Utrikes:** percentage of the normalbelopp. All three meals 85 %, lunch and middag 70 %, lunch or middag 35 %, frukost 15 %.

Domestic percentages are 20/35/70/90, so 10 % (30 kr) remains when all meals are free in Sweden and 15 % abroad. Some websites show a 45 kr domestic breakfast reduction; that is 15 % and wrong for domestic trips.

**Reduce traktamente or tax a kostförmån?** (Skatteverket)

| Situation | Reduce traktamente | Taxable kostförmån |
|---|---|---|
| Free meals on a tjänsteresa (main rule) | Yes | Yes |
| Hotel breakfast compulsorily included in the room price | Yes | No |
| Meal compulsorily included in a transport ticket | No | No |
| Extern representation | Yes | No |
| Intern representation | Yes | No |

Kostförmån 2026: frukost 62 kr, lunch or middag 124 kr, heldag 310 kr.

A meal included in a conference package is a free meal: it reduces traktamente and is a kostförmån unless the conference qualifies as representation.

## 5. Tremånadersregeln, tvåårsregeln, dubbel bosättning

- More than three months in a row at one and the same place: tax-free amount drops to 70 % (210 kr; 70 % of normalbelopp abroad). After two years: 50 %. Beyond that, rules for **tillfälligt arbete** apply to deductions, including lodging.
- The trip is broken only by an interruption where the work moves elsewhere for at least four weeks.
- From 2026, SKV A 2025:5 (replacing SKV A 2023:14): extend the three-month period by breaks shorter than four weeks and by holiday and sick days, but only for time the employee would otherwise have worked.
- The three-month rule does not apply to work done while constantly travelling (for example lorry drivers, pilots).
- **Dubbel bosättning** (moved for work, family home kept) has its own deduction rules in IL 12 kap. Treat employer payments as salary unless the rules for tax-free coverage are clearly met; this skill does not cover them in depth.

## 6. Bilersättning

| Car | 2026 tax-free | Condition |
|---|---|---|
| Egen bil (any fuel) | 25 kr/mil (2,50 kr/km) | Business driving documented in körjournal |
| Förmånsbil, not fully electric | 12 kr/mil | Employee paid all fuel for the trips |
| Förmånsbil, fully electric | 9,50 kr/mil | Employee paid all electricity |

- If the employee paid only part of the fuel (for example charged at home and at work on the employer's account), all car allowance for the förmånsbil is salary. The employer can never reimburse actual fuel costs tax-free.
- **From 2026-07-01** (IL 12 kap. 5 § third paragraph, SFS 2026:464): a **plug-in hybrid** förmånsbil keeps the 12 kr/mil even when charged with electricity the employer provides at the workplace. The tax exemption for workplace charging became permanent at the same time. Does **not** apply to fully electric förmånsbilar.
- **Trängselskatt, parking, bridge tolls** on a business trip in the employee's own car: reimbursed at actual cost on top of mileage (**7333** for trängselskatt). Trängselskatt the employer pays for private trips is a benefit (**7391**).
- **Drivmedelsförmån** (employer pays fuel for private driving in a förmånsbil): market value incl. VAT for arbetsgivaravgifter, and market value incl. VAT × 1,2 for tax withholding.
- Public transport used on a business trip: actual ticket cost, tax-free.

## 7. Logi

- Employer-paid hotel on a business trip: no benefit. Book at actual cost.
- Nattraktamente (150 kr inrikes, half normalbelopp abroad) only if the employer has not paid lodging, for example when staying with friends.
- Employee's own deduction: actual lodging cost; if the cost cannot be shown but the night can, 150 kr per night in 2026.

## 8. Enskild näringsidkare and handelsbolag

- A sole trader cannot pay salary, traktamente or milersättning to themselves.
- IL 16 kap. 28 a § gives a deduction for **ökade levnadskostnader** on business trips with övernattning outside the vanlig verksamhetsort, applying the employee rules ("tjänsteresa" read as "resa i näringsverksamheten"). Same 2026 amounts and reductions. Beyond three months, actual extra costs.
- Business driving in a private car: 25 kr/mil.
- Actual costs (hotel, tickets) are booked as normal, with VAT deduction.
- Common practice (secondary sources, not verified in a primary source): book the schablon deduction on a 58xx cost account against **2018** Övriga egna insättningar, so it reaches the NE-bilaga through the result. Confirm the client's method before booking.
- Egenavgifter (28,97 %) are calculated on the surplus, so the deduction also reduces egenavgifter.
- Handelsbolag partners who are natural persons follow the same rules for their share.

## 9. Aktiebolag owner-employees

An owner who is employed by the AB is an employee. The AB may pay tax-free traktamente and milersättning under the normal rules, with reseräkning and AGI crosses. Expect Skatteverket to look harder at purpose and private elements in fåmansföretag; keep the programme and agenda with the reseräkning.
