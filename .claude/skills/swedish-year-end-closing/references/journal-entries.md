# Specific Closing Journal Entries (Bokslutstransaktioner)

All entries dated on balance sheet date (e.g., 2025-12-31). These are the core entries a software system must generate.

## Salary accruals
December salary earned but paid in January:
```
Debit  7010  Löner till kollektivanställda
Credit 2910  Upplupna löner
```
Alternatives: 7210 (tjänstemän), 7220 (företagsledare).

## Vacation pay accruals
Year-end adjustment of semesterlöneskuld:
```
Debit  7090  Förändring av semesterlöneskuld
Credit 2920  Upplupna semesterlöner
```
Book the difference between calculated vacation pay liability at year-end and opening balance of 2920.

## Social fees on accrued salary and vacation
```
Debit  7510  Lagstadgade sociala avgifter
Credit 2940  Beräknade upplupna sociala avgifter
```
Calculate as: (upplupen lön + upplupen semester) × **31.42%**

## Depreciation (example: machinery)
```
Debit  7831  Avskrivningar på maskiner
Credit 1219  Ack. avskrivningar maskiner
```
Repeat per asset category with appropriate account pairs.

## Överavskrivningar (excess tax depreciation)
```
Debit  8853  Förändring av överavskrivningar maskiner & inventarier
Credit 2153  Ack. överavskrivningar maskiner & inventarier
```

## Inventory increase
```
Debit  1460  Lager av handelsvaror
Credit 4990  Lagerförändring
```
For decrease: reverse the entry. Use separate accounts per inventory type for manufacturing.

## Prepaid expenses (e.g., insurance covering next year)
```
Debit  1730  Förutbetalda försäkringspremier
Credit 6310  Företagsförsäkringar
```
Reversal on January 1 mirrors the entry. Similar for 1710 (rent), 1790 (other).

## Accrued income (work performed, invoice pending)
```
Debit  1790  Övriga förutbetalda kostnader och upplupna intäkter
Credit 3010  Försäljning
```
Booked without moms; moms recognized when invoice is issued.

## Deferred revenue (advance payment for future service)
```
Debit  3010  Försäljning
Credit 2970  Förutbetalda intäkter
```
Recognized monthly: Debit 2970 / Credit 3010.

## Accrued audit/accounting fees
```
Debit  6420  Revision och bokslut
Credit 2992  Beräknat arvode för revision
```

## Periodiseringsfond avsättning (AB, 25% of 400,000 = 100,000)
```
Debit  8811  Avsättning till periodiseringsfond
Credit 2126  Periodiseringsfond tax year 2026
```
Återföring of oldest fund:
```
Debit  2120  Periodiseringsfond [oldest year]
Credit 8819  Återföring från periodiseringsfond
```

## Tax provision (AB, taxable profit 500,000 × 20.6% = 103,000)
```
Debit  8910  Skatt som belastar årets resultat
Credit 2512  Beräknad inkomstskatt
```

## Result closing (AB, profit 397,000 after tax)
```
Debit  8999  Årets resultat
Credit 2099  Årets resultat
```

## Result closing (Enskild firma, profit)
```
Debit  8999  Årets resultat
Credit 2019  Årets resultat, delägare 1
```

## New year opening: carry forward previous year result (AB)
```
Debit  2099  Årets resultat (previous year)
Credit 2098  Vinst/förlust från föregående år
```
After bolagsstämma:
```
Debit  2098  Vinst/förlust från föregående år
Credit 2091  Balanserad vinst eller förlust
```

## New year opening: consolidate equity (Enskild firma)
Zero all of 2011-2019 into 2010:
```
Debit  2010  Eget kapital (for net credits from sub-accounts)
Credit 2011  Egna varuuttag
Credit 2012  Avräkning skatter och avgifter
Credit 2013  Övriga egna uttag
Debit  2017  Årets kapitaltillskott (reverse into 2010)
Debit  2018  Övriga egna insättningar (reverse into 2010)
Debit  2019  Årets resultat (reverse into 2010)
```
(Direction depends on whether sub-accounts have debit or credit balances.)

## Särskild löneskatt on pension provisions
```
Debit  7533  Särskild löneskatt
Credit 2514  Beräknad särskild löneskatt
```
Rate: **24.26%** on pension costs.