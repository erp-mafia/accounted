-- Validate the suggestion_log CHECKs re-added NOT VALID in 20261016150000.
-- Separate transaction: avoids a full-table scan under the stronger lock of
-- the preceding migration (same split as 20261016120200). VALIDATE CONSTRAINT
-- only reads the rows; nothing is rewritten.
-- pg-test: covered-by tests/pg/suggestion-log.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.suggestion_log
  VALIDATE CONSTRAINT suggestion_log_kind_check;
ALTER TABLE public.suggestion_log
  VALIDATE CONSTRAINT suggestion_log_subject;
