# Booking Inventory in Practice (Varulager)

How to get goods into the books, out of the books, and correctly valued on balansdagen. Accounts are verified against the BAS 2026 kontoplan (bas.se, `BAS_kontoplan_2026_v2.xlsx`, v 1.1) and the official change file `Kontoplansforandringar_2026.xlsx`. Core law: ÅRL (1995:1554) 4 kap, IL (1999:1229) 17 och 22 kap, lag (1955:257) om inventering av varulager för inkomstbeskattningen, ML (2023:200), BFL (1999:1078). Frameworks: K2 (BFNAR 2016:10) kap 12, K3 (BFNAR 2012:1) kap 13.

Import VAT and EU-acquisition mechanics are **not** repeated here: see `../../swedish-daily-bookkeeping/references/foreign-purchases.md`.

---

<!-- toc -->
**Contents**

- [1. The two methods](#1-the-two-methods)
- [2. BAS 2026 accounts](#2-bas-2026-accounts)
- [3. Purchases, freight, customs and import](#3-purchases-freight-customs-and-import)
- [4. Inventering: the legal duty](#4-inventering-the-legal-duty)
- [5. Svinn, kassation och stöld](#5-svinn-kassation-och-stöld)
- [6. Uttag ur lagret](#6-uttag-ur-lagret)
- [7. E-commerce specifics](#7-e-commerce-specifics)
- [8. Cut-off at year-end](#8-cut-off-at-year-end)
- [9. Kontantmetoden](#9-kontantmetoden)
- [10. Reconciliation checklist](#10-reconciliation-checklist)
- [11. Ask the user, do not assume](#11-ask-the-user-do-not-assume)

<!-- /toc -->

## 1. The two methods

| | **A. Periodisk lagerredovisning** (expense purchases, adjust at year-end) | **B. Löpande lagerredovisning** (perpetual) |
|---|---|---|
| During the year | Purchases go straight to a class 4 cost account. **1460** is untouched. | Purchases go to **1460**. Each sale also books a cost of goods entry out of **1460**. |
| Stock account movement | Once a year (or per month if the company counts monthly) | Continuously, per transaction |
| Needs | A count at balansdagen | A warehouse system with reliable quantities *plus* a count at balansdagen |
| Cost of goods sold | Derived: purchases ± lagerförändring | Booked directly, transaction by transaction |
| Interim reports | Gross margin is wrong between counts | Gross margin is right at any date |
| BFL | Fine | The stock ledger is a **sidoordnad bokföring** under BFL 5 kap 4 § |

**Recommendation for a small company: method A.** It is fewer moving parts, it is what K2 companies and most Swedish bookkeeping software do by default, and the legal duty (a count and a signed list at balansdagen, section 4) is identical either way. Method B only pays off when the company needs a true monthly gross margin, or when the warehouse system already produces per-SKU movements that can be trusted. Method B does **not** remove the duty to count: a perpetual ledger that has never been reconciled to a physical count is worth nothing at bokslut.

### Method A: worked entries (handelsvaror, 25 % moms)

Purchase, 100 000 kr from a Swedish supplier:

```
4010  Inköp av handelsvaror i Sverige        100 000
2640  Ingående moms                           25 000
   2440  Leverantörsskulder                          125 000
```

Sale, 160 000 kr:

```
1510  Kundfordringar                         200 000
   3001  Försäljning inom Sverige, 25 % moms         160 000
   2611  Utgående moms på försäljning inom Sverige    40 000
```

Year-end, IB lager 150 000, counted UB lager 180 000 → increase 30 000:

```
1460  Lager av handelsvaror                   30 000
   4960  Förändring av lager av handelsvaror          30 000
```

A **decrease** reverses the entry (debit 4960, credit 1460). The sign convention that matters: **an increase in stock credits the class 4 account** (it removes cost from the year), a decrease debits it.

BAS also offers a sub-account layout where the movement is parked on the förändringskonto and 1460 keeps its opening balance all year: debit **1469 Förändring av lager av handelsvaror** instead of 1460, and the balance-sheet post is 1460 + 1469. bas.se lists 1469 as a sub-account of 1460 and 4960 as 1460's contra account, so both layouts are BAS-sanctioned. Pick one and keep it: ÅRL 2 kap 4 § första stycket 2 requires consistent application between years.

### Method B: worked entries

Purchase:

```
1460  Lager av handelsvaror                  100 000
2640  Ingående moms                           25 000
   2440  Leverantörsskulder                          125 000
```

Cost of goods on each sale (cost of the units shipped, 62 500):

```
4960  Förändring av lager av handelsvaror     62 500
   1460  Lager av handelsvaror                        62 500
```

At balansdagen the counted value replaces the ledger value; the difference (svinn, mis-picks, valuation) is booked the same way, against 4960. Some systems instead route purchases through 4010 and transfer to 1460 at period end. Either is acceptable as long as the P&L post **Handelsvaror** and the balance-sheet post **Färdiga varor och handelsvaror** end up right. *Ask the user which their system does before reverse-engineering entries from a trial balance.*

---

## 2. BAS 2026 accounts

### Kontogrupp 14: Lager, produkter i arbete och pågående arbeten

| Konto | Namn | Förändringskonto (klass 1) | Resultatkonto (klass 4) |
|---|---|---|---|
| **1410** | Lager av råvaror | **1419** | **4910** |
| **1420** | Lager av tillsatsmaterial och förnödenheter | **1429** | **4920** |
| **1430** | Lager av halvfabrikat | - | - |
| **1440** | Produkter i arbete | **1449** | **4940** |
| **1450** | Lager av färdiga varor | **1459** | **4950** |
| **1460** | Lager av handelsvaror | **1469** | **4960** |
| **1465** | Lager av varor VMB | - | - |
| **1466** | Nedskrivning av varor VMB | - | - |
| **1467** | Lager av varor VMB förenklad | - | - |
| **1470** | Pågående arbeten (1471 nedlagda kostnader, 1478 fakturering, 1479 förändring) | **1479** | **4970** |
| **1480** | Förskott för varor och tjänster | - | - |
| **1481** | Remburser | - | - |
| **1489** | Övriga förskott till leverantörer | - | - |
| **1490** | Övriga lagertillgångar (1491 värdepapper, 1492 fastigheter, 1493 djur) | - | **4980** |

**1430 Lager av halvfabrikat** is flagged as a *new* account in bas.se's machine-readable BAS 2026 list (revision 260114) but does not appear in the published `BAS_kontoplan_2026_v2.xlsx` (v 1.1), and BAS has added no matching 49xx account for it. *Osäkert:* which förändringskonto BAS intends for 1430: until BAS clarifies, book halvfabrikat changes on **4940** (produkter i arbete) and present them in the post *Varor under tillverkning*, or just keep halvfabrikat inside 1440.

Balance-sheet posts under K2 (BFNAR 2016:10 kap 4): *Råvaror och förnödenheter* (1410, 1420), *Varor under tillverkning* (1430, 1440), *Färdiga varor* (1450), *Handelsvaror* (1460), *Övriga lagertillgångar* (1490), *Pågående arbete för annans räkning* (1470), *Förskott till leverantörer* (1480).

### Kontoklass 4: restructured in BAS 2026

BAS 2026 split class 4 along the two ÅRL/K2 cost posts. Groups 40-42 are **handelsvaror**, groups 43-48 are **råvaror och förnödenheter**, group 49 is lagerförändring.

| Grupp | Rubrik | Nyckelkonton |
|---|---|---|
| **40** | Inköp av handelsvaror | 4000 gruppkonto, **4010** i Sverige, **4060**/4065-4067 omvänd betalningsskyldighet, **4070**/4075-4078 från annat EU-land, **4080**/4085-4087 import, **4090**/4091/4092/4099 erhållna rabatter |
| **42** | Sålda handelsvaror VMB | 4200, 4210, 4211 positiv VMB 25 %, 4212 negativ VMB 25 % |
| **43** | Inköp av råvaror och material i Sverige | 4300 gruppkonto, **4310** |
| **44** | Inköp av råvaror/material/tjänster i Sverige, omvänd betalningsskyldighet | 4400, **4410**/4415-4417 varor, **4420**/4425-4427 tjänster |
| **45** | Inköp av råvaror/material/tjänster från utlandet | 4500, **4510**/4515-4518 EU, **4530**/4531-4538 tjänster, **4540**/4545-4547 import |
| **46** | Inköp av tjänster, underentreprenader och legoarbeten i Sverige | 4600, **4610**, **4670** |
| **47** | Reduktion av inköpspriser (råvaror och förnödenheter) | 4700, **4730**/4731/4732/4739 |
| **48** | Andra produktionskostnader (råvaror och förnödenheter) | 4800, 4810 energi, 4820 drivmedel, 4830 resor, 4840 hyra av utrustning, 4890 övriga |
| **49** | Förändring av lager, produkter i arbete och pågående arbeten | 4900, **4910**, **4920**, **4940** (4944/4945/4947), **4950**, **4960**, **4970** (4974/4975/4977), **4980** (4981/4987/4988) |

Removed in BAS 2026: **4733** Erhållet aktivitetsstöd, **4790** Övriga reduktioner av inköpspriser.

### Migration traps from BAS 2025

In BAS 2025 group 40 held only the gruppkonto *4000 Inköp av varor från Sverige*, and goods purchases from abroad shared the 45xx range with råvaror. BAS 2026 splits them:

| Purchase | BAS 2025 | BAS 2026 handelsvaror | BAS 2026 råvaror |
|---|---|---|---|
| Domestic | 4000/4010 (free) | **4010** | **4310** |
| EU-förvärv, 25 % | 4515 | **4075** | **4515** |
| Import, 25 % | 4545 | **4085** | **4545** |
| Omvänd betalningsskyldighet, 25 % | 4415 | **4065** | **4415** |
| Erhållna kassarabatter | 4731 | **4091** | **4731** |

A webshop that kept booking EU purchases of goods for resale on 4515 after the 2026 switch will land them in the *Råvaror och förnödenheter* line instead of *Handelsvaror*. The result is right, the presentation is not: flag it rather than silently re-posting a closed year.

### 4990 does not exist in BAS

**4990 "Lagerförändring" is not a BAS account.** It appears in neither the BAS 2025 nor the BAS 2026 kontotabell (verified: zero occurrences in both files from bas.se). It is a convention some accounting software ships as a free account. If a client's SIE file carries 4990 with a lagerförändring balance, map it to **4960** for handelsvaror or **4910/4920** for råvaror before producing an INK2R/SRU file, and note the mapping.

### Which account carries the lagerförändring

This is the question that decides which line of the income statement moves.

| Lager | Förändringskonto | ÅRL/K2 resultatpost | INK2R | SRU |
|---|---|---|---|---|
| Handelsvaror | **4960** | Handelsvaror (cost) | 3.6 | 7512 |
| Råvaror | **4910** | Råvaror och förnödenheter (cost) | 3.5 | 7511 |
| Tillsatsmaterial och förnödenheter | **4920** | Råvaror och förnödenheter (cost) | 3.5 | 7511 |
| Produkter i arbete | **4940** | Förändring av lager av produkter i arbete, färdiga varor och pågående arbete för annans räkning (income side) | 3.2 | 7510 |
| Färdiga varor (egentillverkade) | **4950** | same as above | 3.2 | 7510 |
| Pågående arbeten | **4970** | same as above | 3.2 | 7510 |
| Lager av värdepapper | **4980** | Handelsvaror | 3.6 | 7512 |

The split matters: changes in **purchased** stock (handelsvaror, råvaror) adjust the *cost* lines, turning purchases into consumption. Changes in **self-manufactured** stock (PIA, färdiga varor, pågående arbeten) appear as a separate *income-side* line: K2 12.13 and ÅRL bilaga 2 post 2. The INK2R/SRU codes above come from bas.se's own mapping in the BAS 2025 machine-readable file. *Osäkert:* bas.se has not yet published SRU codes for the new 40xx/42xx handelsvaror accounts; by the group naming and the K2 post they belong to 7512, but confirm against Skatteverket's INK2R räkenskapsschema before generating a filing.

---

## 3. Purchases, freight, customs and import

K2 12.7 (and K3 via ÅRL 4 kap 3 § andra stycket) is explicit: utgifter for **frakt**, **importavgifter** and **tull** that are directly attributable to the purchase **must** be included in the varans anskaffningsvärde, and varurabatter, bonus och liknande prisavdrag must be deducted. Indirect costs must not.

Two workable routines:

1. **Load the cost onto the purchase account.** Freight and customs invoices are coded to **4010**/**4310** (or the relevant 40xx/45xx account) on the same shipment. Clean, works when the carrier invoices per shipment.
2. **Expense during the year, add a schablonpålägg at valuation.** Inbound freight to **5711 Fraktkostnader**, customs duty to **5721 Tullkostnader**, forwarding to **5722 Speditionskostnader**, and at balansdagen add a percentage uplift to the counted stock value. K2 12.7's commentary sanctions this expressly: the schablon must have a relevant and reliable basis, be applied consistently, and give roughly the same value as actual costs: and it must be compared against actual costs at bokslut and adjusted.

BAS 2026 has no dedicated hemtagningskostnad account, so routine 2 needs a documented calculation kept with the bokslutsbilagor.

**Tull (customs duty) is a cost of the goods. Importmoms is not**: it is input VAT, reclaimed via 2615/2645 and never part of the stock value (K2 9.9: amounts paid for someone else's account, such as VAT, are excluded from anskaffningsvärdet, except to the extent the company cannot deduct it). For the mechanics of importmoms, EU-förvärv, omvänd betalningsskyldighet and the 45xx/2645 pairs, read `../../swedish-daily-bookkeeping/references/foreign-purchases.md`.

**Förskott to a supplier** for goods not yet delivered is not stock and not a cost: debit **1489 Övriga förskott till leverantörer** (or **1481 Remburser** for a letter of credit) and release it against the purchase account when the goods arrive.

---

## 4. Inventering: the legal duty

Lag (1955:257) om inventering av varulager för inkomstbeskattningen, three short paragraphs, all of them binding.

**1 §** A skattskyldig who is bokföringsskyldig under BFL must inventera *varje i lagret ingående post* of assets held for omsättning eller förbrukning. A **förteckning** must be drawn up showing, for each post, the value at which it is taken up under IL 17 kap. When anskaffningsvärdet is determined, the goods remaining in stock at the end of the beskattningsår are deemed to be those most recently acquired or manufactured: i.e. **FIFU is compulsory for tax purposes**, and LIFO is banned outright by ÅRL 4 kap 11 §. If the company claims the 97 %-regeln in IL 17 kap 4 §, the **anskaffningsvärde for each post** must also be stated on the list. The duty does not apply to assets valued to a bestämd mängd och fast värde under ÅRL 4 kap 12 §.

**2 §** The skattskyldig must sign on the list a **försäkran på heder och samvete** that no lagertillgång was left out of the count. An unsigned list is not a compliant list.

**3 §** If the rules are not followed, **the reported stock value is not accepted for income taxation**: Skatteverket may set it itself. The only relief is 3 § andra stycket: a business run under special conditions that cannot comply without considerable difficulty may have its own utredning accepted unless the value appears improbable.

### What the list must contain, in practice

Per post: article/description, quantity, unit value, the valuation basis used (anskaffningsvärde or nettoförsäljningsvärde), post total, and: if the 97 % rule is used, anskaffningsvärdet separately. Plus the date of the count, the counter's name, and the signed försäkran. Keep it with the bokslutsbilagor for the BFL 7 kap 2 § retention period: through the **seventh year** after the end of the calendar year in which the räkenskapsår ended.

### When

At balansdagen. **1 § tredje stycket** permits counting *before* balansdagen only if the value at the count date can be corrected in a satisfactory way for stock movements up to and including balansdagen: so a documented roll-forward (count value + purchases − cost of sales in the intervening period) is required, not an assertion that nothing moved. A count *after* balansdagen needs the same roll-back. See section 8.

### Valuation

| Rule | Source | Note |
|---|---|---|
| Lägsta värdets princip: lowest of anskaffningsvärde and nettoförsäljningsvärde, post för post | ÅRL 4 kap 9 §, IL 17 kap 3 §, K2 12.4, K3 13.x | Kollektiv värdering only for homogena varugrupper or when individual valuation is not cost-justifiable (K2 12.3, K3 13.3) |
| FIFU or vägda genomsnittspriser; **LIFO forbidden** | ÅRL 4 kap 11 §; IL 17 kap 3 § for tax | |
| 97 %-regeln (3 % schablonmässig inkurans) | IL 17 kap 4 §, K2 12.5 | Not for fastigheter, aktier/obligationer, elcertifikat, utsläppsrätter. **Blocked entirely if any vara or varugrupp is written to nettoförsäljningsvärde** |
| Detaljhandelsmetoden: anskaffningsvärde = försäljningspris exkl. moms less the pålägg or bruttovinstmarginal | K2 12.8 | Detaljhandels- and handelsföretag only |
| Indirekta tillverkningskostnader | K2 12.11 optional; **K3 13.7 mandatory** when more than an insignificant part of total manufacturing cost | A common K2→K3 transition difference |
| Enskild näringsidkare with förenklat årsbokslut: stock of at most half a prisbasbelopp (**29 600 kr för 2026**) need not be taken up at all | IL 17 kap 4 a § (Lag 2024:1131), K1 BFNAR 2006:1 p. 6.47 | 29 600 kr → omit; 29 601 kr → take up in full |
| Juridisk person under K3 may value stock per IL | K3 13.14 | |

---

## 5. Svinn, kassation och stöld

| Event | What it is | Entry |
|---|---|---|
| **Svinn** (shrinkage found by the count) | The count is lower than the ledger | Method A: nothing to book: the loss is already inside the lagerförändring, because the closing value is the counted one. Method B: debit **4960** / credit **1460** for the difference |
| **Kassation** (goods scrapped) | Goods physically removed from stock with the intention of discarding them | Same as svinn. K2 12.18: *kostnad för kasserade varor ska redovisas i den period varorna kasseras* |
| **Stöld / inbrott** (material, identified event) | An extraordinary loss, not a normal cost of goods | Debit **7990 Övriga rörelsekostnader** / credit **1460** under method B; under method A, reclassify out of 4960 if the amount matters for the gross margin. Insurance proceeds are an intäkt (K2 9.10 commentary), not a reduction of the loss |

K2's description of the post *Råvaror och förnödenheter* says in so many words that a tillverkande företag books the anskaffningsutgift for råvaror that are no longer in stock **"t.ex. svinn och kassationer"** in that post. So ordinary shrinkage belongs in the cost line, not in Övriga rörelsekostnader.

**The 97 % trap.** K2 12.18's commentary: for goods to count as kasserade they must have been **physically separated from the stock with the intention of discarding them**. If the goods to be scrapped are still physically in the stock and valued at zero, that counts as an inkuransbedömning of the varulager: and then **the 97 %-regeln may not be used for any goods in the stock**. Scrap physically, or accept losing the 3 %.

**Documentation.** BFL 5 kap 6-7 §§ require a verifikation for every affärshändelse, and 5 kap 10 § extends that to other bokföringsposter: date compiled, date of the event, what it concerns, amount, counterparty. For svinn and kassation there is no external document, so the company must create one: a **kassationsrapport** listing article, quantity, value, reason and date, signed by the person who scrapped the goods. For stöld, add the **polisanmälan** and the insurance claim.

**VAT: normally nothing happens.** Goods lost, destroyed or stolen are not uttag under ML 5 kap 9 §: nothing has been taken out for private use, transferred without consideration, or used for non-business purposes. The input VAT deducted on purchase stands, and no utgående moms arises. What changes the answer is *destination*, not damage: if the "scrapped" goods are actually taken home, given to staff, or given away above the gåvor-av-mindre-värde threshold, it is an uttag, section 6.

---

## 6. Uttag ur lagret

**ML 5 kap 8 §**: uttag av varor is treated as a leverans mot ersättning. **9 §**: uttag means the beskattningsbara person takes a vara out of the rörelse (1) for own or staff private use, (2) to transfer it without consideration, or (3) otherwise for purposes other than the business. Transfers without consideration are **not** uttag if the goods are **gåvor av mindre värde eller varuprover** given within the business. **11 §**: the rules apply only if input VAT on the goods or their components was wholly or partly deductible.

Two different valuation bases, and mixing them is the classic error:

| | Base | Source |
|---|---|---|
| **Moms** | Inköpspris of the goods or similar goods at the time of the uttag; if no such price exists, självkostnadspris | ML 8 kap 5 § |
| **Inkomstskatt** | **Marknadsvärde**: the uttag is treated as a disposal at market value | IL 22 kap 2, 3 och 7 §§ |

### Enskild firma: owner takes handelsvaror

Inköpspris 4 000, marknadsvärde 6 000, 25 % moms. VAT base 4 000 → 1 000 kr utgående moms (the debit to eget kapital is base + moms = 5 000, which is not the income-tax figure).

```
2011  Egna varuuttag                           5 000
   3401  Egna uttag momspliktiga, 25 %                4 000
   2612  Utgående moms på egna uttag, 25 %            1 000
```

The 3401 amount is the VAT base. The remaining 2 000 kr up to marknadsvärde carries no moms and is picked up as a skattemässig justering in the NE-bilaga. *Osäkert:* whether to instead book the full 6 000 to 3401 and treat only 4 000 as momsunderlag is a presentation choice: confirm with the client's tax adviser when the spread is material.

### Aktiebolag: shareholder or employee takes goods

An AB has no egna uttag. The withdrawal is either a **löneförmån** (value at marknadsvärde, on the AGI, with arbetsgivaravgifter), a **förtäckt utdelning**, or a **sale at market price** to the person. The VAT entry is the same shape (**2612**, base = inköpspris), the offsetting debit depends on which of the three it is. **Ask the user which it is before booking**: the three have different consequences for AGI, for the 3:12 calculation, and for whether ABL's värdeöverföring rules are engaged.

### Representation

Goods handed out at a representation event are an uttag unless they are gåvor av mindre värde or varuprover (ML 5 kap 9 § andra stycket). Where they are deductible representation, the cost goes to **6071 Representation, avdragsgill**; otherwise **6072 Representation, ej avdragsgill**. The moms deduction cap for representationsmåltider and the exact thresholds live in the `swedish-vat` skill: do not restate them from memory.

---

## 7. E-commerce specifics

**Fulfilment providers (Amazon FBA, third-party 3PL).** Goods sitting in a fulfilment centre are still **the seller's stock**: the provider is a warehouse operator, not the owner. They belong in **1460** and on the inventeringsförteckning, and the provider's stock report is the underlag for the count. Use the provider's documentation to establish *where the goods physically are* and *how many*, never to decide the tax treatment.

**Stock moved to another EU country is a registration trigger.** ML 5 kap 12 § treats a beskattningsbar person's överföring of goods from their own rörelse to another EU country as a leverans mot ersättning. Pan-EU FBA, EFN with local stock, or any 3PL that relocates stock across a border does exactly this. That normally creates a **VAT registration duty in the destination country** plus a periodisk sammanställning in Sweden. 5 kap 15 § carves out **avropslager** (call-off stock) on strict conditions, including that the intended buyer is known and VAT-registered there and that the transfer is entered in the register under SFL 39 kap 14 a §. **Flag this and stop: foreign VAT registration is outside this skill.** Refer the user to a VAT adviser or to the destination country's tax authority.

**Kommission (consignment).** ML 5 kap 3 § andra stycket 3 makes the transfer of goods under a kommissionsavtal a leverans av varor. For accounting, the commission goods stay in the **kommittent's** stock until the kommissionär sells them; the kommissionär holds goods they do not own and must **not** carry them in 1460. If the client is the kommissionär, the goods belong off balance sheet and only the provision is revenue. If the client is the kommittenten, the goods held by the kommissionär must be counted and included at balansdagen.

**Dropshipping.** Normally **no inventory at all**: the goods never enter the seller's control, so there is nothing to count, no 1460 balance and no lagerförändring. Purchases go straight to **4010** (or 4075/4085 depending on origin) and the gross margin is correct as booked. The moment the seller starts holding buffer stock, or the platform deems itself the supplier under ML 5 kap 5-6 §, this stops being true.

**Returns.** A customer return is a **kreditfaktura** reversing the sale, plus the goods back into stock: method A needs no stock entry (the count picks them up), method B debits **1460** and credits **4960** at the original cost. Goods returned to a supplier reverse the purchase entry including the input VAT. At year-end, goods **in transit back** from a customer are still the seller's if risk has passed back: and unsold returns that are damaged are an inkurans question, not a stock-quantity question.

---

## 8. Cut-off at year-end

The single largest source of stock errors. Three questions, in order.

**1. Goods in transit: who owns them on balansdagen?** K2 6.7 sets when väsentliga risker och förmåner pass on a varuförsäljning: when the buyer collects the goods; when the goods are handed to the fraktföretag if transport is at the buyer's risk; when the fraktföretag hands them to the buyer if transport is at the seller's risk. Read the mirror image for a purchase.

| Incoterm 2020 | Risk passes | Goods in transit on balansdagen |
|---|---|---|
| EXW, FCA, FAS, FOB | At origin / on handover to the carrier | **In the buyer's stock** |
| CFR, CIF, CPT, CIP | At origin, even though the seller pays the freight | **In the buyer's stock**: the classic trap |
| DAP, DPU, DDP | At destination | **In the seller's stock**, not the buyer's |

Incoterms are ICC contract terms, not Swedish law: the contract decides where risk passes, and K2 6.7 then decides the accounting. A container on the water under CIF at 31 December belongs in the buyer's closing stock **and** the supplier invoice belongs in the buyer's leverantörsskulder: booking one without the other overstates or understates the result by the full margin.

**2. Supplier invoices arriving after year-end.** BFL 5 kap 3 § requires the bokslutstransaktioner needed to determine the year's intäkter, kostnader and finansiella ställning. A goods invoice dated in January for goods received in December belongs in the old year: book the cost (or the stock, under method B) against **2440** if the invoice is in hand, otherwise against **2990 Övriga upplupna kostnader och förutbetalda intäkter**. Run the goods-received-not-invoiced report against 2440 and 2990 and reconcile it to the counted stock: every counted item must have a matching cost booked somewhere.

**3. Count before or after balansdagen.** Permitted under 1 § tredje stycket of the 1955 act only with a satisfactory correction to balansdagen. Document the roll-forward or roll-back explicitly: count value ± purchases received ± cost of goods shipped between the count date and balansdagen, with the underlying delivery notes attached. A count more than a couple of weeks off balansdagen in a fast-moving warehouse is hard to defend; say so rather than papering over it.

---

## 9. Kontantmetoden

BFL 5 kap 2 § tredje stycket lets a company with an annual nettoomsättning normally at most **3 miljoner kronor** defer bokföring until payment. What changes for stock:

- **The inventering duty is unchanged.** The 1955 act attaches to bokföringsskyldighet, not to the bokföringsmetod. Count, list, sign, keep.
- **At räkenskapsårets utgång all unpaid fordringar och skulder must be booked** (same paragraph, last sentence). So unpaid supplier invoices for goods already received come into the books at year-end, and the goods they cover come into the count. During the year the two drift apart; at balansdagen they must meet.
- **Unpaid goods invoices are the main cut-off risk.** Under kontantmetoden a December delivery paid in February is invisible until the year-end conversion. If the goods are in the count but the invoice is not in 2440, the stock increase has no matching cost and the year's result is overstated by the whole amount.
- **The moms period follows the invoice, not the payment, from the year-end conversion onward**: see the `swedish-vat` skill.

---

## 10. Reconciliation checklist

Run at every month-end where the company counts, and always at year-end.

| # | Check | What a difference usually means |
|---|---|---|
| 1 | **1460** (+1469) equals the total of the signed inventeringsförteckning, to the krona | A lagerförändring entry was posted without re-running the count, or the count total was keyed wrong |
| 2 | Every lager account in group 14 has a bilaga and a förteckning | 1410/1420/1440/1450 forgotten in a company that has both handelsvaror and råvaror |
| 3 | The förändringskonto used matches the lager account (4960↔1460, 4910↔1410, …) | Handelsvaror booked to 4910 → wrong INK2R line, right result |
| 4 | **Gross margin** = (nettoomsättning − varukostnad) / nettoomsättning, compared to last year and to the pricing model. Varukostnad = purchases ± lagerförändring | A swing of more than a couple of percentage points with no pricing change is a cut-off error, a missing supplier invoice, stock valued at selling price instead of cost, or unrecorded svinn |
| 5 | **No negative stock**: 1460 must not have a credit balance, and no SKU may have a negative quantity | Goods sold that were never booked in, a purchase invoice not yet received, or double-booked issues in the perpetual ledger |
| 6 | Goods-received-not-invoiced (2440/2990) reconciles to what was counted | The cut-off test in section 8 |
| 7 | Förskott on **1489** have not silently become stock | Goods delivered but the förskott never released |
| 8 | If the 97 %-regeln is used: no post is valued at nettoförsäljningsvärde, and all scrapped goods were physically removed | K2 12.5 and 12.18: the rule is lost for the whole stock if either fails |
| 9 | Valuation method unchanged from last year, or the change is documented | ÅRL 2 kap 4 § första stycket 2 |
| 10 | Inkurans assessed and documented per post or homogen varugrupp | A single collective write-down of the whole stock is not an LVP assessment |
| 11 | Stock held at a 3PL or a kommissionär is included; stock held **for** someone else is excluded | The most common e-commerce error |

---

## 11. Ask the user, do not assume

- **Which method**: is the company expensing purchases and adjusting at year-end, or running a perpetual ledger? Reverse-engineering this from a trial balance is guesswork.
- **Handelsvaror or råvaror?** It decides 4010 vs 4310, 4960 vs 4910, INK2R 3.6 vs 3.5. A company that both resells and manufactures needs both.
- **K2, K3 or K1?** It decides whether indirect manufacturing costs are mandatory (K3 13.7) and whether the half-PBB exemption applies (IL 17 kap 4 a §).
- **Is the 97 %-regeln being used?** If yes, the förteckning must show anskaffningsvärde per post and nothing may be at nettoförsäljningsvärde.
- **Where is the stock physically?** Own warehouse, 3PL, FBA, kommissionär, or at a customer on approval. Each answer changes what is counted and, for another EU country, whether a foreign registration duty has already been triggered.
- **What are the delivery terms?** Needed before any goods-in-transit judgment at year-end.
- **For an uttag in an AB:** förmån, utdelning, or sale at market price?
