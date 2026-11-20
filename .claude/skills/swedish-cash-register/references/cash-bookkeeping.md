# Bokföring av dagskassor (Cash Sales and the Daily Takings)

Booking the day's takings in a Swedish shop, restaurant or salon.

Out of scope, handled elsewhere: acquirer payouts, provider fees and settlement files → `swedish-daily-bookkeeping/references/payment-providers.md`; kassaregisterkrav, certifiering, kontrollenhet, SKVFS → the kassaregister-law reference in this skill; payroll mechanics → `swedish-payroll`; VAT edge cases and momsdeklaration rutor → `swedish-vat`.

<!-- toc -->
**Contents**

- [1. Dagsavslut and the Z-dagrapport](#1-dagsavslut-and-the-z-dagrapport)
- [2. Accounts (verified against the BAS 2026 kontoplan, bas.se)](#2-accounts-verified-against-the-bas-2026-kontoplan-basse)
- [3. VAT rates for a cash business, September 2026](#3-vat-rates-for-a-cash-business-september-2026)
- [4. Worked example: one restaurant day](#4-worked-example-one-restaurant-day)
- [5. Växelkassa](#5-växelkassa)
- [6. Kassadifferens](#6-kassadifferens)
- [7. Insättning till bank and the reconciliation chain](#7-insättning-till-bank-and-the-reconciliation-chain)
- [8. Dricks](#8-dricks)
- [9. Personalmåltider and uttag](#9-personalmåltider-and-uttag)
- [10. Presentkort (vouchers)](#10-presentkort-vouchers)
- [11. Kontantmetoden versus faktureringsmetoden](#11-kontantmetoden-versus-faktureringsmetoden)
- [12. Daily and monthly checklist](#12-daily-and-monthly-checklist)
- [13. Red flags an agent must raise](#13-red-flags-an-agent-must-raise)
- [14. Ask the user rather than assume](#14-ask-the-user-rather-than-assume)
- [Sources](#sources)

<!-- /toc -->

## 1. Dagsavslut and the Z-dagrapport

### What it is

A **gemensam verifikation** may document all receipts from one day's cash sales (BFL 5 kap 6 § tredje stycket), consisting of "uppgifter från en kassaapparat, kassarapport eller annan uppgift som anger summan av mottagna betalningar". Card and other electronic sales may be included in it, or kept in separate gemensamma verifikationer per payment type (BFNAR 2013:2 p. 6.4).

BFN's comment: "Ett tömningskvitto är en sammanställning över affärshändelser för en dag. Tömningskvittot benämns i många kassaregister Z-dagrapport." The Z-report is therefore not *support* for the verifikation: together with the kontrollremsa or journalminne it **is** the verifikation.

### When a gemensam verifikation is allowed

| Situation | Allowed? | Source |
|---|---|---|
| Sales registered in a kassaregister (certified or not) | Yes, always | BFNAR 2013:2 p. 6.6 a + comment |
| No kassaregister, but "mindre belopp" | Yes | BFNAR 2013:2 p. 6.6 b |
| Company issues kontantfakturor instead of using a kassaregister | **No**: book in sammandrag per p. 2.9 instead | BFNAR 2013:2 p. 6.6 comment |
| Förskottsbetalning (postorder, internet sales) | No: the rule is for payment on delivery | BFNAR 2013:2 p. 6.4 comment |
| Kontanta **inköp** made from the till | No: these need their own verifikation | BFNAR 2013:2 p. 6.6 comment |

### What the day's verifikation must consist of

| Company type | Gemensam verifikation consists of | Source |
|---|---|---|
| Uses a kassaregister | Tömningskvitton (Z-dagrapporter) **plus** either kontrollremsor or journalminnen | BFNAR 2013:2 p. 6.7 |
| No kassaregister | One **kassarapport per kassa**, showing (a) which day, (b) the ort(s) where sales took place, (c) the day's total. Dated and **signed** by whoever prepared it | BFNAR 2013:2 p. 6.8 |
| Myntautomat without kassaregister | One kassarapport per automat: period, which automat, sum found at emptying. Dated and signed | BFNAR 2013:2 p. 6.9 |

Two further content rules, both easy to fail in software. **p. 6.10**: the split between kontantförsäljning and sales against kontokort / other electronic means must be visible **in the gemensam verifikation itself**. **p. 6.11**: where card sales are included, a sammanställning over them must be part of the verifikation, and where they exist, the individual köpnotor as well.

If the company actually holds the counterparty's identity (tidsbeställningslistor, kundnummer, a receipt issued so the customer can prove ownership or claim a guarantee), BFN says it cannot be considered "svårt" to include it, so motpart must be in or referenced from the gemensam verifikation: the BFL 5 kap 8 § exemption does not apply. This bites in salons with booking systems.

### When it must be booked

| Payment type | Deadline for grundbokföring (registreringsordning) | Source |
|---|---|---|
| Sedlar och mynt, postväxlar, mottagna checkar, other betalningsanvisningar immediately convertible to cash | **Senast påföljande arbetsdag** | BFL 5 kap 2 § 1 st; BFNAR 2013:2 p. 3.2 |
| Received paper måltidskuponger, rabattkuponger, presentkort in paper form, where the company is reimbursed by redemption | Same as cash: they are jämställda med kontanta inbetalningar | BFNAR 2013:2 p. 1.10 |
| Kontokort, Swish, sms, electronic presentkort, bankgiro/plusgiro | Not kontant: "så snart det kan ske", and may be senarelagd under p. 3.6-3.9 | BFNAR 2013:2 p. 1.9 comment; BFN Q&A "Swishbetalningar" |
| Cash sales **registered in a certified kassaregister** (or one with tillverkardeklaration, p. 1.12) | 50 days after the end of the month in which they occurred | BFNAR 2013:2 p. 3.10 |
| Cash **out of the till** that the kassaregister does not register: e.g. taking the dagskassa out for a bank deposit | **Still senast påföljande arbetsdag** | BFNAR 2013:2 p. 3.10 comment; exempel 2.1 |
| Business concentrated in separate periods (market stalls, fairs), so the next working day is more than a few days away | Senast dagen efter the day it occurred | BFNAR 2013:2 p. 3.3 |

**The trap in p. 3.10.** A restaurant with a certified kassaregister that sends verifikationer to a konsult monthly may defer booking the *sales*, but the daily cash withdrawal for the bank deposit is not registered in the kassaregister and must be entered by the next working day: typically in a **kassajournal** kept by the company itself, showing registreringsordning, redovisningsperiod, verifikationsnummer, kontering and bokfört belopp (BFNAR 2013:2 p. 2.3). BFN's exempel 2.1 is exactly this case, a lunchrestaurang.

**Swish.** BFN: "Betalning med swish ska bokföras vid samma tidpunkt som betalning med andra elektroniska betalmedel, t.ex. kontokort", and "Betalningssättet avgör inte hur en försäljning ska bokföras." *Osäkert:* whether Swish triggers the **kassaregisterskyldighet** in SFL 39 kap 4 § (which names kontant betalning and betalning med kontokort) is a separate question: check the kassaregister-law reference in this skill; do not infer it from the BFN answer.

## 2. Accounts (verified against the BAS 2026 kontoplan, bas.se)

| Account | Name (BAS 2026) | Use |
|---|---|---|
| **1910** | Kassa | The till. Sub-accounts **1911** Huvudkassa, **1912** Kassa 2, **1913** Kassa 3 |
| **1930** | Företagskonto | The bank account |
| **1686** | Fordringar för kontokort och kuponger | Receivable on the card/acquirer company, under **1680** Andra kortfristiga fordringar |
| **1990** | Redovisningsmedel | Money held for someone else's account |
| **2421** | Ej inlösta presentkort | Under **2420** Förskott från kunder |
| **2611 / 2621 / 2631** | Utgående moms på försäljning inom Sverige, 25 % / 12 % / 6 % | |
| **2612 / 2622 / 2632** | Utgående moms på egna uttag, 25 % / 12 % / 6 % | |
| **2820 / 2829** | Kortfristiga skulder till anställda / Övriga kortfristiga skulder till anställda | |
| **3001 / 3002 / 3003 / 3004** | Försäljning inom Sverige, 25 % / 12 % / 6 % moms / momsfri | |
| **3401 / 3402 / 3403** | Egna uttag momspliktiga, 25 % / 12 % / 6 % | Under **3400** Försäljning, egna uttag |
| **3740** | Öres- och kronutjämning | Rounding |
| **3999** | Övriga rörelseintäkter | |
| **6570** | Bankkostnader | Card/acquirer fees: see `payment-providers.md` |
| **7382** | Kostnader för fria eller subventionerade måltider | |
| **7388** | Anställdas ersättning för erhållna förmåner | Nettolöneavdrag for meals |

**1580 no longer exists.** BAS moved the card receivable to **1686** because the debtor is the card company, not the customer, so it belongs under Övriga fordringar rather than Kundfordringar (bas.se, "Hur ska försäljning mot kontokort bokföras?", 2025-10-30). Any system still posting to 1580 is on a pre-2026 plan. BAS 2026 also has **no account named "Kassadifferens"**: verified by reading the published kontoplan; see section 6.

## 3. VAT rates for a cash business, September 2026

| Sale | Rate | Source |
|---|---|---|
| Restaurang- och cateringtjänst (food and non-alcoholic drink served on site) | 12 % | ML 9 kap 5 § |
| The part of that service that is spritdrycker, vin or starköl | 25 % | ML 9 kap 5 §, ML 9 kap 2 § |
| Livsmedel (take-away, shop sales) | **6 %** temporarily, 1 April 2026 to 31 December 2027 | ML 9 kap 19 § (SFS 2026:118) |
| Bottled water sold as a vara | 6 % during the same period | ML 9 kap 19 § 2 st |
| Spritdrycker, vin, starköl sold as varor | 25 % | ML 9 kap 19 § 1 st p. 2 |
| Hairdressing, beauty, most other services | 25 % | ML 9 kap 2 § |

From 1 January 2028 the livsmedel rule moves back to ML 9 kap 3 § at 12 % (SFS 2026:119). **Never hard-code a rate**: today the same burger is 12 % eaten in and 6 % taken away, and both are 12 % in 2028. Ask whether the kassaregister separates servering from avhämtning; if not, the split is unsupportable.

## 4. Worked example: one restaurant day

**Facts.** Friday 2026-09-11. Z-dagrapport, journalminne, acquirer sammanställning and köpnotor form one gemensam verifikation. Sales inkl. moms: servering av mat 24 640, servering av öl och vin 11 250, take-away 3 180. Payment split: kort 28 000, Swish 6 000, kontant 5 070. Counted cash agrees with the Z-report.

| Sale line | Inkl. moms | Net | VAT | Accounts |
|---|---|---|---|---|
| Servering, mat och alkoholfritt, 12 % | 24 640 | 22 000 | 2 640 | 3002 / 2621 |
| Servering, öl och vin, 25 % | 11 250 | 9 000 | 2 250 | 3001 / 2611 |
| Take-away livsmedel, 6 % | 3 180 | 3 000 | 180 | 3003 / 2631 |
| **Total** | **39 070** | **34 000** | **5 070** | |

Verifikation A (the day's takings, dated 2026-09-11):

| Konto | Namn | Debet | Kredit |
|---|---|---|---|
| **1686** | Fordringar för kontokort och kuponger | 28 000,00 | |
| **1930** | Företagskonto (Swish) | 6 000,00 | |
| **1910** | Kassa | 5 070,00 | |
| **3001** | Försäljning inom Sverige, 25 % moms | | 9 000,00 |
| **2611** | Utgående moms på försäljning inom Sverige, 25 % | | 2 250,00 |
| **3002** | Försäljning inom Sverige, 12 % moms | | 22 000,00 |
| **2621** | Utgående moms på försäljning inom Sverige, 12 % | | 2 640,00 |
| **3003** | Försäljning inom Sverige, 6 % moms | | 3 000,00 |
| **2631** | Utgående moms på försäljning inom Sverige, 6 % | | 180,00 |
| | **Summa** | **39 070,00** | **39 070,00** |

Verifikation B, the cash leaving the till that evening: a kontant utbetalning, so booked by the next working day even where the sales are deferred under p. 3.10: Debit **1930** 5 070,00 / Credit **1910** 5 070,00.

Verifikation C, acquirer payout 2026-09-14 with a 0,6 % fee: Debit **1930** 27 832,00 and **6570** Bankkostnader 168,00 / Credit **1686** 28 000,00.

### 1686 or straight to 1930 for card sales?

| Condition | Treatment | Source |
|---|---|---|
| The company reports card sales to the card company **daily** and payment is contractually due within **three bankdagar** | The receivable and the payment may be booked and presented as **one** affärshändelse: post the sale straight to **1930** on the sale date, in a separate posting to make reconciliation possible | BFNAR 2013:2 p. 2.12 |
| Anything slower, netting of fees, chargebacks, multiple providers, or automated bank reconciliation | Use **1686** and clear it against the payout. BAS also notes a genomgångskonto in the 19xx group as an alternative for automated reconciliation | BFNAR 2013:2 p. 2.12; bas.se 2025-10-30 |

**Ask the user** which one their routine supports before choosing. A 1686 balance that never clears means unmatched payouts, not a card sale.

## 5. Växelkassa

The växelkassa is the float that stays in the till. Setting it up, topping it up and reducing it are **transfers between two asset accounts**: never a cost.

| Event | Entry |
|---|---|
| Set up / top up a float of 2 000 from the bank | Debit **1910** 2 000 / Credit **1930** 2 000 |
| Reduce the float back to the bank | Debit **1930** / Credit **1910** |
| Owner of an enskild firma puts private cash in as float | Debit **1910** / Credit **2018** Övriga egna insättningar |
| Second till | Use **1912**, **1913**: one account per kassa, so a kassarapport per kassa (p. 6.8) has a matching ledger |

Rules an agent should enforce: **1910** must never be negative at any point in time: a negative kassa is proof that something is booked wrong or missing, not a valid balance. The **1910** balance should equal the float plus takings not yet deposited; if the company banks every evening, the year-end balance is the float, physically counted on balansdagen. If the float is "used up", the money went somewhere, a kontant inköp needs its own verifikation (BFNAR 2013:2 p. 6.6 comment) and may not hide inside the day's gemensam verifikation.

## 6. Kassadifferens

A difference is the gap between the Z-report's cash line and the cash actually counted. Same facts as section 4, but only 5 020 is counted: 50 short. Verifikation A is posted unchanged except that **1910** is debited 5 020,00 and the differenskonto debited 50,00. The sale, the VAT and the revenue are **not** adjusted: the Z-report is the verifikation of what was sold, and the difference is a separate event.

**Which account.** BAS 2026 has no account named Kassadifferens. In practice:

| Kind of difference | Usual account | Note |
|---|---|---|
| Öresavrundning at the till (smallest coin is 1 krona) | **3740** Öres- och kronutjämning | This is genuinely a price adjustment, a systematic few kronor per day |
| Genuine over/short | A dedicated account the company adds, commonly in the 39xx or 69xx range; many small companies use **3740** for both | Ask the user which account their kontoplan and their software already use: do not invent a new one silently |

*Osäkert:* BAS's own konteringsinstruktion for 3740 sits in the paid Kontotabell and was not verified here. Only the account number and name were verified against the published BAS 2026 kontoplan.

**When a difference becomes a problem.** There is no statutory tolerance; what exists is the requirement that the bokföring must make it possible to "kontrollera fullständigheten i bokföringsposterna" (BFL 5 kap 1 §). So: document each difference with amount, who counted, who approved and the cause if known (the kassarapport under p. 6.8 is already dated and signed: extend that discipline to registered tills); record differences **gross per day**, never netted over a month, since a month netted to zero hides a +900/−900 pair; escalate systematic one-sided differences or a growing absolute sum as an internal control finding; and never absorb a difference by adjusting revenue or VAT, which misstates the momsdeklaration.

## 7. Insättning till bank and the reconciliation chain

Book the deposit on the day the cash **leaves the till**, not the day the bank credits it. That withdrawal is a kontant utbetalning: senast påföljande arbetsdag (BFL 5 kap 2 §; BFNAR 2013:2 p. 3.10 comment).

**Same-day deposit at a bank or deposit machine:** Debit **1930** / Credit **1910**, verifikation = deposit receipt plus the day's Z-report. **Värdetransport or a deposit box where the credit lands days later:** the money is out of the till but not yet on the bank account. Ask the user which account they use for money in transit: a dedicated sub-account under 1910 (an own 1914 "Kassa på väg") and **1689** Övriga kortfristiga fordringar are both used; it must clear within days and be zero, or explained, on balansdagen. Never treat a bank credit of an unknown amount as a sale.

**The chain an agent should be able to walk, both directions:**

```
Z-dagrapport (gross, split by VAT rate and payment type)
  ├── kontant  → counted cash → kassadifferens note → deposit slip → bank statement line
  ├── kort     → acquirer sammanställning + köpnotor → payout report → bank statement line
  └── Swish    → Swish sammanställning → bank statement line(s)
```

Every link needs a document. Missing the acquirer sammanställning breaks BFNAR 2013:2 p. 6.11, not just the reconciliation.

## 8. Dricks

Verified Skatteverket position (FAQ "I mitt arbete på en restaurang får jag ibland dricks av gästerna. Ska jag skatta för dricksen?"; news 2024, "Tänk på att redovisa dricks om inte arbetsgivaren gjort det"): "Ja, dricks är en inkomst som ska beskattas." "Är det din arbetsgivare som tar hand om dricksen och efter eget bestämmande fördelar den bland er i personalen, är dricksen en inkomst för företaget och lön för dig": the employer then reports it, makes skatteavdrag and pays arbetsgivaravgifter. Otherwise "fördelas [den] av er i personalen. Då behöver du själv redovisa den" (punkt 1.5 in the employee's deklaration). **The payment method is not the test**: cash, a card surcharge and Swish are all taxable income for the recipient. The stated tests are whether the recipient performed work for the payer, and whether the employer takes charge of the tips and distributes them at its own discretion.

| Situation | Company income? | Lön? | Skatteavdrag + arbetsgivaravgifter? | Booking |
|---|---|---|---|---|
| Cash tips kept or split by the staff themselves; never enters the company's till or account | No | No | No: the employee declares it | Nothing in the company's books. If it passes through **1910**, it is no longer "outside" and must be accounted for |
| Card/Swish tips that land on the company's account and are paid on to the staff, with the **employer** deciding the split | **Yes**: income for the company | **Yes** | **Yes**, skatteavdrag, arbetsgivaravgifter, AGI | Receipt: Debit 1686/1930, Credit **3999**. Payout via payroll: **7010/7210** + **2731/2710**, arbetsgivaravgifter **7510/2731** |
| Card/Swish tips the employer only forwards, staff decide the split, employer exercises no discretion | See below | See below | See below | Treated as held for others: Debit 1686/1930, Credit **2820/2829** (or **1990** Redovisningsmedel), cleared on payout |

*Osäkert:* the third row. Skatteverket's wording turns on the employer taking charge of the tips and distributing them "efter eget bestämmande", which suggests a pure pass-through is not lön: but no primary source confirming that a card-tip pass-through escapes skatteavdrag and arbetsgivaravgifter was located. Since the money does pass through the employer's account and the employer does make the payment, **ask the user** how the split is decided and documented, and raise the risk before booking it as a liability rather than lön. Once it is lön, see `swedish-payroll` for skatteavdrag, arbetsgivaravgifter and AGI.

*Osäkert:* the VAT treatment of voluntary dricks (unlike an obligatory serveringsavgift added to the bill, which is part of the beskattningsunderlag under ML 8 kap 2 §) was not verified in a primary source here. Do not run voluntary tips through 3001/2611 without checking `swedish-vat` first.

## 9. Personalmåltider and uttag

Two separate consequences, and agents routinely book only one of them.

**Benefit side (inkomstskatt).** A free or subsidised meal is a kostförmån at the schablon: 2026: 310 SEK hel dag, 124 SEK lunch eller middag, 62 SEK frukost. It goes into the AGI and carries skatteavdrag and arbetsgivaravgifter. Cost to **7382**; any nettolöneavdrag the employee pays to **7388**. If the employee pays at least the schablonvärde, no taxable benefit arises. Rates and entries: `swedish-payroll` (`references/benefits.md`).

**VAT side (uttagsbeskattning).** Serving a meal to staff without ersättning is uttag av tjänst (ML 5 kap 28-29 §§), and the beskattningsunderlag is "kostnaden vid tidpunkten för uttaget för att utföra eller på annat sätt tillhandahålla tjänsterna", i.e. the share of fixed and running costs attributable to the meal (ML 8 kap 6 §). Book output VAT to **2622** (12 %, restaurangtjänst) against **3402** Egna uttag momspliktiga, 12 %. Where the employee pays but pays less than market value, ML 8 kap 17 § can force omvärdering to marknadsvärdet if the parties are förbundna and the VAT is not fully deductible for the buyer. Owner's own consumption in an enskild firma: **2011** Egna varuuttag or **2013** Övriga egna uttag, uttagsmoms on the same basis (ML 5 kap 8-10 §§, ML 8 kap 5 §: inköpspris, or självkostnadspris if none exists).

*Osäkert:* whether Skatteverket accepts the kostförmån schablon as a proxy for the ML 8 kap 6 § cost base. The law says cost, not schablon. Ask the user for the kitchen's self-cost calculation before using the schablon for VAT.

## 10. Presentkort (vouchers)

Definitions: a **voucher** carries an obligation to accept it as consideration, with the goods/services or the potential suppliers named on it or in its documentation (ML 2 kap 26 §). An **enfunktionsvoucher** is one where, already at issue, both the VAT amount and the place of supply are known; anything else is a **flerfunktionsvoucher** (ML 2 kap 27 §).

| | Enfunktionsvoucher | Flerfunktionsvoucher |
|---|---|---|
| Typical case | Gift card for a named service at one rate: a haircut, a massage | Gift card for "anything in the shop/restaurant" spanning 6 %, 12 % and 25 % |
| Each transfer | Counts as the supply itself (ML 5 kap 40-42 §§) | Not a taxable transaction; only the actual redemption is (ML 5 kap 43 §) |
| VAT due | On sale/issue: reported for the period the voucher was handed over, or payment received earlier (ML 7 kap 18 §) | On redemption |
| Beskattningsunderlag | The consideration for the voucher | The consideration paid for the voucher; if unknown, the monetary value stated on it or in its documentation (ML 8 kap 4 §) |

**1 000 SEK enfunktionsvoucher (25 % service).** Sale: Debit **1910** 1 000,00 / Credit **2421** Ej inlösta presentkort 800,00 and **2611** 200,00. Redemption: Debit **2421** 800,00 / Credit **3001** 800,00: no VAT movement, it was settled at sale.

**1 000 SEK flerfunktionsvoucher.** Sale: Debit **1910** 1 000,00 / Credit **2421** 1 000,00, no VAT. Redeemed against a 12 % meal: Debit **2421** 1 000,00 / Credit **3002** 892,86 and **2621** 107,14.

**Unredeemed vouchers.** For a flerfunktionsvoucher no supply ever occurs, so ML 5 kap 43 § never triggers and no output VAT arises; the remaining **2421** liability is derecognised to income (**3999**) when the claim lapses. For an enfunktionsvoucher the VAT was already paid at sale and expiry gives no ground to reduce the beskattningsunderlag, so only the net 800 moves from **2421** to income. *Osäkert:* no Skatteverket ställningstagande on breakage was verified: the above follows from the ML text alone. *Osäkert:* how long the liability must be carried is a civil-law preskription question (preskriptionslagen 1981:130), not a bokföring one. Ask the user for the validity printed on the card and the company's policy before releasing a 2421 balance.

BFL interaction: a **paper** presentkort the company *receives* and is reimbursed for (someone else's card, a måltidskupong) is jämställd med kontant inbetalning under BFNAR 2013:2 p. 1.10: next working day. An **electronic** presentkort is "andra elektroniska betalningsmedel" and is not (p. 1.10 comment, p. 6.4). A voucher the company issued itself and was already paid for is outside p. 1.10.

## 11. Kontantmetoden versus faktureringsmetoden

Two separate regimes with the same 3 MSEK threshold: do not conflate them.

| | Bokföring | Moms |
|---|---|---|
| Rule | BFL 5 kap 2 § 3 st: nettoomsättning normally at most 3 miljoner kronor → may wait to book until payment | ML 7 kap 16 §: sammanlagd årlig omsättning normally at most 3 miljoner kronor → utgående skatt may be reported for the period payment is received |
| Year-end | "Vid räkenskapsårets utgång ska dock samtliga då obetalda fordringar och skulder bokföras" | Output VAT for **all** receivables unpaid at the end of the beskattningsår must be reported in that last period |
| Switching | - | Moving from faktureringsmetoden to bokslutsmetoden requires an application to Skatteverket (ML 7 kap 17 §) |
| Excluded | Credit institutions, insurance undertakings, their financial holding companies | Same exclusions |

For a cash business almost nothing changes on the sales side: the customer pays at the moment of supply, so affärshändelse and payment coincide. What changes is the **purchase** side (supplier invoices not booked until paid) and the **year-end cut-off**. Two things that do **not** change: verifikationer must still be kept ordered while awaiting bokföring (BFNAR 2013:2 p. 3.14), and the next-working-day rule for kontanta in- och utbetalningar still applies, with the senareläggning windows in p. 3.6-3.13 simply counted from the payment date (p. 3.15).

At year-end a cash business should also: count and book the växelkassa per balansdagen, book all obetalda leverantörsskulder and kundfordringar plus the VAT catch-up on them, reconcile **2421**, clear **1686**, and take stock (see `swedish-inventory`).

## 12. Daily and monthly checklist

**Daily, per kassa:** Z-dagrapport taken and its Z-number continuous with yesterday's; Z gross total = sum of the VAT-rate lines = sum of the payment-type lines; the VAT split matches how the products are configured (servering vs avhämtning); cash counted, float deducted, any difference documented and signed; card sammanställning and köpnotor attached (p. 6.11) and the Swish sammanställning with them; cash removed from the till booked as a kontant utbetalning by the next working day; kontanta inköp given their own verifikationer, not folded into the dagsavslut.

**Monthly:** 1910 per kassa reconciled to a physical count with the float intact; 1686 aged, every open item traced to a payout report; 1930 reconciled line by line with every cash deposit matched to a Z-report; sum of the month's Z-reports = sum booked on 3001/3002/3003; output VAT 2611/2621/2631 = rate × the matching revenue account, to the krona; kassadifferenser summed gross (plus and minus separately) and the trend reviewed; 2421 agreed to the kassaregister's outstanding voucher list; dricks liability on 2820/2829 cleared or reflected in the payroll run; personalmåltider counted and reported in the AGI.

## 13. Red flags an agent must raise

| Signal | What it usually means |
|---|---|
| **1910 negative** at any date | Sales missing, a deposit booked twice, or an undocumented cash withdrawal. Never "fix" it with a rounding entry |
| Kassadifferens on nearly every day, always the same sign | Float miscounted, systematic skimming, or a till configured with the wrong rounding |
| Takings that barely vary day to day, or round to even hundreds | Fabricated dagskassor. Real takings vary with weekday and weather |
| Gaps in the Z-number sequence, or Z-reports missing for open days | Missing verifikationer under BFL 5 kap 6 § |
| Personalliggare hours with no matching sales day | Restaurant, hairdressing/beauty, tvätteri and fordonsservice must keep a personalliggare (SFL 39 kap 11 §): Skatteverket cross-checks it against takings |
| 1686 balance that never clears, or grows monthly | Payouts not matched; possibly a whole terminal missing from the books |
| Cash sales but no kassaregister | Kassaregisterskyldighet under SFL 39 kap 4 §, with only narrow undantag in 39 kap 5 § (including sales normally at most **four prisbasbelopp** per beskattningsår, distansavtal, taxitrafik, varuautomat). Kontrollavgift is 12 500 SEK per kontrolltillfälle, 25 000 SEK on repeat within a year (SFL 50 kap 1-2 §§) |
| Take-away and servering booked at the same VAT rate after 1 April 2026 | 6 % vs 12 % mixed up: a direct momsdeklaration error |
| Dricks paid out but no AGI line, where the employer decides the split | Missing skatteavdrag and arbetsgivaravgifter |
| Staff meals with no kostförmån and no uttagsmoms | Both the payroll and the VAT side missed |

## 14. Ask the user rather than assume

1. Is there a kassaregister, and is it certified or covered by a tillverkardeklaration? This decides whether p. 3.10's 50-day window applies at all.
2. Does it separate servering from avhämtning? Without that the 12 %/6 % split cannot be supported.
3. Card sales via 1686 or straight to 1930: and does the acquirer contract really pay within three bankdagar (BFNAR 2013:2 p. 2.12)?
4. Which account for kassadifferens, and which for money in transit to the bank?
5. How is dricks collected, and who decides the split?
6. Are the presentkort single- or multi-purpose, and what validity is printed on them?
7. Kontantmetoden or faktureringsmetoden: answer separately for bokföring and for moms.
8. How many tills, and is there one ledger account and one kassarapport per till?

## Sources

- Bokföringslagen (1999:1078), 5 kap 1-2, 6-8, 11-12 §§.
- BFNAR 2013:2 Bokföring with BFN's vägledning: punkterna 1.9-1.12, 2.3, 2.9, 2.12, 3.2-3.3, 3.5-3.6, 3.10-3.15, 6.1, 6.4-6.11, and exempel 2.1 (lunchrestaurang).
- BFN, frågor och svar, "Swishbetalningar".
- Mervärdesskattelagen (2023:200): 2 kap 26-27 §§, 5 kap 8-10, 28-30, 40-44 §§, 7 kap 16-18 §§, 8 kap 2, 4-6, 17 §§, 9 kap 2, 5, 19 §§ (SFS 2026:118, 2026:119).
- Skatteförfarandelagen (2011:1244): 39 kap 4-11 §§, 50 kap 1-2 §§.
- Skatteverket: FAQ on dricks for restaurant staff; news item "Tänk på att redovisa dricks om inte arbetsgivaren gjort det" (2024).
- BAS 2026 kontoplan (bas.se) and bas.se, "Hur ska försäljning mot kontokort bokföras?" (2025-10-30).
