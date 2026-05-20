-- Phase C intake conversation support.
--
-- verification_questions stores the composer's high-leverage uncertainties
-- so the intake agent can read them server-side when the chat opens. Today
-- they are streamed to the client and used by Phase B's inline question
-- stepper, but never persisted — meaning the chat agent has no way to know
-- what was asked or skipped. Persisting them closes that loop.
--
-- intake_completed_at marks the moment the user finishes (or explicitly
-- ends) the intake conversation. NULL = intake still pending; other intents
-- may opportunistically ask one more intake-style question when this is
-- still NULL. Plan ref: dev_docs/specialized-agent-plan.md §7 Phase C.

ALTER TABLE agent_profiles
  ADD COLUMN IF NOT EXISTS verification_questions text[],
  ADD COLUMN IF NOT EXISTS intake_completed_at timestamptz;

NOTIFY pgrst, 'reload schema';
