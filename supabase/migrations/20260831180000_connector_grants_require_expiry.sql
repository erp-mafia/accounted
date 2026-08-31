-- Require an expiry on every source='connector' capability grant.
--
-- Connector grants are the self-host instance's offline cache: the hourly
-- connector sync writes them with expires_at = min(now + 72h, period_end + 3d)
-- and deletes them when the subscription lapses. Both the TS gate
-- (lib/entitlements/has-capability.ts grantIsActive) and the SQL helper
-- (public.company_has_capability) treat a NULL expires_at as active forever,
-- so a hand-written connector row without an expiry would be a permanent
-- unlock that no sync ever revokes. No writer legitimately produces that
-- shape; make the database refuse it (CodeRabbit finding on PR #1747,
-- defense in depth on top of the sync's own arithmetic).
--
-- Safe to validate inline: 'connector' entered the source CHECK only in
-- 20260831170000 (this same PR) and no code path has written a connector row
-- yet, so no existing row can violate the constraint. The table is small
-- (a handful of grant rows per company); the ACCESS EXCLUSIVE lock is brief.

ALTER TABLE public.capability_grants
  ADD CONSTRAINT capability_grants_connector_expiry_check
  CHECK (source <> 'connector' OR expires_at IS NOT NULL);

COMMENT ON CONSTRAINT capability_grants_connector_expiry_check
  ON public.capability_grants IS
  'Connector grants are a short-lived offline cache written by the instance connector sync; a NULL expiry would be a permanent unlock nothing revokes.';
