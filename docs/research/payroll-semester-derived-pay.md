# Payroll: pay derived from vacation days taken (issue #85)

Status: decided 2026-10-23 for the build in the merge request that closes #85. This is not legal advice; the law text was read on riksdagen.se the same day and every rule below cites it. One-line decision record: `docs/decisions/2026-10/2026-10-23-semester-derived-pay.md`.

## Sources

Primary:

- Semesterlag (1977:480), riksdagen.se, "Ändrad: t.o.m. SFS 2014:424" (read 2026-10-23, the live page and `data.riksdagen.se/dokument/sfs-1977-480.text` agree): 2 a, 3, 4, 7, 8, 12 a, 16, 16 a, 16 b, 17-17 b, 22, 26, 26 a, 28, 29, 29 a §§. 27 § is repealed (Lag 2009:1439). https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/semesterlag-1977480_sfs-1977-480/
- The `swedish-payroll` skill, `references/vacation-pay.md` (nettometoden, 12 a §; paid days vs days off).

Secondary (practice, never the rule itself):

- Företagarna, "Hur räknar jag ut semesterlön till mina anställda?": procentregeln semesterlön per day is the year's semesterlön divided by the paid semesterdagar ("13 722 kr / 15 ≈ 915 kr"), and the employer deducts the salary for the day ("20 000 kr * 12 / (52 * 5) ≈ 923 kr per semesterdag"), the same amount per obetald semesterdag. https://www.foretagarna.se/juridisk-faq/semester-ledighet/hur-raknar-jag-ut-semesterlon-till-mina-anstallda/
- Fortnox ordlista, "Förskottssemester": "den anställde får behålla sin ordinarie lön under de semesterdagar som denne ännu inte hunnit tjäna in semesterlön för". https://www.fortnox.se/fortnox-foretagsguide/ekonomisk-ordlista/forskottssemester
- Fackförbundet ST, "Vanliga frågor om semester": förskott creates a debt equal to "det löneavdrag som annars skulle ha gjorts om du tagit ut obetald semester". https://www.st.org/fortroendevald/arbetsplatsombud/semester
- Kollektivavtal examples (Grafiska, Bygg tjänstemän, published by Arbetsmiljöverket for utstationering): semestertillägg 0,8 % of the "vid semestertillfället aktuella månadslön", avdrag per obetald semesterdag 4,6 % of the månadslön. These are agreement rules, not law.

## What the calculation reads today

- A vacation row is a manual payslip line: `item_type 'vacation'`, `quantity` = days off, `vacation_category` in `paid | extra_paid | saved | unpaid | advance` (NULL = paid), amount optional (0 kr when only days are given, !738).
- The engine sums it in Step 3 (absence) with its amount. A days-only row contributes 0 kr: the monthly salary runs on under every rule, nothing else changes.
- Each run accrues the semesterlöneskuld: sammalöneregeln `månadslön × semestertillagg_rate × vacation_days_per_year / 12` (plus 12 % of rörliga lönedelar, #60 B, already built), procentregeln `semesterunderlag × resolveVacationPayRate`. Debit 7290/7090, credit 2920; avgifter 7519/2940. Payouts never relieve 2920; the semesterårsavslut (`semesterberedning.ts`) trues 2920/2940 up to the day-valued liability.

## Decision 1: only a days-only line is priced; a line with an amount is paid as entered

The calculation derives pay for every manual vacation line whose amount is 0 kr and whose quantity is above 0. A vacation line that carries an amount (quantity × à-pris, or an amount) is the operator's own pricing and derives nothing.

Why: 2 a § andra stycket lets a central kollektivavtal deviate from 16-16 b §§ and 26 §, so some payslips will always need a figure the statute does not give (a 4,6 % avdrag, a tillägg on förskott days, a June lump sum). Keeping the amount as the override gives every such case a door without new settings, and it means the 10 draft vacation lines in production that already carry an amount calculate exactly as before (read-only count 2026-10-23: 21 vacation lines in total, all sammalöneregeln; 4 days-only lines are on booked runs).

Rejected: deriving for every line and warning about doubles. A typed tillägg plus a derived one is paid twice the moment someone misses the warning.

## Decision 2: sammalöneregeln pays a semestertillägg per paid day

Rule (16 a § första och andra stycket): "Semesterlön enligt sammalöneregeln är den vid semestertillfället aktuella vecko- eller månadslönen, eventuella fasta lönetillägg samt ett semestertillägg." "Semestertillägget för varje betald semesterdag är ... för månadsavlönade arbetstagare 0,43 procent av månadslönen."

- The monthly salary runs on (nothing deducted). The derived row is the tillägg only: `paid days × round(månadslön × rate)`, one row "Semestertillägg".
- Månadslön: the run's monthly salary × employment_degree / 100, i.e. the salary the employee actually has at the semestertillfälle. A part-timer's tillägg is on the part-time salary (the statute names the employee's månadslön; part time changes nothing else). Not prorated for a partial month: the statute names the månadslön, not the month's pay.
- Fasta lönetillägg would raise the base (16 a § andra stycket, last sentence). Accounted refuses recurring additions (`recurring-lines.ts`), so none exist; nothing to add.
- Paid days: days off × the payslip's paid-days-per-day-off factor (12 a §, nettometoden: 1,25 at four days a week). The tillägg is "för varje betald semesterdag", so it follows paid days, not days off.
- Rate: `employees.semestertillagg_rate` (DB default 0,0043; a kollektivavtal raises it, 0,8 % is common). It is the field the monthly accrual already reads, so the payout and the provision cannot disagree. All active employees in production are at 0,0043 (read-only 2026-10-23). A stored rate below 0,43 % is used as stored: 2 a § andra stycket allows a central kollektivavtal to deviate from 16 a §, so it is not invalid on its face (open question for Jakob below).
- Which days carry it: `paid`, `extra_paid` and `saved` (Decision 6). `advance` carries none and `unpaid` is a deduction (Decisions 5 and 7).
- Hourly pay on sammalöneregeln stops the line: 16 § andra stycket 1 puts "lön som inte är bestämd per vecka eller månad" on procentregeln, and there is no månadslön to take 0,43 % of. None exist in production.

Worked example: 40 000 kr, 5 paid days, 0,43 %: 172,00 kr per day, 860,00 kr.

Rejected: valuing the tillägg off a dagslön (the error the accrual had and fixed), and a flat per-day amount typed on the employee (a second definition of the rate).

## Decision 3: procentregeln deducts the salary for the day and pays 12 % of last year's base per paid day

Rule (16 b § första stycket): "Semesterlön enligt procentregeln utgör tolv procent av arbetstagarens förfallna lön i en anställning under intjänandeåret." The statute gives the year's total; it is paid per paid day as total / paid days earned (Företagarna's worked example; 7 § decides the paid days). 22 §: saved days "ska betraktas som intjänade under det närmast föregående intjänandeåret".

Monthly pay, two rows:

- "Semesterlöneavdrag": days off × dagslön, where dagslön = månadslön × employment_degree / 100 / `dailyDivisor(workdays_per_week)` (21 at five days a week), rounded to öre first. This is the day the engine already deducts for tjänstledighet utan lön and prices sick days with, so "one day of salary" has one definition. The semesterlön replaces the salary for the leave, so the salary for those days goes.
- "Semesterlön": paid days × round(rate × base / earned paid days).

Hourly pay: only the "Semesterlön" row. Timlön is paid for hours worked, so there is nothing to deduct.

Inputs:

- rate: `resolveVacationPayRate` (12 %, 14,4 % at 30 days, a higher kollektivavtal rate), the codebase's one semesterlön percentage. 14,4 % over 30 days and 12 % over 25 days give the same day value.
- base year: the vacation year before the one the run's payment date falls in. Under the statutory basis (1 April to 31 March) that is exactly the intjänandeår (3 §). Under the calendar basis (sammanfallande intjänande- och semesterår, a kollektivavtal arrangement) it is the previous calendar year: the year being earned cannot be valued before it ends, and 22 § values saved days at "det närmast föregående intjänandeåret" (open question for Jakob below).
- base: the sum of `vacation_basis` from the procentregeln step of the employee's payslips with status approved, paid or booked whose payment date falls in the base year ("förfallen" read as the payment date, the reading `variable-vacation-pay.ts` already uses). That figure already leaves out semesterlön and qualifying absence and adds hourly pay's lost hours (16 b § andra och tredje stycket, #60 C).
- earned paid days: `computeEntitledDays` (7 §, rounded up) under the statutory basis; under the calendar basis `vacation_days_per_year` and the employee must have been employed the whole base year.

When the base is not known, the line stops with a reason, never a guessed amount. It is not known when:

- a month of the base year in which the employee was employed has no counted payslip in Accounted (a cutover employee whose history is in another system, a missing run), or a payslip of the year was not calculated under procentregeln;
- the employee earned no paid days in the base year (hired after it, a first-year employee): the days are unpaid or förskott, and the reason says so;
- under the calendar basis, the employee was not employed the whole base year.

The reason names the employee, the year and the months, and says what to do: price the line yourself (amount or quantity × à-pris) or register the days as obetalda or förskott.

Worked example (statutory basis, vacation in July 2026): twelve payslips April 2025 to March 2026 at 40 000 kr each, base 480 000 kr, 25 earned days, 12 %: 2 304,00 kr per paid day. Five days: semesterlön 11 520,00 kr, avdrag 5 × 1 904,76 = 9 523,80 kr, gross 41 996,20 kr. The month's accrual falls to 12 % × (40 000 - 9 523,80) = 3 657,14 kr: semesterlön is not semesterlönegrundande (16 b § andra stycket 1).

Rejected:

- Estimating the base from the current salary × 12, or from the cutover `opening_semester_liability`: both guess, and a liability includes saved days and avgifter rules that are not the day value.
- 4,6 % of the månadslön per day (tjänstemannaavtal) or månadslön × 12 / 260 (Företagarna's example) as the avdrag: both are agreement or guidance conventions, not law; Accounted's tjänstledighet day is `månadslön / dagdivisor`, and two definitions of "a day's salary" in one engine is how payslips stop adding up. A company convention for it is a follow-up (open question below).
- Deriving nothing and warning (today's behaviour): the employee is paid the salary instead of the semesterlön, which is the rule for sammalöneregeln, not this one.

## Decision 4: an obetald semesterdag is a dagslön deduction

Rule: 4 § andra stycket pays semesterlön only for days earned under 7 §; 8 § lets the employee take or decline "semesterledighet som inte är förenad med semesterlön". The statute sets no deduction rate.

- Monthly pay, every rule: one row "Obetald semester", -(days off × dagslön), the same dagslön as Decision 3 and as tjänstledighet.
- Not semesterlönegrundande: it is none of the absence 17-17 b §§ list, so under procentregeln the deduction lowers the base (`is_vacation_basis` true), as unpaid leave does.
- Hourly pay: nothing; hours not worked were never paid.

Worked example: 40 000 kr, five-day week, 2 days: 1 904,76 × 2 = -3 809,52 kr.

Rejected: 4,6 % (agreement rule; a policy option later) and the calendar-day convention of `long_leave` (it is defined for tjänstledighet, föräldraledighet and sick day 15+, not for obetald semester).

## Decision 5: förskott derives nothing for monthly pay; hourly förskott stops

Förskottssemester is paid leave before it is earned, given by agreement; 29 a § only says how it is settled at termination. Practice (Fortnox, ST): the employee keeps the ordinary salary, and the debt equals the deduction an unpaid day would have made.

- Monthly pay: the salary runs on and no row is derived, under both rules. The statutory semestertillägg is per "betald semesterdag" earned under 7 §, which a förskott day is not. The ledger already counts the advance days (`vacation-category.ts`).
- Hourly pay: there is no ordinary salary that runs on, so any figure is a guess: the line stops and the reason asks for the amount.

## Decision 6: sparade and extra betalda days are paid days

- Sparade (22 §): calculated under 16-16 b §§ and treated as earned in the most recent intjänandeår. Sammalöneregeln: the tillägg at today's månadslön and rate. Procentregeln: the same day value as Decision 3.
- Extra betalda: the ledger counts them in the paid pool and `vacation_days_per_year` includes them, so the accrual already provisions them. They are priced as paid days. A contract that pays extra days differently uses the amount override (Decision 1).

## Decision 7: vacation_rule none and semesterersattning

- `none` (vacation included in the salary, e.g. an owner outside semesterlagen): paid, extra, saved and förskott days derive nothing; obetalda days deduct as in Decision 4.
- `semesterersattning` (12 % paid with every salary): the semesterlön has already been paid, so the leave itself is without pay. Obetalda days deduct as in Decision 4; any other category stops with the reason "register the days as obetalda, or give the amount", because paying the salary through the leave as well would pay the vacation twice.

## Decision 8: the run that carries the days pays them

26 § första stycket: "Arbetsgivaren ska betala ut semesterlön till arbetstagaren i samband med semesterledigheten." The days sit on the payslip the operator registers them on, and that payslip pays the derived rows. With "föregående månads avvikelser" the July days land on the August run, the payment right after the leave. 2 a § andra stycket lets a central kollektivavtal deviate from 26 § (a June lump sum for the summer, for instance): the amount override covers it.

Rejected: a separate payout run or date for the tillägg. It needs a schedule the statute does not set and leaves the days and their pay on different payslips.

## Decision 9: the semesterlöneskuld model is unchanged, so nothing is counted twice

- The derived rows are pay on the salary voucher: the tillägg and the semesterlön book on 7285 (7082 arbetare, 7286 företagsledare) through the existing account map; the semesterlöneavdrag and the obetald deduction carry `is_gross_deduction` like the sick rows, so they reduce the employee's salary account (7210/7010/7220) through the base-salary remainder. Gross pay, tax, avgifter and AGI follow the engine as for any line.
- The accrual voucher is untouched. Payouts never relieved 2920 per run, by design, and the semesterårsavslut reduces 2920/2940 to the day-valued liability of the days left. The year's cost is therefore the payout plus the change in the provision: once, not twice. Before the close 2920 is overstated by what was taken, exactly as it is today for a typed tillägg.
- Inside the run: the semesterlön row is not semesterlönegrundande and the avdrag lowers the procentregeln base, so the month accrues on worked pay only. The tillägg row is type `vacation`, not a wage addition, so the 12 % on rörliga lönedelar (#60 B) never accrues on it.

Rejected: relieving 2920/2940 on every payout (debit 2920 per derived row). It is the cleaner monthly picture, but it changes what the year close and the vacation-liability report read as "booked", which is a change of the liability model of its own (open question below).

## Decision 10: booked runs never change; drafts recalculate

- `runSalaryCalculation` refuses every run that is not a draft, so an approved, paid or booked run keeps its stored lines and figures. The 4 booked days-only lines in production stay as booked; whether to settle them (a correction run, or a line on a later run) is the byrå's call, not this change's.
- A draft recalculates on the next "Beräkna": the derived rows are deleted by provenance and written again, so repeated calculations never stack them. A correction run copies provenance (`correct-run.ts`), so the copied rows are replaced, not doubled.

## Decision 11: data model

- Derived rows keep `item_type 'vacation'` (semester on the payslip, in Fora, in the account map) and get a new provenance value, `calculation_source = 'vacation_pay'`, allowed by a new CHECK only on `item_type 'vacation'`. NULL stays manual and `vacation_compensation` keeps its meaning.
- Quantity is NULL on derived rows: the vacation ledger and the payslip's `vacation_days_taken` count vacation quantities, and the days are already on the operator's line. The description and the calculation breakdown carry every input (days, rate, månadslön, dagslön, base, earned days, year).
- `isCalculatedLine` treats the provenance as engine-owned, so the line commands refuse to edit or delete the rows from every door (dashboard, v1, MCP).
- Rejected: new item types (`semestertillagg`, `semesterlon`). They need a CHECK, an account, an AGI, a Fora and a role entry each, and every reader of vacation rows would have to learn them, for no difference in what is paid.

## Open for Jakob (not settled by the law)

1. Calendar basis (sammanfallande semesterår) under procentregeln: the day value comes from the previous calendar year, and a partial previous year stops. The law has no sammanfallande year; the employer's kollektivavtal decides. Confirm the reading or name the agreement rule to follow.
2. The avdrag per vacation day and per obetald day is the engine's dagslön (månadslön / 21 at five days a week, 4,76 %). Tjänstemannaavtal use 4,6 %. Add it as a company calculation convention (`salary_calculation_policy`, a migration and a settings option) if customers ask; until then the amount override covers it.
3. Förskott days get no tillägg and no derived pay. If a customer's agreement pays the tillägg on förskott days, that is an amount on the line today.
4. Procentregeln stops until a whole base year is in Accounted, and today that is nobody: 266 companies with procentregeln employees are on the calendar basis (4 on the statutory one) and the first counted payslip in production is from January 2026 (read-only count, 2026-10-23). So every procentregeln days-only line in 2026 is refused and has to be priced by hand, which is what the operator had to do before this change, now said out loud instead of paying the salary through the leave. The real fix is an opening-balance field for the previous system's semesterlönegrundande lön of the base year (and, if wanted, its earned days), set with the other cutover figures. Not built here: it widens the opening-balance doors (v1, MCP, the panel). The alternative until then, letting the salary run on with a warning, pays a monthly employee roughly 0,43 % of the salary per day too little and an hourly employee nothing for the day.
5. A `semestertillagg_rate` below 0,43 % is used as stored. Enforce 0,43 % as a floor (as `resolveVacationPayRate` floors 12 %) or keep allowing the 2 a § deviation.
6. Per-payout relief of 2920/2940 (Decision 9) instead of the year-close true-up.

## Not in scope

- #60 B (sammalöneregeln and rörliga lönedelar): built separately; untouched, and its variable-pay definition does not see the new rows.
- #60 C (absence and the procentregeln base): untouched; the base this change reads is the one #60 C defined.
- #31 (a changed employment level forces procentregeln): untouched; the derivation follows whatever rule the employee is on.
