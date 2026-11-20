---
areas: [lopande, lon]
---

# Restaurang och café: drift, personal och nyckeltal

Operating-side reference for an agent doing bookkeeping and advising for a Swedish restaurant, café, food truck, gatukök or catering business. Everything below is stated as it is in force on **17 September 2026**.

Scope split:

- VAT rates, the servering/avhämtning split, vouchers, platforms → `moms-och-forsaljning.md`
- Kassaregister mechanics (certification, receipts, Z-dagrapport, returer, driftsavbrott) → `swedish-cash-register`
- Payroll calculation, AGI, arbetsgivaravgifter, semesterlöneskuld → `swedish-payroll`
- Stock valuation, lägsta värdets princip, write-down mechanics → `swedish-inventory`
- Depreciation, leasing classification, komponentavskrivning → `swedish-asset-accounting`

---

<!-- toc -->
**Contents**

- [1. Serveringstillstånd: what it demands from the books](#1-serveringstillstånd-what-it-demands-from-the-books)
- [2. Kassaregister for this industry](#2-kassaregister-for-this-industry)
- [3. Personalliggare](#3-personalliggare)
- [4. What a kontrollbesök looks like in a restaurant](#4-what-a-kontrollbesök-looks-like-in-a-restaurant)
- [5. Svinn and inventering](#5-svinn-and-inventering)
- [6. Payroll specifics](#6-payroll-specifics)
- [7. Dricks](#7-dricks)
- [8. Costs and assets typical to the industry](#8-costs-and-assets-typical-to-the-industry)
- [9. Key figures a restaurant agent should sanity-check](#9-key-figures-a-restaurant-agent-should-sanity-check)
- [10. Ask-the-user checklist before taking on a restaurant client](#10-ask-the-user-checklist-before-taking-on-a-restaurant-client)
- [Sources](#sources)

<!-- /toc -->

## 1. Serveringstillstånd: what it demands from the books

A serveringstillstånd is a municipal licence under **alkohollagen (2010:1622)**. Most of it is not an accounting matter, but four parts are.

### 1.1 The bookkeeping must be built for supervision

**Alkohollagen 9 kap. 14 § första stycket**: *"Bokföringen i en rörelse som är tillståndspliktig eller som annars bedrivs med stöd av denna lag ska vara så utformad att kontroll av verksamheten är möjlig. Den som bedriver rörelsen är skyldig att på begäran av en tillsynsmyndighet visa upp bokföringshandlingarna."*

This is a standard **above** ordinary BFL compliance. "Kontroll av verksamheten" in practice means the municipality can follow alcohol from purchase invoice to stock to sale. Concretely:

- Alcohol purchases must be separable from food purchases in the ledger, not merged into one 4310. Use a dedicated sub-account.
- Alcohol sales must be separable: which the 25 % rate already forces (**3001**), provided nothing else 25 % is mixed into the same account.
- Stock of alcohol must be countable at any balance date and reconcilable to purchases less sales.

**Alkohollagen 9 kap. 13 §**: on request, the licence holder must give the supervisory authority access to the premises, hand over documents relating to the business, help with the supervision without compensation, supply varuprover, and **report figures on the scale and development of the business**. Refusing or not being able to produce this is a licence risk, not only a tax risk.

**Alkohollagen 9 kap. 14 § andra stycket** adds a duty to supply the supervisory authority with the data it needs for statistics on activity under the Act: the annual restaurangrapport in most municipalities.

### 1.2 Purchases only from partihandlare or Systembolaget

**Alkohollagen 8 kap. 13 §**: a holder of a permit to serve the public, or a standing permit for slutna sällskap, may buy the spritdrycker, vin, starköl och andra jästa alkoholdrycker the business needs **only from a partihandlare or from detaljhandelsbolaget (Systembolaget)**. A permit for a single occasion means Systembolaget only. The same applies to alkoholdrycksliknande preparat taxable under lag (2022:156) om alkoholskatt.

Bookkeeping consequence: a supplier invoice for alcohol from anyone else: a cash-and-carry, a private person, a related restaurant, is evidence of an offence against the Act, independent of whether the accounting entry is correct. Flag it; do not just book it.

### 1.3 Economic fitness is a licence condition

**Alkohollagen 8 kap. 12 §**: a permit may be granted only to someone who shows that they are suitable *"med hänsyn till sina personliga och ekonomiska förhållanden"* and that the business will be run in accordance with the Act. The applicant must also pass a knowledge test on the Act.

In practice the municipality checks Skatteverket for unpaid tax, missing declarations and repeated late filing. So for a licensed client, **late momsdeklaration or an unpaid skattekonto is a licence risk, not just a förseningsavgift**. Say so when advising on cash-flow prioritisation.

### 1.4 Who may work in the kitchen and the dining room

**Alkohollagen 8 kap. 18 §**: the licence holder or a designated **serveringsansvarig** must supervise serving and be present throughout serving hours (not required for rumsservering). A serveringsansvarig must have turned **20** and be notified to the municipality. Crucially: *"Endast den som är anställd av tillståndshavaren eller som är inhyrd av ett bemanningsföretag får anlitas som köks- eller serveringspersonal"*: with narrow exceptions for ordningsvakter and restaurangskola pupils.

Bookkeeping consequence: **a kitchen hand or waiter who invoices the restaurant as a sole trader on F-skatt is not permitted under the Act**, whatever the tax position. When a licensed client books kitchen work to **6810 Inhyrd produktionspersonal** or **6550 Konsultarvoden**, check whether the supplier is a bemanningsföretag. If not, raise it before year-end.

Ages for the guest side: alcohol may not be sold or handed out to anyone under 20 (folköl: under 18), but may be **served** to someone who has turned 18, and the person handing it out must satisfy themselves about the age (**alkohollagen 3 kap. 7-8 §§**).

### 1.5 The 2026 change: the food requirement is gone

**SFS 2026:511** (Prop. 2025/26:221, bet. 2025/26:SoU33, rskr. 2025/26:251), in force **1 June 2026**, **repealed alkohollagen 8 kap. 15 §**: the requirement that a serveringsställe serving the public have its own kitchen adjacent to the serving area and offer a varied range of prepared food. It also amended 8 kap. 4 § (catering for slutna sällskap) and 8 kap. 8 § (serving folköl). Older provisions still apply to breaches committed before 1 June 2026.

This matters commercially: a bar or café that previously had to run a kitchen to hold a licence no longer does. If a client is winding down a kitchen on that basis during 2026, the food-cost and staffing ratios in §8 will break, and the break is legitimate: do not read it as an error.

**Ask the user**: is there a serveringstillstånd, is it stadigvarande or tillfälligt, does it cover slutna sällskap, and what did the last restaurangrapport to the municipality say?

---

## 2. Kassaregister for this industry

The general duty, certification and receipt rules are in `swedish-cash-register`. What is specific here:

**Restaurangverksamhet is defined in SFL (2011:1244) 39 kap. 2 §** as *"näringsverksamhet som avser restaurang, pizzabutik och annat liknande avhämtningsställe, gatukök, kafé, personalmatsal, catering och centralkök"*. That definition drives both the kassaregister and the personalliggare duty, and it is wider than "restaurant" in ordinary speech: a café, a central production kitchen and a staff canteen are all inside it.

| Rule | Content | Source |
|------|------|------|
| Duty | Anyone selling goods or services against cash or card must use a certified kassaregister | SFL 39 kap. 4, 8 §§ |
| Register everything | All sales and all other running use of the register must be registered; a receipt must be produced and **offered** at every sale | SFL 39 kap. 7 § |
| Obetydlig omfattning | No duty where cash + card sales normally stay at or below **four prisbasbelopp** per beskattningsår: **236 800 kr for 2026** (4 × 59 200 kr) | SFL 39 kap. 5 § första stycket 1 och andra stycket; amount per Skatteverket |
| Invoiced sales | Fall outside the kassaregister duty entirely; a kontantfaktura meeting BFL's verifikation requirements is the alternative | Skatteverket; BFL 5 kap. 7 § |
| Distansavtal | Sales under a distansavtal are exempt: **but Skatteverket states that app or web ordering inside the restaurant or café, where the guest is sitting in the restaurant, is not a distansavtal** | SFL 39 kap. 5 § första stycket 4; Skatteverket |
| Separate activities | Self-standing activities inside one business are judged separately | SFL 39 kap. 6 § |
| Individual exemption | Skatteverket may grant one where reliable control can be achieved otherwise, or a duty is unreasonable. Bad weather and no electricity are **not** accepted grounds | SFL 39 kap. 9 §; Skatteverket (SKV 1510) |

The app-ordering point is the one that catches modern table-service concepts: QR-code ordering at the table is in-house sale and must go through the kassaregister; pre-paid delivery ordering is distance selling and need not.

A restaurant's daily cash takings may be booked on one **gemensam verifikation**: the Z-dagrapport, under **BFL 5 kap. 6 § tredje stycket**, and cash payments must be booked no later than the following working day.

**Kontrollavgift**: **12 500 kr per kontrolltillfälle**, doubled to **25 000 kr** for a new breach within one year of the earlier decision (**SFL 50 kap. 1-2 §§**).

---

## 3. Personalliggare

**SFL 39 kap. 11 §**: anyone running restaurangverksamhet must keep a personalliggare. Identification details must be documented for the näringsidkare and, **continuously**, for everyone *verksam* in the premises: including people working in another business the same trader runs in the same verksamhetslokal. "Verksam" is wider than "employed": unpaid family, a friend helping at the bar, a hired consultant in the kitchen all count.

Exemptions (SFL 39 kap. 11 § andra stycket):

1. Enskild näringsverksamhet where only the trader, their spouse or children under 16 are active.
2. Fåmansföretag or fåmanshandelsbolag where only the företagsledare, their spouse or children under 16 are active.

**SFL 39 kap. 2 § sista stycket**: a business that *huvudsakligen* consists of something other than restaurangverksamhet is not treated as restaurangverksamhet. Skatteverket applies this as a turnover test: a hotel whose restaurant is under 25 % of total turnover needs no liggare.

**SFL 39 kap. 12 §**: the liggare must be available to Skatteverket **in the verksamhetslokal**: not in a cloud account nobody on the evening shift can open.

**Kontrollavgift** (**SFL 50 kap. 3-4 §§**): **12 500 kr per kontrolltillfälle plus 2 500 kr for every person found working and not documented in an available liggare**, with 25 000 kr as the base on a repeat within one year. The per-person element is why the liggare, not the kassaregister, is usually the expensive finding in a restaurant.

Book control fees to **6992 Övriga externa kostnader, ej avdragsgilla**: they are sanctions, not deductible.

---

## 4. What a kontrollbesök looks like in a restaurant

Skatteverket may make tillsyns- and kontrollbesök **unannounced**. From Skatteverket's own description (checked 2026-09-17), a visit may include:

- **Kundräkning**: counting guests over a period and comparing to registered sales
- **Kontrollköp**: an anonymous purchase, to see whether it is registered and a receipt is offered
- **Kvittokontroll**: whether receipts are actually offered, in any payment method
- **Kassainventering**: counting the drawer against the register

Anonymous kontrollköp, kvittokontroller and kundräkningar are often done *before* the officers identify themselves. During the visit the business must hand over the documents and information needed, and **be able to produce data from the journal or other underlag showing how sales were registered**. A decision is handed over before the officers leave.

The practical preparation an agent can give a restaurant client:

1. The Z-dagrapport for every trading day exists and is filed, with no gaps and no days with a suspiciously round total.
2. The växelkassa is registered in the till at the start of every day, and changes during the day are registered.
3. **1910 Kassa** never goes negative and reconciles to counted cash; recurring kassadifferenser are booked, not absorbed.
4. Returns are made as returer in the register with a returkvitto, not by voiding.
5. The personalliggare is on the premises, current to the hour, and the staff on shift know how to open it.
6. Driftsavbrott are reported to Skatteverket and the manual documentation of those sales is in the bookkeeping: sales are **not** entered retroactively once the register works again.

---

## 5. Svinn and inventering

### 5.1 The statutory count

**Lag (1955:257) om inventering av varulager för inkomstbeskattningen 1 §**: a bookkeeping-obliged taxpayer must inventory **each individual post** of goods held for sale or consumption, and draw up a **förteckning** stating the value each post is taken up at under IL 17 kap. Items remaining at year-end are deemed to be the most recently acquired (FIFO). **2 §**: the taxpayer must sign, on the förteckning, a **försäkran på heder och samvete** that no stock item was left out.

That signed list is the primary document. A spreadsheet with a single total for "kök" does not satisfy 1 §.

### 5.2 Valuation

- **IL 17 kap. 3 §**: lägsta värdets princip: not lower than the lower of anskaffningsvärde and nettoförsäljningsvärde; FIFO for anskaffningsvärde.
- **IL 17 kap. 4 §**: the stock may instead be taken up at **lowest 97 % of the aggregate anskaffningsvärde** (the 3 % schablon). For a restaurant this is usually simpler and more favourable than item-by-item inkurans, and it replaces the need to argue individual write-downs.
- Mechanics, K2 vs K3 differences and the interaction between the schablon and individual write-downs → `swedish-inventory`.

### 5.3 Shrinkage is a loss, not an uttag

Food that spoils, is dropped, burnt, or passes its date has not been supplied to anyone and has not been put to private use. It is **not** an uttag, no output VAT arises, and deducted input VAT stays deducted (contrast the free staff meal in `moms-och-forsaljning.md` §6). The cost simply stays in **4310 / 4010** and the loss materialises in **4910 / 4960 Förändring av lager** when the count comes in lower than purchases less sales implied.

That automatic mechanism is exactly why svinn is invisible unless it is measured separately.

### 5.4 What documentation supports a write-down or an unusual loss

BAS 2026 has **no svinn account**. Create a sub-account under the relevant purchase account (the kontoplan leaves sub-account levels free) so that svinn is a measured figure rather than a residual. Then keep, per event:

| Event | Documentation |
|------|------|
| Routine kitchen svinn | A running kasseringslista per shift: date, item, quantity, reason, signature. This is normally also required by the client's HACCP egenkontroll under livsmedelslagstiftningen |
| Date-expired goods | The kasseringslista plus the disposal record |
| Breakage of bottled alcohol | A separate log, because alcohol stock must reconcile for the municipality (§1.1). Note quantity, brand, date, who witnessed it |
| Freezer or fridge failure | Temperature log, service report, insurance claim if any. Book any insurance proceeds to **3994 Försäkringsersättningar** |
| Theft | Police report number |
| Portioning drift | Not documentation but a recipe/portion standard; without one, no variance can be explained |

### 5.5 Portioning

A restaurant's food cost is a function of recipe, portion size and yield. An agent cannot audit portion sizes, but can compute expected consumption from recipes × dishes sold and compare with purchases less stock movement. When the client has no written portion standard, that is the finding: not the resulting variance.

**Ask the user**: is there a stock count at every month-end or only at year-end? Are alcohol and food counted separately? Is there a kasseringslista, and does anyone reconcile it to the ledger?

---

## 6. Payroll specifics

Calculations, tax tables, arbetsgivaravgifter and semesterlöneskuld are in `swedish-payroll`. What is specific to this industry:

### 6.1 OB-tillägg

**There is no statutory OB-tillägg in Swedish law.** Obekväm arbetstid supplements exist only where a collective agreement or the individual contract creates them: in this sector typically the Visita-HRF agreement (*Gröna riksavtalet*) or the corresponding Visita-Unionen agreement. The hours that count as obekväm, the percentage or krona amounts, and how they interact with övertid, are set in that agreement and are renegotiated each avtalsperiod.

**Do not state an OB rate or an OB time window from memory.** Ask for the collective agreement or the employment contract, and read the current version.

**Osäkert:** collective agreement texts are not published as primary open sources and were not accessible for this file. Every OB figure must come from the client's own agreement.

BAS has no OB account. Book OB-tillägg to **7010 / 7011 Löner till kollektivanställda** with a company-defined sub-account if the client wants it visible. Do not park it in **7310 Kontanta extraersättningar**: OB is ordinary salary for arbetsgivaravgifter, skatteavdrag, semesterlönegrundande pay and sjuklön.

Accrual effect: OB, övertid and tips-like supplements are usually **semesterlönegrundande**, which raises the semesterlöneskuld in **2920 Upplupna semesterlöner** and the change in **7090 / 7290**. A restaurant with heavy weekend staffing and no OB in the semester base has an understated liability.

### 6.2 Timanställda and schemalagd deltid

Hour-paid staff are ordinary employees: full arbetsgivaravgifter, skatteavdrag, AGI per individual per month, sjuklön and semesterersättning. The two recurring errors:

1. **Paying by invoice.** An hour-paid waiter invoicing on F-skatt is a re-characterisation risk under SAL and, for a licensed restaurant, also breaches alkohollagen 8 kap. 18 § (§1.4).
2. **Semesterersättning "included in the hourly rate"** without it being shown separately. It must be identifiable; otherwise the client cannot show it was paid.

Accrual: unpaid hours worked before period end belong in **2910 Upplupna löner** (or **7019** for kollektivanställda) with the associated **2941 Beräknade upplupna lagstadgade sociala avgifter**.

### 6.3 Minors

**AFS 2023:2, 8 kap. Minderårigas arbetsmiljö** (Arbetsmiljöverket's regelstruktur in force since 1 January 2025) governs this. Key limits (Arbetsmiljöverket, page updated 2025-01-21):

| Group | Limits |
|------|------|
| All minderåriga (under 18) | Never between **midnight and 05.00**. Continuous break of at least 30 minutes after at most 4½ hours. Weekly rest of at least 2 days per 7-day period, of which at least 36 continuous hours |
| Yngre barn (under 13) and äldre barn (13-15) | No work between **20.00 and 06.00**; at least 14 continuous hours' night rest. During school weeks max 2 h per school day, 7 h per school-free day, 12 h per school week. During a school holiday of at least a week, max 7 h/day and 35 h/week. At least 4 continuous weeks free from work per calendar year |
| Ungdom (has completed year 9 and turns at least 16 during the calendar year) | Max **8 h/day and 40 h/week**; averaging over a seven-day period is allowed where the work requires it. At least 12 continuous hours' daily rest; **22-06 or 23-07 must be free from work**, reducible to 11 hours where an ordinary shift ends 22-24 or starts 05-07 |

**A collective agreement cannot derogate from these rules.** Where the minor works for more than one employer, the total hours are added and each employer must ask.

For the restaurant: a 17-year-old cannot close a bar at 01.00 (alkohollagen's default serving end), and a 15-year-old cannot work a Friday evening shift past 20.00. Also note alkohollagen 8 kap. 18 §: serveringsansvarig must be 20.

### 6.4 Jour and beredskap

**ATL (1982:673) 6 §**: where the nature of the business makes it necessary for an employee to be at the workplace available to work if needed, **jourtid may be taken out at most 48 hours per employee over four weeks, or 50 hours per calendar month**. Time actually worked is not jourtid. **ATL 8 §**: allmän övertid max 48 hours over four weeks or 50 hours per calendar month, and **at most 200 hours per calendar year**; **8 a §**: extra övertid max a further 150 hours per calendar year where there are särskilda skäl. A collective agreement may replace these under ATL 3 §.

Compensation for jour is contractual, not statutory. Ask for the agreement.

### 6.5 Terms that affect accruals

Ask which collective agreement applies and then pin down, for the accrual model:

- Semester: percentage rule or sammalöneregeln, and whether OB and övertid are in the base
- Whether arbetstidsförkortning / tidbank exists and how it is valued
- Retirement provision: which arbetsmarknadsförsäkring applies (**7571**, **7572**, **2951**, **2959**)
- Whether tips are distributed through payroll (§7)

---

## 7. Dricks

Three separate questions. Answer them in this order.

**Is it part of the VAT base?** The beskattningsunderlag is the *ersättning* for the supply (ML 8 kap. 2 §). A genuinely voluntary tip the guest decides to add is not consideration for the meal and does not enter the base. An obligatory service charge added by the restaurant to the bill **is** part of the price and carries the rate of what it relates to.

**Is it salary?** Under **SAL (2000:980) 2 kap. 10 §**, *"Löner, arvoden, förmåner och andra ersättningar för arbete är avgiftspliktiga"*, and arbetsgivaravgifter are paid by the person who **pays out** the remuneration. So:

| Route | Employer's position |
|------|------|
| Guest hands cash directly to the server, who keeps it | The employer pays out nothing. No arbetsgivaravgifter, no skatteavdrag, nothing in AGI. The recipient declares it as income from employment themselves |
| Tip arrives by card or Swish into the restaurant's account and the restaurant distributes it | The restaurant is paying out remuneration for work: **arbetsgivaravgifter, skatteavdrag and AGI**, exactly like salary |
| Tip pooled and shared by staff among themselves without the employer touching it | The employer pays out nothing: but see the caution below |

**Does it pass through the till?** Card tips land in the restaurant's settlement and are therefore in the business's money. Until distributed they are a liability, not revenue: **2820 Kortfristiga skulder till anställda** (or **2829**). Booking card tips as turnover, or netting them against the acquirer fee, is the common error.

| Event | Debit | Credit |
|------|------|------|
| Card tip included in the day's settlement | **1686 Fordringar för kontokort och kuponger** | **2820 Kortfristiga skulder till anställda** |
| Paid out through payroll | **2820** | **7010** (gross): with the usual **2710**, **2731**, **7510** entries |

**Osäkert:** how a specific kassaregister must register dricks, and what Skatteverket requires on the receipt when a tip is added at the terminal, is a kassaregister question and is covered in `swedish-cash-register`. Skatteverket's rättslig vägledning on dricks blocks automated retrieval and could not be read for this file: do not state a registration rule from memory.

**Ask the user**: are tips taken by card, and who currently receives the money: the individual server, a pool, or the company? If the company, is it running through payroll?

---

## 8. Costs and assets typical to the industry

| Item | Account | Notes |
|------|------|------|
| Kitchen equipment, ovens, kylar, diskmaskin | **1210 Maskiner och andra tekniska anläggningar** (kitchen as production) or **1220 Inventarier, verktyg och installationer** | Depreciation → `swedish-asset-accounting`. BAS 2026 renamed these; use **1219 / 1229** for ackumulerade avskrivningar |
| Inredning: bord, stolar, bardisk, belysning | **1220 / 1221** | |
| Fast inredning in rented premises (ventilation hood, fixed bar) | **1120 Förbättringsutgifter på annans fastighet**, amortised via **1129** | Or **1222 Byggnads- och markinventarier (ej för produktion)** where it is an inventarie rather than a building improvement |
| Låginköp: glas, porslin, bestick, kastruller | **5410 Förbrukningsinventarier** (5411 / 5412 by expected life) | Direct expensing allowed where the anskaffningsvärde excl. VAT is under **half a prisbasbelopp: 29 600 kr for 2026** (IL 18 kap. 4 §). Watch the **naturligt samband** rule in the same §: 60 chairs bought together are judged as one set, not 60 items |
| Engångsförpackningar, servetter, take-away boxes | **5460 Förbrukningsmaterial** or **5440 Förbrukningsemballage** | |
| Arbetskläder, kockrockar, skor | **5480 Arbetskläder och skyddsmaterial**; laundry to **5580 Underhåll och tvätt av arbetskläder** | Tax-free for the employee only where they qualify as arbetskläder; otherwise a förmån → **7384** |
| Leasing of a coffee machine, dishwasher or beer system | Operationell lease → **5220 Hyra av inventarier och verktyg, ej datorer och fordon**. Finansiell lease under K3 → capitalise to **1227 Finansiellt leasade inventarier** | K2 treats all leases as operationella. Classification → `swedish-asset-accounting` |
| Hyra av lokal | **5010 Lokalhyra** (5011 / 5013 for sub-splits) | See VAT note below |
| El, värme, vatten in rented premises | **5020**, **5030**, **5040** | Kitchen energy that is genuinely a production input may sit in **4810 Kostnader för energi (Råvaror och förnödenheter)**; pick one convention |
| Städning, sophämtning, fettavskiljartömning | **5060 / 5061 / 5062** | |
| Reparation och underhåll of premises / of kitchen equipment | **5070** / **5510**, **5520** | |
| Music: STIM and SAMI licences | **6910 Licensavgifter och royalties** | |
| Food-delivery platform commission | **6050 Försäljningsprovisioner** | See `moms-och-forsaljning.md` §4 |
| Card acquiring and terminal fees | **6040 Kontokortsavgifter** | |
| Branschorganisation (e.g. Visita): service fee vs. membership fee | **6560 Serviceavgifter till branschorganisationer** for the deductible service element; the membership element to **6981 / 6982 Föreningsavgifter, avdragsgilla / ej avdragsgilla** | The invoice normally splits the two. A membership fee to an employers' or trade association is not deductible |
| Kontrollavgift from Skatteverket, licence sanctions | **6992 Övriga externa kostnader, ej avdragsgilla** | |
| Municipal ansöknings- and tillsynsavgift for the serveringstillstånd | **6950 Tillsynsavgifter myndigheter** | Chargeable under alkohollagen 8 kap. 10 § |

### Hyra av lokal with or without VAT

Letting property is exempt. A landlord may opt into **frivillig beskattning** and then charges 25 % on the rent, which the restaurant deducts as ordinary ingående moms (**2641**). If the landlord has not opted in, the rent carries no VAT and the VAT embedded in the landlord's costs is a hidden cost in the rent: there is nothing to deduct. Check the lease before assuming a deduction. Mechanics and the jämkning consequences of a change → `swedish-vat`.

### Music

Public performance of music in a restaurant or café needs licences from the rights organisations: **STIM** for the composers' and publishers' rights, and the performers' and producers' side (SAMI/IFPI) for recorded music. These are ordinary deductible operating costs in **6910**.

Skatteverket's public rate guidance states that upplåtelse or överlåtelse of the copyright to literary and artistic works carries **6 % VAT in all links of the chain**, and names remuneration from upphovsrättsorganisationer such as STIM as an example. **Osäkert:** whether the performers'/producers' remuneration is treated identically was not confirmable: Skatteverket's rättslig vägledning is not machine-readable. Book the rate the invoice actually states.

**There is no radio or TV fee for a restaurant.** The old radio- och tv-avgift (lag 1989:41) was repealed by **lag (2018:1893)** from 1 January 2019 and replaced by a public service-avgift charged to individuals through the tax system; lag 2018:1893 was in turn repealed at the end of 2025 and replaced by **lag (2025:986) om public service**, which re-enacts the avgift on individuals (5 kap.), not on companies. A "Sveriges Radio" or "SVT" invoice to a restaurant in 2026 is therefore not a public service fee: check what it actually is before booking it.

---

## 9. Key figures a restaurant agent should sanity-check

Compute these monthly, on turnover **excluding VAT**, and always against the same client's own trailing twelve months. They are diagnostics, not compliance tests.

| Ratio | Formula | Reads on |
|------|------|------|
| **Råvarukostnad** (food cost) | (**4310** + **4010** purchases ± **4910** / **4960** lagerförändring) ÷ net sales | Purchasing, portioning, svinn, unrecorded sales |
| **Alcohol cost separately** | Alcohol purchases ± alcohol stock movement ÷ alcohol sales (**3001**) | Pour control, breakage, staff consumption, licence reconciliation |
| **Personalkostnad** | (**70xx** + **7510** + **7570** + **7090/7290**) ÷ net sales | Scheduling, OB load, unrecorded cash wages |
| **Prime cost** | Food + drink + personnel ÷ net sales | The single number an operator can act on |
| **Lokalkostnad** | **50xx** ÷ net sales | Whether the site is viable at current volume |
| **Bruttovinstmarginal per rate bucket** | (Sales − direct cost) ÷ sales, computed separately for 6 %, 12 % and 25 % | Whether the servering/avhämtning split in the till is real |
| **Kassalikviditet and 1910 behaviour** | Daily cash balance vs. Z reports | Skimming, unbooked drawer withdrawals |

### What an unusual ratio suggests

| Observation | Most likely cause, in order |
|------|------|
| Food cost **rises** with flat sales | Portioning drift; supplier price increases not passed to the menu; svinn; stock count wrong; **purchases posted but the matching sales not registered** |
| Food cost **falls** sharply | Stock overvalued at period end; purchase invoices sitting unbooked in **2995 Ej ankomna leverantörsfakturor**; a period cut-off error |
| Alcohol cost high against alcohol sales | Over-pouring, breakage, staff drinks; alcohol sold but registered at 12 % instead of 25 %; purchases outside the permitted channel |
| Personnel cost falls while turnover and guest counts hold | Cash wages; hours moved to invoicing suppliers; unbooked accrued salary at period end |
| The 6 % bucket grows without a change in the concept | The till's servering/avhämtning default has been changed, or lines are being switched manually. This is the single highest-risk pattern after 1 April 2026 |
| The 12 % and 25 % mix shifts toward 12 % | Alcohol coded as food; bundle discounts loaded onto the alcohol line |
| **1910 Kassa** trends toward zero every day regardless of trade | Cash removed without a verifikation |

**Osäkert:** there is **no Swedish primary source that publishes binding benchmark ratios for this industry**. Figures circulating as "normal" food cost or personnel cost for Swedish restaurants come from trade statistics (Visita, SCB) and advisory material, not from law or from Skatteverket, and vary widely between a wine bar, a lunch restaurant and a food truck. Do not present a benchmark as an authority. **Build the benchmark from the client's own history**, state the number of periods it rests on, and treat a deviation as a question to ask the operator, not as a conclusion.

What is fair to say: Skatteverket's restaurant audits work from exactly these relationships: purchases against registered sales, guest counts against receipts, staff on the liggare against payroll. A ratio that the operator cannot explain is a ratio Skatteverket will ask about.

---

## 10. Ask-the-user checklist before taking on a restaurant client

1. Serveringstillstånd: stadigvarande or tillfälligt, slutna sällskap included, and who is the notified serveringsansvarig?
2. Are alcohol purchases and alcohol sales separable in the ledger today?
3. Is anyone doing kitchen or serving work who is **not** an employee or hired from a bemanningsföretag?
4. Which kassaregister, is it certified and notified, and does it split turnover by VAT rate on the Z report?
5. Is there in-house app or QR ordering, and does it route through the kassaregister?
6. Is the personalliggare physically available in the premises, and who updates it on an evening shift?
7. Stock: counted monthly or only at year-end? Food and alcohol separately? Is there a signed förteckning with the försäkran under lag (1955:257) 2 §?
8. Is there a kasseringslista, and does anyone reconcile it?
9. Which collective agreement, and can we see the current OB and semester provisions?
10. Any employees under 18, and what shifts do they work?
11. Card tips: who gets the money, and does it run through payroll?
12. Is the lease subject to frivillig beskattning?
13. Any Skatteverket kontrollavgift or municipal remark in the last two years?

---

## Sources

All checked **2026-09-17**.

**Statutes (consolidated text, lagen.nu; SFS PDFs from svenskforfattningssamling.se)**

- Alkohollag (2010:1622): 1 kap. (definitions); 3 kap. 7-8 §§; 8 kap. 4, 10, 12, 13, 18, 19 §§; 9 kap. 13-14 §§
- **SFS 2026:511**: Lag om ändring i alkohollagen (2010:1622), in force **2026-06-01**; upph. 8 kap. 15 §, ändr. 8 kap. 4, 8 §§ och rubriken närmast före 8 kap. 14 §. Prop. 2025/26:221, bet. 2025/26:SoU33, rskr. 2025/26:251. Transitional: older provisions still apply to breaches before 1 June 2026
- Skatteförfarandelag (2011:1244): 39 kap. 2, 4, 5, 6, 7, 8, 9, 10, 11, 12 §§; 50 kap. 1-4 §§
- Bokföringslag (1999:1078): 5 kap. 6 § tredje stycket, 5 kap. 7 §
- Inkomstskattelag (1999:1229): 17 kap. 3-4 §§ (lager, 97 %-regeln); 18 kap. 3-4 §§ (inventarier av mindre värde, naturligt samband)
- Lag (1955:257) om inventering av varulager för inkomstbeskattningen: 1-2 §§
- Socialavgiftslag (2000:980): 2 kap. 10 §
- Arbetstidslag (1982:673): 6 §, 8 §, 8 a §
- Lag (2022:156) om alkoholskatt: 9 kap.
- Lag (2018:1893) om finansiering av radio och tv i allmänhetens tjänst: in force 2019-01-01, repealing lag (1989:41); itself replaced by **lag (2025:986) om public service** (in force 2025-12-02; the individual avgift continues under its 5 kap.)

**Skatteverket (www.skatteverket.se, full page text retrieved)**

- *Vissa verksamheter är undantagna från kravet på kassaregister*: four prisbasbelopp = **236 800 kr för 2026**; app/web ordering in the restaurant is not a distansavtal
- *Skatteverket gör tillsyns- och kontrollbesök*: kundräkning, kontrollköp, kvittokontroll, kassainventering; kontrollavgift 12 500 / 25 000 kr
- *Så här använder du kassaregister*: växelkassa, returkvitto, driftsavbrott, Z-dagrapport
- *Personalliggare* and *Personalliggare, restaurang*: what counts as restaurang, the family exemption, the 75 % mixed-activity test
- *Momssatser och undantag från moms*: 6 % on upplåtelse/överlåtelse of copyright, STIM named

**Arbetsmiljöverket (www.av.se)**

- *Arbetstider för minderåriga*, page last updated 2025-01-21, referring to **AFS 2023:2, 8 kap. Minderårigas arbetsmiljö**

**BAS**

- KONTOPLAN BAS 2026, `BAS_kontoplan_2026_v2.xlsx`, bas.se/kontoplaner/: every account number and name in this file read from that spreadsheet. Note BAS 2026 renamed 1210/1220 and restructured class 3

**Not reachable**

- Skatteverket's *Rättslig vägledning* (www4.skatteverket.se) rejects automated requests. Points that would have been settled there are marked **Osäkert** above (kassaregister handling of dricks; the VAT rate on performers'/producers' music remuneration).
- Collective agreement texts (Visita-HRF *Gröna riksavtalet* and equivalents) are not open primary sources. No OB rate, OB time window or semester rule is stated in this file: all must come from the client's own agreement.
