---
areas: [moms, lopande]
---

# Restaurang och café: moms och försäljning

Reference for an agent doing bookkeeping and advising for a Swedish restaurant, café, food truck, gatukök or catering business. All rates and amounts below are those in force on **17 September 2026**.

Scope split:

- Till mechanics (kassaregister, kvitto, Z-dagrapport, returer, driftsavbrott, dricks in the till) → `swedish-cash-register`
- General VAT machinery (periods, rutor, EU trade, jämkning, representation, blandad verksamhet) → `swedish-vat`
- Benefit valuation, AGI and arbetsgivaravgifter → `swedish-payroll`
- Stock valuation and write-downs → `swedish-inventory`

This file only covers what is specific to serving food and drink.

---

<!-- toc -->
**Contents**

- [1. The rate split as it stands in September 2026](#1-the-rate-split-as-it-stands-in-september-2026)
- [2. Servering or take-away: what actually decides it](#2-servering-or-take-away-what-actually-decides-it)
- [3. Packaging, transport and single-use items](#3-packaging-transport-and-single-use-items)
- [4. Catering, delivery and platforms](#4-catering-delivery-and-platforms)
- [5. Alcohol](#5-alcohol)
- [6. Personalmåltider](#6-personalmåltider)
- [7. Free meals to guests, complimentary dishes, samples and spill](#7-free-meals-to-guests-complimentary-dishes-samples-and-spill)
- [8. Presentkort, lunchkuponger and third-party lunch cards](#8-presentkort-lunchkuponger-and-third-party-lunch-cards)
- [9. Rabatter, happy hour and bundles across two rates](#9-rabatter-happy-hour-and-bundles-across-two-rates)
- [10. Worked example: one full day](#10-worked-example-one-full-day)
- [11. BAS 2026 accounts used in this file](#11-bas-2026-accounts-used-in-this-file)
- [12. Ask-the-user checklist before booking a first period](#12-ask-the-user-checklist-before-booking-a-first-period)
- [Sources](#sources)

<!-- /toc -->

## 1. The rate split as it stands in September 2026

Three rates run side by side in the same basket. The rate depends on **what the guest gets**, not on what is cooked.

| Supply | Rate | Statute |
|------|------|------|
| Restaurang- och cateringtjänst (food and drink served with support services) | **12 %** | ML (2023:200) 9 kap. 5 § |
| Leverans av livsmedel, including take-away and food-truck sales | **6 %** (temporary) | ML 9 kap. 19 §, wording from SFS 2026:118 |
| Spritdrycker, vin och starköl: served or sold | **25 %** | ML 9 kap. 5 § (exception) and 9 kap. 19 § p. 2 |
| Dricksvatten från vattenkran sold separately | **25 %** | ML 9 kap. 2 §; water per art. 6 dricksvattendirektivet is excluded from 9 kap. 19 § |
| Dricksvatten på flaska eller behållare avsedd för försäljning | **6 %** | ML 9 kap. 19 § andra stycket |
| Rumsuthyrning in hotell/pensionat/vandrarhem, incl. breakfast tied to the room | **12 %** | ML 9 kap. 4 § |

### Timeline: verify the transaction date before choosing a rate

| Period | Livsmedel (leverans) | Restaurang-/cateringtjänst |
|------|------|------|
| Until 2026-03-31 | 12 % | 12 % |
| **2026-04-01 to 2027-12-31** | **6 %** | 12 % |
| From 2028-01-01 | 12 % again | 12 % |

- **SFS 2026:118** (utfärdad 26 februari 2026; Prop. 2025/26:55, bet. 2025/26:SkU9, rskr. 2025/26:158) renumbered the old 9 kap. 3 § to **9 kap. 19 §** and set the rate to 6 %, in force **1 April 2026**. Övergångsbestämmelse: the old rules still apply where the *beskattningsgrundande händelse* occurred before entry into force.
- **SFS 2026:119** (same date, same prop) renumbers 9 kap. 19 § back to **9 kap. 3 §** and restores **12 %** from **1 January 2028**, with the same transitional wording. Both are enacted law, not proposals.

So the 6 % window is exactly **1 April 2026 to 31 December 2027**. On 1 January 2028 the reduction lapses automatically: no further decision is needed, and no extension is law today.

**Ask the user** before the turn of a year inside this window: whether their kassaregister, menu prices and article register are already parameterised for a 6 % → 12 % switch on 2028-01-01, and whether prices are set inclusive or exclusive of VAT (an inclusive price keeps the guest price and cuts the margin; an exclusive price raises the guest price).

The rate follows the *beskattningsgrundande händelse*, not the payment. A 2027 gift card redeemed in 2028 is taxed at the 2028 rate (see §9).

**Osäkert:** ML 9 kap. 5 § and 9 kap. 19 § name only *spritdrycker, vin och starköl* as the 25 % exception. Cider and other *andra jästa alkoholdrycker* over 3,5 volymprocent are a separate category in alkohollagen 1 kap. and are not named in either VAT provision, and Skatteverket's public page describes the 25 % group as "spritdrycker, vin och öl med högre alkoholhalt än folköl". Skatteverket's rättslig vägledning blocks automated fetching, so this could not be resolved from a primary source. Ask the user how cider is coded in their till today, and get the position confirmed with Skatteverket before changing it.

---

## 2. Servering or take-away: what actually decides it

Skatteverket's test (Momssatser och undantag från moms, skatteverket.se, checked 2026-09-17) is a **helhetsbedömning of what the customer actually receives**, not what the seller intended.

It is a **restaurang- eller cateringtjänst (12 %)** when food or drink is supplied together with *stödtjänster* that let the guest eat or drink immediately:

- servering, dukning och diskning
- tillgång till lokal med bord och stolar
- tillgång till glas, porslin och bestick

It is a **leverans av livsmedel (6 %)** when those support services are absent: including when they exist but the guest declines them and takes the food away. Services connected only to the cooking itself are never enough to make it a restaurangtjänst.

Restaurang vs catering is decided by **place**: in the seller's premises it is a restaurangtjänst; carried to the customer's premises with support services performed there it is a cateringtjänst. Both are 12 %.

### Decision table

| Situation | Treatment | Rate |
|------|------|------|
| Dagens rätt served in the dining room / taken away | Restaurangtjänst / Livsmedel | 12 % / 6 % |
| Coffee and fikabröd at the café's table / taken to go | Restaurangtjänst / Livsmedel | 12 % / 6 % |
| Loaf of bread bought over the same café counter | Livsmedel | 6 % |
| Food truck: guest takes the food on disposable material and eats on a public park bench | Livsmedel | 6 % |
| Food court: guest eats in a restaurant-like area the seller shares with other sellers | Restaurangtjänst | 12 % |
| Café-like seating area inside a grocery store, operated by that seller | Restaurangtjänst | 12 % |
| Same forecourt shop, guest pays for take-away and then sits down anyway | Livsmedel (judged at the till) | 6 % |
| Ready meal on a tray with porcelain and cutlery ordered to a hotel room | Restaurangtjänst | 12 % |
| Self-serve salad the guest weighs, boxes and takes away with disposable cutlery | Livsmedel | 6 % |
| Popcorn and läsk in a cinema | Livsmedel | 6 % |
| Måltider och förfriskningar inside a konferensarrangemang | Part of the conference service | 25 % |
| Hotel breakfast tied to the room, not part of a conference | Rumsuthyrning | 12 % |

The forecourt pair is the key one: **the split is made at the point of sale on what the customer chooses then**. A later change of mind does not reopen the VAT treatment.

### The bakery counter inside a café, and mixed orders

A café that also sells bread, cakes or coffee beans over the counter is running two supplies from one till. Nothing turns on the article: only on the choice made at the till. The basket is therefore split **per line, not per receipt**. Skatteverket's own example: coffee and a pastry eaten at the café's table (12 %) and a loaf taken home (6 %) on one purchase.

Where a single price covers parts with different rates and the split cannot be established, **ML 8 kap. 20 §** requires the beskattningsunderlag to be divided *efter skälig grund*, and expressly applies that to splitting a base across different rates.

### Practical rule for a till that must split the basket

1. Every article carries a **default rate**, but the rate is set by a **servering / avhämtning switch** applied to the line or to the order: never by the article alone. The switch must be a deliberate keypress, and the receipt must show which rate each line carried (`swedish-cash-register`).
2. Articles that can never move (sprit, vin, starköl at 25 %; tap water at 25 %) are locked to their rate and excluded from the switch.
3. The Z-dagrapport must split turnover by rate, not only in total. If the report shows one 12 % bucket for a business that visibly sells take-away, the parameterisation is wrong and the day cannot be booked correctly.
4. **Ask the user** whether the till currently defaults the switch to servering or to avhämtning. A default of servering overcharges the guest and overpays VAT; a default of avhämtning understates VAT and is the error Skatteverket looks for.

---

## 3. Packaging, transport and single-use items

| Item | Treatment | Rate |
|------|------|------|
| Packaging or transport charged by the restaurant for its own ready meal | Shares the rate of the food | 6 % take-away, 12 % served |
| Transport performed by another company (the guest ordered via an app other than the restaurant's own) | Separate transporttjänst by that company | 25 % |
| Engångsartiklar (cutlery, napkins) the guest can *choose* to buy | Separate supply of goods | 25 % |

Note the asymmetry: disposables *included* in the meal follow the meal; disposables *offered as an option* are their own 25 % sale.

---

## 4. Catering, delivery and platforms

### When catering is a restaurangtjänst

Catering is the same supply as restaurant service, moved to the customer's premises, and carries **12 %** under ML 9 kap. 5 §: provided the support services are actually performed there. Dropping off insulated trays with no serving, no dukning and no diskning is a delivery of **livsmedel at 6 %**. The invoice should say which it was, and what was done on site. For catering to slutna sällskap under a serveringstillstånd, each venue must be notified to and approved by the municipality (alkohollagen 8 kap. 4 §, as amended by SFS 2026:511), see `drift-och-personal.md`.

### The restaurant delivers with its own staff or its own app

One supply. The food keeps its rate (6 % take-away), and a separately charged delivery fee follows the food. Support services are not performed at the guest's home, so this is not catering.

### A platform is involved (Foodora, Uber Eats, Wolt and similar)

Two questions, in this order.

**Who is the seller of the food towards the guest?** This is a contract question, answered from the platform agreement, not from the app's appearance.

| The platform acts | Consequence | Statute |
|------|------|------|
| **In its own name** for the restaurant's account | The platform is deemed to have acquired and supplied the food itself. The restaurant's supply is to the platform; the platform's supply is to the guest. | ML 5 kap. 27 § (services); 5 kap. 3 § p. 3 (kommissionsavtal, goods) |
| **In the restaurant's name** (pure förmedling) | The restaurant supplies the guest directly. The platform supplies an agency service to the restaurant. | General rule; cf. ML 5 kap. 41 § for the parallel voucher case |

**Who performs the transport?** Skatteverket is explicit: if another company transports the food: typically where the guest ordered through an app other than the restaurant's own, that transport is a **separate transporttjänst at 25 %**.

### Commission and payout

A platform normally sells to the guest at a menu price, withholds a commission and pays the net. Booking the net receipt only is wrong: it understates both revenue and output VAT.

| Step | Entry |
|------|------|
| Sales of the day made through the platform | Debit **1686 Fordringar för kontokort och kuponger** (or **1510 Kundfordringar** if invoiced) / Credit **3003 Försäljning inom Sverige, 6 % moms** (or **3002**, 12 %) and **2631** / **2621** |
| Platform commission on the settlement statement | Debit **6050 Försäljningsprovisioner** and **2641 Debiterad ingående moms** / Credit **1686** |
| Net payout to the bank | Debit **1930 Företagskonto** / Credit **1686** |

The commission is a Swedish B2B service taxed at 25 % when the platform is established in Sweden. Where the platform invoices from another EU country under the main rule, the restaurant self-assesses: see `swedish-vat` (rutor 21/30/48, accounts **2614** and **2645**).

**Osäkert:** the treatment of a specific platform's commission and payout turns on that platform's own contract and invoice wording, which is not a public primary source. **Ask the user for the platform agreement and one settlement statement** before booking the first payout, and check three things: whether the platform invoices the restaurant or self-bills, whether it states it acts in its own name, and whether the delivery fee is charged to the guest by the platform or by the restaurant. (Prop. 2025/26:55 records that the 6/12 split was expected to favour platform take-away over restaurants; that does not change the legal test.)

---

## 5. Alcohol

- **25 % VAT** on spritdrycker, vin och starköl, whether served in the dining room or sold to go (ML 9 kap. 5 §; 9 kap. 19 § p. 2). A restaurangtjänst containing both food and alcohol is **split**: food at 12 %, alcohol at 25 %.
- Alkoholfria drycker, **lättöl och folköl** are livsmedel: 6 % taken away, 12 % served. Definitions: alkoholdryck > 2,25 volymprocent; folköl > 2,25 but ≤ 3,5; starköl > 3,5 (alkohollagen 2010:1622, 1 kap.).
- **Alkoholskatt is not booked separately by the restaurant.** Liability sits with upplagshavare, registrerade varumottagare and importers under lag (2022:156) om alkoholskatt 9 kap., not with a serving business: the tax is already in the purchase price. It is also part of the VAT base on the way out: **ML 8 kap. 13 §**, the beskattningsunderlag includes skatter och avgifter utom mervärdesskatt. So the 25 % is computed on a price that already contains alkoholskatt. There is no netting and no **2660 Punktskatter** entry for a restaurant.
- Purchases of spritdrycker, vin, starköl och andra jästa alkoholdrycker may only be made from a partihandlare or from Systembolaget (alkohollagen 8 kap. 13 §). A supplier invoice from anyone else is both a licence problem and an audit flag.

---

## 6. Personalmåltider

Two separate taxes. Keep them apart.

### VAT side (here)

A free meal to staff is a supply without ersättning:

| Case | Treatment | Base | Rate |
|------|------|------|------|
| Free meal eaten on the premises | **Uttag av tjänst**, ML 5 kap. 29 § | Kostnaden for providing it, **ML 8 kap. 6 §** | 12 % |
| Free food the employee takes home | **Uttag av vara**, ML 5 kap. 9 § p. 1 | Inköpspriset, or självkostnadspriset if none, **ML 8 kap. 5 §** | 6 % |
| Employee pays a price below market value | Ersättningen is the base, **ML 8 kap. 2 §**, but see below | Ersättningen or marknadsvärdet | 12 % / 6 % |

Uttag only applies where input VAT on the goods or their components was deductible (**ML 5 kap. 11 §**): which it is for a restaurant's food purchases.

**Omvärdering:** where the employee pays less than market value, the base is raised to **marknadsvärdet** if the employee's VAT is not fully deductible, the parties are *förbundna med varandra*, and the employer cannot show the price was marknadsmässigt betingad (**ML 8 kap. 17 §**). **ML 8 kap. 19 §** states expressly that *band på grund av anställning* makes the parties förbundna. A private employee never has deduction right, so a subsidised staff meal will normally be revalued to market unless the discount is commercially justified. Entry for the VAT on free staff meals:

| | Account | Debit | Credit |
|------|------|------|------|
| Uttagsmoms, meals served on the premises | **7382 Kostnader för fria eller subventionerade måltider** | x | |
| | **2622 Utgående moms på egna uttag, 12 %** | | x |

The raw-material cost is already in **4310**; the uttag adds only the VAT. Use **2632** (6 %) where the uttag is of goods taken home. Where the uttag is also to be shown as turnover, route it through **3402 / 3403 Egna uttag momspliktiga** instead: but do not do both.

### Benefit side (→ `swedish-payroll`)

Schablonvärden för fri kost, **inkomstår 2026** (Skatteverket, Kostförmån, checked 2026-09-17):

| Benefit | 2026 | 2025 |
|------|------|------|
| Helt fri kost (minst tre måltider) | **310 kr/dag** | 305 kr/dag |
| Fri lunch eller middag | **124 kr/dag** | 122 kr/dag |
| Fri frukost | **62 kr/dag** | 61 kr/dag |

Reported in AGI **ruta 012**. An employee payment (directly or by nettolöneavdrag) reduces the benefit value krona för krona; book it against **7388 Anställdas ersättning för erhållna förmåner**. Arbetsgivaravgifter on benefit values go to **7512**.

Skatteverket can decide a **lower benefit value on application** where the meal deviates considerably from a normal lunch, and names gatukök, baguettebutiker and salladsrestauranger as typical cases. If granted, tick **ruta 048** in AGI. **Ask the user** whether such a beslut exists before applying the schablon to a fast-food operation.

Fri kost at genuine **intern representation** (personalfest, intern kurs, informationsmöte, kick-off: tillfällig och kortvarig, max one week) is tax-free for the employee; recurring working lunches for running work are not. Documentation of the occasion is required.

---

## 7. Free meals to guests, complimentary dishes, samples and spill

| Case | VAT | Income tax / booking |
|------|------|------|
| **Komplimentmåltid** to a guest (goodwill after a complaint) | Uttag av tjänst, ML 5 kap. 29 §; base = kostnaden, ML 8 kap. 6 §; 12 % | Cost stays in **4310**; a meal has a 0 kr income-tax deduction ceiling, so the uttagsmoms goes to **6072 Representation, ej avdragsgill** (or **7632** when it was for staff), not to 6071 |
| **Free dish to a paying table already invoiced** (price reduction, not a gift) | No uttag: reduce the ersättning; **3730 Lämnade rabatter** | Normal revenue reduction |
| **Varuprover and gåvor av mindre värde** given inside the business | **Not** an uttag: ML 5 kap. 9 § andra stycket | Book cost only |
| **Tasting portions to the public** as marketing | Varuprover if of minor value; otherwise uttag | **5960 Varuprover, reklamgåvor, presentreklam och tävlingar** |
| **Svinn**: food spoiled, dropped, burnt, past date | **No uttag.** The goods left the business through destruction, not through a supply or a private use. Input VAT stays deducted. | Cost stays in **4310 / 4010**; the loss lands automatically in **4910 / 4960 Förändring av lager** at the count |

The dividing line is use: a meal that a person eats free of charge is an uttag; food thrown away is an ordinary business loss. Documentation for svinn is covered in `drift-och-personal.md` and `swedish-inventory`.

Complimentary meals to guests are representation; the VAT deduction cap and the 300 SEK schablon are in `swedish-vat`. Note this is the *input* side: the uttag here is output VAT and is not capped.

---

## 8. Presentkort, lunchkuponger and third-party lunch cards

### Which voucher is it

**ML 2 kap. 27 §**: a voucher is an **enfunktionsvoucher** if, already when it is issued, both the VAT amount payable for the goods or services it covers and the place of supply are known. Anything else is a **flerfunktionsvoucher**.

For a restaurant, the VAT amount is knowable only if the rate is knowable: and after 1 April 2026 the rate is not knowable unless the voucher is restricted to one of servering or avhämtning.

| Voucher | Classification | VAT falls |
|------|------|------|
| Lunchkupong usable **only for dine-in** | Enfunktionsvoucher | At sale, **12 %** |
| Lunchkupong usable **only for take-away** | Enfunktionsvoucher | At sale, **6 %** |
| Voucher usable for **either**, or for anything on the menu incl. alcohol | **Flerfunktionsvoucher** | At redemption, at the rate of what is actually taken |
| Open-amount gift card | Flerfunktionsvoucher | At redemption |

Skatteverket confirms the 1 April 2026 consequence directly: lunch coupons sold from that date that can be used both for servering and for avhämtning are flerfunktionsvouchrar, and the rate is determined only on redemption: 12 % if the guest eats in, 6 % if the guest takes the food.

### Statutory mechanics

- **ML 5 kap. 40-42 §§**: every transfer of an enfunktionsvoucher by a person acting in their **own name** is itself the supply, and the later handover of the food is not a separate transaction; a transfer made in **another person's name** makes that other person the supplier.
- **ML 5 kap. 43-44 §§**: for a flerfunktionsvoucher only the actual supply on redemption is taxed, earlier transfers are not, but a separately identifiable distribution or marketing service around the voucher is taxed in its own right.
- **ML 7 kap. 18 §**: output VAT on an enfunktionsvoucher is reported for the period the voucher was handed over, or earlier payment received.
- **ML 8 kap. 4 §**: on redemption of a flerfunktionsvoucher the base is what was paid for the voucher; if unknown, the monetary value stated on it or in its documentation.

### Booking

| Event | Debit | Credit |
|------|------|------|
| Sale of a **flerfunktionsvoucher** (gift card) | **1910 / 1930** | **2421 Ej inlösta presentkort** |
| Redemption against a served meal / against take-away | **2421** | **3002** + **2621** / **3003** + **2631** |
| Sale of an **enfunktionsvoucher** (dine-in only) | **1910 / 1930** | **3002** + **2621** |
| Redemption of that enfunktionsvoucher | **2421** (if parked) or memo only |: no second VAT event |
| Voucher expired unredeemed | **2421** | **3990 Övriga ersättningar, bidrag och intäkter**: no VAT for a flerfunktionsvoucher, since no supply ever occurred |

**Ask the user** how long gift cards are valid and whether the balance in **2421** has been aged. An unmoving balance older than the stated validity is either an unrecognised gain or a liability that was never a voucher.

### Third-party lunch cards (Edenred, Rikskortet, Benify and similar)

The restaurant supplies the **meal to the guest** and takes payment in a medium that a third party settles. The provider's supply is a service to the restaurant (and separately to the employer), not a share of the meal.

| Step | Entry |
|------|------|
| Meal redeemed against a lunch card | Debit **1686 Fordringar för kontokort och kuponger** / Credit **3002** + **2621** (dine-in) or **3003** + **2631** (take-away): full gross value, not the net |
| Provider's fee on the settlement statement | Debit **6050 Försäljningsprovisioner** (or **6040 Kontokortsavgifter** where it is a card acquiring fee) and **2641** / Credit **1686** |
| Net settlement | Debit **1930** / Credit **1686** |

The kassaregister must be able to register presentkort and kuponger as payment types and show the payment method on the receipt (`swedish-cash-register`).

**Osäkert:** whether a given provider's fee carries 25 % Swedish VAT or is an exempt financial service depends on what the provider actually supplies and where it is established. That is on the provider's invoice, which is the source to follow: do not assume. Skatteverket's rättslig vägledning on vouchers could not be fetched for this file (the site blocks automated requests).

---

## 9. Rabatter, happy hour and bundles across two rates

| Case | Treatment |
|------|------|
| Happy hour price on beer | Lower price is simply the ersättning. No rabattpost needed; the rate is unchanged (folköl 12 % served, starköl 25 %) |
| Discount given at the till and shown on the receipt | Reduces the beskattningsunderlag directly; book net |
| Discount granted after the fact (loyalty, complaint credit) | **3730 Lämnade rabatter**, with output VAT reversed at the rate of the original sale |
| Kassarabatt for early payment on a catering invoice | **3731 Lämnade kassarabatter** |
| **Bundle spanning two rates**: e.g. "lunch + beer" or "burger meal to take away + bottled water" | Split the price per rate |

For a bundle, the base is allocated **efter skälig grund** where a component's share cannot be established (**ML 8 kap. 20 §**, second paragraph, which covers precisely the case where VAT is charged at different rates). The defensible key is the **relation between the components' ordinary à-la-carte prices**, applied consistently and documented once rather than re-argued per receipt. A discount on a mixed bundle must be spread over the rates on that same key, not loaded onto the highest-rate component. Loading a discount onto the alcohol line to move value into the 12 % or 6 % bucket is the classic manipulation and is what a bruttovinst analysis exposes.

**Ask the user** for the price list behind every fixed menu, and whether the till applies bundle discounts per line or as one lump on the receipt total. A lump discount with no per-line allocation cannot be booked correctly.

---

## 10. Worked example: one full day

*Sunset Kök & Bar AB, Z-dagrapport for Thursday 17 September 2026. Restaurant with a take-away hatch, full serveringstillstånd, gift cards in circulation.*

| Sales line | Gross | Rate | Net | VAT |
|------|------|------|------|------|
| Servering: mat och alkoholfritt | 42 000.00 | 12 % | 37 500.00 | 4 500.00 |
| Servering: sprit, vin och starköl | 18 750.00 | 25 % | 15 000.00 | 3 750.00 |
| Avhämtning: livsmedel | 10 600.00 | 6 % | 10 000.00 | 600.00 |
| Servering paid with a redeemed gift card | 1 120.00 | 12 % | 1 000.00 | 120.00 |
| **Total** | **72 470.00** | | **63 500.00** | **8 970.00** |

Payment media on the Z report: kontant 8 000.00, kort 61 000.00, Swish 2 350.00, inlöst presentkort 1 120.00: total 72 470.00.

**Verifikation A: the day's sales** (gemensam verifikation for the day's cash takings, BFL 5 kap. 6 § tredje stycket):

| Account | Debit | Credit |
|------|------|------|
| **1910 Kassa** | 8 000.00 | |
| **1686 Fordringar för kontokort och kuponger** | 61 000.00 | |
| **1930 Företagskonto** (Swish) | 2 350.00 | |
| **2421 Ej inlösta presentkort** | 1 120.00 | |
| **3002 Försäljning inom Sverige, 12 % moms** | | 38 500.00 |
| **2621 Utgående moms på försäljning inom Sverige, 12 %** | | 4 620.00 |
| **3001 Försäljning inom Sverige, 25 % moms** | | 15 000.00 |
| **2611 Utgående moms på försäljning inom Sverige, 25 %** | | 3 750.00 |
| **3003 Försäljning inom Sverige, 6 % moms** | | 10 000.00 |
| **2631 Utgående moms på försäljning inom Sverige, 6 %** | | 600.00 |
| | **72 470.00** | **72 470.00** |

The gift card was a flerfunktionsvoucher: no VAT was taken when it was sold, and it is taxed here at 12 % because the guest ate in (ML 5 kap. 43 §, 8 kap. 4 §).

**Verifikation B: four free staff lunches eaten on the premises**, självkostnad 45,00 kr each, base 180,00 (ML 8 kap. 6 §):

| Account | Debit | Credit |
|------|------|------|
| **7382 Kostnader för fria eller subventionerade måltider** | 21.60 | |
| **2622 Utgående moms på egna uttag, 12 %** | | 21.60 |

Benefit side, same day: 4 × 124,00 = **496,00 kr** kostförmån to AGI ruta 012, arbetsgivaravgifter to **7512** / **2731**: calculation in `swedish-payroll`.

**Verifikation C: card settlement received the next banking day**, acquirer fee 0,9 %:

| Account | Debit | Credit |
|------|------|------|
| **1930 Företagskonto** | 60 451.00 | |
| **6040 Kontokortsavgifter** | 549.00 | |
| **1686 Fordringar för kontokort och kuponger** | | 61 000.00 |

Cash must be booked **senast påföljande arbetsdag** and **1910** must reconcile to the counted drawer; the växelkassa is registered in the till before the day starts (`swedish-cash-register`).

---

## 11. BAS 2026 accounts used in this file

Verified against KONTOPLAN BAS 2026 (bas.se, downloaded 2026-09-17). Note that domestic sales are now **3000** with **3001-3004** by rate: the older per-product 30xx series is gone.

| Account | Name |
|------|------|
| **1686** | Fordringar för kontokort och kuponger |
| **1910 / 1930** | Kassa / Företagskonto |
| **2421** | Ej inlösta presentkort |
| **2611 / 2621 / 2631** | Utgående moms på försäljning inom Sverige, 25 % / 12 % / 6 % |
| **2612 / 2622 / 2632** | Utgående moms på egna uttag, 25 % / 12 % / 6 % |
| **2641 / 2650** | Debiterad ingående moms / Redovisningskonto för moms |
| **3001 / 3002 / 3003 / 3004** | Försäljning inom Sverige, 25 % / 12 % / 6 % / momsfri |
| **3401-3404** | Egna uttag momspliktiga 25 % / 12 % / 6 %, och momsfria |
| **3730 / 3731 / 3732** | Lämnade rabatter / kassarabatter / mängdrabatter |
| **3740 / 3990** | Öres- och kronutjämning / Övriga ersättningar, bidrag och intäkter |
| **4010 / 4310** | Inköp av handelsvaror / av råvaror och material i Sverige |
| **4910 / 4960** | Förändring av lager av råvaror / av handelsvaror |
| **5960 / 6040 / 6050** | Varuprover och reklamgåvor / Kontokortsavgifter / Försäljningsprovisioner |
| **6071 / 6072** och **7631 / 7632** | Representation och personalrepresentation, avdragsgill / ej avdragsgill |
| **7382 / 7388 / 7512** | Kostnader för fria eller subventionerade måltider / Anställdas ersättning för erhållna förmåner / Arbetsgivaravgifter för förmånsvärden |

Drinks bought for resale unchanged belong in handelsvaror (**4010 / 1460 / 4960**); ingredients transformed in the kitchen belong in råvaror (**4310 / 1410 / 4910**). Pick one convention per client and hold it: the ratio work in `drift-och-personal.md` depends on it.

---

## 12. Ask-the-user checklist before booking a first period

1. Does the business sell take-away at all, does the till have a servering/avhämtning switch, and what is its default?
2. Is there a serveringstillstånd, are sprit/vin/starköl locked to 25 % in the article register, and how is cider coded today?
3. Are menu prices set inclusive or exclusive of VAT? (Decides who absorbs the 2028-01-01 reversal.)
4. Which delivery platforms are used, does each contract say the platform acts in its own name, and can we see one settlement statement per platform?
5. Are gift cards restricted to dine-in, to take-away, or open? Any stated expiry, and has **2421** been aged?
6. Which third-party lunch cards are accepted, and what does each provider's fee invoice look like?
7. Do staff eat free, at a discount, or at full price: and is there a Skatteverket beslut on a lower kostförmånsvärde?
8. Are bundle and happy-hour prices backed by a written price list?

---

## Sources

All checked **2026-09-17**.

**Statutes (consolidated text, lagen.nu / Svensk författningssamling)**

- Mervärdesskattelag (2023:200): 2 kap. 27 §; 5 kap. 3, 9, 11, 27, 29, 40-44 §§; 7 kap. 18 §; 8 kap. 2, 4, 5, 6, 13, 17, 19, 20 §§; 9 kap. 2, 4, 5, 19 §§
- **SFS 2026:118**: Lag om ändring i mervärdesskattelagen (2023:200), utfärdad 2026-02-26, published 2026-03-03, in force **2026-04-01**; renumbers 9 kap. 3 § → 9 kap. 19 § and sets 6 % on livsmedel. Official PDF read in full (svenskforfattningssamling.se/doc/2026118.html). Prop. 2025/26:55, bet. 2025/26:SkU9, rskr. 2025/26:158
- **SFS 2026:119**: same act and prop; renumbers 9 kap. 19 § → 9 kap. 3 § and restores 12 %, in force **2028-01-01**. Official PDF read in full
- Prop. 2025/26:55, *Tillfälligt sänkt mervärdesskatt på livsmedel* (riksdagen.se)
- Alkohollag (2010:1622): 1 kap. (definitions of alkoholdryck, folköl, starköl); 8 kap. 13 §
- Lag (2022:156) om alkoholskatt: 9 kap. (skattskyldighet)
- Bokföringslag (1999:1078): 5 kap. 6 § tredje stycket (gemensam verifikation for a day's cash sales)

**Skatteverket (www.skatteverket.se, full page text retrieved)**

- *Momssatser och undantag från moms*: sections "Livsmedel eller restaurangtjänst", "Restaurangtjänster och cateringtjänster", "Förpackningar, transport och engångsartiklar", "Lunchkuponger (voucher)", "Konferensarrangemang"
- *Kostförmån*: schablonvärden for inkomstår 2026 and 2025, justering av förmånsvärde, intern representation
- *Så här använder du kassaregister*: payment types incl. presentkort och kuponger

**BAS**

- KONTOPLAN BAS 2026, `BAS_kontoplan_2026_v2.xlsx`, bas.se/kontoplaner/: every account number and name in this file read from that spreadsheet

**Not reachable**

Skatteverket's *Rättslig vägledning* (www4.skatteverket.se) rejects automated requests and could not be read for this file. The points that would have been settled there are marked **Osäkert** above (cider and other andra jästa alkoholdrycker; the VAT status of a specific lunch-card provider's fee). Nothing in this file is stated on the authority of a secondary source.
