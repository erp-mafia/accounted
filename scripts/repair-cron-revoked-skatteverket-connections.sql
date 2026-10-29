-- One-shot repair for #115 (b), 2026-10-28. Run it by hand against prod only
-- AFTER the fix (fix/background-jobs-fail-loudly) is deployed; before that,
-- the next unexplained 403 can write the same state again.
--
-- Until the fix, a single unexplained system-mode 403 from Skatteverket
-- (OMBUD_GRANT_MISSING) made the skattekonto or VAT receipt cron write
-- status 'revoked' on the company's connection row once no behorighet was
-- left granted. 'revoked' is the value of the user's own "Koppla från", and
-- the nightly ombudsregister sync skips revoked rows for good, so the
-- connection stayed off even when the company's grant still stood at
-- Skatteverket.
--
-- Which rows: status 'revoked' with at least one behorighet 'denied'. The
-- user's disconnect (markConnectionRevoked) writes 'revoked' with both
-- behorigheter 'unknown', and nothing else writes 'revoked', so a 'denied'
-- one can only come from the cron. A user who disconnected after the cron's
-- write has both 'unknown' again and is left alone.
--
-- What changes: status becomes 'pending'. The grant columns stay as they are:
-- only the register grants. At 03:30 the ombudsregister sync reads these rows
-- again and records what the register lists (granted rows switch back on,
-- withdrawn ones stay denied). Idempotent: a second run finds no rows.

-- 1. Dry run: what will change. Compare the count with step 2's.
select c.company_id, c.environment, c.lasombud_status, c.moms_ombud_status, c.last_error, c.updated_at
from public.skatteverket_company_connections c
where c.status = 'revoked'
  and 'denied' in (c.lasombud_status, c.moms_ombud_status)
  and not exists (select 1 from public.company_migration_resets m where m.source_company_id = c.company_id)
order by c.updated_at;

-- 2. Repair
begin;

update public.skatteverket_company_connections c
set status = 'pending'
where c.status = 'revoked'
  and 'denied' in (c.lasombud_status, c.moms_ombud_status)
  and not exists (select 1 from public.company_migration_resets m where m.source_company_id = c.company_id)
returning c.company_id, c.environment;

commit;
