-- A new company starts on the semesterlagen's semesterår, 1 April to 31 March
-- (3 §): a company_settings row inserted from now on without a basis gets
-- 'statutory_apr_mar' instead of 'calendar'.
--
-- Only the column default changes. SET DEFAULT applies to later INSERTs and
-- rewrites no row, so every existing company keeps the basis it has stored:
-- the column is NOT NULL, and each row from before this migration holds
-- 'calendar' unless the company chose otherwise (rows that existed when
-- 20260713122000 added the column read the 'calendar' it was added with).
-- pg-test: covered-by tests/pg/vacation-year-basis-default.pg.test.ts

-- company_settings is read on nearly every request: fail the migration job
-- instead of queueing reads behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.company_settings
  ALTER COLUMN salary_vacation_year_basis SET DEFAULT 'statutory_apr_mar';

NOTIFY pgrst, 'reload schema';
