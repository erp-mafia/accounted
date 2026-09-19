export const COOKBOOK_ONBOARD_PAYROLL_MD = `# Cookbook: onboard a payroll customer and run the first month

> For payroll operators and bureaus that run many companies over the API: provision a company, set its payroll settings, load employees and their cutover balances, feed the month's deviations, run payroll, pay it, book it, file the AGI. Everything here is API-callable; nothing requires the dashboard.

This is the operator-side companion to [Run payroll and generate the AGI XML](/docs/api/cookbook/run-payroll-and-agi), which walks the run state machine in detail. Here the focus is the setup you do once per customer and the inputs you push every month.

## What you'll need

- A **live** API key with \`companies:write\`, \`payroll:read\` and \`payroll:write\`. One key covers every company its user belongs to: a company you create with the key is immediately accessible with the same key.
- \`Idempotency-Key\` on every mutating call (\`uuidgen\` is fine). Retries replay the original response with \`Idempotent-Replayed: true\`.
- \`?dry_run=true\` on anything you are unsure about: the request is validated and previewed, nothing is written.

## 1. Create the company

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies" \\
  -H "Authorization: Bearer gnubok_sk_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "Ingager AB", "entity_type": "aktiebolag", "org_number": "5566778899", "vat_registered": true, "moms_period": "monthly", "accounting_method": "accrual", "f_skatt": true }'
\`\`\`

The response carries the \`id\` you use as \`$COMPANY_ID\` from here on. The BAS chart of accounts is seeded on creation; the fiscal year follows \`fiscal_year_start_month\` (default January). Bank details for the payment file (IBAN + BIC for pain.001, bankgiro for Bankgirot LB) go on \`PATCH /companies/{id}/settings\`.

## 2. Payroll settings, once, before the first run

\`\`\`bash
curl -X PATCH "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary/settings" \\
  -H "Authorization: Bearer gnubok_sk_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "salary_pay_day": 25,
    "salary_deviation_period": "previous_month",
    "preferred_payment_format": "pain001",
    "salary_default_bank": "seb",
    "salary_net_rounding": false,
    "salary_voucher_series": "L"
  }'
\`\`\`

- \`salary_deviation_period\` is the avvikelseperiod: \`previous_month\` means a run for September reads August's absence, sick days, VAB and worked hours (the standard "innevarande månads lön, föregående månads avvikelser"). \`same_month\` reads September. The window is snapshotted on each run at creation, so decide this before the first run: switching later makes the next run's window overlap the previous run and it is refused with \`409 SALARY_RUN_DEVIATION_PERIOD_OVERLAP\`.
- \`salary_pay_day\` only sets the default \`payment_date\` of new runs.
- \`salary_voucher_series\` is the verifikationsserie salary vouchers book under. A fresh company defaults to K; send the letter explicitly when provisioning so it is never a surprise.

Read it back with \`GET /salary/settings\`. There is no separate "avtal" to configure: statutory parameters (arbetsgivaravgifter, traktamenten, karens, sjuklön) live centrally per year and are maintained by Accounted.

### Calculation policies

The law fixes what is paid (sjuklön at 80 %, one karensavdrag per sjuklöneperiod, semesterlön); how a monthly salary is turned into a day, an hour or a partial month follows the employment contract and the kollektivavtal, and every payroll system has its conventions. \`salary_calculation_policy\` on the same endpoint makes them explicit per company. Every key defaults to the calculation Accounted has always done; the other value of each is what Fortnox does, so a customer you take over from Fortnox keeps the öre on their payslips. Send only the keys you change; they are merged into the stored policy and the response always shows all six.

\`\`\`bash
curl -X PATCH "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary/settings" \\
  -H "Authorization: Bearer gnubok_sk_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "salary_calculation_policy": { "partial_month": "annual_calendar_days", "sick_rate": "annual_hourly", "long_leave": "calendar_after_five_workdays" } }'
\`\`\`

| Key | Default (Accounted) | Fortnox parity | What it changes |
|---|---|---|---|
| \`partial_month\` | \`workdays\`: månadslön × arbetsdagar i anställning / arbetsdagar i månaden | \`annual_calendar_days\`: (månadslön × 12 / 365, rounded to öre) × kalenderdagar i anställning; a whole month pays the whole salary | Base salary the month an employment starts or ends. Needed for every Fortnox customer with mid-month starters or leavers. |
| \`sick_rate\` | \`daily_divisor\`: månadslön / 21 per day (schedule divisor for part-time weeks), weighted by hours | \`annual_hourly\`: timlön = månadslön × 12 / (52 × veckoarbetstid); sjukavdrag per timme = timlön, sjuklön = 80 % of it | Sick days 1-14. The karensavdrag (20 % of an average week's sjuklön) is the same under both. |
| \`long_leave\` | \`workdays\`: one daily rate per absent day | \`calendar_after_five_workdays\`: up to five working days per working day; longer episodes per calendar day at månadslön × 12 / 365, weekends included; a full calendar month deducts exactly the monthly salary; sick day 15+ always per calendar day | Föräldraledighet, tjänstledighet utan lön and sjukfrånvaro from day 15. Five-day schedules only: \`:calculate\` refuses a monthly employee with another \`workdays_per_week\` while this is on. |
| \`leave_context\` | \`all_registered\`: days registered after the deviation period's end count toward the five-day threshold | \`through_deviation_end\`: only days up to the period's end count, so a later registration never reprices a settled month | Only under \`calendar_after_five_workdays\`. Choose \`through_deviation_end\` when the customer registers leave month by month. |
| \`net_rounding\` | \`up\`: whole-krona öresavrundning always rounds up | \`nearest\`: to the nearest krona; a negative difference books as a 3740 credit | Only when \`salary_net_rounding\` is on. |
| \`one_off_tax_rounding\` | \`truncate\`: engångsskatt = belopp × procent, öretal bortfaller (SFL 22 kap. 1 §) | \`nearest\`: round to the nearest krona | Engångsskatt on lines with \`one_off_tax_percent\` (step 5). Keep the statutory default unless you are reproducing another system's history. |

The conventions are read at \`:calculate\` and frozen into the run's \`calculation_params.salary_calculation_policy\`, so a change never moves a run that is already calculated; recalculate a draft to apply it, \`:correct\` a booked run. Set them in step 2, and compare one historical payslip from the old system against a dry run before the first live month.

## 3. Employees

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/employees" \\
  -H "Authorization: Bearer gnubok_sk_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "first_name": "Anna", "last_name": "Andersson", "personnummer": "YYYYMMDDNNNN",
    "employment_type": "employee", "employment_start": "2024-01-15",
    "salary_type": "monthly", "monthly_salary": 35000, "employment_degree": 100,
    "workdays_per_week": 5,
    "tax_table_number": 33, "tax_column": 1, "f_skatt_status": "a_skatt",
    "vacation_rule": "sammalone", "vacation_days_per_year": 25, "semestertillagg_rate": 0.0043,
    "clearing_number": "5000", "bank_account_number": "1234567890",
    "email": "anna@example.se"
  }'
\`\`\`

Hourly staff: \`"salary_type": "hourly", "hourly_rate": 210\` and no \`monthly_salary\`; their gross derives from the worked days you register in step 5. Jämkning (\`jamkning_percentage\` with \`valid_from\` and \`valid_to\`), växa-stöd and part-time schedules (\`workdays_per_week\`) are fields on the same record. \`personnummer\` is masked on the list, full on the detail endpoint.

## 4. Cutover balances (only when you take over mid-year)

\`\`\`bash
curl -X PUT "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/employees/$EMPLOYEE_ID/opening-balances" \\
  -H "Authorization: Bearer gnubok_sk_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "cutover_date": "2026-09-01",
    "ytd_gross": 280000, "ytd_tax": 64000, "ytd_net": 216000,
    "vacation_as_of_date": "2026-07-31",
    "vacation_paid_days_remaining": 12.5,
    "vacation_days_taken_this_year": 10,
    "vacation_extra_paid_days_remaining": 2,
    "vacation_saved_days_by_year": { "2025": 5, "2024": 2 },
    "vacation_unpaid_days_remaining": 0,
    "vacation_advance_days_remaining": 3,
    "opening_semester_liability": 42000,
    "opening_semester_liability_avgifter": 13196.4,
    "opening_advance_vacation_debt": 4500,
    "karens_periods_adjustment": 1
  }'
\`\`\`

Every field maps onto the semestersaldo the previous system prints per employee:

| Field | Fortnox / Azets | Meaning |
|---|---|---|
| \`cutover_date\` | | First day of the first month Accounted runs (always the 1st). YTD and the pools apply from here. |
| \`ytd_gross\`, \`ytd_tax\`, \`ytd_net\` | Ackumulerat i år | Gross, withheld tax and net paid so far this calendar year. Send \`"ytd_net": null\` when the old system cannot export net: the payslip then prints "Underlag saknas" for the accumulator instead of a false 0. Never send gross minus tax as net. |
| \`vacation_as_of_date\` | Saldo per | The day the vacation pools below are struck per. Omitted = the day before \`cutover_date\`. See the as-of rule under the table. |
| \`vacation_paid_days_remaining\` | Betalda (kvar) | Paid days left this vacation year. |
| \`vacation_days_taken_this_year\` | Betalda (uttagna) | Paid days already taken this vacation year. Together with the remaining days this gives the year's entitlement. |
| \`vacation_extra_paid_days_remaining\` | Extra betalda | Paid days above the statutory 25 (kollektivavtal or contract) left this year. They join the paid pool. |
| \`vacation_saved_days_by_year\` | Sparade per år | Sparade dagar keyed by the intjänandeår they come from, at most five years back; each year expires on its own (Semesterlagen 18 §). |
| \`vacation_unpaid_days_remaining\` | Obetalda | Unpaid days the employee may still take this year (Semesterlagen 8 §). They lapse at the vacation-year close. |
| \`vacation_advance_days_remaining\` | Förskott | Förskottssemester days granted but not yet taken. Days taken reduce the next year's entitlement. |
| \`opening_semester_liability\`, \`opening_semester_liability_avgifter\` | Semesterlöneskuld | SEK on 2920 and 2940 at cutover. Report only: the balances themselves arrive through the SIE import. |
| \`opening_advance_vacation_debt\` | Förskottsskuld | SEK the employee owes for förskottssemester already taken (Semesterlagen 29 a §, deductible at termination within five years, then written off). Report only: its own row on \`GET /reports/vacation-liability\`, subtracted from the net liability. |
| \`karens_periods_adjustment\` | | Sjuklöneperioder in the 12 months before cutover that the previous system handled, so the högriskskydd cap (10 karensavdrag per rolling 12 months) carries over. |

**The as-of rule.** The vacation ledger deducts a booked run's vacation days only when the run's avvikelseperiod ends after \`vacation_as_of_date\`; a run whose window ended on or before it is treated as already inside the balance. With \`same_month\` the default (the day before cutover) is right: the September run deducts September. With \`previous_month\` the September run deducts August, so a balance struck per 31 August already contains August's leave and the run is skipped; if the old system would have deducted August in its own September run, its "per 31 August" balance does not contain those days, and you send \`"vacation_as_of_date": "2026-07-31"\` so Accounted deducts them. Ask the customer which month the last payroll in the old system deducted leave for; the as-of date is the last day of that month.

A pågående sjukfall is registered as ordinary absence days on their real dates (step 5): the engine merges them into the running sjuklöneperiod. \`PUT /employees/{employeeId}/opening-balances\` sets one employee; \`PUT /employees/opening-balances\` (no employee id) takes the whole roster in one call. Both are full replaces: an omitted pool resets to 0. The balances lock when the first run books.

## 5. Monthly inputs

Register deviations on the dates they happened. The run reads them from its avvikelseperiod, not from the day you registered them.

**Absence** (sick, vab, parental, unpaid leave and so on), weekends skipped unless \`include_weekends\`:

\`\`\`bash
curl -X PUT "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/employees/$EMPLOYEE_ID/absence" \\
  -H "Authorization: Bearer gnubok_sk_..." -H "Content-Type: application/json" \\
  -d '{ "from": "2026-08-10", "to": "2026-08-12", "absence_type": "sick" }'
\`\`\`

Karensavdrag, sjuklön dag 2-14, day 15+ (Försäkringskassan), återinsjuknande and högriskskydd are derived from the dates; nothing to configure.

**Worked days** for hourly staff, and for OB/shift premiums on anyone:

\`\`\`bash
curl -X PUT "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/employees/$EMPLOYEE_ID/worked-days" \\
  -H "Authorization: Bearer gnubok_sk_..." -H "Content-Type: application/json" \\
  -d '{ "days": [
    { "work_date": "2026-08-03", "hours": 8, "start_time": "07:00", "end_time": "15:30" },
    { "work_date": "2026-08-04", "hours": 6.5, "start_time": "16:00", "end_time": "22:30" }
  ] }'
\`\`\`

**Standing rows and benefits** live on the employee and are re-derived on every run whose payment date falls inside their validity:

\`\`\`bash
# A monthly allowance that recurs until further notice
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/employees/$EMPLOYEE_ID/recurring-lines" \\
  -H "Authorization: Bearer gnubok_sk_..." -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \\
  -d '{ "item_type": "allowance", "description": "Friskvårdsbidrag", "amount": 416.67, "valid_from": "2026-09-01" }'

# Bilförmån at the Skatteverket schablon value
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/employees/$EMPLOYEE_ID/benefits" \\
  -H "Authorization: Bearer gnubok_sk_..." -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \\
  -d '{ "benefit_type": "car", "description": "Volvo XC40 2025", "monthly_value": 4210, "valid_from": "2026-09-01" }'
\`\`\`

Deductions carry a negative amount and the API rejects the wrong sign for the item type. The förmånsvärde is added to the tax and avgifter basis at \`:calculate\`; supply the schablon figure, the API does not compute it from the car.

**Vacation taken** is a payslip line too: \`item_type: "vacation"\` with \`quantity\` = days, and \`vacation_category\` when the days are not this year's paid days (\`saved\` with an optional \`vacation_saved_year\`, else the oldest saved year is consumed first; \`unpaid\`; \`advance\`; \`extra_paid\`), so the ledger draws them from the right pool loaded in step 4.

**One-off lines** (bonus, deduction, reimbursement) go on the run itself once it exists: \`POST /salary-runs/{id}/employees/{employeeId}/lines\`. A bonus, provision or final-settlement semesterersättning that Skatteverket taxes as an engångsbelopp takes \`one_off_tax_percent\` with the percentage you verified for the employee's yearly income; the line is then withheld at that flat rate instead of through the monthly table (a valid jämkning decision on the employee still wins), equal percentages are summed before the öre are dropped, and the payslip breakdown shows an "Engångsskatt (x %)" step. A different base salary for one month: \`PATCH /salary-runs/{id}/employees/{employeeId}\` with \`monthly_salary\`.

## 6. Run payroll

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs" \\
  -H "Authorization: Bearer gnubok_sk_..." -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \\
  -d '{ "period_year": 2026, "period_month": 9, "payment_date": "2026-09-25", "voucher_series": "L" }'
\`\`\`

The response echoes \`deviation_period_start\` / \`deviation_period_end\` (here 2026-08-01 to 2026-08-31 under \`previous_month\`). Pass both explicitly to override for one run. Then attach the roster (\`POST /salary-runs/{id}/employees\` per employee), \`POST /salary-runs/{id}/calculate\`, read each payslip with its step-by-step breakdown (\`GET /salary-runs/{id}/employees/{employeeId}\`), and \`POST /salary-runs/{id}/approve\`. The calculate response carries non-blocking warnings (läkarintyg expected, Försäkringskassan reporting, F-skatt not verified) that an operator should surface to the customer.

## 7. Pay

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/salary-runs/$RUN_ID/payment-file" \\
  -H "Authorization: Bearer gnubok_sk_..." -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \\
  -d '{ "format": "pain001" }'
\`\`\`

The file comes back inline as \`data.content\` with \`data.filename\`; write it to disk and upload it in the bank's file channel (pain.001 usually needs a filkommunikationsavtal, not the ordinary web upload). Generating the file does not change the run's state. When the bank has executed, \`POST /salary-runs/{id}/mark-paid\`.

## 8. Book and file

\`POST /salary-runs/{id}/book\` posts the verifikat (gross, tax, net, avgifter, vacation accrual) under the run's voucher series, and \`POST /salary-runs/{id}/generate-agi\` returns the arbetsgivardeklaration XML for the payout month. Uploading the AGI to Skatteverket requires BankID signing by the company's ombud; that is deliberate. Subscribe to \`salary_run.approved\`, \`salary_run.booked\` and \`agi.generated\` via [webhooks](/docs/api/cookbook/webhooks) to drive your own workflow.

A booked month that turns out wrong is corrected with \`POST /salary-runs/{id}/correct\`: the run's verifikat are reversed by storno (BFL 5 kap 5 §, nothing is edited or deleted), the original is marked \`corrected\`, and a fresh draft for the same period is returned as \`correction_run\`, already carrying the original's roster and lines. Edit its lines, then calculate, approve, pay and book it like any run, and regenerate the AGI for the period. Dates inside a calculated, approved, paid or booked run's avvikelseperiod are locked for absence and worked-days writes (\`409 SALARY_REGISTER_DATES_LOCKED_BY_RUN\`); register the days once the correction run exists.

## 9. Year end

\`POST /salary/vacation-year-close\` runs the semesterårsavslut (beredning + commit) and \`GET /reports/vacation-liability\` gives the semesterskuld per employee at any time. \`GET /reports/salary-journal\` is the lönejournal for the customer's accountant.

## Pitfalls

- **Settings before runs.** \`salary_deviation_period\` and \`salary_voucher_series\` are copied onto each run when it is created. Set them in step 2, not after the first run exists.
- **Dates, not months.** Absence and worked days are per calendar day. A sick period that spans a month boundary is registered as one range; each run takes the days inside its own window.
- **Hourly staff without worked days calculate to zero.** Register the days before \`:calculate\`, or set \`hours_worked\` when attaching the employee to the run if you only have a total.
- **Payment file is not payment.** \`:mark-paid\` is your confirmation that the bank executed; the AGI period follows the payout month.
- **Test keys never write.** A \`gnubok_sk_test_*\` key forces every mutation into dry-run mode, so a test key cannot create a company or a run. Use it to validate payloads, then switch to the live key.
`
