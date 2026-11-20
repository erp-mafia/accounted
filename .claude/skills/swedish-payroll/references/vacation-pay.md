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

## Fewer than five workdays a week (nettometoden)

Statute: Semesterlagen (1977:480), text checked against riksdagen.se 2026-10-12.

- 4 §: 25 semesterdagar each semesterår. 2 § voids an agreement that cuts the employee's rights; 2 a § lists the sections an agreement may deviate from, and 12 a § is not among them.
- 12 a §: "Semesterledighet ska förläggas så, att arbetstagare med lägre sysselsättningsgrad än heltid eller med oregelbunden arbetstid får lika lång ledighet som en arbetstagare som arbetar heltid eller en arbetstagare med regelbunden arbetstid."
- 3 a §: leave is taken in whole days, so the days off round up.
- Days off = paid days x workdays per week / 5, rounded up (Unionen, Lawline): 4 days a week gives 20, 3.5 gives 18, 3 gives 15, 2.5 gives 13, 2 gives 10. An irregular schedule uses its average workdays per week.
- Pay and pools stay on the paid days: the semestertillägg is "för varje betald semesterdag" (16 a §), saving needs "mer än tjugo semesterdagar med lön" (18 §), and the payout of untaken days counts paid days (26 a §). Only the number of days off is converted.
- Kvotsemester (each day off uses 5 / workdays paid days, no rounding) gives the same length of leave; a central kollektivavtal may deviate from 3 a, 9 and 16 to 16 b §§ (2 a §).
- Weekend workers (9 §): Saturdays and Sundays are not semesterdagar (3 a §); a leave of at least five days carries weekend leave around it, and in a leave shorter than five days a weekend day that would have been a workday counts as a semesterdag. Five or more workdays a week therefore converts one for one.
- 16 § second paragraph, points 3 and 4: sammalöneregeln gives way to procentregeln when the sysselsättningsgrad varied during the intjänandeår or changed before the semestertillfälle. The employer may always choose procentregeln (16 § first paragraph).

In Accounted: `employees.workdays_per_week` drives the conversion (`src/lib/salary/vacation-net-days.ts`). The vacation ledger counts paid days; a vacation payslip line holds days off, and each payslip stores the factor it used (`salary_run_employees.vacation_paid_days_per_day_off`, 1.25 at four days a week) so a later schedule change never re-counts booked leave.
