-- pending_operations.rejection_category: tell the system's rejections apart
-- from a person's.
--
-- A rejected operation was either judged by a person (what they said was
-- wrong) or closed by the system without anyone judging it: it expired after
-- 30 days, it was replaced or handled another way, or it failed when it was
-- approved. Until now the system wrote no category at all, so its rows looked
-- like a person's rejection that gave no reason, and any count of "why people
-- say no" was diluted by expiries and failed commits.
--
-- Three system values join the five a person can pick:
--   expired     the expiry cron closed it unanswered
--   superseded  replaced by a newer proposal, or handled another way
--   failed      a person approved it and the approval did not complete
--
-- One column, not a separate flag: every rejection now says why, and "a
-- person's verdict" is the five person values. The route schemas and the MCP
-- tool accept only the person values (plus 'superseded' from the assistant's
-- own regenerate flow); the system values are written by the system.
--
-- No backfill: rejected rows are immutable (pending_operations_immutability,
-- BFL 7 kap.). Older system rejections keep NULL and stay recognisable by
-- result_data (auto_rejected, threw).

ALTER TABLE public.pending_operations
  DROP CONSTRAINT pending_operations_rejection_category_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_rejection_category_check
  CHECK (rejection_category IS NULL OR rejection_category IN (
    'wrong_category',
    'wrong_amount',
    'duplicate',
    'wrong_period',
    'other',
    'expired',
    'superseded',
    'failed'
  ));

COMMENT ON COLUMN public.pending_operations.rejection_category IS
  'Why the operation was rejected. A person''s verdict: wrong_category, wrong_amount, duplicate, wrong_period, other. Written by the system, no verdict: expired, superseded, failed. NULL on rejections recorded before the system values existed.';
