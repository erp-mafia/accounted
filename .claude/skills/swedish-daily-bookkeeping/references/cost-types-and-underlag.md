# Cost Types and Underlag

Decision reference for an agent categorising bank transactions and receipts. Two parts:

- **Part A: Underlag:** what documentation a booking needs, what to do when it is missing, and when a self-made verifikation is enough (and when it is not).
- **Part B: Cost types:** the recurring judgement calls, each with the BAS 2026 account, income-tax deductibility, VAT deduction, and the trap.

Scope boundaries. Moms mechanics, rutor and blandad verksamhet: `swedish-vat`. Traktamente, milersättning, förmånsvärden and gift amounts for employees: `swedish-payroll`. Capitalisation, avskrivning and inventarieregister: `swedish-asset-accounting`. Verifikationsserier, gemensam verifikation and arkivering in general: `swedish-accounting-compliance`. Account numbers below are BAS 2026 (bas.se, *BAS-kontoplan 2026 v2*).

---

# Part A: Underlag

<!-- toc -->
**Contents**

- [A1. What a verifikation must contain](#a1-what-a-verifikation-must-contain)
- [A2. Receipt missing: the three separate consequences](#a2-receipt-missing-the-three-separate-consequences)
- [A3. Egen verifikation / bokföringsorder](#a3-egen-verifikation--bokföringsorder)
- [A4. What the VAT deduction actually requires](#a4-what-the-vat-deduction-actually-requires)
- [A5. Digital receipts: photograph it, then bin the paper](#a5-digital-receipts-photograph-it-then-bin-the-paper)
- [A6. Decision table: receipt missing](#a6-decision-table-receipt-missing)
- [A7. The extra underlag requirements that only exist for some costs](#a7-the-extra-underlag-requirements-that-only-exist-for-some-costs)
- [B1. Representation](#b1-representation)
- [B2. Personalfest and interna möten](#b2-personalfest-and-interna-möten)
- [B3. Friskvård, arbetsredskap, arbetskläder](#b3-friskvård-arbetsredskap-arbetskläder)
- [B4. Förbrukningsinventarie vs anläggningstillgång](#b4-förbrukningsinventarie-vs-anläggningstillgång)
- [B5. Travel](#b5-travel)
- [B6. Car costs](#b6-car-costs)
- [B7. Subscriptions, software, telefoni, bredband](#b7-subscriptions-software-telefoni-bredband)
- [B8. Hemmakontor](#b8-hemmakontor)
- [B9. Gifts](#b9-gifts)
- [B10. Medlemsavgifter vs serviceavgifter](#b10-medlemsavgifter-vs-serviceavgifter)
- [B11. Utbildning, kurser, facklitteratur](#b11-utbildning-kurser-facklitteratur)
- [B12. Försäkringar](#b12-försäkringar)
- [B13. Bankavgifter, räntor, inkasso](#b13-bankavgifter-räntor-inkasso)
- [B14. Kundförluster](#b14-kundförluster)
- [B15. Quick lookup](#b15-quick-lookup)
- [B16. Escalation rules](#b16-escalation-rules)

<!-- /toc -->

## A1. What a verifikation must contain

**BFL 5 kap 6 § 1 st:** "För varje affärshändelse ska det finnas en verifikation." If the company has received a document about the affärshändelse in one of the forms in 7 kap 1 § 1 st, *that* document shall be used as the verifikation.

**BFL 5 kap 7 § 1 st**: the mandatory content:

| # | Uppgift | Where it comes from on a supplier invoice | If missing |
|---|---|---|---|
| 1 | När verifikationen sammanställts | System timestamp | Auto-filled; never blank |
| 2 | När affärshändelsen inträffat | Fakturadatum / leveransdatum / betaldatum | Use the bank date, note the assumption |
| 3 | Vad affärshändelsen avser | Line description | **Ask the user**: this is the field receipts most often fail |
| 4 | Vilket belopp den gäller | Total, split per momssats | Use the bank amount |
| 5 | Vilken motpart den berör | Seller name | Bank counterparty text is usually enough |

**BFL 5 kap 7 § 2 st:** the verifikation must also carry a **verifikationsnummer or other identifieringstecken**, plus whatever else is needed so the link between the verifikation and the bokförda affärshändelsen can be established without difficulty.

**BFL 5 kap 8 §:** a 5:7 field may be omitted only if including it is "förenat med svårigheter" *and* the omission is compatible with god redovisningssed. This is a narrow escape hatch, not a default. "The user did not tell me the purpose" is not svårigheter.

**BFL 5 kap 9 §:** if a verifikation is corrected, record **when** the correction was made and **who** made it. Never overwrite silently.

**BFL 5 kap 10 §:** 5:1-9 apply equally to bokföringsposter that are not affärshändelser: avskrivningar, periodiseringar, momsredovisning, lönebokföring. Those also need an underlag, which will be a self-made one.

## A2. Receipt missing: the three separate consequences

Do not collapse these into one "not allowed". They fail independently:

1. **Bookkeeping.** The affärshändelse still happened and must still be booked (BFL 5 kap 1-2 §§). A bank transaction is never left unbooked because the receipt is missing. Leaving it out is the actual bokföringsbrott risk, not booking it without a receipt.
2. **Income tax.** The company carries the burden of proving the cost is a business cost. Without an underlag the deduction can be denied on revision, but a well-documented egen verifikation with a plausible business purpose is frequently accepted for small amounts.
3. **VAT.** Hard rule, no judgement: **ML 13 kap 31 §**: "Avdragsrätten ska styrkas genom faktura eller motsvarande handling enligt 17 kap." No invoice, no input VAT. Ever.

So the default treatment of a missing receipt is: **book the gross amount as cost, claim no VAT, document why.**

## A3. Egen verifikation / bokföringsorder

Allowed when no external handling exists or cannot be obtained (BFL 5 kap 6 §; BFNAR 2013:2). Typical cases: cash withdrawal for a business purchase where the receipt was lost, a lönekörning, an avskrivning, a periodisering, a rättelse, a bank charge that appears only on the statement.

An egen verifikation must contain the 5 kap 7 § fields **plus**:

- who created it (name), and when;
- why there is no external underlag ("kvitto förlorat", "leverantören har inte skickat faktura");
- what secondary evidence exists (bank line, order confirmation, email, calendar entry, photo of the goods);
- the business purpose, stated concretely: not "kostnad".

**It does not create a VAT deduction.** An egen verifikation is not a faktura under ML 17 kap, so ML 13 kap 31 § is not satisfied. Book the full amount including the VAT you cannot deduct as cost on the ordinary cost account. Do not post anything to **2641**.

Never reconstruct or re-type a supplier invoice and present it as the original. If the supplier can still issue or re-send the invoice, get it: that restores the VAT deduction; an egen verifikation does not.

## A4. What the VAT deduction actually requires

| Document | Gives VAT deduction? | Rule |
|---|---|---|
| Fullständig faktura with the ML 17 kap 24 § fields | Yes | ML 13 kap 31 §; fields in `swedish-invoice-compliance` |
| Förenklad faktura / kassakvitto, total **≤ 4 000 kr incl. moms** | Yes | ML 17 kap 26-28 §§. Content: date, seller's VAT/org number, type of goods or services, VAT amount or the data to compute it |
| Förenklad faktura, total **> 4 000 kr incl. moms** | **No** | Skatteverket is explicit: there is no right to deduct VAT in a förenklad faktura when the total exceeds 4 000 kr incl. moms. Request a full invoice |
| Kortslip / terminal receipt only (no VAT amount, no seller VAT number) | No | Not a faktura. It proves payment, not the supply |
| Bank statement line | No | Same |
| Egen verifikation | No | A3 |
| Order confirmation, kvitto på betalning from a payment provider | No, unless it carries the 17 kap fields | Name on the document is irrelevant: content decides |

A förenklad faktura does not need the buyer's name and address, so a shop receipt in the company's hands is fine up to the threshold. Above the threshold, the buyer's details are exactly what is usually missing.

**Card slip only:** ask the supplier for the kassakvitto or an invoice. Until it arrives, book gross cost, no VAT. If the user insists on claiming VAT off a card slip, refuse and explain ML 13 kap 31 §.

## A5. Digital receipts: photograph it, then bin the paper

- **Form (BFL 7 kap 1 §):** räkenskapsinformation is preserved as a pappershandling, an elektronisk handling, or mikroskrift. **7 kap 1 § 3 st (SFS 2024:342, in force 1 July 2024):** an elektronisk handling *received* must be preserved in the condition it had when it reached the company; one the company itself drew up, in the condition it had when it was drawn up.
- **Transfer and destruction (BFL 7 kap 6 §, SFS 2024:342):** a company may destroy the paper or electronic handling used to preserve räkenskapsinformation **if the information is transferred to another handling**, and the transfer is done so that the information is not altered or lost. The older requirement to keep the paper original for three further years is gone. In force since 1 July 2024, so it applies to everything an agent handles today.
- **Retention (BFL 7 kap 2 §):** until and including the **seventh year** after the end of the calendar year in which the räkenskapsår ended.
- **Storage location:** 7 kap 2-4 §§, see `swedish-accounting-compliance`.

Practical rules for an agent:

1. A receipt photographed to an image counts as a transfer under 7:6 only if the image is **complete and legible**: seller, org/VAT number, date, amounts, momssats, VAT amount. A blurry corner means the paper may not be destroyed.
2. A PDF invoice received by email is an elektronisk handling. Keep **the PDF**. Printing it and scanning it back, or screenshotting it, changes the skick it had when received (7:1 3 st).
3. Store the image or PDF attached to the verifikation, not only in the mailbox.
4. Do not convert a structured e-faktura into a PDF and throw the original away.

## A6. Decision table: receipt missing

Read down to the first row that matches.

| Situation | Book? | VAT | Underlag | Ask the user? |
|---|---|---|---|---|
| Card slip only, amount ≤ 4 000 kr incl. moms | Yes, gross | **None** | Egen verifikation + slip | Ask for the kassakvitto once |
| Nothing at all, amount small (rule of thumb ≤ 1 000 kr), counterparty and purpose obvious from the bank text (e.g. SL, a known SaaS vendor) | Yes, gross | **None** | Egen verifikation stating purpose | No, but flag in the month-end list |
| Nothing at all, amount > 1 000 kr | Yes, gross | **None** | Egen verifikation | **Yes**: what was it and for what |
| Nothing at all, purpose unclear at any amount | Yes, to a holding account or gross cost | **None** | Egen verifikation | **Yes**: cannot pick an account without the purpose |
| Nothing at all, and the payment may be private | Do not force a cost account | **None** | Book against **2013**/**2018** (EF egna uttag) or **2893** owner's account (AB) | **Yes**: always |
| Invoice exists but VAT is not specified | Yes, gross | **None** | The invoice | Ask supplier for a compliant faktura |
| Förenklad faktura > 4 000 kr incl. moms | Yes, gross | **None until replaced** | The receipt | Ask supplier for a full faktura |
| Receipt in a foreign currency, no SEK amount | Yes, converted at the bank rate on the payment date | Per A4 | Receipt + rate used | No |
| Supplier invoice that will arrive later (goods received) | Yes, accrue | Claim when the invoice arrives | Egen verifikation for the accrual | No |

**Always ask the user, never guess:**

- the **purpose** of any representation, travel, gift or conference cost, and **who participated** (A7);
- whether a purchase is private or business when the counterparty is a consumer-facing merchant (groceries, clothing, electronics, travel) and nothing else indicates business use;
- whether a vehicle cost belongs to a company car, a förmånsbil, or the owner's private car;
- the split for any cost with both private and business use (phone, broadband, home office);
- whether an asset purchase near the half-prisbasbelopp threshold is one item or several with a natural connection (B4).

## A7. The extra underlag requirements that only exist for some costs

| Cost | Extra underlag | Source |
|---|---|---|
| Representation (extern and intern) | **Purpose** of the sammankomst and **the participants by name and company** | Skatteverket, *Avdrag för moms vid representation* |
| Personalfest | Purpose, date, participant list, and the split of måltid vs kringkostnader | Same |
| Konferens-/studieresa | Programme with hours per day, participants | Skatteverket |
| Milersättning | Körjournal or equivalent per trip: date, purpose, from/to, km | `swedish-payroll` |
| Traktamente | Destination, departure and return times | `swedish-payroll` |
| Gåva | Recipient and occasion | Skatteverket |

If the participant list or purpose is missing, the VAT deduction on representation fails even when a perfect restaurant invoice exists. Ask for it at booking time, not at bokslut.

---

# Part B: Cost types

## B1. Representation

Two separate tracks, and conflating them is the single most common error:

- **Income tax:** måltider at representation are **not deductible at all** (IL 16 kap 2 §, after the 2017 reform). Only *enklare förtäring* up to **60 kr per person and occasion excl. moms**, and *kringkostnader* (venue hire, entertainment, theatre tickets, greens fee) up to **180 kr per person and occasion excl. moms**.
- **VAT:** deduction is retained, on a beskattningsunderlag of at most **300 kr excl. moms per person and occasion** (ML 13 kap 24-25 §§).

### VAT ceiling per person and occasion

| Situation | Max VAT deduction | Note |
|---|---|---|
| Restaurang/servering, food only (12 %) | 300 × 12 % = **36 kr** | Restaurant and catering stayed at 12 % in 2026 |
| Food + alcohol, cost > 300 kr excl. moms | schablon **46 kr** | Only if the VAT actually charged is ≥ 46 kr per person |
| Food taxed at **6 %** (shop-bought or takeaway, 1 Apr 2026 to 31 Dec 2027), cost > 300 kr excl. moms | schablon **33 kr** | Only if the VAT actually charged is ≥ 33 kr per person |
| Food at 6 % only | 300 × 6 % = **18 kr** | |
| Everything at 25 % | 300 × 25 % = **75 kr** | |
| Kringkostnader (entertainment, venue) | base max **180 kr** per person | |
| Representationsgåva | base max **300 kr** excl. moms per person | |

Instead of the schablon you may apportion the 300 kr base proportionally between the 12 % and 25 % parts of the bill. The schablon is a simplification, not an entitlement: it requires the charged VAT to reach the schablon amount. Rate mechanics and the 2026 food change: `swedish-vat`.

### Accounts

| Type | Deductible part | Non-deductible part |
|---|---|---|
| Extern representation (customers, suppliers) | **6071** | **6072** |
| Intern representation (staff, personalfest, interna möten) | **7631** | **7632** |

### Worked entry: dinner with customers

Four people (2 employees, 2 customers), 4 800 kr incl. moms, mixed food and alcohol, > 300 kr excl. moms per person. Schablon 46 × 4 = 184 kr. Underlag records purpose and the four names.

| Account | Debit | Credit |
|---|---|---|
| **6072** Representation, ej avdragsgill | 4 616 | |
| **2641** Debiterad ingående moms | 184 | |
| **1930** Företagskonto | | 4 800 |

Nothing lands on 6071: no part of a meal is income-tax deductible.

**Traps.** Deducting full VAT with no cap. Booking the whole cost to 6071 because "it's representation". Treating a customer lunch under 300 kr as deductible for income tax: it is not; only enklare förtäring (coffee, sandwich, fruit) at 60 kr is. Missing participant list kills the VAT deduction regardless of the invoice.

## B2. Personalfest and interna möten

| Item | Income tax | VAT | Account |
|---|---|---|---|
| Food and drink at a personalfest | Only enklare förtäring, 60 kr/person | Base max 300 kr/person | **7631** up to the limit, **7632** above |
| Kringkostnader (lokalhyra, musik, underhållning) | **180 kr/person and occasion excl. moms** | Base max 180 kr/person | **7631** / **7632** |
| Number of personalfester | **Max two per year** | - | - |
| Interna kurser, planeringskonferenser, informationsmöten | Same enklare-förtäring limits | Same 300 kr base | **7631** / **7632** |

Skatteverket's conditions for intern representation: the sammankomst must be short (max about one week) and not recur regularly (not every or every other week). Free food at a qualifying intern representation is a **tax-free benefit** for the employee: no kostförmån. Recurring Friday breakfasts or a standing weekly lunch fall outside, and become a taxable kostförmån (`swedish-payroll`).

## B3. Friskvård, arbetsredskap, arbetskläder

| Item | Income tax | VAT | Account |
|---|---|---|---|
| Friskvårdsbidrag, max **5 000 kr/år incl. moms**, offered to all staff on equal terms | Deductible personalkostnad | No deduction: the employee buys the service, the employer reimburses | **7699** |
| Naturaförmån motion (gym the employer contracts directly) | Deductible | Deductible if the employer is the purchaser and holds the invoice | **7699** |
| Arbetsredskap (laptop, monitor, headset, chair) of väsentlig betydelse for the work, private use limited | Deductible | Full deduction | **5410**/**5411** or **1220** per B4 |
| Arbetskläder | Only if unsuitable for private use and marked or with special protective properties | Deductible when the cost is | **5480** |
| Ordinary clothing, glasses, gym clothes | Not deductible | No | Private |

The 5 000 kr friskvård limit is all-or-nothing: exceed it and the **whole** amount becomes taxable, not just the excess. Amounts, qualifying activities and the 1 000 kr-per-occasion rule for non-motion treatments: `swedish-payroll`.

## B4. Förbrukningsinventarie vs anläggningstillgång

**IL 18 kap 4 §:** immediate expensing for *inventarier av mindre värde*: anskaffningsvärde below **half a prisbasbelopp**, measured excluding deductible VAT, and for *korttidsinventarier* with an economic life of at most three years.

| Year | Prisbasbelopp | Threshold (half PBB) |
|---|---|---|
| 2025 | 58 800 kr | 29 400 kr |
| **2026** | **59 200 kr** | **29 600 kr** |

PBB 2026 = 59 200 kr confirmed against Skatteverket, *Belopp och procent 2026*. The threshold is "understiger" half a PBB, so 29 600 kr exactly is above the line.

```
Cost excl. deductible VAT < 29 600 kr (2026)?
├─ YES → expense: 5410 (5411 life > 1 yr, 5412 life ≤ 1 yr), 5420 for software
└─ NO
   └─ Economic life ≤ 3 years?
      ├─ YES → expense (korttidsinventarie)
      └─ NO  → capitalise 1220 Inventarier, verktyg och installationer
               → swedish-asset-accounting
```

**The trap is the grouping rule (IL 18 kap 4 § 2 st):** items with a *naturligt samband* that are acquired to be used together are measured **as one unit**. Ten desk chairs bought in one order, or a conference table with its chairs, are tested on the combined cost. An agent seeing several similar lines on one invoice must ask whether they form a unit before expensing each below the threshold.

## B5. Travel

| Cost | VAT | Account | Note |
|---|---|---|---|
| Hotel room in Sweden | **12 %** | **5831** Kost och logi i Sverige | Breakfast included in the room price follows the room rate |
| Restaurant and catering in Sweden | 12 % (alcohol 25 %) | **5831** or representation accounts | Unchanged by the 2026 food reduction |
| Domestic flight, train, bus, taxi (inrikes persontransport) | **6 %** | **5810** Biljetter | ML 9 kap, 6 %-gruppen |
| International flight ticket | **No Swedish VAT** | **5810** | Passenger transport to or from abroad is not taxed in Sweden: there is no input VAT to deduct. *Osäkert: the exact ML 6 kap paragraph was not verified against a primary source; the substance is settled.* |
| Foreign hotel, foreign restaurant, foreign taxi | Foreign VAT | **5832** Kost och logi i utlandet | Foreign VAT is **never** deducted in the Swedish momsdeklaration. Book gross, or split the foreign VAT to **6998 Utländsk moms**, and reclaim through återbetalningsansökan: see `swedish-vat` |
| Hyrbil on a business trip | 25 %, but see B6 for personbil | **5820** Hyrbilskostnader | |
| Parking during a business trip | 25 % | **5890** or **5619** | Deductible; the *fine* is not (B6) |
| Conference or congress fee, Sweden | 25 % | **7610** (staff) | Exempt only if it is utbildning covered by ML 10 kap: commercial conferences are not |
| Congress abroad | Reverse charge or foreign VAT | **7610** | Services to a Swedish business are normally reverse-charged, `swedish-vat` |
| Milersättning, traktamente | - | **7331**, **7321** | Amounts, reductions and körjournal requirements: `swedish-payroll`. Do not restate them |

**Konferensresa trap.** A trip with a genuine programme (roughly six hours of work per day, documented) is a deductible conference cost. Attached leisure days, and the cost of accompanying family members, are not. Ask for the programme before booking the whole invoice to 7610.

## B6. Car costs

| Cost | Income tax | VAT | Account |
|---|---|---|---|
| Purchase of a personbil | Capitalise and depreciate | **No deduction** (exceptions: resale, uthyrning, taxi, körkortsutbildning, transport of the deceased) | **1220** |
| **Leasing of a personbil** | Deductible | **50 % of the VAT on the leasing charge**, provided the car is used more than *obetydlig omfattning*: more than 100 mil/year, in VAT-liable business | **5615** Leasing av personbilar, mc, m.m. |
| Drivmedel, service, reparation, besiktning on a company-owned or leased car | Deductible | **Full** deduction when the car is an anläggningstillgång or leased for taxable business | **5611**, **5613**, **5612** |
| Parkering at the workplace / during business driving | Deductible | 25 % | **5619**, or **5890** on a trip |
| **Parkeringsböter, kontrollavgift, fortkörningsböter** | **Not deductible**: IL 9 kap 9 §: "Böter och offentligrättsliga sanktionsavgifter får inte dras av" | No | **6992** Övriga externa kostnader, ej avdragsgilla |
| Trängselskatt and infrastrukturavgift, business driving | Deductible | **No VAT**: it is a tax, not a supply | **5616** Trängselskatt personbilar |
| Trängselskatt paid by the employer for an employee's *private* trips in a förmånsbil | Deductible as personalkostnad | No | **7391** Kostnad för trängselskatteförmån: taxable benefit, reported separately in the AGI; see `swedish-payroll` |
| Enskild näringsidkare's own car used in the business | Milersättning per km, not actual costs | No | `swedish-payroll` / `swedish-ef-skatteplanering` |

The 50 % leasing rule is a flat halving: it is not affected by the actual private-use share, and it does not extend to driftkostnader, which are fully deductible. Buying out a car at the end of a lease gives **no** VAT deduction on the purchase.

**Förmånsbil vs company car** is a payroll question, not a bookkeeping one: the costs sit in 56xx either way, and what changes is the benefit reported for the employee. Route it to `swedish-payroll`.

## B7. Subscriptions, software, telefoni, bredband

| Cost | Account | VAT | Note |
|---|---|---|---|
| Purchased software licence, perpetual, below the B4 threshold | **5420** Programvaror | 25 % | Above the threshold and with a life > 3 years: capitalise |
| SaaS subscription from a Swedish supplier | **6540** IT-tjänster | 25 % | |
| SaaS from an EU or non-EU supplier | **6540** | Reverse charge: output and input VAT both booked | `swedish-vat`. Check the supplier charged no VAT and quoted your VAT number |
| Licence fees and royalties | **6910** | 25 % | |
| Fast telefoni | **6211** | 25 % | |
| Mobiltelefoni | **6212** | 25 % | |
| Bredband / datakommunikation | **6230** | 25 % | |
| Porto | **6250** Porto | 6 % on stamps, 25 % on most parcel services | |

**Private use.** A phone or broadband subscription paid by an AB for an employee is a tax-free arbetsredskap if the subscription is a flat fee where private use cannot be separated, the subscription is of väsentlig betydelse for the work, and the private benefit is of limited value. Per-call extras (premium numbers, roaming above the plan) are always taxable. For an **enskild näringsidkare**, the fixed subscription at home is not deductible; only the variable business-call cost is. If the user cannot state a business share, ask: do not deduct 100 % by default.

## B8. Hemmakontor

| Form | Rule | Booking |
|---|---|---|
| **Enskild firma**, no särskilt inrättad del, at least **800 hours** worked at home in the year | Schablon **2 000 kr/år** if the home is owned, **4 000 kr/år** if it is a hyresrätt or bostadsrätt | A tax deduction claimed in the NE-bilaga. Do not invent a cost with VAT |
| **Enskild firma**, särskilt inrättad del (a room whose layout and furnishing make it unusable as living space) | Skälig del of the actual housing costs | **5090** Övriga lokalkostnader, no VAT |
| **AB** renting a room from its owner | The AB deducts a **marknadsmässig** rent; there must be a genuine need and the space must be used for the business. The owner declares the rent as inkomst av kapital | **5010**/**5090**. **No VAT**: a room in a private home is not covered by frivillig beskattning |

The 800 hours may include the spouse's and children-over-16's hours in the business. If the business has other premises where the work could be done, home hours for that work do not count.

## B9. Gifts

| Type | Income tax | VAT | Account |
|---|---|---|---|
| **Reklamgåva** (low value, mass-distributed, with the company's name or logo, or a simple product sample) | Deductible up to **300 kr excl. moms** per gift | Deductible on the deductible base | **5960** Varuprover, reklamgåvor, presentreklam och tävlingar |
| **Representationsgåva** (flowers for a customer's jubilee or new branch) | Deductible up to **300 kr excl. moms** per person | Base max 300 kr per person | **6071** up to the limit, **6072** above |
| **Julgåva / jubileumsgåva / minnesgåva** to staff | Deductible personalkostnad while the gift stays inside the tax-free limit | **Deductible input VAT as long as the benefit is tax-free for the employee** (Skatteverket) | **7690**/**7699** |
| Gift to a charity | Not deductible | No | **6993** Lämnade bidrag och gåvor |
| Sponsring | Deductible only to the extent there is a motprestation | On the deductible part | **5981** / **5982** |

Employee gift amounts for 2026 are in `swedish-payroll`. Two rules an agent must apply anyway: exceeding the limit makes the **whole** gift taxable from the first krona, and gifts in money: including gift cards exchangeable for money, are never tax-free.

A gift to a customer that is neither a reklamgåva nor tied to a specific occasion is normally a non-deductible personal gift (IL 9 kap 2 §). Ask what the occasion was.

## B10. Medlemsavgifter vs serviceavgifter

This is the classic error, and the two can appear on the same invoice.

| | Medlemsavgift | Serviceavgift |
|---|---|---|
| Income tax | **Not deductible**: IL 9 kap 2 §: avgifter till kassor, föreningar och andra sammanslutningar som den skattskyldige är medlem i count as levnadskostnader | **Deductible**, when it pays for actual services the company uses |
| VAT | No | Normally 25 % and deductible, if invoiced with VAT |
| Account | **6982** Föreningsavgifter, ej avdragsgilla | **6560** Serviceavgifter till branschorganisationer |

The separation must be real: a separate service company, or at least a separately specified line on the invoice. If the invoice shows only one undivided amount, the whole thing is a medlemsavgift. **Exception:** an annual fee that is a necessary prerequisite for practising the profession (maintaining an authorisation or approval) is deductible: **6981**.

If an invoice from a branschorganisation is not split, ask the user for the association's own split before booking anything to 6560.

## B11. Utbildning, kurser, facklitteratur

| Cost | Income tax | VAT | Account |
|---|---|---|---|
| Course or training for staff, relevant to the current business | Deductible | 25 % on a commercial course | **7610** Utbildning |
| Utbildning that is exempt under ML 10 kap (grundskole-, gymnasie-, högskoleutbildning by a recognised provider) | Deductible | Exempt: no input VAT exists | **7610** |
| Facklitteratur with a clear connection to the business, not of general interest | Deductible | 6 % on books | **6970** Tidningar, facklitteratur, m.m. |
| Dagstidning | Deductible only as facklitteratur, or when bought for customers in the business premises | 6 % | **6970** |
| Training that qualifies the owner for a *new* profession | Not deductible | No | Private |

## B12. Försäkringar

| Insurance | Employer deduction | Employee | Account |
|---|---|---|---|
| Företagsförsäkring (egendom, ansvar, avbrott) | Deductible | - | **6310**; självrisk **6320** |
| Reseskyddsförsäkring for business travel | Deductible | Tax-free | **6310** |
| Grupplivförsäkring | Deductible | Tax-free | **7581** Grupplivförsäkringspremier (group **7580**) |
| Gruppsjukförsäkring designed per kollektivavtal | Deductible | Tax-free | **7580**-series; avtalsförsäkringar **7571** |
| Tjänstepensionsförsäkring | Deductible within the pension rules | Not a taxable benefit | **7410**-series; `swedish-payroll` |
| **Sjukvårdsförsäkring** (private healthcare) | See note | **Taxable benefit, schablon 60 % of the premium** | **7620**/**7623** |
| Sjuk- och olycksfallsförsäkring for an enskild näringsidkare personally | Not deductible | - | Private (IL 9 kap 2 §) |

Insurance premiums carry **no VAT** (exempt under ML 10 kap): there is nothing to post to 2641.

Sjukvårdsförsäkring: Skatteverket's schablon is that the taxable part of a policy covering both taxable and tax-free elements is **60 % of the premium**; a lower taxable share must be documented and producible on request. The tax-free part covers rehabilitering and förebyggande behandling. *Osäkert: whether any portion of the premium is non-deductible for the employer: BAS keeps **7623** "Sjukvårdsförsäkring, ej avdragsgill", was not confirmed against a primary source here. Verify before defaulting a posting to 7623; report the benefit through `swedish-payroll` either way.*

## B13. Bankavgifter, räntor, inkasso

| Cost | Income tax | VAT | Account |
|---|---|---|---|
| Bank charges, account fees, payment fees | Deductible | **None**: financial services are exempt (ML 10 kap) | **6570** Bankkostnader |
| Kortinlösenavgifter | Deductible | None | **6040** Kontokortsavgifter |
| Interest on business loans | Deductible (subject to the ränteavdragsbegränsningar, `swedish-tax-planning`) | None | **8410** long-term, **8420**-series short-term |
| Dröjsmålsränta on a supplier invoice | Deductible | None: interest is not consideration for a supply | **8422** Dröjsmålsräntor för leverantörsskulder |
| **Kostnadsränta on the skattekonto** | **Not deductible** | None | **8423** Räntekostnader för skatter och avgifter |
| Intäktsränta on the skattekonto | Tax-free income | None | **8314** Skattefria ränteintäkter |
| Påminnelseavgift charged by a supplier | Deductible | *Osäkert: these fees are generally treated as outside the scope of VAT, but this was not confirmed against a primary source here. Do not deduct VAT unless the invoice specifies it* | **6991** Övriga externa kostnader, avdragsgilla |
| Your own inkasso and KFM fees when collecting a receivable | Deductible | Per the invoice from the inkasso company | **6062** Inkasso och KFM-avgifter |
| Reminder or collection fees on a **fine** | **Not deductible**: follows the fine | No | **6992** |

## B14. Kundförluster

Two stages, and only the second one touches VAT.

**Befarad kundförlust**: the claim looks doubtful at bokslut, but nothing is settled. Balance-sheet adjustment only, **no VAT correction**:

| Account | Debit | Credit |
|---|---|---|
| **6352** Befarade förluster på kundfordringar | X excl. moms | |
| **1519** Nedskrivning av kundfordringar | | X excl. moms |

**Konstaterad kundförlust**: the loss is established when you can show the customer will probably not pay: bankruptcy with an unsecured claim, a Kronofogden report showing no assets, or collection being practically impossible. Now the utgående moms may be reduced (reported in ruta 10-12 by rate, `swedish-vat`). Reverse the befarad first, then:

| Account | Debit | Credit |
|---|---|---|
| **6351** Konstaterade förluster på kundfordringar | Net excl. moms | |
| **2611** Utgående moms 25 % | VAT of the loss | |
| **1510** Kundfordringar | | Gross |

**Traps.**

- A **disputed** claim is not a konstaterad kundförlust. If the parties disagree about the amount, it is a price reduction and requires an **ändringsfaktura** before any VAT is adjusted (`swedish-invoice-compliance`).
- A befarad förlust never reduces VAT. Reducing output VAT at the nedskrivning stage is a common and visible error.
- If the customer pays later, the output VAT must be reported again in the period the payment is received, and the loss reversed.
- Use the momssats from the original invoice, not today's rate: relevant for anything sold at 12 % before 1 April 2026.

---

## B15. Quick lookup

| Cost | Account | VAT | Income tax |
|---|---|---|---|
| Customer lunch | **6072** | Base max 300 kr/person | Not deductible |
| Coffee and sandwiches at a customer meeting | **6071** | Base max 300 kr/person | 60 kr/person |
| Personalfest, venue and band | **7631** / **7632** | Base max 180 kr/person | 180 kr/person, max 2 per year |
| Friskvårdsbidrag | **7699** | No | Deductible, 5 000 kr limit |
| Laptop 18 000 kr | **5411** | Full | Deductible now |
| Laptop 34 000 kr | **1220** | Full | Via avskrivning |
| Hotel, Sweden | **5831** | 12 % | Deductible |
| Domestic flight | **5810** | 6 % | Deductible |
| International flight | **5810** | None | Deductible |
| Taxi | **5810** | 6 % | Deductible |
| Leasing, personbil | **5615** | **50 %** | Deductible |
| Fuel, company car | **5611** | Full | Deductible |
| Parking fine | **6992** | No | **Not deductible** |
| Trängselskatt, business | **5616** | No | Deductible |
| SaaS subscription | **6540** | 25 % or reverse charge | Deductible |
| Mobile phone | **6212** | 25 % | Deductible |
| Medlemsavgift | **6982** | No | **Not deductible** |
| Serviceavgift | **6560** | 25 % | Deductible |
| Course fee | **7610** | 25 % | Deductible |
| Facklitteratur | **6970** | 6 % | Deductible |
| Företagsförsäkring | **6310** | None | Deductible |
| Bank fee | **6570** | None | Deductible |
| Skattekontoränta | **8423** | None | **Not deductible** |
| Reklamgåva | **5960** | On base max 300 kr | 300 kr excl. moms |
| Julgåva to staff | **7690**/**7699** | Deductible while tax-free | Deductible |

## B16. Escalation rules

Stop and ask the user rather than pick an account when:

1. A cost could be representation but the participants or purpose are unknown.
2. A purchase is near the 29 600 kr threshold and may be part of a group of connected items.
3. A vehicle cost cannot be tied to a specific car and its förmån status.
4. An invoice from an association is not split between medlemsavgift and serviceavgift.
5. A merchant is consumer-facing and there is no receipt showing what was bought.
6. A foreign invoice shows VAT and it is unclear whether it is Swedish reverse charge or foreign VAT.
7. The only underlag is a card slip above 4 000 kr incl. moms.

In every one of these, booking gross with no VAT and a clearly worded egen verifikation is the safe interim position. It is always reversible; a wrongly claimed VAT deduction is not.
