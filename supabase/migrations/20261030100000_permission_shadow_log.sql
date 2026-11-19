-- Permission shadow log (rights wave W2b).
-- pg-test: tests/pg/permission-shadow-log.pg.test.ts
--
-- WHY
-- ---
-- decide() (src/lib/permissions/decide.ts) will replace the role and scope
-- checks at every door. Before it enforces anything it runs next to today's
-- checks in shadow mode (src/lib/permissions/shadow.ts) and changes nothing;
-- where its answer differs from what today's code did, one row lands here.
-- Read over a week, the unexplained rows (expected = false) are what
-- enforcement waits for.
--
-- WHAT
-- ----
-- public.permission_shadow_log: ids and codes only (no request body, no
-- name, no free text), written by the service role after the response,
-- deduplicated in the application. Read and written by the service role
-- only: RLS on with no policy, and no grant to anon or authenticated.
-- Seven days of retention, swept by /api/permissions/shadow-log/cleanup/cron.
--
-- No foreign keys: a short-lived diagnostic log must never block account
-- erasure or sandbox teardown (DELETE FROM auth.users / companies), and its
-- rows age out within the week either way. No audit trigger: it records no
-- business change. No updated_at: rows are never updated.

CREATE TABLE public.permission_shadow_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  -- The person, or the sponsor an agent acts for.
  user_id           uuid NOT NULL,
  agent_identity_id uuid,
  api_key_id        uuid,
  principal_kind    text NOT NULL
    CONSTRAINT permission_shadow_log_principal_kind_check
    CHECK (principal_kind IN ('person', 'agent', 'assistant')),
  -- 'session:<operation>', 'v1:<operation>', 'mcp:<tool>', 'ext:<extension><path>', 'assistant:<tool>'.
  door              text NOT NULL
    CONSTRAINT permission_shadow_log_door_check CHECK (char_length(door) BETWEEN 1 AND 200),
  method            text
    CONSTRAINT permission_shadow_log_method_check CHECK (method IS NULL OR char_length(method) <= 10),
  today_outcome     text NOT NULL
    CONSTRAINT permission_shadow_log_today_outcome_check
    CHECK (today_outcome IN ('allow', 'stage', 'deny')),
  today_code        text
    CONSTRAINT permission_shadow_log_today_code_check CHECK (today_code IS NULL OR char_length(today_code) <= 64),
  decide_outcome    text NOT NULL
    CONSTRAINT permission_shadow_log_decide_outcome_check
    CHECK (decide_outcome IN ('allow', 'stage', 'sign', 'deny')),
  decide_reason     text NOT NULL
    CONSTRAINT permission_shadow_log_decide_reason_check CHECK (char_length(decide_reason) BETWEEN 1 AND 64),
  permission        text NOT NULL
    CONSTRAINT permission_shadow_log_permission_check CHECK (char_length(permission) BETWEEN 1 AND 64),
  expected          boolean NOT NULL,
  expected_reason   text
    CONSTRAINT permission_shadow_log_expected_reason_check
    CHECK ((expected = (expected_reason IS NOT NULL)) AND (expected_reason IS NULL OR char_length(expected_reason) <= 64)),
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.permission_shadow_log IS
  'Where decide() disagreed with what a door''s checks did, in shadow mode (src/lib/permissions/shadow.ts): ids and codes only. Service role only; kept 7 days (/api/permissions/shadow-log/cleanup/cron).';
COMMENT ON COLUMN public.permission_shadow_log.today_code IS
  'The code of the check that refused (ROLE_READ_ONLY, WRITE_REQUIRED, HANDLER_FORBIDDEN, ...), or DRY_RUN.';
COMMENT ON COLUMN public.permission_shadow_log.expected IS
  'True for a difference the rights plan intends (expected_reason says which); only false rows count toward enforcement.';

CREATE INDEX idx_permission_shadow_log_created_at ON public.permission_shadow_log (created_at);

ALTER TABLE public.permission_shadow_log ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON TABLE public.permission_shadow_log TO service_role;
-- no-grant: authenticated on public.permission_shadow_log (service-role only: written after the response and read through the service role)
-- no-grant: anon on public.permission_shadow_log (service-role only: no public surface reads it)

NOTIFY pgrst, 'reload schema';
