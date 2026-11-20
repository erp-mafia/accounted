-- skatteverket_api_audit_log.user_id: allow NULL for system calls.
--
-- The Skatteverket transport now writes one audit row per outbound call
-- itself instead of leaving it to each route. Background reads on Accounted's
-- own ombud credentials (kvittens crons, the skattekonto sync, grant probes)
-- run for a company with no user behind them. NULL user_id records exactly
-- that: a call the system made with no user. Every call a person caused keeps
-- naming that person.
--
-- Nothing else changes: the column has no foreign key, RLS still scopes rows
-- by company_id, and the immutability and migration-reset triggers are
-- untouched. The migration-reset and fiscal-year-reset guards read endpoint,
-- outcome and redovisningsperiod only, never user_id.

ALTER TABLE public.skatteverket_api_audit_log
  ALTER COLUMN user_id DROP NOT NULL;

COMMENT ON COLUMN public.skatteverket_api_audit_log.user_id IS
  'The user who caused the outbound call. NULL: a call the system made with no user (background ombud reads).';

NOTIFY pgrst, 'reload schema';
