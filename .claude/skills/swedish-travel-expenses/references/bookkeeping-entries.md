# Bookkeeping and AGI reporting for travel

BAS 2026 accounts, worked journal entries and how travel lands in the arbetsgivardeklaration (AGI). Amounts follow `tax-rules.md`; VAT treatment follows `vat-on-travel.md`. Tax withholding in the examples assumes 30 % for simplicity; use the employee's skattetabell.

## Contents

1. Accounts
2. A: Employee utlägg with receipts
3. B: Domestic traktamente above schablon
4. C: Utlandstraktamente within schablon
5. D: Milersättning above schablon
6. E: Receipt in foreign currency
7. F: Företagskort
8. G: Travel-agency invoice
9. H: Hyrbil in Sweden
10. Reseförskott
11. AGI reporting

## 1. Accounts

| Account | Use |
|---|---|
| **1611** | Reseförskott (travel advance to employee) |
| **1689** | Övriga kortfristiga fordringar (foreign VAT to reclaim) |
| **2641** | Debiterad ingående moms |
| **2710** | Personalskatt |
| **2731** | Avräkning lagstadgade sociala avgifter |
| **2821** | Löneskulder (traktamente and milersättning through payroll) |
| **2822** | Reseräkningar (employee utlägg to repay) |
| **2890** | Övriga kortfristiga skulder (company card liability, if no dedicated account) |
| **5611** | Drivmedel för personbilar |
| **5616** | Trängselskatt personbilar (company cars) |
| **5810** | Biljetter |
| **5820** | Hyrbilskostnader |
| **5831** | Kost och logi i Sverige |
| **5832** | Kost och logi i utlandet |
| **5890** | Övriga resekostnader (taxi, parking, fees, per policy) |
| **6071** / **6072** | Representation, avdragsgill / ej avdragsgill |
| **7631** / **7632** | Personalrepresentation, avdragsgill / ej avdragsgill |
| **7321** / **7322** | Traktamenten Sverige, skattefria / skattepliktiga |
| **7323** / **7324** | Traktamenten utlandet, skattefria / skattepliktiga |
| **7331** / **7332** | Bilersättningar, skattefria / skattepliktiga |
| **7333** | Ersättning för trängselskatt, skattefri |
| **7382** | Kostnader för fria eller subventionerade måltider |
| **7391** | Kostnad för trängselskatteförmån |
| **7515** | Arbetsgivaravgifter på skattepliktiga kostnadsersättningar |
| **6998** | Utländsk moms |
| **3960** / **7960** | Valutakursvinster / -förluster av rörelsekaraktär |

**7381** is Kostnader för fri bostad, not a travel account; use it only when the employer provides housing.

Keep tax-free and taxable parts on separate accounts. Then the AGI crosses, ruta 011 and **7515** reconcile directly against the ledger.

## 2. A: Employee utlägg with receipts

Hotel in Göteborg 1 344 kr incl. 12 % VAT; train 530 kr incl. 6 % VAT. Employee paid privately.

| Account | Debit | Credit |
|---|---|---|
| **5831** Kost och logi i Sverige | 1 200 | |
| **5810** Biljetter | 500 | |
| **2641** Ingående moms (144 + 30) | 174 | |
| **2822** Reseräkningar | | 1 874 |

On payment: debit **2822**, credit **1930**. Not reported in AGI.

## 3. B: Domestic traktamente above schablon

Three heldagar (out Monday 07:00, back Wednesday 20:00). A customer provides lunch on Tuesday, so reduce by 105 kr. Policy pays 300 kr/day without reduction: 900 kr paid.

- Tax-free: 900 − 105 = 795 kr. Taxable: 105 kr.
- Tax 30 % of 105 = 32 kr. Arbetsgivaravgifter 105 × 31,42 % = 33 kr.

| Account | Debit | Credit |
|---|---|---|
| **7321** Skattefria traktamenten, Sverige | 795 | |
| **7322** Skattepliktiga traktamenten, Sverige | 105 | |
| **2710** Personalskatt | | 32 |
| **2821** Löneskulder (net payable) | | 868 |
| **7515** Arbetsgivaravgifter på skattepliktiga kostnadsersättningar | 33 | |
| **2731** Avräkning lagstadgade sociala avgifter | | 33 |

AGI: cross in ruta 051, and 105 kr in ruta 011.

## 4. C: Utlandstraktamente within schablon

The Germany trip in `tax-rules.md` section 3: 2 052 kr.

| Account | Debit | Credit |
|---|---|---|
| **7323** Skattefria traktamenten, utlandet | 2 052 | |
| **2821** Löneskulder | | 2 052 |

AGI: cross in ruta 051 only.

## 5. D: Milersättning above schablon

42 mil in own car, policy rate 30 kr/mil = 1 260 kr. Tax-free 42 × 25 = 1 050 kr. Taxable 210 kr. Tax 63 kr. Avgifter 66 kr.

| Account | Debit | Credit |
|---|---|---|
| **7331** Skattefria bilersättningar | 1 050 | |
| **7332** Skattepliktiga bilersättningar | 210 | |
| **2710** Personalskatt | | 63 |
| **2821** Löneskulder | | 1 197 |
| **7515** Arbetsgivaravgifter | 66 | |
| **2731** | | 66 |

AGI: cross in ruta 050, and 210 kr in ruta 011.

## 6. E: Receipt in foreign currency

Hotel in Berlin, EUR 300 including German VAT, paid privately by the employee.

- Convert at the **avistakurs on the transaction date** (BFNAR 2013:2 punkt 2.4), for example Riksbanken's daily rate or the ECB reference rate.
- An approximation (average or standard rate for a period) is allowed if it does not deviate too much and the currency is not moving sharply (punkt 2.5). Kontantmetod companies may use the payment rate (punkt 2.6). A cash purchase close to a currency withdrawal may use the withdrawal rate.
- BFN does not address card-statement rates specifically; using them must fit punkt 2.5 or 2.6.

At 11,00 SEK/EUR = 3 300 kr: debit **5832** 3 300, credit **2822** 3 300.

To reclaim the German VAT through the EU refund, book the VAT part to **1689** instead of **5832**, and take any shortfall to **6998** later. Differences between the booked rate and the settlement rate of a company card go to **3960** / **7960**.

## 7. F: Företagskort

Company card with company liability. Taxi 318 kr incl. 6 % VAT.

| Account | Debit | Credit |
|---|---|---|
| **5890** Övriga resekostnader (or **5810** per policy) | 300 | |
| **2641** | 18 | |
| **2890** Card liability | | 318 |

When the card invoice is paid: debit **2890**, credit **1930**.

The card invoice cannot replace the receipts: each purchase needs its own underlag. Transactions may be booked in summary (BFNAR 2013:2 punkt 2.10), but the receipts must still be there.

## 8. G: Travel-agency invoice

Domestic flight 2 000 kr incl. 6 % VAT, international flight 4 500 kr with no Swedish VAT, service fee 250 kr + 25 % VAT.

| Account | Debit | Credit |
|---|---|---|
| **5810** Biljetter (1 886,79 + 4 500) | 6 386,79 | |
| **5890** Övriga resekostnader (service fee) | 250,00 | |
| **2641** Ingående moms (113,21 + 62,50) | 175,71 | |
| **2440** Leverantörsskulder | | 6 812,50 |

Check that the invoice shows VAT per component. Taxes and airport fees carry no VAT.

## 9. H: Hyrbil in Sweden

Rent 3 000 kr + 750 kr VAT.

| Account | Debit | Credit |
|---|---|---|
| **5820** Hyrbilskostnader (3 000 + 375 non-deductible) | 3 375 | |
| **2641** (50 % of 750) | 375 | |
| **2440** or **1930** | | 3 750 |

Fuel bought separately: debit **5611** (or **5820**) net, debit **2641** full VAT, credit **1930**.

## 10. Reseförskott

Advance paid: debit **1611**, credit **1930**. When the reseräkning is settled, book the costs and allowances as above and credit **1611** for the advance; repay or collect the difference through **2822** / **2821**.

## 11. AGI reporting

| What | AGI |
|---|---|
| Tax-free bilersättning (incl. förmånsbil where employee pays fuel) | Cross only, ruta 050 |
| Tax-free traktamente, domestic or foreign | Cross only, ruta 051 |
| Excess over schablon | Cash salary, ruta 011, with tax and avgifter on the excess |
| Bilförmån | Ruta 013 |
| Other taxable kostnadsersättningar (not car or traktamente) | Ruta 020 |
| Tax-free reimbursement of actual costs against receipts (tickets, hotel) | Not reported |

Skatteverket: bil- och traktamentsersättningar up to the tax-free schablon are reported only with a cross in ruta 050 and 051 respectively. Other field codes, such as the tjänsteställe fields, are in `swedish-payroll` (`references/agi-filing.md`).
