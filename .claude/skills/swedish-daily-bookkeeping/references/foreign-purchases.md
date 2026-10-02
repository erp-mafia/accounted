# Buying From Abroad: Practical Booking Reference

Decision reference for an agent categorising a bank line or a supplier invoice from a foreign supplier. This is the **booking view**: which account, which VAT treatment, which ruta. The rule derivations live in the `swedish-vat` skill (`references/vat-compliance-reference.md`): go there for why, come here for what to book.

Account numbers are **BAS 2026**. Class 4 was restructured for 2026: series **40-42** is now *Handelsvaror* and series **43-48** is *Råvaror och förnödenheter*. Foreign purchases therefore have **two parallel account sets**: see §5 and §6.


## Table of Contents

1. [Decision procedure for a foreign supplier invoice](#1-decision-procedure-for-a-foreign-supplier-invoice)
2. [Services from an EU supplier](#2-services-from-an-eu-supplier)
3. [Services from a non-EU supplier](#3-services-from-a-non-eu-supplier)
4. [The trap: the supplier charged foreign VAT anyway](#4-the-trap-the-supplier-charged-foreign-vat-anyway)
5. [Goods from another EU country](#5-goods-from-another-eu-country)
6. [Goods from outside the EU (import)](#6-goods-from-outside-the-eu-import)
7. [Foreign supplier with a Swedish VAT registration](#7-foreign-supplier-with-a-swedish-vat-registration)
8. [Small everyday cases](#8-small-everyday-cases)
9. [Supplier quick lookup](#9-supplier-quick-lookup)
10. [Stop and ask](#10-stop-and-ask)

---

## 1. Decision procedure for a foreign supplier invoice

Run these five steps in order. Do not skip to the lookup table in §9: it is a sanity check, not a decision.

### Step 1: Goods or service?

| Signal | Classification |
|------|------|
| Physical items shipped, has a tariff/HS number, freight line, packing list | **Goods** |
| SaaS subscription, ads, hosting, consulting, licence, support, API usage | **Service** |
| Software on physical media shipped to you | Goods (rare) |
| Downloaded/streamed software, cloud compute | Service (elektronisk tjänst, ML 6 kap. 57 §) |

This decides the ruta pair and the cost account series. Get it wrong and every downstream field is wrong.

### Step 2: Where is the supplier established?

Three buckets, in this order of priority:

1. **Established in Sweden** (Swedish seat, or a fast etableringsställe here **that took part in this supply**) → ordinary domestic purchase, Swedish VAT on the invoice, **2641**, ruta 48. Done.
2. **Another EU country** → §2 (services) or §5 (goods).
3. **Outside the EU** → §3 (services) or §6 (goods).

A Swedish VAT number on the invoice does **not** by itself put the supplier in bucket 1. Under **ML 16 kap. 4 §** a supplier with a fast etableringsställe in Sweden is still treated as *not established here* if the supply was made **without the involvement of** that Swedish establishment: and then the buyer is liable (**ML 16 kap. 9 §** for services under huvudregeln). See §7.

### Step 3: What does the invoice show?

| Invoice shows | Meaning | Action |
|------|------|------|
| No VAT + the words "omvänd betalningsskyldighet" / "reverse charge" / "Art. 196 VAT Directive" | Supplier applied reverse charge correctly | Self-assess. §2 / §3 / §5 |
| No VAT, no reverse-charge note, our VAT number printed | Almost certainly reverse charge, invoice is defective (**ML 17 kap. 24 § p. 14** requires the wording) | Self-assess anyway; request a corrected invoice |
| No VAT, **no VAT number of ours** printed | Supplier may have treated us as a consumer | Verify our status; self-assess; get the invoice corrected |
| **Swedish** VAT (25/12/6 %) + a Swedish VAT number (SE…01) | Supplier is registered here and invoicing domestically | §7: usually **2641**, ruta 48, *no* reverse charge |
| **Foreign** VAT (DE 19 %, IE 23 %, US sales tax …) | Either correct (local-place-of-supply service) or supplier error | §4: never goes in ruta 48 |

### Step 4: Do we have a valid VAT number on the invoice?

Both parties' VAT numbers belong on a reverse-charge invoice (**ML 17 kap. 24 §** p. 3-4). If ours is missing, the supplier will often have charged its local VAT: see §4 and §5.

### Step 5: Currency

Convert to SEK per **ML 8 kap. 21-22 §§**: the latest average rate on the most representative currency market in Sweden, **or** the latest ECB rate, at the time of the beskattningsgrundande händelse. Pick one source and use it consistently. Where the invoice states the SEK VAT amount itself, **ML 7 kap. 42 §** requires you to use the SEK amount shown.

### Master decision table

| Case | Cost account (råvaror / handelsvaror) | Output VAT | Input VAT | Rutor |
|------|------|------|------|------|
| Service, EU supplier, huvudregeln | **4535/4536/4537** | **2614/2624/2634** | **2645** | 21 + 30/31/32 + 48 |
| Service, non-EU supplier, huvudregeln | **4531/4532/4533** | **2614/2624/2634** | **2645** | 22 + 30/31/32 + 48 |
| Goods, EU supplier, unionsinternt förvärv | **4515/4516/4517** / **4075/4076/4077** | **2614/2624/2634** | **2645** | 20 + 30/31/32 + 48 |
| Goods, non-EU, import | **4545/4546/4547** / **4085/4086/4087** | **2615/2625/2635** | **2645** | 50 + 60/61/62 + 48 |
| Supplier established in Sweden, Swedish VAT charged | ordinary cost account | - | **2641** | 48 |
| Foreign VAT correctly charged (hotel, restaurant, event, short-term car hire abroad) | ordinary cost account, gross | - | none | none |

**Two traps encoded in that table, both common in older material:**

- **4531 is non-EU, 4535 is EU.** The lower number is the *further away* country. This is counter-intuitive and is a frequent miscoding.
- **2615 is import only.** Intra-EU goods acquisitions use **2614** (ruta 30), not 2615. Before 2015 the 261**5** series carried EU acquisition output VAT; it has carried **import** output VAT (ruta 60) ever since. Any rule that sends a unionsinternt förvärv to 2615 is pre-2015 and wrong.

### What rutor 23 and 24 are *not*

Rutor **23** and **24** are **domestic** reverse charge: goods bought *in Sweden* where the buyer is liable (ruta 23) and "other services than those reported in ruta 21 or 22" (ruta 24: byggtjänster, skrot, mobiltelefoner etc.). They have nothing to do with buying from abroad. Foreign purchases pair **21→30/31/32** and **22→30/31/32**. Skatteverket's own wording for ruta 30-32 is: "den utgående momsen för varje momssats på inköp som du har redovisat i fält 20-24", one shared output-VAT box for all five purchase boxes.

### Two booking patterns, both acceptable

Real systems do one of these:

- **Pattern A (BAS-native).** The 45xx account *is* the cost account: debit **4535**, and ruta 21 is read off the account balance.
- **Pattern B (cost account + momskod).** Debit the natural cost account (**6540** IT-tjänster, **5910** Annonsering, **6550** Konsultarvoden …) and attach the EU-service VAT code; the system derives ruta 21 from the code.

What must **never** happen is Pattern B *without* a VAT code: the cost lands in the P&L, rutor 21/30/48 are all zero, and the reverse charge is silently dropped. That is the single most common foreign-purchase error. If a foreign supplier invoice has no VAT line and no VAT code, treat it as unfinished.

---

## 2. Services from an EU supplier

SaaS, ads, hosting, consultants, agency work, licences, support.

**Rule.** Huvudregeln, **ML 6 kap. 33 §**: a service supplied to a beskattningsbar person is supplied where the buyer has its seat (or the fast etableringsställe the service is supplied to, 34 §). The supply is therefore in Sweden and **ML 16 kap. 9 §** makes the Swedish buyer liable to pay the VAT.

**Conditions.** You bought as a beskattningsbar person, you gave the supplier your valid Swedish VAT number, and the service is not one of the exceptions in §8.

**Rutor.** Base in **ruta 21**. Output VAT in **ruta 30** (25 %), **31** (12 %) or **32** (6 %). Input VAT in **ruta 48** to the extent you have avdragsrätt. Both sides must be filed; netting them to zero and reporting nothing is prohibited even though the cash effect is nil.

### Worked example

EU hosting supplier, invoice EUR 1 000, no VAT, marked "reverse charge", supplier VAT number `DExxxxxxxxx`, our SE-number printed. Rate 11.50 SEK/EUR → SEK 11 500.

| Account | Name | Debit | Credit |
|------|------|------|------|
| **4535** | Inköp av tjänster från annat EU-land, 25 % | 11 500.00 | |
| **2645** | Beräknad ingående moms på förvärv från utlandet | 2 875.00 | |
| **2614** | Utgående moms omvänd betalningsskyldighet, 25 % | | 2 875.00 |
| **2440** | Leverantörsskulder | | 11 500.00 |

Momsdeklaration: ruta 21 = 11 500, ruta 30 = 2 875, ruta 48 = 2 875. Net effect on ruta 49: zero.

Payment later: debit **2440** 11 500 / credit **1930**, with any FX difference to **7960** (loss) or **3960** (gain).

**If avdragsrätt is limited** (blandad verksamhet, or a cost that is not deductible), ruta 30 is still the full 2 875 but ruta 48 carries only the deductible part. Book the non-deductible part to the cost account and use **2649** for the deductible portion in mixed operations.

---

## 3. Services from a non-EU supplier

US, UK, Swiss, Norwegian, Indian, Australian suppliers: AWS invoiced from outside the EU, OpenAI, Anthropic, Cloudflare, a UK consultant.

**Same mechanism, different base ruta.** ML 6 kap. 33 § places the service in Sweden regardless of where the supplier sits, and ML 16 kap. 9 § makes the buyer liable. There is no requirement that the supplier be inside the EU.

**Rutor: state this exactly:**

| Field | Value |
|------|------|
| **Ruta 22** | Inköp av tjänster från ett land utanför EU (the base, excl. VAT) |
| **Ruta 30 / 31 / 32** | The Swedish output VAT you calculate, by rate: **the same boxes as for EU services** |
| **Ruta 48** | The deductible input VAT |

Only the base box differs between EU (21) and non-EU (22). There is no separate output-VAT box for non-EU services.

There is **no periodisk sammanställning** for non-EU purchases (nor for EU *purchases*; the periodisk sammanställning is a sales-side report only).

### Worked example

US SaaS supplier, invoice USD 2 400, no VAT, no EU VAT number. Rate 10.40 SEK/USD → SEK 24 960.

| Account | Name | Debit | Credit |
|------|------|------|------|
| **4531** | Inköp av tjänster från ett land utanför EU, 25 % moms | 24 960.00 | |
| **2645** | Beräknad ingående moms på förvärv från utlandet | 6 240.00 | |
| **2614** | Utgående moms omvänd betalningsskyldighet, 25 % | | 6 240.00 |
| **2440** | Leverantörsskulder | | 24 960.00 |

Ruta 22 = 24 960, ruta 30 = 6 240, ruta 48 = 6 240.

Under Pattern B the debit goes to **6540** IT-tjänster (or **5420** Programvaror for a licence, **6910** Licensavgifter och royalties for a royalty) with the non-EU service VAT code.

---

## 4. The trap: the supplier charged foreign VAT anyway

This is the most expensive everyday mistake, because the natural move: put the foreign VAT in ruta 48, is both wrong and detectable.

**The hard rule.** **ML 13 kap. 4 §** defines ingående skatt as "mervärdesskatt **enligt denna lag**". German, Irish, Danish or US tax is not Swedish VAT and is therefore **never** ingående skatt, **never** goes to 2641/2645, and **never** appears in ruta 48.

### Which of the three situations is this?

| Situation | Is the foreign VAT correct? | What to do |
|------|------|------|
| **A.** Service whose place of supply is genuinely the other country: hotel, restaurant, physical event admission, short-term car hire, work on immovable property abroad | **Yes** | Book gross as cost. Optionally reclaim via the refund procedure. No Swedish VAT, no ruta |
| **B.** Service under huvudregeln, or intra-EU goods, where the supplier charged its local VAT because our VAT number was missing or unverified | **No: supplier error** | Go back for a corrected invoice/credit note. Until then, self-assess on the **full amount incl. the foreign VAT** |
| **C.** Supplier has a Swedish VAT registration and charged **Swedish** VAT | Possibly: see §7 | If correct: **2641**, ruta 48, no reverse charge |

### Situation B in detail

Skatteverket's guidance for intra-EU goods is explicit and the same logic follows from **ML 8 kap. 2 §** (beskattningsunderlaget = ersättningen) for services: you must calculate and declare Swedish VAT on **the whole amount you paid, including the foreign VAT**, and you may deduct only the Swedish VAT you calculated. The foreign VAT is not deductible. You are, in effect, taxed twice until the supplier corrects the invoice: which is exactly why the correction matters.

**Worked example.** German consultant, EUR 1 000 + 19 % German VAT = EUR 1 190. Rate 11.50 → SEK 13 685 (of which SEK 2 185 is German VAT).

| Account | Name | Debit | Credit |
|------|------|------|------|
| **4535** | Inköp av tjänster från annat EU-land, 25 % | 13 685.00 | |
| **2645** | Beräknad ingående moms på förvärv från utlandet | 3 421.25 | |
| **2614** | Utgående moms omvänd betalningsskyldighet, 25 % | | 3 421.25 |
| **2440** | Leverantörsskulder | | 13 685.00 |

Ruta 21 = 13 685, ruta 30 = 3 421, ruta 48 = 3 421. The German 2 185 sits inside the cost: it is not recoverable in the Swedish declaration.

**Always go back to the supplier when:** the invoice is for a huvudregeln service or intra-EU goods, our valid VAT number exists, and the supplier still charged its local VAT. Ask for a kreditfaktura plus a corrected invoice with our VAT number and the "omvänd betalningsskyldighet" wording. Most SaaS vendors fix this by adding the VAT number in the billing portal and reissuing.

### Reclaiming EU VAT that was correctly charged (situation A)

Foreign EU VAT that was rightly charged is reclaimed from the other member state through the electronic refund procedure: **not** through the momsdeklaration.

| Item | Rule | Source |
|------|------|------|
| Route | Apply to the other EU country **via Skatteverket's electronic portal**, e-service *Momsåterbetalning inom EU*. Paper is not accepted | ML 14 kap. 55 § |
| Deadline | **30 September of the calendar year after the refund period** | ML 14 kap. 56 § |
| Deadline is hard | The weekend/holiday extension in lagen (1930:173) is expressly **not** applicable: 30 September stands even on a Saturday | ML 14 kap. 56 § 2 st |
| Period | Three calendar months up to one calendar year | Skatteverket |
| Minimum | **EUR 400** (period of 3+ months, under a year), **EUR 50** (full year or remainder) | Skatteverket |
| Access | The company must first register users on form **SKV 4852** | Skatteverket |
| Non-EU countries | Skatteverket's portal is not used; each country's own rules apply | Skatteverket |

Skatteverket will refuse to forward the application if, during the period, you were not a beskattningsbar person, made only exempt supplies without avdragsrätt, or were covered by the small-business exemption in ML 18 kap. (ML 14 kap. 58 §).

**Booking.** Book the invoice gross to the cost account. When you decide to claim, reclassify the foreign VAT to a receivable (e.g. **1688** Övriga kortfristiga fordringar: pick your system's receivable account) and clear it on refund. If you are not going to claim (below the threshold, or the destination country blocks the expense type), leave it in the cost. Do not park it in 26xx.

> **Osäkert:** which expense categories a given member state actually refunds varies by country: several block or restrict hotel, restaurant and passenger-car costs. Skatteverket points you to the refunding state and does not publish the list. Verify before promising a refund.

---

## 5. Goods from another EU country

**Unionsinternt förvärv.** The acquisition is made in Sweden when the transport to you ends here (**ML 6 kap. 29 §**), and **ML 16 kap. 17 §** makes the acquirer liable.

**Three conditions** (Skatteverket): the seller is VAT-registered in another EU country; the goods are physically transported between EU countries; and you gave the seller your valid Swedish VAT number.

**Accounts: pick the right BAS 2026 set:**

| The goods are | Account | Also |
|------|------|------|
| Råvaror och förnödenheter (input material, consumables) | **4515** / **4516** / **4517** (25/12/6 %) | **4518** momsfri |
| Handelsvaror (bought for resale) | **4075** / **4076** / **4077** (25/12/6 %) | **4078** momsfri |

Both feed **ruta 20**. The split is new in BAS 2026 and older mappings list only 4515-4517 for ruta 20: check that your ruta 20 definition includes 4075-4077 as well.

**Rutor.** Base in **ruta 20**, output VAT in **ruta 30/31/32** via **2614/2624/2634**, input VAT in **ruta 48** via **2645**. Input VAT is deducted in the same period the output VAT is reported (**ML 7 kap. 40 §**).

### Worked example

Danish supplier, råvaror, EUR 5 000 incl. freight, invoice without VAT, both VAT numbers shown. Rate 11.50 → SEK 57 500.

| Account | Name | Debit | Credit |
|------|------|------|------|
| **4515** | Inköp av råvaror och material från annat EU-land, 25 % | 57 500.00 | |
| **2645** | Beräknad ingående moms på förvärv från utlandet | 14 375.00 | |
| **2614** | Utgående moms omvänd betalningsskyldighet, 25 % | | 14 375.00 |
| **2440** | Leverantörsskulder | | 57 500.00 |

Ruta 20 = 57 500, ruta 30 = 14 375, ruta 48 = 14 375.

### If the supplier charged VAT because our VAT number was missing

Skatteverket: you must still calculate and declare Swedish VAT **on the full amount including the foreign VAT**, you may deduct the Swedish VAT you calculated, and you may **not** deduct the foreign VAT. Ask for a credit note and a corrected invoice. Book as in §4 situation B, using 4515/4075 instead of 4535.

### Goods that never arrived in Sweden

If you quoted your Swedish VAT number but the goods were delivered in another EU country, **ML 6 kap. 30 §** still places the acquisition in Sweden (the "reservregel"): output VAT in ruta 30, and there is **no** corresponding deduction. The fix is to register (or use trepartshandel) in the destination country; ML 6 kap. 31 § and ML 7 kap. 47 § govern the unwinding once the acquisition has been taxed where the transport ended. Escalate this one, it is not a routine booking.

---

## 6. Goods from outside the EU (import)

Since 2015, a VAT-registered importer reports import VAT to **Skatteverket** in the momsdeklaration. Tullverket collects only customs duty and other charges. A non-VAT-registered importer pays import VAT to Tullverket instead.

### The underlag is the tullräkning or tullkvitto: not the supplier invoice

Say this plainly, because it is the part that gets confused: the supplier's commercial invoice gives you the **goods cost**. The **VAT base and the reporting period** come from Tullverket's document.

| Question | Answer | Source |
|------|------|------|
| What is the underlag for the import VAT? | Tullverket's **tullräkning** or **tullkvitto** (the tulldeklaration/tullvärdebesked data behind it); the figure to use is the **monetärt tullvärde (1MT)** | Skatteverket / Tullverket |
| Which period? | The period in which Tullverket issued the tullräkning/tullkvitto: its **date**, not the supplier invoice date | Skatteverket; ML 7 kap. 41 § |
| Where do I see it? | Tullverket's e-service **Momsredovisning** lists the monthly import figures to report | Tullverket |
| Billing rhythm | Tullverket issues tullräkningar periodically to the party marked as payment-liable in the tulldeklaration (commonly a monthly cycle for a credit-holder; a direct payer gets a tullkvitto per declaration) | Tullverket |

> **Osäkert:** Tullverket's exact tullräkning cadence and payment deadline depend on the company's credit arrangement (kredithavare vs. kontantbetalning). Read the tullräkning itself rather than assuming a fixed monthly date.

### The taxable base

**ML 8 kap. 24-26 §§:**

1. **24 §**: the goods' value for customs purposes as determined by Tullverket under the Union Customs Code (the monetärt tullvärde).
2. **25 §**: plus customs duty and other state taxes and charges levied by Tullverket at import, except the VAT itself, and only to the extent not already in the customs value.
3. **26 §**: plus ancillary costs such as commission, packing, transport and insurance **up to the first place of destination in Sweden**.

Freight *to* the EU entry point is already inside the customs value: do not add it twice. Freight *from* the entry point onward (e.g. Rotterdam → Malmö) is added.

### Accounts

| The goods are | Account |
|------|------|
| Råvaror och förnödenheter | **4545** / **4546** / **4547** (25/12/6 %) |
| Handelsvaror | **4085** / **4086** / **4087** (25/12/6 %) |

Output VAT: **2615** (25 %) → ruta 60, **2625** (12 %) → ruta 61, **2635** (6 %) → ruta 62. Input VAT: **2645** → ruta 48. Base → **ruta 50**.

Customs duty and forwarder charges: **5721** Tullkostnader, **5722** Speditionskostnader, **5711** Fraktkostnader.

### Worked example

Råvaror from a Chinese supplier. Supplier invoice USD 9 615, rate 10.40 → SEK 100 000. Tullräkning dated 14 October shows monetärt tullvärde SEK 100 000 and tull SEK 4 200. Forwarder invoices SEK 3 000 for transport from the EU entry point to Sweden.

**Verification 1: supplier invoice (no VAT):**

| Account | Name | Debit | Credit |
|------|------|------|------|
| **4545** | Import av råvaror och material, 25 % moms | 100 000.00 | |
| **2440** | Leverantörsskulder | | 100 000.00 |

**Verification 2: tullräkning (duty only; no VAT on it for a VAT-registered importer):**

| Account | Name | Debit | Credit |
|------|------|------|------|
| **5721** | Tullkostnader | 4 200.00 | |
| **2440** | Leverantörsskulder (Tullverket) | | 4 200.00 |

**Verification 3: forwarder invoice, Swedish forwarder with Swedish VAT:**

| Account | Name | Debit | Credit |
|------|------|------|------|
| **5711** | Fraktkostnader | 3 000.00 | |
| **2641** | Debiterad ingående moms | 750.00 | |
| **2440** | Leverantörsskulder | | 3 750.00 |

**Verification 4: import VAT self-assessment, base 100 000 + 4 200 + 3 000 = 107 200, dated in the tullräkning's period (October):**

| Account | Name | Debit | Credit |
|------|------|------|------|
| **2645** | Beräknad ingående moms på förvärv från utlandet | 26 800.00 | |
| **2615** | Utgående moms import av varor, 25 % | | 26 800.00 |

Momsdeklaration October: ruta 50 = 107 200, ruta 60 = 26 800, ruta 48 = 26 800 + 750 = 27 550.

> **Osäkert:** BAS 2026 provides no counter-account for carrying the ruta 50 base when the base (107 200) differs from what is already on 4545 (100 000). Systems solve this differently: some post the full base to 4545 against an offsetting credit, some hold ruta 50 as a statistical field on the import verification. Check how your system derives ruta 50 before assuming the 4545 balance is the answer; a ruta 50 that equals the supplier invoice and ignores duty and inland freight is understated.

---

## 7. Foreign supplier with a Swedish VAT registration

A foreign company can be VAT-registered in Sweden and invoice with 25 % Swedish VAT. Sometimes that is right, sometimes it is a mis-set billing profile.

**When Swedish VAT is correct:** the supplier has a **fast etableringsställe in Sweden that took part in the supply**: e.g. a Swedish branch (filial) that actually delivers the service. Then the supplier is liable, the invoice carries Swedish VAT and a Swedish VAT number, and you book it as an ordinary domestic purchase: cost account + **2641**, ruta 48, no reverse charge, no ruta 21/22.

**When it is not:** a supplier that is merely *registered* here (for example to handle distance sales or its own imports) but makes this supply from abroad without the Swedish establishment's involvement is treated as **not established in Sweden** (**ML 16 kap. 4 §**), and the reverse charge in **ML 16 kap. 9 §** applies. Swedish VAT on such an invoice is felaktigt debiterad mervärdesskatt: you may not deduct it (it was not lawfully chargeable), and you must still self-assess. Get a corrected invoice; ML 7 kap. 49-50 §§ govern how the supplier corrects it.

**Practical signals:**

- Swedish VAT number ending `…01` on a filial + Swedish address + Swedish VAT line → likely correct domestic supply.
- Luxembourg/Irish address, a Swedish VAT number, 25 % Swedish VAT on a pure cloud service → question it.
- Same supplier, same service, VAT appearing on some invoices and not others → the VAT number on the account was added or removed mid-stream. Check the billing profile.

> **Osäkert:** whether the Swedish establishment "took part in" a given supply is a judgment call on the facts (ML 16 kap. 4 §). Where it is not obvious from the invoice, ask rather than guess: the two answers produce opposite bookings.

---

## 8. Small everyday cases

These are the receipts that break the reverse-charge reflex. Huvudregeln has exceptions, and in each of these the place of supply is *not* Sweden, so there is **no** reverse charge and **no** ruta.

| Receipt | Rule | Booking |
|------|------|------|
| **Hotel abroad** | Tjänst med anknytning till fastighet: supplied where the property is (**ML 6 kap. 38 §**) | Gross incl. foreign VAT to **5832** Kost och logi i utlandet. No ruta. EU VAT may be reclaimable (§4) |
| **Restaurant/catering abroad** | Supplied where physically performed (**ML 6 kap. 48 §**) | Gross to **5832** or **6071** if representation. No ruta |
| **Conference/event admission abroad (physical)** | Tillträde till evenemang: supplied where the event takes place (**ML 6 kap. 45-46 §§**) | Gross incl. foreign VAT to **7610** Utbildning (or 5800-series). No ruta |
| **Conference/webinar attended virtually** | ML 6 kap. 46 § expressly does **not** cover events where attendance is virtual (Lag 2024:942) → falls back to huvudregeln | **Reverse charge**: 4535/4531, ruta 21 or 22 |
| **Short-term car hire abroad** (≤ 30 days, vehicles) | Supplied where the vehicle is actually placed at the customer's disposal (**ML 6 kap. 52 §**) | Gross to **5820** Hyrbilskostnader. No ruta |
| **Long-term vehicle rental / leasing from abroad, B2B** | Not covered by 52 § → huvudregeln | **Reverse charge**: 4535/4531, ruta 21 or 22 |
| **Foreign bank fees, card fees, FX fees** | Financial services are exempt from VAT; no Swedish VAT arises | **6570** Bankkostnader, gross. No VAT |
| **App-store purchases (App Store, Google Play, etc.)** | The store is usually the merchant of record; treatment depends on the store entity and whether a business VAT number is registered on the account | Read the receipt. VAT number registered + no VAT charged → reverse charge. Swedish VAT charged by an EU entity acting as deemed supplier → **2641**, ruta 48 |
| **Foreign conference fee invoiced as a service (course, training, membership)** | Huvudregeln unless it is admission to a physical event | Reverse charge; if in doubt, ask |
| **Foreign advertising (Meta, LinkedIn, Google Ads)** | Elektronisk tjänst / annonseringstjänst, huvudregeln | **5910** Annonsering or 4535/4531; ruta 21 or 22 |

> **Osäkert:** whether an exempt purchase (a foreign bank fee, an insurance premium) should still be entered as a base amount in ruta 21/22 is not addressed in Skatteverket's ruta-21/22 guidance. The reverse charge presupposes a taxable transaction in Sweden, so the common practice is to leave exempt purchases out of the rutor entirely. Confirm against your filing policy before changing existing treatment.

> **Osäkert:** a *conference package* (venue + meals + programme) bought abroad can be a single supply falling under huvudregeln rather than "tillträde", which flips the treatment. Skatteverket has addressed conference arrangements in the Swedish domestic context but the cross-border split is fact-dependent. Ask when the invoice is a package rather than a ticket.

---

## 9. Supplier quick lookup

**Verify on the invoice; entities change.** This table is a sanity check on the treatment you derived from §1, never a substitute for it. The same supplier bills different entities in different years, and the presence of a valid VAT number on the account changes the outcome for every row.

Assumption for the "usual treatment" column: a Swedish AB, VAT-registered, with a **valid VAT number registered on the supplier account**, full avdragsrätt.

| Supplier | Invoicing entity | Usual treatment |
|------|------|------|
| **AWS** | **Amazon Web Services EMEA SARL, Luxembourg** (verified, AWS tax help). AWS states it has branches in 17 EU countries treated as local vendors for VAT | EU service → ruta 21 + 30 + 48. **If the invoice shows a Swedish branch and Swedish VAT**, it is a domestic supply → 2641, ruta 48. Check the header |
| **Apple** (App Store, Apple Media Services) | **Apple Distribution International Ltd., Cork, Ireland** (verified, Apple's own terms) | EU service → ruta 21 + 30 + 48 if billed without VAT on a business account. A consumer-style receipt with Irish or Swedish VAT is not reverse charge |
| **Google / Google Cloud / Google Ads** | Not verified here: commonly an Irish entity for EU customers, but Google also bills through local entities | Read the invoice. No VAT + EU VAT number → ruta 21 + 30 + 48 |
| **Microsoft** (365, Azure) | Not verified here: commonly an Irish entity for EU customers | Read the invoice. No VAT + EU VAT number → ruta 21 |
| **OpenAI** | Not verified here: EU and US entities both exist | If the invoice carries an EU VAT number → ruta 21. If a US entity → **ruta 22** + 30 + 48 |
| **Anthropic** | Not verified here | Same test: EU entity → ruta 21; US entity → **ruta 22** |
| **Meta** (ads) | Not verified here: commonly an Irish entity for EU advertisers | No VAT + IE VAT number → ruta 21 + 30 + 48 |
| **LinkedIn** | Not verified here: commonly an Irish entity | As Meta |
| **Adobe** | Not verified here: commonly an Irish entity | As Meta |
| **Slack / Salesforce** | Not verified here | Read the entity line; EU → 21, non-EU → 22 |
| **Notion** | Not verified here | Read the entity line |
| **GitHub** | Not verified here: part of Microsoft | Read the entity line |
| **Figma** | Not verified here | Read the entity line |
| **Zoom** | Not verified here | Read the entity line |
| **Dropbox** | Not verified here: commonly an Irish entity | Read the entity line |
| **Cloudflare** | Not verified here | Read the entity line |
| **Vercel** | Not verified here | Read the entity line |
| **Hetzner** | Not verified here: German | EU service → ruta 21 + 30 + 48. German VAT on the invoice means the VAT number is not registered on the account, fix it (§4 situation B) |

The one thing that is stable across every row: **EU entity without VAT → ruta 21. Non-EU entity without VAT → ruta 22. Any VAT on the invoice → stop and classify it before booking.**

---

## 10. Stop and ask

Do not guess. Ask a human when:

1. **You cannot tell goods from services**: a mixed invoice (hardware + support + shipping), or a "platform fee" with no description.
2. **You cannot identify the supplier's country of establishment**: the invoice has no address, or an address in one country and a VAT number from another.
3. **The invoice shows VAT and you cannot tell whose**: no country prefix, no rate that matches a known jurisdiction, or a number labelled only "tax".
4. **The supplier has a Swedish VAT number and charged Swedish VAT on a cross-border service**: §7, judgment call under ML 16 kap. 4 §.
5. **Goods were shipped somewhere other than Sweden**: ML 6 kap. 30 § territory; do not book it as a normal förvärv.
6. **The company does not have full avdragsrätt**: blandad verksamhet, non-deductible expense types, personbil costs. Ruta 30/60 is still full; ruta 48 is not.
7. **A ruta 50 base would have to be invented** because no tullräkning or tullkvitto is on file: book the goods cost and hold the VAT until the customs document arrives.
8. **An EU VAT refund claim is being considered near the 30 September cut-off**: the deadline is hard (ML 14 kap. 56 §) and a missed year is not recoverable.
9. **A supplier's invoice changed VAT behaviour between periods** without anything else changing: someone edited the billing profile, and the earlier periods may need correcting.

### Red flags on a booked entry

- Ruta 21 or 22 has a value but ruta 30 is zero → the output side was dropped.
- Ruta 48 contains foreign VAT → ML 13 kap. 4 § violation.
- **2615** used for an intra-EU goods purchase → pre-2015 mapping; should be **2614**.
- **4531** used for an EU supplier or **4535** for a US supplier → the two series are swapped.
- A foreign supplier invoice with no VAT line, no VAT code, and a plain 6xxx cost account → the reverse charge was silently skipped.
- Ruta 50 equals the supplier invoice exactly → duty and inland freight are missing from the base.

---

## Sources

Primary: skatteverket.se (Köpa tjänster/varor från andra EU-länder, Köpa varor från länder utanför EU: import, Fylla i momsdeklarationen, Återbetalning av utländsk moms, Omvänd betalningsskyldighet); mervärdesskattelag (2023:200) via riksdagen.se, 6 kap. 29-31, 33-34, 38, 45-46, 48, 52, 57 §§; 7 kap. 40-42, 47, 49-50 §§; 8 kap. 2, 21-22, 24-26 §§; 13 kap. 4 §; 14 kap. 55-58 §§; 16 kap. 4, 6, 9, 17 §§; 17 kap. 24 §; tullverket.se (Importmoms, Tullvärde, Tullräkningar, Momsredovisning); bas.se, BAS 2026 kontoplan v2. Supplier entities: AWS and Apple confirmed from their own published invoicing/terms documentation; all other rows explicitly unverified.

Cross-reference: `swedish-vat/references/vat-compliance-reference.md` for rule derivations, the full BAS 26xx series, and the complete ruta-to-account mapping.
