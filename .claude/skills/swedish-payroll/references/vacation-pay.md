# Semesterlöneskuld (Vacation Pay)

## Two calculation methods

### Sammalöneregeln (§16a Semesterlagen)

Default for monthly-salaried employees. Regular salary continues during vacation, plus a semestertillägg of minimum 0.43% of monthly salary per vacation day (many CBAs use 0.8%). An additional 12% of variable pay (OB, overtime, bonuses) that fell due during the semesterår is paid no later than one month after the semesterår ends (§16a third paragraph, §26). Kollektivavtal may regulate this differently.

### Procentregeln (§16b)

Applies to hourly employees, those with >10% variable pay, or when sammalöneregeln cannot be used. Semesterlön = 12% of total semesterlönegrundande income during the intjänandeår. For entitlements beyond 25 days, add 0.48 percentage points per extra day (e.g., 30 days = 14.4%).

## Intjänandeår

Runs April 1 - March 31 by law, but many collective agreements use sammanfallande (concurrent) calendar-year periods. Developers must make this configurable.

## Accounting entries (BAS accounts)

| Account | Purpose |
|---|---|
| 2920 | Upplupna semesterlöner (vacation pay liability, balance sheet) |
| 2940/2941 | Upplupna sociala avgifter på semesterlöner |
| 7090 | Förändring av semesterlöneskuld, kollektivanställda (P&L) |
| 7290/7291/7292 | Förändring av semesterlöneskuld, tjänstemän/företagsledare (P&L) |
| 7519 | Arbetsgivaravgifter för semester- och löneskulder (P&L) |

### Monthly accrual

Debit 7090/7290 and credit 2920 for new vacation pay earned. Debit 7519 and credit 2940 for social charges on the accrual (31.42% for standard employees, 10.21% for 67+).

### Vacation taken

Reverse: debit 2920 / credit 7090 or 7290.

### Liability calculation

Must be calculated individually per employee under BFNAR 2016:10.

## Sparade semesterdagar

Employees with >20 paid days may save the excess (max 5 from a 25-day entitlement), up to 5 years. Saved days are valued using the most recent intjänandeår's calculation.

Upon termination, all untaken days must be paid as semesterersättning within 1 month.

## Semesterlönegrundande frånvaro

Certain absences count as if worked for vacation accrual purposes: sjukfrånvaro (first 180 days), föräldraledighet (up to 120 days per child, 180 for a single parent; SemL 17 a §), studieledighet with stipend, and more. See Semesterlagen §17-17b for complete list.