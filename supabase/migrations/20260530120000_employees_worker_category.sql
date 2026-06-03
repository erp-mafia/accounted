-- Migration: employees.worker_category — blue-collar vs white-collar split.
--
-- Why this exists: SCB KLP (Konjunkturstatistik, löner för privat sektor)
-- reports employees in three buckets — timavlönade arbetare, månadsavlönade
-- arbetare and tjänstemän. gnubok already knows salary_type (hourly/monthly)
-- but not whether a person is an "arbetare" (worker) or "tjänsteman"
-- (salaried/white-collar). This column carries that classification.
--
-- Bucketing for KLP: arbetare+hourly → At*, arbetare+monthly → Am*,
-- tjansteman → Tm*. Nullable: existing rows are unclassified; the report
-- treats null as tjänsteman and surfaces a "needs classification" warning.

ALTER TABLE public.employees
  ADD COLUMN worker_category TEXT
    CHECK (worker_category IS NULL OR worker_category IN ('arbetare', 'tjansteman'));

NOTIFY pgrst, 'reload schema';
