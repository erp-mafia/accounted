-- salary_line_items.source_benefit_id: ON DELETE SET NULL -> NO ACTION (#2801).
-- pg-test: tests/pg/salary-benefit-source-fk.pg.test.ts
--
-- Step 8d of lib/salary/run-calculation.ts replaces derived benefit lines by
-- this back-link (delete where source_benefit_id is not null, then re-derive
-- from the active employee_benefits rows). Under SET NULL, deleting a benefit
-- nulled the link on every line it had produced, which turned a derived line
-- into an apparent manual one: no later recalculation removed it, so the
-- employee stayed taxed on a removed förmån and the AGI individuppgift carried
-- it (#2695). No immutability trigger guards salary_line_items, so the same
-- delete also silently rewrote lines beneath booked runs.
--
-- #2734 and #2760 guarded this in application code with a count of
-- referencing lines before the delete. A recalculation can insert its derived
-- line between that count and the delete, so the invariant was never really
-- held. It belongs here: with NO ACTION, Postgres refuses the delete (23503)
-- whenever any line references the benefit, including one committed by a
-- calculation racing the request, because the derived insert takes FOR KEY
-- SHARE on the benefit row and the delete must wait for it.
-- lib/salary/employee-benefits.ts catches 23503 and deactivates the row.
--
-- NO ACTION, not RESTRICT: this mirrors the recurring-lines back-link
-- (20260902140000), which chose NO ACTION so that a company delete, which
-- reaches employee_benefits and salary_line_items along separate cascade
-- paths, is checked once both sides are gone instead of depending on the
-- order the cascades happen to fire in. For the single-row delete that the
-- race is about, the two actions refuse identically.
--
-- The other parents of employee_benefits cannot meet a referencing line:
-- employees is unreachable because salary_run_employees.employee_id is ON
-- DELETE RESTRICT (an employee with any payslip line cannot be deleted), and
-- auth.users rows are never deleted (account erasure keeps a tombstone).
--
-- One ALTER TABLE so the drop and the add are a single atomic step with no
-- window in which the column is unconstrained. DROP CONSTRAINT deliberately
-- has no IF EXISTS: were the name ever different, IF EXISTS would skip the
-- drop and leave the SET NULL key live beside the new one, silently defeating
-- this migration. The re-add revalidates existing rows, which the outgoing
-- key already guarantees; salary_line_items is a few thousand rows on prod,
-- so the NOT VALID / VALIDATE split used for larger tables is not warranted.
-- No data is rewritten.

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT salary_line_items_source_benefit_id_fkey,
  ADD CONSTRAINT salary_line_items_source_benefit_id_fkey
    FOREIGN KEY (source_benefit_id) REFERENCES public.employee_benefits(id);

NOTIFY pgrst, 'reload schema';
