-- Makes a BankID session usable exactly once, atomically.
--
-- The BankID flow now lives in a cookie rather than per-tab client storage, so
-- every tab of the browser shares one session. That is what lets the tab the
-- BankID app returns the user to finish a flow another tab started, and it is
-- also why two tabs can observe `status: complete` inside the same poll tick
-- and both try to finish it.
--
-- Both would call supabase.auth.admin.generateLink(), and the second magic link
-- invalidates the first, so whichever tab the user is actually looking at may
-- be the one that fails with "Inloggningen med BankID misslyckades".
--
-- Clearing the flow cookie on the way out does NOT prevent this: a Set-Cookie
-- only takes effect once a response reaches the browser, so two requests that
-- both already carried the cookie both pass the check. There is no shared
-- process memory to coordinate in on serverless either. A unique index is the
-- only thing here that is genuinely atomic: the second INSERT raises 23505 and
-- that request stops before minting anything.
--
-- Rows are bookkeeping, not business data: a BankID session id is meaningless
-- to TIC within the hour, and nothing reads a row back. They are nonetheless
-- retained rather than deleted, so a replayed id is still recognised as spent
-- instead of silently becoming reusable.
--
-- There is deliberately NO cleanup job in this migration. At current volume
-- (single-digit BankID authentications per day) the table takes decades to
-- reach a megabyte, and a pruning cron is a moving part that can fail open.
-- consumed_at is indexed so an age-based prune can be added later without a
-- second migration. What the retention does mean, and is worth being explicit
-- about: this is a permanent record of when each BankID identification
-- happened, which is why the table is service-role only.

CREATE TABLE public.bankid_consumed_sessions (
  session_id TEXT PRIMARY KEY,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- For a future age-based prune; nothing queries it today.
CREATE INDEX idx_bankid_consumed_sessions_consumed_at
  ON public.bankid_consumed_sessions (consumed_at);

ALTER TABLE public.bankid_consumed_sessions ENABLE ROW LEVEL SECURITY;

-- No policies at all, deliberately. The table is written and read only by the
-- TIC extension's BankID handlers through createServiceClient(), which bypasses
-- RLS. Nothing user-facing may see which sessions exist: the ids are bearer
-- credentials for a personnummer and for a Supabase session, and the row set is
-- a record of who authenticated and when.

COMMENT ON TABLE public.bankid_consumed_sessions IS
  'Spent BankID session ids. The PK is the single-use guard for /bankid/complete and /bankid/link; see migration header.';

NOTIFY pgrst, 'reload schema';
