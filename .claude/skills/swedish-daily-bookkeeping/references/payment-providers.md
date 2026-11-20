# Payment Providers, Card Acquiring and Payouts: Reference

Decision reference for categorising bank lines and receipts that involve a payment provider (Stripe, Klarna, Zettle/PayPal, SumUp, Swish Handel, Nets/Worldline, Adyen, Amazon, Etsy, Shopify Payments).

Scope boundary: this file decides **which accounts, which VAT treatment, which ruta** for the *provider relationship*. It does not restate EU VAT place-of-supply, OSS, import VAT or the full ruta↔BAS map: use the **`swedish-vat`** skill for those. Invoice content requirements and kreditfaktura mechanics: **`swedish-invoice-compliance`**.

All account numbers are **BAS 2026**.

---

<!-- toc -->
**Contents**

- [1. The one rule that governs everything here](#1-the-one-rule-that-governs-everything-here)
- [2. Interim account: use 1686](#2-interim-account-use-1686)
- [3. Identify the counterparty before you book](#3-identify-the-counterparty-before-you-book)
- [4. Worked example A: net payout (Stripe pattern)](#4-worked-example-a-net-payout-stripe-pattern)
- [5. Worked example B: gross payout, fee invoiced separately (acquirer / Swish pattern)](#5-worked-example-b-gross-payout-fee-invoiced-separately-acquirer--swish-pattern)
- [6. VAT on the provider's fee: exempt or taxable?](#6-vat-on-the-providers-fee-exempt-or-taxable)
- [7. Reporting: does an exempt foreign fee go in ruta 21 / 22?](#7-reporting-does-an-exempt-foreign-fee-go-in-ruta-21--22)
- [8. Swish](#8-swish)
- [9. Card terminal and kortinlösen: three different numbers](#9-card-terminal-and-kortinlösen-three-different-numbers)
- [10. Chargebacks, refunds and reserves](#10-chargebacks-refunds-and-reserves)
- [11. Marketplace sales (Amazon, Etsy, Shopify + provider)](#11-marketplace-sales-amazon-etsy-shopify--provider)
- [12. Currency: payouts in EUR/USD](#12-currency-payouts-in-eurusd)
- [13. Dricks (tips) through a card terminal or Swish](#13-dricks-tips-through-a-card-terminal-or-swish)
- [14. Ask-the-user rules (consolidated)](#14-ask-the-user-rules-consolidated)
- [15. Sources](#15-sources)

<!-- /toc -->

## 1. The one rule that governs everything here

A payment provider is an **intermediary**, not the customer. The customer owes the full price; the provider owes you the full price minus its fee.

Two consequences, both mandatory:

| Consequence | Legal hook |
|---|---|
| Revenue and output VAT are booked on the **gross** customer price, never the payout amount | **ML 8 kap 2-3 §§ (2023:200)**: beskattningsunderlaget is *ersättningen*: "allt det som leverantören … har fått eller ska få för varan eller tjänsten från förvärvaren **eller en tredje part**" |
| The provider's fee is a **cost**, booked separately; it may not be netted against revenue | **ÅRL 2 kap 4 § första stycket 6**: "Inte heller får intäkter och kostnader kvittas mot varandra" |
| Output VAT is recognised when the supply happens, not when the payout lands | **ML 7 kap 4 §**: beskattningsgrundande händelse inträffar när leveransen eller tillhandahållandet sker |

A bank line reading `STRIPE PAYMENTS 18 432,10` is **not** revenue of 18 432,10. It is the settlement of a receivable. Booking it as revenue understates både omsättning and utgående moms, and is one of the most common material errors in small-company bookkeeping.

---

## 2. Interim account: use 1686

**Use `1686` Fordringar för kontokort och kuponger** (kontogrupp 16: Övriga kortfristiga fordringar, huvudkonto **`1680`** Andra kortfristiga fordringar).

**BAS 2026 change: important.** The account many systems still call **1580** *Fordringar för kontokort och kuponger* was **removed in BAS 2026** and re-created as **1686** inside 1680. If a ledger, template or SIE file still posts to 1580, remap it to 1686. (Same 2026 cleanup removed 7833/7834/7835; 7830 was renamed *Avskrivningar på maskiner respektive inventarier*.)

Why 1686 and not 1930 or 1510:

- It is a **short-term receivable on the provider**, not cash. The money is not at your disposal until the payout clears, so it is not 19xx.
- It is not a **kundfordran** (1510): the customer has already paid and is discharged. The debtor is the provider.
- Using a dedicated interim account is what makes the payout reconcilable at all. Without it, timing differences over a month end are invisible.

**One balance per provider.** Do not merge Stripe, Klarna and Zettle into one 1686 balance. Either keep a sidoordnad bokföring per provider (**BFL 5 kap 4 §**: konton över tillgångar ska specificeras i sidoordnad bokföring i den utsträckning det behövs för kontroll och överblick), or open company-specific accounts in the 168x range and document the mapping.

**Do not use 1680 directly** unless the system forbids subaccounts: 1680 is the huvudkonto for the whole group.

Related accounts:

| Account | Use |
|---|---|
| **1686** | Receivable on a card acquirer / payment provider / marketplace, from sale until payout |
| **1650** | Momsfordran: unrelated, do not confuse with a provider balance |
| **1685** | Kortfristiga fordringar hos delägare eller närstående: where business money landed in a private Swish (see §8) |
| **2820 / 2829** | Kortfristiga skulder till anställda: tips collected on behalf of staff |
| **2830** | Avräkning för annans räkning: alternative for pure pass-through tips |
| **6570** | Bankkostnader: default account for provider and acquirer fees |
| **4538** | Inköp av tjänster från annat EU-land, momsfri: only when the fee is a direct cost of sales in a producing/service company |

---

## 3. Identify the counterparty before you book

| Bank line looks like | Provider type | Payout is normally | Fee arrives as |
|---|---|---|---|
| `STRIPE`, `STRIPE PAYMENTS EUROPE` | PSP + acquirer | **Net** of fees | Deducted in the payout; itemised in the balance report |
| `KLARNA BANK AB` | Credit/payment provider (SE) | **Net** | Deducted; settlement report per payout |
| `ZETTLE`, `PAYPAL`, `SUMUP` | Card acquirer (mobile POS) | **Net** | Deducted per transaction or per payout |
| `NETS`, `WORLDLINE`, `BAMBORA` | Kortinlösen (acquirer) | **Gross or net: varies by contract** | Often a separate monthly invoice |
| `SWISH`, bank's own Swish line | Bank-operated payment scheme | **Gross** (typically) | Normally billed by the bank |
| `ADYEN` | PSP + acquirer | **Net** | Deducted; settlement detail report |
| `AMAZON`, `ETSY` | Marketplace (deemed supplier rules may apply) | **Net** | Commission + fulfilment, separately invoiced |

**Never assume gross or net from the brand.** Open the provider's settlement/payout report and check whether the payout equals the gross sales of the period. Both patterns are handled below; picking the wrong one silently corrupts the 1686 balance.

> **If you cannot obtain a settlement report that splits gross sales, fees, refunds and reserves for the payout period: ask the user for it. Do not book the payout as revenue as a fallback.**

---

## 4. Worked example A: net payout (Stripe pattern)

Facts. Swedish AB, 25 % VAT, faktureringsmetoden. On 12 September the webshop sells goods for **25 000 SEK incl. VAT** (beskattningsunderlag 20 000, utgående moms 5 000). Stripe's fee for the period is **437,50 SEK** (exempt payment service, see §6). Payout on 15 September: **24 562,50 SEK**.

**12 Sept: the sale** (source: order/sales report, ML 7 kap 4 §: beskattningsgrundande händelse = leveransen):

| Konto | Namn | Debet | Kredit |
|---|---|---|---|
| 1686 | Fordringar för kontokort och kuponger | 25 000,00 | |
| 3001 | Försäljning inom Sverige, 25 % moms | | 20 000,00 |
| 2611 | Utgående moms på försäljning inom Sverige, 25 % | | 5 000,00 |

Momsdeklaration: 20 000 in **ruta 05**, 5 000 in **ruta 10**. (Full ruta↔BAS map: `swedish-vat`.)

**15 Sept: the payout and the fee** (source: Stripe payout report):

| Konto | Namn | Debet | Kredit |
|---|---|---|---|
| 1930 | Företagskonto | 24 562,50 | |
| 6570 | Bankkostnader | 437,50 | |
| 1686 | Fordringar för kontokort och kuponger | | 25 000,00 |

1686 goes to zero. No VAT on the fee line: no 2645, no 2614, nothing in ruta 21/22/30/48 (§7).

**Reconciliation test.** For every period:

```
opening 1686 + gross sales − refunds/chargebacks − fees − payouts received ± reserve movement = closing 1686
```

If it does not close, the difference is one of: a sale booked at net, a refund not booked, a fee invoiced separately and already expensed, a payout that crossed the period end, or a reserve the provider withheld (§10).

---

## 5. Worked example B: gross payout, fee invoiced separately (acquirer / Swish pattern)

Facts. Restaurant, 12 % VAT on food. Day's card sales 30 Sept: **11 200 SEK incl. VAT** (beskattningsunderlag 10 000, utgående moms 1 200). The acquirer pays out the full 11 200 on 2 October and invoices **168 SEK** in kortinlösenavgift on 31 October.

**30 Sept: dagens försäljning.** A day's cash/card takings may be documented by a **gemensam verifikation** (**BFL 5 kap 6 § tredje stycket**), normally the kassaregister's Z-rapport:

| Konto | Namn | Debet | Kredit |
|---|---|---|---|
| 1686 | Fordringar för kontokort och kuponger | 11 200,00 | |
| 3002 | Försäljning inom Sverige, 12 % moms | | 10 000,00 |
| 2621 | Utgående moms på försäljning inom Sverige, 12 % | | 1 200,00 |

**The month-end timing difference is the point of this example.** On 30 September the 11 200 sits in 1686, not in 1930. That is correct and must not be "fixed". The balance sheet shows a real receivable on the acquirer. Anyone who books card sales straight to 1930 on the sale date will have a bank reconciliation that never closes.

**2 Oct: payout:** Debit **1930** 11 200 / Credit **1686** 11 200.

**31 Oct: fee invoice:** Debit **6570** 168 / Credit **2440** 168. (If the invoice is exempt, no input VAT; §6.)

**Kassaregister.** A business selling against cash or card must use a certified kassaregister (**SFL 39 kap 4 §**), with exemptions in **39 kap 5 §**: including sales of obetydlig omfattning, assessed at normally at most four prisbasbelopp per beskattningsår, and distansavtal (e-commerce). The register's Z-rapport is the verifikation behind the entry above; the acquirer's report is the verifikation behind the payout. Do not go deeper here, kassaregister obligations are their own topic.

> **Osäkert:** whether a payment made by Swish triggers the kassaregister obligation. **SFL 39 kap 4 §** names only "kontant betalning eller … betalning med kontokort", and Skatteverket's public kassaregister pages do not address Swish. If a client's kassaregister exposure turns on Swish volume, ask Skatteverket or the user: do not decide it from this file.

---

## 6. VAT on the provider's fee: exempt or taxable?

### The legal test

**ML 10 kap 33 § (2023:200)**: "Från skatteplikt undantas tillhandahållanden av bank- och finansieringstjänster samt sådana tillhandahållanden som utgör värdepappershandel eller liknande verksamhet." The paragraph expressly excludes **notariatverksamhet, inkassotjänster, administrativa tjänster avseende factoring och uthyrning av förvaringsutrymmen** from the concept.

The EU basis is **article 135.1 d** of the VAT Directive (transactions concerning payments and transfers). Per Skatteverket's rättsliga vägledning on *Betaltjänster och förmedling av sådana tjänster*, the service must **"medföra en ändring i den befintliga rättsliga och finansiella ställningen mellan betalaren och mottagaren"**: that change of legal and financial position is the defining characteristic of an exempt payment service.

**So:** moving the money is exempt. Selling software, hardware, data, access or marketing around the money movement is **not**.

### Decision table: read the invoice line by line

| Invoice line | Treatment | Why |
|---|---|---|
| Kortinlösenavgift / acquiring fee / processing fee (x % + fixed) | **Exempt**, no VAT, no reverse charge | Effects the transfer of funds: ML 10 kap 33 § |
| Klarna/Stripe/Zettle transaction fee on a settled sale | **Exempt** | Same |
| Swish-transaktionsavgift | **Exempt** | Same |
| Valutaväxlingspåslag / FX conversion fee | **Exempt** | Currency transaction |
| Utbetalningsavgift / payout fee | **Exempt** | Part of the transfer |
| Månadsabonnemang för plattform, gateway, SaaS-modul, Stripe Billing/Tax/Radar, Shopify subscription | **Taxable** | Electronically supplied service, not a transfer of funds |
| Terminalhyra / hardware rental / card reader purchase | **Taxable** | Supply of goods or hire of goods |
| Marketplace commission (Amazon, Etsy) | **Taxable** | Förmedlings-/plattformstjänst |
| Annonsering, sponsrade placeringar, Klarna Ads | **Taxable** | Advertising |
| Chargeback-avgift / dispute fee | **See note** | Usually treated as part of the exempt payment service; if the provider invoices it with VAT, follow the invoice unless it is clearly wrong |
| Inkassoavgift, påminnelsehantering | **Taxable** | ML 10 kap 33 § explicitly excludes inkassotjänster |
| Kreditupplysning, risk scoring sold as a standalone product | **Taxable** | Information service |

### How to tell them apart in practice

1. **One invoice, several lines → split per line.** A Nets or Adyen invoice routinely mixes exempt acquiring fees with taxable terminal hire on the same document.
2. **Look at what changes.** If the merchant's position vis-à-vis the payer changes because the provider acted, exempt. If you would have bought the same thing without any money moving (a dashboard, a plugin, a report, a reader), taxable.
3. **The provider's own labelling is evidence, not the answer.** An EU invoice stamped "reverse charge: article 196" on an exempt acquiring fee does not create a reverse charge (§7). Conversely an unlabelled invoice from an Irish SaaS entity is still a taxable EU service purchase.
4. **Check the invoicing entity.** The same brand often invoices from two legal entities: a regulated payment institution for the acquiring fee and an ordinary company for the software. Different entity, different answer.
5. **Bundled, inseparable price with no line split → treat as one supply and determine its dominant element**, and say in the verifikation note why you chose it.

> **If a single un-split fee bundles clearly exempt acquiring with a clearly taxable subscription and the amounts are material: ask the user for the itemised statement rather than guessing the split.**

### When the provider charges Swedish VAT on an exempt fee

If a line that is genuinely exempt under 10 kap 33 § carries Swedish VAT:

- That amount is **felaktigt debiterad mervärdesskatt** (**ML 2 kap 12 §**: a sum described as VAT in an invoice that is not VAT under the law).
- It is **not ingående skatt** (**ML 13 kap 4 §**: ingående skatt is *mervärdesskatt enligt denna lag*), so it is **not deductible**. Do not put it in 2641 / ruta 48.
- The provider must correct it with an ändringsfaktura (**ML 17 kap 22 §**; supplier-side adjustment **ML 7 kap 49-50 §§**).
- **Until corrected:** book the whole amount, VAT included, as cost on 6570. Flag it to the user and ask for a corrected invoice.
- **Before doing any of this, re-run the §6 decision table.** In the overwhelming majority of cases the VAT is correct because the line is terminal hire, a gateway subscription or a marketplace commission: not an acquiring fee.

---

## 7. Reporting: does an exempt foreign fee go in ruta 21 / 22?

**No: for both EU and non-EU suppliers. Nothing is reported anywhere in the momsdeklaration.**

Not ruta 21, not ruta 22, not ruta 23 or 24, not ruta 30-32, not ruta 48, and not in the periodisk sammanställning (which concerns your sales, not your purchases).

**Why:**

1. Reverse charge on services from a non-established supplier under the huvudregeln rests on **ML 16 kap 9 §** (read with 6 kap 33 §).
2. But **ML 16 kap 3 §** limits the entire chapter: "Bestämmelserna i detta kapitel om vem som är skyldig att betala mervärdesskatt till staten är tillämpliga på beskattningsbara transaktioner som är **skattepliktiga** och görs inom landet."
3. A service exempt under ML 10 kap 33 § is not skattepliktig. No betalningsskyldighet arises, so there is no output VAT to self-assess and no input VAT to deduct.
4. Skatteverket's instruction for the momsdeklaration is explicit that rutor 21, 22 and 24 are for purchases "när huvudregeln gäller och **du som köpare är betalningsskyldig**" and must yourself report utgående moms. An exempt purchase fails that condition.

### Decision table

| Fee, supplier | Ruta 21 | Ruta 22 | Ruta 30/31/32 | Ruta 48 | Cost account |
|---|---|---|---|---|---|
| Exempt payment fee, **EU** supplier (Klarna DE, Adyen NL, Stripe Payments Europe IE) | - | - | - | - | 6570 |
| Exempt payment fee, **non-EU** supplier (UK, US, CH acquirer) | - | - | - | - | 6570 |
| Exempt payment fee, **Swedish** supplier | - | - | - | - | 6570 |
| **Taxable** service, EU supplier (Shopify subscription, Amazon commission, Etsy fees) | **Yes**: beskattningsunderlaget | - | **Yes** (usually ruta 30) | **Yes** | 6540/6590/6910 or 4535-4537 |
| **Taxable** service, non-EU supplier | - | **Yes** | **Yes** | **Yes** | same |
| Taxable service, Swedish supplier with Swedish VAT | - | - | - | **Yes** (2641) | same |

For a taxable EU/non-EU purchase the mechanics are the ordinary reverse charge (2614 + 2645, net zero with full avdragsrätt): see **`swedish-vat`**, do not re-derive it here.

**Corollary for the ledger:** a company whose only foreign purchases are exempt payment fees has **no** entries in rutor 20-24 from them. If a system auto-tags every foreign supplier invoice as reverse charge, that tagging is wrong for acquiring fees and will overstate both 2614 and 2645.

---

## 8. Swish

### Företagsswish (Swish Handel / Swish Företag) vs a private Swish

| | Företagsswish | Private Swish used for business |
|---|---|---|
| Registered to | Org.nr, Swish-nummer starting 123 | Personnummer |
| Money lands in | Company bank account | Owner's private account |
| Verifikation quality | Settlement/transaction report per payment | Screenshots; payer name only |
| Accounting consequence | Ordinary revenue entry | Revenue **plus** a separate entry for money held outside the company |

Business income received in a private Swish is still an affärshändelse of the business and must be bookkept. **BFL 5 kap 2 §**: kontanta in- och utbetalningar ska bokföras senast påföljande arbetsdag.

- **Aktiebolag:** Debit **1685** Kortfristiga fordringar hos delägare eller närstående / Credit 3001 + 2611. Clear 1685 when the owner transfers the money in. A balance that is allowed to stand is a shareholder loan and may be caught by the låneförbud in **ABL 21 kap 1 §**: flag it, do not silently carry it.
- **Enskild firma:** the receipt is an egen insättning; the money is the näringsidkare's anyway, so book revenue against **2018 Övriga egna insättningar** (or the firm's bank account if transferred immediately).

> **If a bank line or receipt shows business income paid to a private Swish number, flag it to the user every time.** It is a bookkeeping defect, not a neutral choice of payment method.

### Swish Handel settlement

Swish agreements are entered through the company's own bank; the bank, not Swish AB, is the counterparty for pricing and reporting. Swish Handel (the integrated variant, with callbacks and a settlement/avräkning report per day) is what makes Swish reconcilable; Swish Företag without integration gives you only bank lines.

Book each day's Swish takings the same way as §5: gross to **1686** (or straight to 1930 if the money is in the account the same day and the fee is invoiced separately: then no interim step is needed), revenue and VAT on the gross amount.

Transaction fees: exempt payment service (§6), to **6570**, no VAT, nothing in the momsdeklaration.

> **Osäkert:** whether Swish Handel payouts reach the account gross or net of fees, and whether fees are debited directly or invoiced monthly. This is set by the bank agreement and varies between banks. Verify against the bank's Swish report for the specific client before choosing the §4 or §5 pattern; if the report is not available, ask.

---

## 9. Card terminal and kortinlösen: three different numbers

Keep these strictly apart. They are almost never equal, and treating any two as the same is the classic source of an unreconcilable 1686.

| # | Number | Where it comes from | Where it is booked |
|---|---|---|---|
| 1 | **Dagens kortförsäljning** (gross, incl. VAT) | Kassaregister Z-rapport / terminal day-end | Debit 1686, credit 30xx + 26xx, on the sale date |
| 2 | **Acquirer's payout** | Bank line | Debit 1930, credit 1686, on the payout date |
| 3 | **Kortinlösenavgift** | Deducted from #2, or a separate monthly invoice | Debit 6570 |

Ordinary causes of #1 ≠ #2 in a given month: weekend and holiday settlement lags, batches cut at a fixed hour rather than midnight, refunds netted into the next payout, tips settled on a different cycle, a reserve withheld (§10), and chargebacks deducted from an unrelated payout.

**Month end.** Never force a period-end adjustment to make 1686 zero. The residual balance at 30 September *is* the amount the acquirer owed you on 30 September, and it should be supported by the acquirer's statement. If the residual cannot be tied to identified transactions, do not write it off to 6570: ask.

---

## 10. Chargebacks, refunds and reserves

| Event | Booking | VAT |
|---|---|---|
| **Refund** of a sale | Reverse the original entry: Debit 30xx + 26xx / Credit 1686 | Reduce utgående moms. For an invoiced sale an ändringsfaktura is required: see `swedish-invoice-compliance` |
| **Chargeback**: customer wins, money reversed | Same as a refund: the supply is undone, revenue and output VAT reverse | Reduce utgående moms |
| **Chargeback fee** charged by the provider | Debit 6570 / Credit 1686 | Follow the provider's invoice (§6) |
| **Chargeback lost but goods not returned**: treat as a bad debt, not a sales reversal | Debit 6351 or the relevant kundförlust account; keep output VAT unless the conditions for reducing it are met | Reducing output VAT on a kundförlust has its own conditions, `swedish-vat` |
| **Reserve / rolling reserve withheld** | The money is still owed to you. **Leave it in 1686** (or move it to a clearly named reserve subaccount). Do **not** expense it | None: it is not a fee |
| **Reserve released** | Debit 1930 / Credit 1686 | None |

A reserve expensed to 6570 is a direct overstatement of costs and understatement of assets. The provider's settlement report names it explicitly (`reserve held`, `reserverat belopp`); the balance sheet must show it.

---

## 11. Marketplace sales (Amazon, Etsy, Shopify + provider)

Keep this shallow and hand off. **ML 5 kap 4-6 §§** define an *elektroniskt gränssnitt* (marknadsplats, plattform, portal) and the **deemed-supplier** rules: the platform is treated as having itself acquired and supplied the goods for (a) distance sales of goods imported from outside the EU in consignments of at most **150 euro** (5 kap 5 §), and (b) supplies within the EU by a non-EU-established seller to a non-taxable person (5 kap 6 §).

For a **Swedish established seller selling from Sweden**, the deemed-supplier rules in 5 kap 5-6 §§ do **not** normally bite. The practical booking is then the ordinary §4 pattern:

1. Gross sale to the end customer → revenue + output VAT per the place-of-supply rules (`swedish-vat`; for B2C cross-border, OSS).
2. Receivable on the platform → **1686**.
3. Platform **commission** → taxable service, **reverse charge** for an EU platform (ruta 21 + 30 + 48), **not** exempt (§6, §7).
4. Fulfilment, storage and shipping fees → taxable services, same treatment.
5. Payout → clears 1686.

The trap: a marketplace statement shows one net figure. Revenue must still be the gross end-customer price, and the commission is a separate taxable purchase with a reverse charge: the opposite answer from an acquiring fee.

> **If the seller is not established in Sweden, or goods are shipped from a warehouse outside Sweden, or the platform states it has accounted for the VAT: stop and route to `swedish-vat`.** Do not resolve deemed-supplier questions from this file.

---

## 12. Currency: payouts in EUR/USD

**Which rate (VAT).** **ML 8 kap 21 §**: amounts in another currency are converted using either (1) the latest average rate fixed on the most representative currency market in Sweden at the time of the beskattningsgrundande händelse, or (2) the latest rate published by the ECB at that time. **8 kap 22 §**: conversions between two non-euro currencies under alternative 2 go via each currency's euro rate. Pick one method and apply it consistently.

**Which rate (bookkeeping).** Transaction-date rate on recognition; **ÅRL 4 kap 13 §** permits (and practice requires) monetary receivables and payables in foreign currency to be translated at balansdagens kurs. Under K3 this is **BFNAR 2012:1 kap. 30**; under K2, **BFNAR 2016:10**.

**Where the difference goes.**

| Item | Nature | Account |
|---|---|---|
| Provider balance on **1686** arising from sales | Fordran av **rörelsekaraktär** | **3960** Valutakursvinster på fordringar och skulder av rörelsekaraktär / **7960** Valutakursförluster på fordringar och skulder av rörelsekaraktär |
| Kundfordringar (1510), leverantörsskulder (2440) | Rörelsekaraktär | 3960 / 7960 |
| **1980 Valutakonton** and other financial short-term receivables/placements | Financial | **8330** Valutakursdifferenser på kortfristiga fordringar och placeringar (8331 vinst / 8336 förlust) |
| Loans and other liabilities of a financial nature | Financial | **8430** Valutakursdifferenser på skulder (8431 vinst / 8436 förlust) |

**Verified for BAS 2026:** 3960 and 7960 are single accounts for rörelsefordringar/-skulder; 8330 and 8430 are the finansiella-poster accounts with the vinst/förlust split in the subaccounts above. The provider receivable belongs to the operating cycle, so **3960/7960**, matching the treatment of kundfordringar already used by `swedish-invoice-compliance`.

**Worked fragment.** Sale 1 000 EUR on 10 Sept at 11,30 → 1686 debited 11 300, revenue 9 040 + moms 2 260 (VAT converted at the 10 Sept rate per ML 8 kap 21 §). Payout 15 Sept at 11,42, net of a 25 EUR fee:

| Konto | Debet | Kredit |
|---|---|---|
| 1930 (975 EUR × 11,42) | 11 134,50 | |
| 6570 (25 EUR × 11,42) | 285,50 | |
| 1686 | | 11 300,00 |
| 3960 Valutakursvinster | | 120,00 |

The VAT base stays at the 10 Sept rate. A later FX movement never changes utgående moms.

---

## 13. Dricks (tips) through a card terminal or Swish

This is the easiest item on this page to get wrong. Two separate questions: VAT, and whether it is lön.

### VAT: no

A voluntary tip is not *ersättning för varan eller tjänsten* under **ML 8 kap 3 §**: the customer decides freely whether and how much to give, so the amount is not consideration for the restaurant's supply and falls outside the beskattningsunderlag. Skatteverket states the same in its rättsliga vägledning *Moms på drickspengar*. **No output VAT on dricks**, regardless of whether it arrives as cash, on the card terminal or by Swish.

Consequence: when the terminal settles 1 000 SEK of which 80 is dricks, the beskattningsunderlag is computed on **920**, not 1 000.

### Income tax and arbetsgivaravgifter: depends on who handles the money

Skatteverket's stated position:

- **Staff handle and share the tips themselves, without the employer being involved** → the recipient reports it in their own inkomstdeklaration. No skatteavdrag, no arbetsgivaravgifter for the employer.
- **The employer receives the tips and distributes them** → the payment is treated as coming from the employer, i.e. **lön**: skatteavdrag and arbetsgivaravgifter apply, and it is reported in AGI.
- The payment method is irrelevant: "Det spelar ingen roll om dricksen lämnas kontant eller genom ett extra belopp vid betalning med kontokort eller på annat elektroniskt sätt, till exempel med Swish."

Card and Swish tips arrive inside the acquirer's payout, i.e. through the company's account. That does not by itself make them the company's revenue, but it does put the employer in the distribution chain, which is what triggers the lön treatment when the employer then pays them out.

### Booking

Default (pass-through, employer distributes as lön):

| Step | Konto | Debet | Kredit |
|---|---|---|---|
| Day's takings incl. 80 dricks | 1686 | 1 000,00 | |
| | 3002 Försäljning 12 % | | 821,43 |
| | 2621 Utgående moms 12 % | | 98,57 |
| | 2820/2829 Kortfristiga skulder till anställda (or 2830 Avräkning för annans räkning) | | 80,00 |
| Payout to staff via lön | 2820/2829, then normal payroll accounts | 80,00 | |

Arbetsgivaravgifter, skatteavdrag and AGI reporting on the distributed amount: **`swedish-payroll`**.

> **Osäkert:** whether tips received via a card terminal are an **intäkt** of the company (revenue + salary cost) or a pure **skuld** (the entry above). Skatteverket has litigated this; in **KRNG mål nr 548-20, 550-20 och 551-20** the kammarrätt found that Skatteverket had not shown the tips were the company's income, despite deficiencies in the bookkeeping. Skatteverket's own rättsliga vägledning pages on dricks (*Moms på drickspengar*; *Frågor om redovisning och beskattning av dricks*; ställningstagande dnr 131 184388-16/111) block automated retrieval and were not read directly for this file: the summaries above come from skatteverket.se's public pages. **Book the liability route by default and ask the user before switching to the intäkt route.**

---

## 14. Ask-the-user rules (consolidated)

Do not guess. Ask when:

1. You cannot obtain a settlement report splitting gross sales, refunds, fees and reserves for the payout period.
2. You cannot tell whether the provider pays out gross or net.
3. A fee invoice bundles exempt acquiring with taxable software or hardware and the amounts are material.
4. A provider charges Swedish VAT on something you believe is exempt (confirm the nature of the service first).
5. The 1686 residual at period end cannot be tied to identified transactions.
6. Business income arrived in a private Swish or private bank account.
7. Tips arrive through the terminal and you do not know whether the employer distributes them.
8. The seller is not Swedish-established, or goods ship from outside Sweden, on a marketplace sale.
9. The provider withheld an amount you cannot classify as fee, refund, chargeback or reserve.

---

## 15. Sources

- **Mervärdesskattelag (2023:200)**: 2 kap 12 §; 5 kap 4-6 §§; 7 kap 4 §, 49-50 §§; 8 kap 2-3 §§, 21-23 §§; 10 kap 33 §; 13 kap 4 §; 16 kap 3 §, 9 §; 17 kap 22 §
- **Årsredovisningslag (1995:1554)**: 2 kap 4 § första stycket 6 (kvittningsförbud); 4 kap 13 § (omräkning av fordringar och skulder)
- **Bokföringslag (1999:1078)**: 5 kap 2 § (bokföringstidpunkt), 4 § (sidoordnad bokföring), 6 § (verifikation, gemensam verifikation)
- **Skatteförfarandelag (2011:1244)**: 39 kap 4-5 §§ (kassaregister)
- **Skatteverket**: *Fylla i momsdeklarationen* (ruta 21/22/24 conditions); *Betaltjänster och förmedling av sådana tjänster*, rättslig vägledning; *Tänk på att redovisa dricks om inte arbetsgivaren gjort det* (2024); *Moms på drickspengar*, rättslig vägledning
- **BAS 2026 kontoplan** (bas.se, `BAS_kontoplan_2026_v2.xlsx`) and **Kontoplansförändringar 2026**: 1580 removed, 1686 added; 7833-7835 removed, 7830 renamed; class 4 restructured to separate Handelsvaror from Råvaror och förnödenheter
- **BFN**: BFNAR 2012:1 (K3) kap. 30; BFNAR 2016:10 (K2)
- Provider documentation used only to describe settlement mechanics, never for a tax or accounting conclusion
