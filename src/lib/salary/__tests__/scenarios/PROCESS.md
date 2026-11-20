# Payroll process scenarios (area d)

The calculation scenarios in this folder (`*.scenarios.ts`) run as unit tests. The
scenarios below cross the database, the bookkeeping engine, the bank or
Skatteverket, so they are a checklist: run each on a test company (never the
production database behind `.env.local`) before a payroll release that touches the
flow, and whenever an agreement feature or the vacation liability true-up lands.

Each item states the setup, the expected system behaviour, how to check it, the
code or tests that cover part of it, and what stays manual. The `*.pg.test.ts`
files run against real Postgres (`npm run test:pg`, Docker); they first run in
CI, not on a machine without Docker.

## P1. Booking into a locked period

- **Setup:** an approved and paid salary run whose payment date falls in a fiscal
  period that is locked (or behind the company lock date).
- **Expected:** booking refuses with `PERIOD_LOCKED` before anything is posted. No
  verifikat, no voucher number consumed (no gap), the run stays `paid`. The same
  holds for the vacation year close adjustment and, once built, the monthly
  true-up: they check the lock first and write nothing.
- **Check:** lock the period, book the run (dashboard, v1 `:book`, or MCP
  `accounted_book_salary_run`), confirm the refusal names the period; the
  journal's voucher sequence and `voucher_gap_explanations` are unchanged.
  Unlock, book again: the vouchers take the next numbers.
- **Covered by:** `book-run.ts` (lock pre-check), `semesterberedning.ts`
  `commitVacationYearClose` (lock pre-check), DB triggers as the backstop;
  `book-run.test.ts` ("refuses a payment date in a locked period with
  PERIOD_LOCKED before claiming or posting"), `semesterberedning.test.ts`
  ("fails cleanly when the adjustment period is locked"). The true-up
  (`vacation-liability-reconcile.ts`): `vacation-liability-reconcile.test.ts`
  ("refuses a locked period before anything posts", "to remeasure in a locked
  period: refused, the method stays") and the route test
  (`src/app/api/salary/vacation-liability/__tests__/routes.test.ts`, the
  refusal in Swedish).
- **Manual:** that the voucher sequence and `voucher_gap_explanations` are
  unchanged after a refusal; the unit tests stop before the database.

## P2. Booking retry and concurrent booking

- **Setup:** a paid run; interrupt the booking after the first verifikat is
  posted (or fire two booking calls at once).
- **Expected:** `createSalaryRunEntries` posts all of the run's vouchers or none;
  a retry adopts what is already in the ledger instead of posting it twice. Of
  two concurrent calls exactly one takes the booking claim and posts; the other
  is refused. The run ends `booked` once, with 2 to 4 vouchers and no gap.
- **Check:** journal for the run's `source_id`: each voucher kind (salary,
  avgifter, vacation, pension) appears once; trial balance 7xxx/27xx/1930 equals
  the run totals.
- **Covered by:** `book-run.ts` booking claim, `book-run.test.ts` (claim
  before posting, SALARY_RUN_ALREADY_BOOKED for the concurrent call, claim
  released on a throw or a refused pre-check); pg-real
  `tests/pg/salary-run-booking-claim.pg.test.ts`.
- **Manual:** interrupting a real booking after the first verifikat.

## P3. Correction run (storno)

- **Setup:** a booked run with a wrong figure (for example a sick day priced
  under the wrong convention).
- **Expected (BFL 5 kap 5 §):** every original voucher is reversed by storno
  (`reverseEntry`, new voucher numbers, nothing edited or deleted), the original
  run becomes `corrected`, its emailed payslip links show "ersatt", and a new
  draft run (`is_correction = true`, `corrects_run_id` set) carries a copy of the
  roster and lines. Recalculate, approve and book the draft: the ledger nets to
  the corrected amounts. A reversal failure part-way (`REVERSAL_FAILED`) leaves
  the posted stornos in place and a retry continues with the rest.
- **Check:** original + storno sum to zero per account; the correction run's
  vouchers equal its totals; the vacation ledger is re-synced for the employees.
- **Covered by:** `correct-run.ts`, `correct-run.test.ts` (storno order,
  resume past reversed entries, stop at the first storno failure),
  `correct-run.engine-input.test.ts`.
- **Manual:** the "ersatt" payslip link and the ledger netting per account on a
  test company.

## P4. An agent proposes a wrong agreement value

- **Setup:** an MCP agent stages an agreement rule with a wrong value, for
  example Almega kvälls/natt-OB at månadslön / 400 instead of / 480
  (`agreements.scenarios.ts` AG-01 cites the text), or a Handels overtime
  premium of 50 % for work after 1 April 2026 (AG-07: 35 %).
- **Expected:** the change is a staged pending operation, never applied
  directly; the review shows the proposed value next to the agreement's value
  and its citation; nothing already calculated changes until a person approves;
  rejecting leaves the rule set as it was. A value outside the plausible range
  of its amount form is refused at validation. Approving a wrong value is the
  person's act and is visible in the audit trail with who and when.
- **Check:** stage through `accounted_stage_tool`, confirm the pending
  operation and that a recalculation of an open draft gives the old figures;
  reject; confirm no rule row changed.
- **Covered by:** the plausible-range bounds per amount form
  (`shift_premium_rules_amount_bounds_check`, migration 20261027160000;
  pg-real `tests/pg/shift-premium-rule-forms.pg.test.ts`); the v1 and
  dashboard premium-rule routes (Idempotency-Key, dry-run; their route tests);
  a calculated run keeps its premium lines with the rule's frozen
  `premium_basis` until it is recalculated (`run-calculation-premium-rules.test.ts`).
- **Gap:** there is no MCP tool for premium rules, so no staged pending
  operation either: an API-key agent writes through v1
  `POST/PATCH /salary/premium-rules` directly (dry-run available). The review
  with the agreement's value and citation stays manual.

## P5. An expired agreement

- **Setup:** an agreement rule valid to 2026-03-31 with no successor entered,
  and a pay period 2026-03-16 to 2026-04-15 with OB hours on both sides.
- **Expected:** hours worked up to 31 March get the old rate; hours from
  1 April get no rate from the expired rule, and the calculation warns by name
  (agreement, rule, first uncovered date) instead of silently carrying the old
  rate forward. With a successor rule entered, the period splits per worked
  date (AG-07 Handels 50 % to 35 %, AG-09 Gröna Riks 26,79 to 27,59 kr/h).
- **Check:** run the period without and with the successor; compare with
  AG-07 and AG-09.
- **Covered by:** AG-17 (an expired rule without a successor pays the days up
  to valid_to and nothing after: no carry-forward), AG-07 and AG-15 (the
  successor splits the period per worked date), `run-calculation-premium-rules.test.ts`
  ("follows the rate step per day").
- **Gap:** no warning names the agreement, the rule and the first uncovered
  date; hours after valid_to are silently unpriced.

## P6. Pay via bank after a correction

- **Setup:** the original run was paid through the bank (payments `executed`),
  then corrected; the correction draft is approved.
- **Expected:** the employees were already paid the original net once. Paying
  the correction run must not send the full net a second time: either only the
  positive difference per employee is paid (a negative difference becomes a
  claim, for example a nettolöneavdrag next month), or the bank payment is
  refused until the person confirms what has already left the account.
- **Check:** on a test company, prepare the bank payment for the correction run
  and read the amounts per employee before anything is approved.
- **Covered by:** a correction run pays each employee its effective net minus
  the most its corrected chain paid them, an overpayment is named and never
  paid or deducted (migration 20261027160500, `salary_run_payable_amounts`;
  `payment/payable.ts`). Unit: `payment/__tests__/pay-via-bank.test.ts`
  ("prepareSalaryBankPayment on a correction run": the difference, a new
  employee in full, a chain of two corrections, nothing to pay, refusal when
  the corrected run cannot be read), `payable.test.ts`,
  `build-payment-file.test.ts` and `bank-list.test.ts` (the pain.001/LB file and
  the bank list carry only the difference). pg-real:
  `tests/pg/salary-correction-pays-difference.pg.test.ts`
  (`create_salary_payment_orders` pays only a positive difference and settles
  the correction once those are executed).
- **Manual:** one correction paid through the real bank provider on a test
  company before the first customer correction.

## P7. AGI after a correction

- **Setup:** the original run's AGI was submitted; the run was corrected and the
  correction booked.
- **Expected:** generating the AGI for the correction run replaces the
  period's declaration wholesale: same redovisningsperiod, the same FK570
  specifikationsnummer per employee (a different number would add a record
  instead of replacing it), `is_correction = true`, status back to `generated`
  so the correction gets its own kvittens; the original's kvittens is kept.
  Any other run in the same period that is not corrected makes the generator
  refuse with `AGI_PERIOD_CONFLICT`.
- **Check:** diff the two XML files: FK570 per employee identical, amounts per
  the correction run.
- **Covered by:** `agi/generate-declaration.ts`, `agi-generate-declaration.test.ts`
  (a corrected run's declaration is the one replaced; the original's filing
  state is reset); pg-real `tests/pg/agi-kvittenser.pg.test.ts`; source:
  `.claude/skills/swedish-payroll/references/agi-filing.md` lines 53-55.
- **Manual:** the XML diff (FK570 per employee identical) and a test filing.

## P8. Catch-up when the vacation liability true-up is switched on

- **Setup:** a company that has booked only the per-run accruals for nine months
  (under sammalöneregeln that is the tillägg only, VL-12) switches the monthly
  true-up on in October.
- **Expected:** the first true-up books target minus booked for 2920 and 2940 in
  one verifikat (VL-16 has the numbers: 28 732,65 and 9 027,80 kr for one
  employee), dated in the first open period and never in a locked one, with the
  per-employee calculation as underlag. Running it again for the same month
  books nothing. The next year close then finds a drift under 1 kr.
- **Check:** preview before switching on, book, then read 2920/2940 in the
  trial balance against the preview; rerun the month and confirm no second
  verifikat.
- **Covered by:** VL-13 to VL-16 (the valuation and the remeasurement
  verifikat: target, entry and the 7290/2920, 7519/2940 sides);
  `vacation-liability-reconcile.test.ts` ("to remeasure: books the first
  catch-up, then switches", "books nothing when the books already hold the
  computed liability, so a repeat is harmless", the locked period);
  `vacation-liability-valuation.test.ts` ("the close values the same liability
  the remeasurement booked on the year end, so its drift is nil"); the method
  switch route (`routes.test.ts`, the pinned preview); pg-real
  `tests/pg/vacation-liability-remeasure.pg.test.ts` (method column, one
  remeasurement per run, RLS).
- **Manual:** the trial balance against the preview on a test company, and a
  real year close after a remeasured year.
