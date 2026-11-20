# VAT (moms) on business travel

How Swedish VAT applies to travel costs, what may be deducted, and what to do with foreign VAT. General VAT mechanics and momsdeklaration rutor are in `swedish-vat`.

## Contents

1. Rates and deduction by cost type
2. Receipt requirements
3. Schablon allowances carry no VAT
4. Hyrbil, fuel and förmånsbil
5. Foreign VAT and refunds
6. Representation and meals on a trip
7. Points not verified

## 1. Rates and deduction by cost type

Source: Skatteverket, *Momssatser och undantag från moms* and *Bilar och moms*.

| Cost | Swedish rate | Deduction for a VAT-registered business |
|---|---|---|
| Hotel room, incl. closely linked services (breakfast in the room price, parking, laundry) | 12 % | Full, if a business trip |
| Conference package | 25 % (delegates' lodging and hotel breakfast 12 %) | Full, if a business trip |
| Domestic train, flight, bus, taxi | 6 % | Full |
| International passenger transport | No Swedish VAT | - |
| Restaurant meal (servering) | 12 % | Personal meal on a trip: private cost (covered by traktamente); see section 6 |
| Food and takeaway | 6 % from 2026-04-01 to 2027-12-31 | As above |
| Alcohol | 25 % | Only within representation limits |
| Hyrbil or leased personbil | 25 % | **50 %** of the VAT |
| Fuel for a company vehicle | 25 % | Deductible as a running cost |
| Foreign VAT on any of the above | - | **Never** in the Swedish momsdeklaration |

Airline taxes and airport charges on a ticket are not VAT; do not book them to **2641**. Swedish flygskatt ended 2025-07-01, so 2026 tickets carry none.

## 2. Receipt requirements

- A **förenklad faktura** (simplified receipt) gives VAT deduction up to **4 000 kr including VAT**. It must show date, seller's VAT or organisation number, what was sold, and the VAT amount or what is needed to calculate it.
- Train and bus tickets may be simplified invoices whatever the amount.
- Above 4 000 kr: a full invoice naming the buyer (the company). Have hotels invoice the company directly.
- Missing details can remove the right to deduct input VAT. An egen verifikation never gives VAT deduction.
- Invoice field rules in depth: `swedish-invoice-compliance`.

## 3. Schablon allowances carry no VAT

Traktamente and milersättning paid at schablon are cost reimbursements, not purchases. There is no input VAT to deduct on them.

## 4. Hyrbil, fuel and förmånsbil

- Short-term hire of a personbil on a business trip: deduct 50 % of the VAT on the rent; the other 50 % goes to the cost account (**5820**).
- Fuel bought separately for the hired car: running cost, full VAT deduction (**5611** or **5820** per the company's policy).
- Fuel billed on the rental invoice itself: secondary sources disagree. Treat conservatively (50 %) unless the invoice clearly separates fuel as a running cost.
- If full VAT was deducted on purchase or lease of a personbil (special cases only), output VAT is charged on 20 % of the bilförmån value. See `swedish-vat`.

## 5. Foreign VAT and refunds

- Foreign VAT is never reported in the Swedish momsdeklaration.
- **EU countries:** apply through Skatteverket's e-service *Momsåterbetalning inom EU* by **30 September of the year after** the calendar year concerned. Late applications cannot be completed. The company must have been VAT-registered in Sweden during the period, and must have notified Skatteverket (SKV 4852) to use the e-service.
- Minimum refund: 50 euro for a calendar year (or the rest of one), 400 euro for a period of at least three months but under a calendar year.
- **Non-EU countries:** each country's own procedure, often needing a certificate from Skatteverket.
- Booking: either include the foreign VAT in **5832**, or book the reclaimable VAT to **1689** and clear it when refunded. Show non-recoverable foreign VAT separately on **6998** Utländsk moms if the company wants it visible.
- Whether a refund is worth applying for depends on amounts and the country's deduction rules (many countries also restrict VAT on hotels and meals). Decide per country.

## 6. Representation and meals on a trip

Income-tax deduction 2026 (excl. VAT):

| Event | Extern | Intern |
|---|---|---|
| Frukost, lunch, middag | 0 kr | 0 kr |
| Enklare förtäring | 60 kr/person | 60 kr/person |
| Golf, theatre etc. | 180 kr/person | 180 kr/person |
| Kringkostnader at personalfest | - | 180 kr/person |

- VAT on representation meals: deduct VAT on a basis of at most **300 kr excl. VAT per person and occasion**, even though the meal is not income-tax deductible. With food and alcohol mixed, the schablon allows **46 kr VAT per person** when the cost exceeds 300 kr excl. VAT and at least 46 kr VAT was charged.
- Intern representation: no more than two personalfester per year (SKV A 2017:26).
- Accounts: **6071** / **6072** extern, **7631** / **7632** intern.
- A meal the employee eats alone on a trip is a private living cost covered by traktamente. If the company pays it, it is a kostförmån and the traktamente is reduced. A genuine representation meal is not a benefit but still reduces the traktamente.

## 7. Points not verified

Not confirmed in a primary source for 2026. Check Skatteverket's rättslig vägledning before relying on them:

- Whether the company may deduct VAT on the fuel portion of milersättning paid for an employee's private car when fuel receipts are attached.
- Uttagsmoms on employer-paid fuel used privately in a förmånsbil.
