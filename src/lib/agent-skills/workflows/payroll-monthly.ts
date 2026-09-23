import type { Skill } from '../types'

const body = `# Lön och AGI: Accounted

One salary run for one month, booked, and its arbetsgivardeklaration (AGI) prepared or filed. You work like a payroll consultant for a small business owner who is not an accountant: check the facts first, ask precise questions, let Accounted do the calculation, and stage every write for the user to approve.

## When to use

- "Kör lönen för mars", "run payroll", "lönekörning", "gör AGI:n"
- Once per month, before the payment date

Not this skill: matching the bank payment of net salaries or the skattekonto draw (see \`bank-reconciliation\`), locking the month (see \`month-end-close\`), one-off questions about booking a salary-like cost (see \`bookkeep\`).

## Step 0: Orient before acting

Answer each question with a tool, not a guess:

1. **Which company?** \`gnubok_list_companies\`. Several: ask which one, then pass that \`company_id\` on every call, including approvals.
2. **Legal form:** \`gnubok_get_agent_briefing\`, read \`entity_type\`.
   - **Enskild firma (EF):** the owner is not a separate legal person and can never be paid lön. The owner's money is **eget uttag** (konto 2013), booked against equity, not in a salary run. Accounted refuses an EF owner or board member as an employee. This skill only applies to an EF's hired staff, who are paid and booked exactly as in an AB. If an EF owner asks to "pay myself a salary", explain eget uttag in one or two sentences and stop this workflow.
   - **Aktiebolag (AB):** the owner can be an employee with \`employment_type: "company_owner"\` (booked to 7220, löner till företagsledare). Board fees use \`"board_member"\`.
3. **Who is on payroll?** \`gnubok_list_employees\`. Per employee check \`personnummer_masked\`, \`salary_type\` with \`monthly_salary\` or \`hourly_rate\`, \`tax_table_number\` + \`tax_column\`, \`employment_type\`. For one employee's full setup (employment start/end, F-skatt status, jämkning, bank details, vacation rule) use \`gnubok_get_employee({ employee_id })\` (search-only read: call it through \`gnubok_call_tool\` if it is not in your tool list).
4. **Which months are already booked?** \`gnubok_get_salary_journal({ year })\` (search-only read, via \`gnubok_call_tool\`) lists booked runs per employee and month. A gap (February booked, March missing, now asked for April) is a question for the user before you create anything.
5. **Is the period open?** \`gnubok_list_fiscal_periods\`. The salary verifikat is dated on the payment date, so that date must fall in an open, unlocked period. Every staged write also returns \`period_status\`.
6. **Is Skatteverket connected?** \`gnubok_connect_skatteverket\` (read). \`available\` says whether filing exists in this environment, \`connected\` whether this company has authorised it. This decides Step 8, so learn it now.

## Questions to ask at the start

Ask them together, in one message, with what you already found:

- **Which month and which payment date?** ("Lönen för april, utbetalning 25 april?") The AGI is declared for the month the salary is **paid**, so the payment date decides the AGI month and its deadline.
- **Anything different this month?** Sick days, VAB, parental leave, unpaid leave, vacation days taken, overtime, bonus, a new or departing employee.
- **Förmåner?** Car, meals, housing or other benefits that are new or changed.
- **Owner's salary (AB):** "How much salary do you take this month?" Owner salary is often decided month by month. Never suggest a level: how much an owner should take (and 3:12 questions) is a decision for the user or their advisor.
- **What does "done" mean?** Booked only, AGI generated, or AGI filed with Skatteverket.

## When information is missing

| Missing | What happens | What you do |
|---|---|---|
| No employees | Nothing to pay | Ask whether they want to add one. EF owner: eget uttag, not payroll (Step 0). |
| New employee not registered | Not on the run | \`gnubok_create_employee\` requires \`first_name\`, \`last_name\`, \`personnummer\` (12 digits), \`employment_start\`. Also ask for salary, tax table and column, municipality, bank account and F-skatt status. Never invent a personnummer or a start date. |
| Tax table missing (A-skatt, not sidoinkomst) | Calculation fails with \`VALIDATION_ERROR\` | Ask for skattetabell and kolumn from the employee's Skatteverket decision, then \`gnubok_update_employee({ employee_id, tax_table_number, tax_column })\`. Do not guess a table from the municipality. |
| Sidoinkomst | Flat 30 % withholding | Set \`is_sidoinkomst: true\` only when the user confirms this is not the employee's main job. |
| F-skatt status \`not_verified\` | Tax and avgifter depend on it | Ask the user to verify with Skatteverket. With no F-skatt stated the rule is 30 % withholding plus full avgifter. |
| Hourly employee without \`hourly_rate\` | Calculation fails | Ask for the rate, stage \`gnubok_update_employee\`. |
| Employment start or end outside the month | Employee is left off the run | Correct the dates only when the user confirms the real ones. |
| Payroll moved from another system mid-year | Year-to-date totals and vacation balances are wrong | \`gnubok_set_employee_opening_balances\` with the figures from the previous system, before the first booked run (locked afterwards). Ask for the numbers; never estimate them. |

## Workflow

### Step 1: Create the run

\`gnubok_create_salary_run({ period_year, period_month, payment_date })\` stages a draft run seeded with every active employee whose employment overlaps the month.

- **Avvikelseperiod:** absence and worked days are read from a deviation window. Default is the company setting (same month, or the common "föregående månads avvikelser"). The staged preview shows the resolved window; tell the user which dates it covers. Override only on request, with both \`deviation_period_start\` and \`deviation_period_end\`. A window that overlaps another run is refused (the same sick day would be deducted twice).
- **"Salary run already exists for this period":** one run per company and month. Do not create another. Ask whether the user means that run (under Löner in Accounted) and get its id from there or from the earlier approval result.
- After approval the run id is in the approved operation's result. Keep it for every later step.

To change a draft's payment date, voucher series or note: \`gnubok_update_salary_run\` (search-only write: stage it through \`gnubok_stage_tool\` if it is not in your tool list). Changing the payment date clears the calculation.

### Step 2: Register this month's changes (before calculating)

- **Owner salary or other variable base pay:** \`gnubok_set_run_salary({ salary_run_id, employee_id, monthly_salary })\`. Per-run value; the employee's fixed salary is untouched. \`0\` is a nollkörning. Never edit the base salary payslip line instead: recalculation rebuilds it from this value.
- **Sick leave, VAB, parental leave, unpaid leave:** \`gnubok_register_absence({ employee_id, from, to, absence_type, hours_per_day })\` with type \`sick\`, \`vab\`, \`parental\`, \`pregnancy\`, \`care_relative\`, \`study\`, \`unpaid_leave\` or \`other_leave\`. Max 92 days per call; weekends are skipped unless \`include_weekends\`. Use \`hours_per_day: 4\` for half days. The dates must be inside the run's avvikelseperiod to count this month. Check what is already registered with \`gnubok_list_absence\` (search-only read) and remove a wrong range with \`gnubok_delete_absence\`. Accounted derives karensavdrag and sjuklön (80 % for day 2 to 14) from these rows. Läkarintyg applies from day 8; from day 15 Försäkringskassan pays, not the employer: tell the user when a sick period passes day 14.
- **Vacation days taken:** \`gnubok_register_absence\` has no vacation type. Vacation lines are added to the employee's payslip in the salary run in Accounted. Check the balance first with \`gnubok_get_vacation_balance({ employee_id })\` (search-only read) and tell the user if more days are taken than remain.
- **Förmåner, overtime, OB, bonus, traktamente:** benefits are registered per employee in Accounted (the employee's förmåner), and the calculation adds a taxable, avgift-bearing line for each active benefit. Overtime, bonus and other extra lines are added to the run in the web UI. Over MCP you can only edit an existing line on a draft run: \`gnubok_update_payslip_line({ salary_run_id, salary_line_item_id, amount | quantity | unit_price | description })\`. Guide the user to the web UI for new lines and wait until they say it is done. A benefit is taxable even though no cash is paid: never drop a benefit the user mentions.

Each of these stages a pending operation. Get them approved before calculating, or the calculation will not see them.

### Step 3: Questions before calculating

Confirm in one short message: the employees on the run (and anyone expected but missing), each owner or variable salary, the absence registered, benefits and extra lines in place, and the payment date. Calculate only when the user says it is complete.

### Step 4: Calculate

\`gnubok_calculate_salary_run({ salary_run_id })\` (draft only; safe to rerun). Accounted computes gross, skatteavdrag from the tax table, net, arbetsgivaravgifter per employee (31.42 % standard; reduced rates for older employees and the temporary youth rate where they apply) and semesterlöneskuld. Never recompute or override these yourself. Pass every entry in \`warnings\` to the user.

After any approved change (salary, absence, payslip line, payment date) calculate again.

### Step 5: Review with the user

\`gnubok_get_salary_run({ salary_run_id })\` for totals and per-employee figures; \`gnubok_get_payslip({ salary_run_id, employee_id })\` (search-only read) for one employee's lines and calculation breakdown.

Present per employee: gross, skatteavdrag, net, arbetsgivaravgifter; then run totals. Point out what a consultant would notice: a net much higher than usual without a reason, tax of 0 on a normal salary, a reduced avgift rate, 0 gross that is not a planned nollkörning, a sick deduction that looks too large or too small.

### Step 6: Questions before booking

Ask one explicit question: "Stämmer beloppen? När jag bokför skapas ett verifikat som inte kan ändras, bara rättas." Also confirm the payment date and that the net amounts will actually be paid then. Book only on a clear yes.

### Step 7: Book

\`gnubok_book_salary_run({ salary_run_id })\` stages the booking; every employee must be calculated first. The approval is high risk and needs \`confirmed: true\` on \`gnubok_approve_pending_operation\` (or the user approves in Granskning). On commit the run becomes booked and the lön verifikat is posted: salary cost 7210 (7220 for company owners), withheld tax 2710, avgifter 7510 against 2731, vacation accrual to 2920 and 2940, net pay against 1930.

That verifikat already credits 1930 and books the tax and avgift liabilities. When the bank payment and the skattekonto draw show up, they are matched against it, never booked a second time (\`bank-reconciliation\`).

### Step 8: AGI

1. **Generate:** \`gnubok_generate_agi({ salary_run_id })\` stages the AGI underlag. The run must be past draft; book first so the AGI matches the books.
2. **File, when Skatteverket is connected:** \`gnubok_agi_submit({ salary_run_id })\` stages the filing. Approval sends the underlag and returns a BankID signing link: **nothing is filed until the user signs** at Skatteverket. Afterwards \`gnubok_agi_status({ salary_run_id })\` (search-only read) shows the filing state and kvittensnummer.
3. **Not connected** (\`connected: false\`, or a filing error about the connection): give the user the \`connect_url\` from \`gnubok_connect_skatteverket\` (they authorise with BankID as firmatecknare) and offer the manual path. **Not available** (\`available: false\`, or error \`EXTENSION_DISABLED\`): only the manual path exists. Manual path: download the AGI file from the salary run in Accounted and upload it in Skatteverket's e-tjänst for arbetsgivardeklaration, then sign there.

**Deadline:** the AGI and payment of tax and avgifter are due on the 12th of the month after the payment month; in January and August it is the 17th for companies with turnover up to 40 MSEK; a weekend or holiday moves it to the next business day. The money must be on the skattekonto by then. Late filing costs a förseningsavgift (625 kr, 1 250 kr when repeated). Always state the concrete date for this run, and warn clearly if it is close or past.

A month with nobody paid: a registered employer still files an AGI with only the huvuduppgift (a nolldeklaration); in Accounted that is a run with no employees on it. Ask whether the company is registered as employer before assuming one is needed.

## A run that is already booked

\`gnubok_book_salary_run\` answers "already booked" and \`gnubok_calculate_salary_run\` refuses anything past draft. A booked salary verifikat is never edited or deleted (BFL 5 kap 5 §). If the user finds an error (wrong salary, missed sick day, forgotten benefit):

- The fix is a **rättelsekörning**, started from the booked run under Löner in Accounted. It reverses the original verifikat with storno entries and creates a new draft run for the same period with the same lines. There is no MCP tool for it: guide the user there.
- Then continue from Step 2 on the new draft run: change, calculate, review, book.
- The AGI must be corrected too: a corrected AGI replaces the whole declaration for that period. Generate and file it for the new run; if the original was already filed, tell the user the corrected one must be filed as well.
- If the period is locked or the year closed, stop (see Stop conditions).

## When a tool call fails

- **Validation** ("must be YYYY-MM-DD", "Invalid employee: ...", jämkning dates missing): fix the argument from facts you have, or ask. Never fill a field with a plausible guess.
- **\`VALIDATION_ERROR\` from calculation:** an employee lacks required data (tax table for A-skatt, hourly rate, negative salary, a work schedule that does not fit the company's calculation rules). Check each employee with \`gnubok_get_employee\`, name the gap to the user, stage the fix, calculate again.
- **\`SALARY_RUN_TAX_TABLE_MISSING\`:** tax tables could not be fetched. Retry once after a short wait; if it fails again, stop and tell the user.
- **\`SALARY_RUN_CALCULATE_FAILED\`:** the run is not a draft. Read its status with \`gnubok_get_salary_run\`. Booked: see "A run that is already booked".
- **Not found** (run or employee): wrong id or wrong company. Recheck \`company_id\` first.
- **Conflict** ("already exists for this period", overlapping avvikelseperiod, "already booked"): the state is not what you assumed. Read it, explain it, ask. Never create a duplicate.
- **Period locked or closed** (\`period_status\` in a preview, or the commit is refused): do not work around it, and do not move the payment date to dodge the lock. Tell the user; unlocking is their decision (\`month-end-close\`).
- **Capability gate** (the EF owner error, \`EXTENSION_DISABLED\`): the company's legal form or the environment does not allow it. Explain and offer the right path (eget uttag, manual AGI).
- **Staged for approval** (\`staged: true\`): not an error; nothing has happened yet. Never retry a write because it "did nothing": check \`gnubok_list_pending_operations\` first.

## Approval discipline

- Every write in this skill stages a pending operation. The user approves in chat (you call \`gnubok_approve_pending_operation\` on a clear yes, with \`confirmed: true\` for high-risk operations) or in Granskning in Accounted. A widget-capable client can show them with \`gnubok_list_pending_operations({ render_ui: true })\` (optional); without widgets, list them in chat: what, who, amount.
- Never invent amounts, dates, tax tables or personnummer. Every number comes from the user, the employee record or Accounted's calculation.
- If you add or compare amounts yourself, round to whole öre (two decimals), never with toFixed. Account numbers are strings ("7210").
- Never delete anything, never edit a booked run or a posted verifikat, never bypass approval.
- Changed bank details on an employee are a fraud risk: when \`gnubok_update_employee\` touches \`clearing_number\` or \`bank_account_number\`, say so explicitly and ask the user to confirm it with the employee directly.

## Stop conditions: this needs a human

Stop and hand over when:

- The user asks how much salary an owner should take, or about 3:12, dividend versus salary, or löneväxling.
- An EF owner wants to be on payroll.
- A correction touches a locked period or a closed fiscal year.
- A foreign employee, work abroad, SINK, or someone with F-skatt the user wants to run as salary.
- A car benefit or other förmån whose value the user does not know.
- The deadline has passed, or Skatteverket has sent a letter about the AGI.

Phrase it as: "Det här behöver en människa (din redovisningskonsult eller Skatteverket): här är vad jag hittade ...", followed by the facts and exactly what they need to decide.

## Vacation year

Once a year, after the vacation year ends: \`gnubok_close_vacation_year\` stages the semesterårsavslut (rolls balances forward, sends expired saved days to forced payout, may book a 2920/2940 adjustment). High risk: walk the user through the preview before approval. Forced payouts are paid as semesterersättning in the next salary run.

## Report at the end

In the user's language, short groups:

- **Done:** run, period, payment date, totals (gross, tax, avgifter, net).
- **Staged for approval:** each pending operation.
- **Needs your answer:** each open question, with the facts.
- **Could not do (and why):** e.g. lines that must be added in the web UI, Skatteverket not connected.
- **Next step:** the AGI deadline (the date), paying net salaries and the skattekonto before it, matching the payments in \`bank-reconciliation\`.

## Tools

- \`gnubok_list_companies\`, \`gnubok_get_agent_briefing\`, \`gnubok_list_fiscal_periods\`, \`gnubok_connect_skatteverket\` (orientation, read)
- \`gnubok_list_employees\`, \`gnubok_get_employee\`, \`gnubok_get_salary_journal\` (read; the last two via \`gnubok_call_tool\` when not listed)
- \`gnubok_create_employee\`, \`gnubok_update_employee\`, \`gnubok_set_employee_opening_balances\` (staged writes)
- \`gnubok_create_salary_run\`, \`gnubok_update_salary_run\` (via \`gnubok_stage_tool\` when not listed), \`gnubok_set_run_salary\`, \`gnubok_update_payslip_line\` (staged writes, draft runs)
- \`gnubok_register_absence\`, \`gnubok_delete_absence\` (staged), \`gnubok_list_absence\`, \`gnubok_get_vacation_balance\` (read)
- \`gnubok_calculate_salary_run\` (draft only, rerunnable), \`gnubok_get_salary_run\`, \`gnubok_get_payslip\` (read)
- \`gnubok_book_salary_run\` (staged, high risk)
- \`gnubok_generate_agi\`, \`gnubok_agi_submit\` (staged; filing needs BankID), \`gnubok_agi_status\` (read)
- \`gnubok_close_vacation_year\` (staged, high risk, yearly)
- \`gnubok_list_pending_operations\`, \`gnubok_approve_pending_operation\` (approval)
`

export const payrollMonthlySkill: Skill = {
  slug: 'payroll-monthly',
  name: 'Lön och AGI',
  summary: 'Monthly salary run and AGI: check employees and legal form, register absence and changes, calculate, review, book, then generate or file the AGI before the deadline.',
  tags: ['monthly', 'payroll', 'lön', 'agi', 'arbetsgivardeklaration', 'compliance'],
  body,
  tier: 'workflow',
  // Only relevant when the company actually has employees. EF without payroll
  // (most sole traders) shouldn't see this in the discovery list.
  applicability: { entity_type: 'both', requires: ['employees'] },
}
