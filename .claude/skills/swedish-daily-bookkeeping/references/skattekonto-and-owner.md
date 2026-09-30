# Skattekontot och pengar mellan företaget och ägaren

Two of the highest-error bank lines in Swedish day-to-day bookkeeping: the lump payment to Skatteverket, and money moving between the company and the person who owns it. Both look like one simple transfer on the bank statement and are almost never one simple transaction in the ledger.

All account numbers below are verified against **BAS 2026** (the full chart; see §3.2 for the K1 exception). Law is cited inline.

Route elsewhere for: moms mechanics and rutor → `swedish-vat`; AGI, skattetabeller and förmånsvärdering → `swedish-payroll`; bokslut netting of 2510/2518/2512 → `swedish-year-end-closing`; lön-vs-utdelning optimisation for AB → `swedish-tax-planning`; räntefördelning/expansionsfond for EF → `swedish-ef-skatteplanering`.

---

<!-- toc -->
**Contents**

- [1. Skattekontot](#1-skattekontot)
- [2. Money between the company and its owner](#2-money-between-the-company-and-its-owner)
- [3. Notes on account numbers](#3-notes-on-account-numbers)
- [4. Law index](#4-law-index)

<!-- /toc -->

## 1. Skattekontot

### 1.1 One bank payment, several liabilities

A payment to Skatteverket is **not** earmarked. Per **SFL 62 kap. 11 §**, inbetalda och andra tillgodoräknade belopp are set off against the payer's *sammanlagda skatteskuld*: first the part not sent for indrivning, then the part that has been. The payer cannot direct a payment at a specific liability (the only exceptions, SFL 62 kap. 12-13 §§, concern paying someone else's tax under a 59 kap. or 5 kap. ansvarsbeslut).

Payment timing follows **SFL 62 kap. 2 §**: the tax is paid the day the payment is *bokförd* on Skatteverket's särskilda konto: not the day it left the company's bank.

So a bank line reading `SKATTEVERKET -142 350` corresponds to no single ledger liability. Booking it straight to 2710, or splitting it by guess across 2710/2731/2650, is a guess about an allocation Skatteverket made by its own rule. When the guess is wrong, the liability accounts carry a permanent residue nobody can explain, and the skattekonto is never reconcilable.

**The rule: the bank line only ever touches 1630.** Liabilities are cleared from the *skattekontoutdrag*, not from the bank.

```
Bank payment to Skatteverket
Debit  1630  Avräkning för skatter och avgifter (skattekonto)
Credit 1930  Företagskonto
```

That entry is always correct, needs no information beyond the bank statement, and can be made the moment the line lands. Everything else waits for the kontoutdrag.

### 1.2 The two BAS accounts

| Account | BAS 2026 name | Use |
|---|---|---|
| **1630** | Avräkning för skatter och avgifter (skattekonto) | The running account. Debit balance = överskott (a receivable on Skatteverket). |
| **2850** | Avräkning för skatter och avgifter (skattekonto) | Same function on the liability side. Use at bokslut if 1630 has a credit balance (underskott), so the balance sheet does not show a negative asset. |
| **2852** | Anståndsbelopp för moms, arbetsgivaravgifter och personalskatt | Amounts under a granted anstånd, split out from the skattekonto balance. |
| **1640** | Skattefordringar | Assessed tax receivable, separate from the running skattekonto. |
| **1650** | Momsfordran | Överskjutande ingående moms at bokslut, if not yet credited. |

Run 1630 all year regardless of sign; reclassify to 2850 only in the bokslut.

### 1.3 What lands on the skattekonto, and which account each entry clears

**SFL 61 kap. 1 §**: Skatteverket registers on the skattekonto (1) skatter och avgifter som ska betalas eller tillgodoräknas, (2) belopp som ska dras ifrån eller läggas till slutlig skatt enligt 56 kap. 9 §, and (3) inbetalningar och utbetalningar. Registration timing: **SFL 61 kap. 2 §**: amounts to be paid are registered on the förfallodag; amounts to be credited as soon as there is underlag.

Book each skattekonto line in the month Skatteverket registered it, using the kontoutdrag as underlag. A verifikation is required for each affärshändelse (BFL 5 kap.); the kontoutdrag is that underlag.

| On the skattekontoutdrag | Ledger account it clears | Entry |
|---|---|---|
| Avdragen personalskatt per AGI | **2710** Personalskatt | D 2710 / K 1630 |
| Arbetsgivaravgifter per AGI | **2731** Avräkning lagstadgade sociala avgifter | D 2731 / K 1630 |
| Särskild löneskatt reported in AGI | **2732** Avräkning särskild löneskatt | D 2732 / K 1630 |
| Moms att betala per momsdeklaration | **2650** Redovisningskonto för moms | D 2650 / K 1630 |
| Överskjutande ingående moms (moms att få tillbaka) | **2650** | D 1630 / K 2650 |
| Debiterad preliminärskatt (F-skatt), **AB** | **2518** Betald F-skatt (under 2510 Skatteskulder) | D 2518 / K 1630 |
| Debiterad preliminärskatt, **enskild firma** | **2013** Övriga egna uttag: see §1.8 | D 2013 / K 1630 |
| Särskild löneskatt på pensionskostnader, debiterad via slutlig skatt | **2514** Beräknad särskild löneskatt på pensionskostnader | D 2514 / K 1630 |
| Slutlig skatt, AB | **2512** Beräknad inkomstskatt | see §1.4 |
| Kvarskatt (slutlig skatt exceeds preliminär) | **2512** | D 2512 / K 1630 |
| Tillgodoförd/överskjutande slutlig skatt | **2512** | D 1630 / K 2512 |
| Kostnadsränta | **8423** Räntekostnader för skatter och avgifter | D 8423 / K 1630 |
| Intäktsränta | **8314** Skattefria ränteintäkter | D 1630 / K 8314 |
| Inbetalning from the company's bank | **1930** | D 1630 / K 1930 |
| Utbetalning from skattekontot to the bank | **1930** | D 1930 / K 1630 |

The moms figure that reaches 1630 is the *netted* one. Within the period, output VAT sits on 2611/2621/2631 etc. and input VAT on 2641; at period end they are netted into **2650**, and only 2650 meets 1630. See `swedish-vat` for the rutor.

Salary is the other chain: `D 7210/7220 / K 1930 + K 2710` for the lön, `D 7510/7511 / K 2731` for the avgifter, then the two 27xx accounts are cleared against 1630 when the AGI amounts hit the skattekonto on the 12th (17th in January and August: **SFL 62 kap. 3 §**; the 26th for employers with beskattningsunderlag over 40 MSEK).

### 1.4 F-skatt and slutlig skatt in an AB

Debiterad preliminärskatt is paid in equal monthly amounts, the 12th (17th in January and August), from the second month of the beskattningsår through the month after it ends (**SFL 62 kap. 4 §**).

```
Each month, when the skattekonto is charged with F-skatt:
Debit  2518  Betald F-skatt
Credit 1630

At bokslut, the computed corporate tax:
Debit  8910  Skatt som belastar årets resultat
Credit 2512  Beräknad inkomstskatt

When the slutskattebesked is registered the following year:
Debit  2512  Beräknad inkomstskatt
Credit 2518  Betald F-skatt          (net the preliminary against the final)

Remaining kvarskatt, when charged to the skattekonto:
Debit  2512
Credit 1630

Difference between the accrued 2512 and the assessed tax:
Debit/Credit 8920  Skatt på grund av ändrad beskattning
```

2518 must be zero after the netting. A 2518 balance that survives a bokslut means a year's preliminary tax was never matched to an assessment.

### 1.5 Ränta på skattekontot

Interest is calculated daily on the skattekonto balance and påförs eller tillgodoräknas **each month** (**SFL 65 kap. 2 §**). Kostnadsränta when the account is in underskott, intäktsränta when in överskott.

| | Basis | Law |
|---|---|---|
| Basränta | 125 % of the räntesats for six-month statsskuldväxlar, floor 1.25 % | SFL 65 kap. 3 § |
| Låg kostnadsränta | = basräntan | SFL 65 kap. 4 § 1 st |
| Hög kostnadsränta (late payment) | basräntan + 15 procentenheter | SFL 65 kap. 13 § |
| Skönsbeskattning | basräntan + 15 procentenheter | SFL 65 kap. 11 § |
| Intäktsränta | 45 % of basräntan (0 if basräntan is at the 1.25 % floor) | SFL 65 kap. 4 § 3 st |

There is a räntefri zon: on debiterad preliminärskatt or slutlig skatt due the 12th of the second month after the beskattningsår or later, no kostnadsränta accrues from the 13th of that second month through the 3rd of the fifth month on amounts up to **30 000 kr** (SFL 65 kap. 4 § 2 st).

Tax treatment: both directions are outside the income tax base, which is why they get their own accounts:

- **Kostnadsränta is not deductible.** **IL 9 kap. 8 §**: "Räntor på skatt, tull eller avgift enligt följande bestämmelser får inte dras av: …: 65 kap. 2 §, 4 § första stycket, 5-13 och 19 §§ skatteförfarandelagen (2011:1244)." Book it to **8423** and add it back as a skattemässig justering in INK2S; never net it against deductible interest on 8410/8420.
- **Intäktsränta is tax-free.** **IL 8 kap. 7 §**: räntor på återbetald skatt enligt 65 kap. 2 §, 4 § tredje stycket samt 16, 17 och 20 §§ SFL är skattefria. Book it to **8314 Skattefria ränteintäkter** and deduct it in the tax computation.

Osäkert: the current basränta. Skatteverket's published rate table last showed basränta 2.5 % / intäktsränta 1.125 % / låg kostnadsränta 2.5 % / hög kostnadsränta 17.5 % from 2024-12-01. Whether a later change has been published as of September 2026 is not confirmed here: read the rate off the kontoutdrag rather than computing it.

### 1.6 Utbetalning from the skattekonto

**SFL 64 kap. 2 §**: on an avstämning showing överskott, the amount is repaid if (1) the kontohavare asks for it, (2) the överskott rests on a slutskatteberäkning per 56 kap. 9 §, a decision on överskjutande ingående moms or punktskatt, or an omprövnings-/domstolsbeslut, or (3) the holder is a kommun or region. An *automatic* repayment under (2) is made only if the amount is at least **2 000 kr** or the payment can go to a registered bank account.

```
Money arrives from Skatteverket:
Debit  1930  Företagskonto
Credit 1630  Skattekonto
```

That is the whole entry. The incoming bank line is never revenue, never a moms refund in itself, and never touches 2650: the moms decision was already booked when it was *registered* on the skattekonto (§1.3); this line only moves the resulting överskott to the bank.

Note SFL 64 kap. 3 §: överskjutande ingående moms redovisad early is repaid only once all arbetsgivar-, moms- and punktskattedeklarationer due that month have been filed. A refund that "should have come" and did not usually means a missing declaration, not an error in the ledger.

### 1.7 The monthly routine

Skatteverket stämmer av skattekontot **every month** in which anything other than interest was registered (**SFL 61 kap. 7 §**). Match that rhythm.

1. Fetch the skattekontoutdrag for the month.
2. Book every line on it against 1630 per the table in §1.3.
3. Compare the closing balance on 1630 with the saldo on the kontoutdrag. They must be equal.

**A difference is a symptom, not a rounding issue.** Ranked by frequency:

| Difference | Usual cause | Fix |
|---|---|---|
| Ledger 1630 too high by exactly one month's AGI | The 2710/2731 clearing was not booked | Book D 2710 + D 2731 / K 1630 from the utdrag |
| Ledger 1630 too high by a small odd amount | Kostnadsränta not booked | D 8423 / K 1630 |
| Ledger 1630 too low by a small odd amount | Intäktsränta not booked | D 1630 / K 8314 |
| Difference equals a payment amount | Payment booked in a different month than Skatteverket registered it, or booked straight from bank to 2710/2650 | Move the payment to 1630; date it per SFL 62 kap. 2 § (the day it was bokförd at Skatteverket) |
| Difference appears and never clears | Something registered by Skatteverket that never reached the ledger: a korrigering, a beslut om skönsbeskattning, a granted anstånd, a växa-stöd återbetalning credited to the account | Read the utdrag line by line; book what is there |
| 2710 or 2731 carries a residue after the clearing | The payment was split across liabilities by guess instead of cleared from the utdrag | See §1.1 |

Sign check: a debit balance on 1630 is an överskott and belongs among the assets. A persistent credit balance is an underskott: move it to **2850** at bokslut.

### 1.8 Enskild firma: debiterad preliminärskatt is *not* a company cost

An enskild näringsidkare and the firm are the same legal and tax person. The debiterad preliminärskatt on the skattekonto covers the owner's *private* inkomstskatt and egenavgifter on the business surplus. It is never a cost of the business, never a skatteskuld of the business, and never touches 2510/2512/2518.

It is an **eget uttag**: the firm's money paying the owner's tax.

```
Skattekonto charged with debiterad preliminärskatt (EF):
Debit  2013  Övriga egna uttag
Credit 1630  Skattekonto
```

Same treatment for kvarskatt on the slutskattebesked. A tillgodoförd/överskjutande skatt left on the skattekonto is the mirror image:

```
Debit  1630
Credit 2018  Övriga egna insättningar
```

Everything else on an EF skattekonto: personalskatt (2710), arbetsgivaravgifter (2731), moms (2650), is the *firm's* liability and clears exactly as in §1.3. Only the preliminär-/slutskatt part is private.

If the owner instead pays the preliminärskatt from a private account, nothing is booked in the firm at all.

### 1.9 If you cannot tell: ask

| Situation | Ask |
|---|---|
| Bank line to Skatteverket, no kontoutdrag loaded | Nothing: book D 1630 / K 1930 and clear liabilities later. Do **not** guess the split. |
| A skattekonto charge you cannot identify on the utdrag | Ask the user for the full skattekontoutdrag for that month. Never post the residual to 2710 or 8423 to make it balance. |
| Entity type unknown and a preliminärskatt charge appears | Ask whether the company is an AB or an enskild firma: the same line is **2518** in one and **2013** in the other. |
| Money in from Skatteverket, and you cannot tell if it is a moms refund, an överskott payout or a växa-stöd credit | Book D 1930 / K 1630 (correct in all three cases) and ask for the utdrag before touching any other account. |
| 1630 will not reconcile after the routine in §1.7 | Ask for the utdrag rather than posting a differenspost. A skattekonto difference is always explainable from the utdrag. |

---

## 2. Money between the company and its owner

### 2.1 Router

| Entity | Owner's money movements live in | Can the company lend to the owner? |
|---|---|---|
| Enskild firma | Eget kapital, **2010-2019** (per delägare: 2020/2030/2040-series) | Not a question: same legal person |
| Handelsbolag / kommanditbolag | Eget kapital per delägare, **2010/2020/2030/2040**-series | Uttag allowed; ABL's låneförbud does not apply |
| Aktiebolag | Owner → company: **2893** / **2393**. Company → owner: lön, utdelning, or a **förbjudet lån** | **No**: ABL 21 kap. 1 § |

### 2.2 Enskild firma

| Account | BAS 2026 name | Use |
|---|---|---|
| **2010** | Eget kapital | The owner's capital; sub-accounts are consolidated into it at the start of each year |
| **2011** | Egna varuuttag | Goods taken for private use (uttagsbeskattning: see `swedish-vat`) |
| **2013** | Övriga egna uttag | Cash draws, private expenses paid by the firm, the owner's preliminärskatt |
| **2017** | Årets kapitaltillskott | Capital contributed |
| **2018** | Övriga egna insättningar | Money and privately paid business expenses put in |
| **2019** | Årets resultat, delägare 1 | Result for the year |

Entries:

```
Cash draw to the owner's private account
Debit  2013  Övriga egna uttag
Credit 1930  Företagskonto

Owner puts money in
Debit  1930  Företagskonto
Credit 2018  Övriga egna insättningar

Private expense paid from the company account (groceries, private travel)
Debit  2013  Övriga egna uttag     (full amount, incl. VAT)
Credit 1930  Företagskonto
-- no cost account, no ingående moms: it is not the firm's expense

Business expense paid privately (owner's own card)
Debit  5xxx/6xxx  Cost account
Debit  2641       Debiterad ingående moms
Credit 2018       Övriga egna insättningar
```

**Why 2010-2019 never reaches the P&L.** The owner is not a party the firm can transact with: a draw is not a cost and a deposit is not income. The owner is taxed on the firm's *surplus*, in full, regardless of how much was drawn; the draws themselves are tax-neutral. Putting a draw on a 7xxx account inflates the deduction and understates the taxable surplus. On the NE-bilaga the whole 20xx block collapses into **B10**.

At the start of the next financial year all sub-accounts are zeroed into 2010, and 2019 opens fresh.

### 2.3 Aktiebolag: the owner's current account and låneförbudet

An AB is a separate legal person. Money flows in both directions have different legal characters and only one direction is free.

**Owner lends to the company: allowed.**

| Account | BAS 2026 name |
|---|---|
| **2893** | Skulder till närstående personer, kortfristig del |
| **2393** | Lån från närstående personer, långfristig del |

```
Owner transfers money into the company
Debit  1930  Företagskonto
Credit 2893  Skulder till närstående personer, kortfristig del

Company repays the owner
Debit  2893
Credit 1930
```

Repayment of principal is not income to the owner and not a cost to the company. If the loan carries interest, the interest must be marknadsmässig; the company books it to the 8420-series (**8429 Övriga räntekostnader för kortfristiga skulder**) and the owner takes it up in inkomstslaget kapital. Two employer-side obligations follow and are routinely missed:

- **Kontrolluppgift** on the ränteinkomst: SFL 17 kap. 1-3 §§ (not required if the person's total ränta is under 100 kr for the year, 17 kap. 4 § 2).
- **Skatteavdrag of 30 %** from the interest: SFL 10 kap. 15 § read with SFL 11 kap. 25 §. Osäkert: the exact KU form number for this is not confirmed against a primary source here; the obligation itself is.

Compare a **kapitaltillskott**, which is not a loan and carries no repayment right: `D 1930 / K 2093 Erhållna aktieägartillskott`. Whether a transfer is a loan or a tillskott is the owner's decision, not an inference: ask.

**Company lends to the owner: forbidden.**

**ABL 21 kap. 1 §**: an aktiebolag may not lend money to a shareholder, a styrelseledamot or VD in the company or a group company, their spouse/sambo/siblings/direct ascendants or descendants, certain in-laws, or a legal person those people control. **ABL 21 kap. 3 §** extends the same prohibition to providing säkerhet for such a loan. **ABL 21 kap. 5 §** separately forbids förskott, lån or säkerhet aimed at financing a purchase of shares in the company.

The exceptions in **ABL 21 kap. 2 §** are narrow and none of them fits a normal owner-manager:

1. the debtor is a kommun, region or kommunalförbund;
2. the debtor is a company in the same koncern as the lender;
3. the loan is intended exclusively for the debtor's *rörelse* and is given on purely commercial grounds;
4. the loan was taken up by Riksgäldskontoret under 5 kap. budgetlagen.

Plus one that matters for wide ownership: the prohibition does not apply where the borrower's and their närståendes combined holding is under **one per cent** of aktiekapitalet (21 kap. 2 § 3 st, Lag 2019:920). A fåmansbolag owner is never under 1 %.

Skatteverket can grant dispens under **ABL 21 kap. 8 §**, but only if there are *synnerliga skäl* for 1 § and 3 §.

Consequences, and they stack:

| Layer | Rule | Effect |
|---|---|---|
| Civil law | **ABL 21 kap. 11 §** | The recipient must återbära what they received |
| Income tax, natural person | **IL 11 kap. 45 §** | The *whole loan amount* is taken up as intäkt i inkomstslaget tjänst, "om det inte finns synnerliga skäl mot detta" |
| Income tax, legal person | **IL 15 kap. 3 §** | Taken up as intäkt i näringsverksamhet: except where the borrower is an aktiebolag, or there are synnerliga skäl |
| Company side | - | No deduction. The company gave away money it had no right to lend; it is not a cost |

The taxation is of the *loan amount*, not of a benefit: a 400 000 kr withdrawal is 400 000 kr of tjänsteinkomst on top of the repayment obligation. Repaying the loan later does not by itself undo the taxation.

For the categoriser: any transfer from an AB's bank account to its owner that is not lön, not a decided utdelning, and not repayment of a 2893 balance is a candidate förbjudet lån. Do not park it on 1685 and move on: see §2.6.

### 2.4 Aktiebolag: utdelning

Utdelning is a **värdeöverföring** (**ABL 17 kap. 1 § 1**) and is only permitted in the forms listed in ABL 17 kap. 2 §. Two limits apply before anything is decided (**ABL 17 kap. 3 §**): after the transfer there must be full täckning for the bundna egna kapitalet, and the transfer must be *försvarlig* given the business's nature, scope and risks and the company's konsolideringsbehov, likviditet och ställning (försiktighetsregeln). Between annual meetings, the amount available is capped at what was available at the last årsstämma (ABL 17 kap. 4 §).

Procedure: the **bolagsstämma** decides (**ABL 18 kap. 1 §**), on a förslag stating amount per share and the payment date (**ABL 18 kap. 3 §**), accompanied by the board's motiverade yttrande on whether the dividend is försvarlig under 17 kap. 3 § (**ABL 18 kap. 4 §**). In a non-avstämningsbolag the dividend is paid at the time the stämma, or the board under its bemyndigande, decides (**ABL 18 kap. 13 §**).

Correct sequence:

```
1. Bokslut: result for the year
Debit  8999  Årets resultat
Credit 2099  Årets resultat

2. First day of the new year: carry forward
Debit  2099  Årets resultat
Credit 2098  Vinst eller förlust från föregående år

3. Årsstämma decides the resultatdisposition
Debit  2098  Vinst eller förlust från föregående år
Credit 2091  Balanserad vinst eller förlust

4. Same decision, the dividend portion
Debit  2091  Balanserad vinst eller förlust
Credit 2898  Outtagen vinstutdelning

5. Payment
Debit  2898  Outtagen vinstutdelning
Credit 1930  Företagskonto
```

Points a categoriser needs:

- **Step 4 requires a stämmobeslut.** Without one there is no dividend. A payment out first and a "decision" written afterwards is an olaglig värdeöverföring (ABL 17 kap. 1 § 4 / 17 kap. 6 §) or a förbjudet lån.
- **A dividend is never a cost.** It moves through 2091 → 2898 → 1930 and touches no result account.
- Steps 4 and 5 may be months apart; **2898** is exactly the account for a decided but unpaid dividend, and it is a kortfristig skuld.
- **Tax point**: utdelning is taken up by the person entitled to it *when it can be disposed of*: **IL 42 kap. 12 §**, not when it is paid.
- **No skatteavdrag** on the dividend: **SFL 10 kap. 18 § 1** exempts utdelning on shares in a svenskt aktiebolag that is not an avstämningsbolag, which covers essentially every fåmansbolag. But **kontrolluppgift is still required** (SFL 19 kap. 1-3 §§).
- Gränsbelopp, K10 and the 3:12 rules decide how the dividend is taxed in the owner's hands. That is `swedish-tax-planning`, not this file.

### 2.5 Handelsbolag

A HB/KB is a separate legal person, but a fysisk delägare cannot be employed by it and does not take salary: money out is an **eget uttag**, exactly as in an enskild firma, per delägare:

| Delägare | Kapital | Varuuttag | Övriga uttag | Kapitaltillskott | Insättningar | Årets resultat |
|---|---|---|---|---|---|---|
| 1 | **2010** | 2011 | **2013** | 2017 | **2018** | 2019 |
| 2 | **2020** | 2021 | **2023** | 2027 | **2028** | 2029 |
| 3 | **2030** | 2031 | **2033** | 2037 | **2038** | 2039 |
| 4 | **2040** | 2041 | **2043** | 2047 | **2048** | 2049 |

Each delägare is taxed on their andel of the HB's result, not on what they drew. ABL 21 kap. does not apply to a HB: but note that IL 11 kap. 45 § and IL 15 kap. 3 § both reach through a svenskt handelsbolag: if an *AB* lends to a HB in which the owner is a delägare, the loan is caught. Where a delägare is itself an AB, that delägare's share is corporate income, not an eget uttag, ask which before booking.

### 2.6 Private expenses on the company card in an AB

This is the single most common owner-money error in an AB, because the bank line looks like any other card purchase.

**Step 1: is the expense the company's?** If the purchase serves the verksamhet, it is an ordinary cost with ordinary momsavdrag. Stop here.

**Step 2: it is private. It is not the company's cost and carries no momsavdrag.** Pick one of three treatments, and the choice is not free:

| Path | Condition | Booking |
|---|---|---|
| **A. Receivable, repaid** | The owner repays the company promptly, and certainly before bokslut | `D 1685 Kortfristiga fordringar hos delägare eller närstående / K 1930` (gross, no moms). On repayment: `D 1930 / K 1685` |
| **B. Förmån / lön** | The owner is employed by the company and the amount is treated as compensation | `D 7389 Övriga kostnader för förmåner / K 1930` (gross). Report the förmånsvärde in the AGI; `D 7512 Arbetsgivaravgifter för förmånsvärden / K 2731`; the skatteavdrag on the förmån is withheld from cash salary and increases **2710**. Taxable under **IL 11 kap. 1 §**; valuation per IL 61 kap.: see `swedish-payroll` |
| **C. Förbjudet lån** | Not repaid, not reported as förmån or lön, no stämmobeslut | The amount is a penninglån in strid med **ABL 21 kap. 1 §**: återbäringsskyldighet (ABL 21 kap. 11 §) and the full amount taken up as tjänsteinkomst (**IL 11 kap. 45 §**). No deduction for the company |

**Decision rule, in order:**

1. Was it repaid, or will it be repaid before the räkenskapsår ends? → **A**.
2. Not repaid, and the owner is employed and the amount is being reported as a förmån in the AGI? → **B**.
3. Otherwise → **C**. There is no fourth option, and "we'll sort it at bokslut" is option C by default.

A standing debit balance on **1685** at bokslut is the marker. It is a loan to the owner unless it is settled, and a recurring or growing balance is a förbjudet lån regardless of what it is called in the ledger. Note also that a private expense paid by the company and never corrected is itself an affärshändelse som medför att bolagets förmögenhet minskar och inte har rent affärsmässig karaktär: a värdeöverföring under **ABL 17 kap. 1 § 4**, with återbäringsskyldighet under 17 kap. 6 § and bristtäckningsansvar for those who took part under 17 kap. 7 §.

Osäkert: there is no bright-line rule in a primary source for how quickly a company-card private expense must be repaid before it counts as a *penninglån* under ABL 21 kap. 1 § rather than a short-lived utlägg. Treat repayment within the same räkenskapsår, documented, as the safe boundary and flag anything older to the user.

**Ask rules for this section:**

| Situation | Ask |
|---|---|
| Card purchase that could be private or business | Ask what it was for. Do not infer from the merchant name alone. |
| Recurring transfer from an AB to a private account, same amount each month | Ask whether it is lön (then AGI is missing), utdelning (then a stämmobeslut is missing), or repayment of a 2893 loan. All three are plausible and the entries share no account. |
| Owner's transfer *into* the AB | Ask: lån (2893/2393) or aktieägartillskott (2093)? The paper says which; the bank line does not. |
| A 1685 balance older than the current räkenskapsår | Escalate to the user: this is a förbjudet lån question, not a bookkeeping question. |

### 2.7 Lön vs utdelning vs eget uttag

| Entity | Form | Booked | Deductible for the company | Taxed in the owner's hands as | Social charges |
|---|---|---|---|---|---|
| Enskild firma | Eget uttag | **2013** → 1930 (balance sheet only) | No: the draw is not a cost | Nothing on the draw; the owner is taxed on the firm's whole surplus | Egenavgifter on the surplus |
| Handelsbolag (fysisk delägare) | Eget uttag | **2013/2023/2033/2043** → 1930 | No | Nothing on the draw; taxed on the andel of the result | Egenavgifter on the andel |
| Aktiebolag | Lön | **7210/7220**, 2710, 2731 | **Yes** | Inkomstslaget tjänst, per skattetabell | Arbetsgivaravgifter 31,42 % |
| Aktiebolag | Utdelning | 2091 → **2898** → 1930 | No | Inkomstslaget kapital; 3:12 for fåmansbolag | None |
| Aktiebolag | Lån to the owner | - | No | Whole amount as tjänsteinkomst, IL 11 kap. 45 § | - |
| Aktiebolag | Repayment of a 2893 loan | **2893** → 1930 | No (principal) | Not income | None |

Which mix is optimal is a planning question, not a bookkeeping one: **AB → `swedish-tax-planning`** (gränsbelopp, löneunderlag, K10, brytpunkter). **Enskild firma → `swedish-ef-skatteplanering`** (räntefördelning, periodiseringsfond, expansionsfond, EF-vs-AB). This file only says which account the money lands on once the decision is made.

---

## 3. Notes on account numbers

### 3.1 Verified against BAS 2026

1630, 2850, 2852, 1640, 1650, 1685, 1930, 2010-2019 (and the 2020/2030/2040 delägare series), 2091, 2093, 2098, 2099, 2393, 2510, 2512, 2514, 2518, 2610-series, 2640/2641, 2650, 2710, 2730/2731/2732, 2893, 2898, 7210, 7220, 7389, 7510/7511/7512, 7533, 8314, 8423, 8910, 8920.

### 3.2 The 2012 trap

Older material books an enskild firma's preliminärskatt to **2012 Avräkning för skatter och avgifter (skattekonto)** under eget kapital. **There is no 2012 in BAS 2026.** The full BAS 2026 chart is published "för alla typer av företag utom de som upprättar förenklat årsbokslut", and its 201x block is 2010, 2011, 2013, 2017, 2018, 2019 only.

2012 belongs to the separate, smaller **BAS-kontoplan för förenklat årsbokslut (K1)**, whose latest published version is the 2018 chart: that chart also numbers egna insättningar differently (2017). So:

- Full BAS 2026 chart → the EF preliminärskatt goes to **2013 Övriga egna uttag**.
- K1 förenklat årsbokslut chart → **2012** is available and correct there.

Check which chart the company runs before booking. Both roll up to **B10** on the NE-bilaga.

---

## 4. Law index

| Cite | Content |
|---|---|
| SFL 61 kap. 1 § | What is registered on a skattekonto |
| SFL 61 kap. 2 § | When registration is made (förfallodag / as soon as there is underlag) |
| SFL 61 kap. 7 § | Monthly avstämning of the skattekonto |
| SFL 62 kap. 2 § | Payment is made the day it is bokförd on Skatteverket's särskilda konto |
| SFL 62 kap. 3 § | Due date for amounts reported in a skattedeklaration |
| SFL 62 kap. 4 § | F-skatt / särskild A-skatt due the 12th, the 17th in January and August |
| SFL 62 kap. 11 § | Payments offset against the aggregate skatteskuld: no earmarking |
| SFL 64 kap. 2-3 § | Repayment of an överskott; the 2 000 kr automatic threshold |
| SFL 65 kap. 2-4, 11, 13, 16-17 §§ | Ränta: daily calculation, monthly posting, basränta, rates |
| SFL 10 kap. 15, 18 §§; 11 kap. 25 §; 17 kap. 1-4 §§; 19 kap. 1-3 §§ | Skatteavdrag and kontrolluppgift on ränta and utdelning |
| IL 8 kap. 7 § | Intäktsränta på skattekontot is skattefri |
| IL 9 kap. 8 § | Kostnadsränta på skattekontot får inte dras av |
| IL 11 kap. 1 § | Förmåner on grund av tjänst are taken up as intäkt |
| IL 11 kap. 45 § | Förbjudet lån taxed in full as tjänsteinkomst (fysisk person) |
| IL 15 kap. 3 § | Förbjudet lån taxed as näringsinkomst (juridisk person), AB excepted |
| IL 42 kap. 12 § | Utdelning taken up when it can be disposed of |
| ABL 17 kap. 1-4, 6-7 §§ | Värdeöverföring, försiktighetsregeln, återbäring, bristtäckning |
| ABL 18 kap. 1, 3, 4, 13 §§ | Vinstutdelning: decision, förslag, styrelsens yttrande, payment |
| ABL 21 kap. 1-3, 5, 8, 11 §§ | Låneförbudet, exceptions, dispens, återbäringsskyldighet |
| BAS 2026 | Account numbers and names (bas.se) |
