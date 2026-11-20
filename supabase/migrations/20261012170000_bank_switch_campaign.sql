-- Switch campaign: every bank feed still on Enable Banking is connected again
-- through Open Payments before a deadline (OPENPAYMENTS_SWITCH_DEADLINE,
-- lib/bank-feed/switch-campaign.ts). A company's state in the campaign is
-- computed from bank_connections and never stored; what this migration adds
-- is the two things that cannot be computed:
--
--   1. bank_switch_notifications: the per-company send log of the campaign
--      mails (the announcement, the reminders at 14/7/3/1 days, a byrå's
--      nudge), so neither the daily cron nor the byrå action ever sends the
--      same mail twice. Service role only: written by the cron and the byrå
--      route, read back by the same code; nothing in the browser reads it.
--   2. bank_switch_progress(p_uncovered text[]): the operator's counter,
--      totals across every company (pending, done, uncovered, per bank).
--      Service role only. The banks Open Payments does not reach come in as
--      the argument, from the one TypeScript list, so SQL and TypeScript
--      cannot disagree on which banks count as covered.

CREATE TABLE public.bank_switch_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('announcement', 'reminder_14', 'reminder_7', 'reminder_3', 'reminder_1', 'byra_nudge')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0)
);

COMMENT ON TABLE public.bank_switch_notifications IS
  'Send log of the Enable Banking to Open Payments switch campaign mails, one row per mail sent to a company (lib/bank-feed/switch-notifications.ts). Append-only.';

CREATE INDEX bank_switch_notifications_company_kind_idx
  ON public.bank_switch_notifications (company_id, kind, sent_at DESC);

ALTER TABLE public.bank_switch_notifications ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bank_switch_notifications TO service_role;
-- no-grant: authenticated on public.bank_switch_notifications (service-role only: written by the cron and the byrå route, which read it through the service client)
-- no-grant: anon on public.bank_switch_notifications (company data)

-- Totals across companies. An Enable Banking row counts once:
--   switched   it was superseded by an Open Payments connection (the dialog's
--              switch revokes it with superseded_by set), or an Open Payments
--              connection at the same bank is live for the company;
--   uncovered  its bank is on the p_uncovered list (Open Payments does not
--              reach it: file import is the path);
--   pending    an active row at a reachable bank with no Open Payments sibling.
-- Bank names match as the dialog matches them (lib/bank-feed/bank-match.ts):
-- equal after trim and lower-case, else one contained in the other.
CREATE OR REPLACE FUNCTION public.bank_switch_progress(p_uncovered text[] DEFAULT '{}')
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
WITH eb AS (
  SELECT b.company_id,
         coalesce(b.bank_name, '') AS bank,
         lower(btrim(coalesce(b.bank_name, ''))) AS bank_key,
         (b.status = 'revoked' AND b.superseded_by IS NOT NULL) AS superseded
  FROM public.bank_connections b
  WHERE b.aggregator = 'enable_banking'
    AND ((b.status = 'active' AND b.superseded_by IS NULL)
      OR (b.status = 'revoked' AND b.superseded_by IS NOT NULL))
),
op AS (
  SELECT b.company_id, lower(btrim(b.bank_name)) AS bank_key
  FROM public.bank_connections b
  WHERE b.aggregator = 'open_payments'
    AND b.status IN ('active', 'pending_selection', 'expired', 'error')
    AND b.superseded_by IS NULL
    AND btrim(coalesce(b.bank_name, '')) <> ''
),
classified AS (
  SELECT eb.company_id, eb.bank,
    CASE
      WHEN eb.superseded THEN 'switched'
      WHEN EXISTS (
        SELECT 1 FROM unnest(coalesce(p_uncovered, '{}'::text[])) AS n
        WHERE btrim(n) <> '' AND position(lower(btrim(n)) IN eb.bank_key) > 0
      ) THEN 'uncovered'
      WHEN eb.bank_key <> '' AND EXISTS (
        SELECT 1 FROM op
        WHERE op.company_id = eb.company_id
          AND (op.bank_key = eb.bank_key
            OR position(op.bank_key IN eb.bank_key) > 0
            OR position(eb.bank_key IN op.bank_key) > 0)
      ) THEN 'switched'
      ELSE 'pending'
    END AS outcome
  FROM eb
),
per_company AS (
  SELECT company_id,
    count(*) FILTER (WHERE outcome = 'pending') AS pending,
    count(*) FILTER (WHERE outcome = 'uncovered') AS uncovered,
    count(*) FILTER (WHERE outcome = 'switched') AS switched
  FROM classified
  GROUP BY company_id
),
per_bank AS (
  SELECT bank,
    count(*) FILTER (WHERE outcome = 'pending') AS pending,
    count(*) FILTER (WHERE outcome = 'uncovered') AS uncovered,
    count(*) FILTER (WHERE outcome = 'switched') AS switched
  FROM classified
  GROUP BY bank
)
SELECT jsonb_build_object(
  'companies', jsonb_build_object(
    'pending', (SELECT count(*) FROM per_company WHERE pending > 0),
    'uncovered', (SELECT count(*) FROM per_company WHERE pending = 0 AND uncovered > 0),
    'done', (SELECT count(*) FROM per_company WHERE pending = 0 AND uncovered = 0)
  ),
  'connections', jsonb_build_object(
    'pending', (SELECT coalesce(sum(pending), 0) FROM per_company),
    'uncovered', (SELECT coalesce(sum(uncovered), 0) FROM per_company),
    'switched', (SELECT coalesce(sum(switched), 0) FROM per_company)
  ),
  'banks', coalesce((
    SELECT jsonb_agg(
      jsonb_build_object('bank', bank, 'pending', pending, 'uncovered', uncovered, 'switched', switched)
      ORDER BY pending DESC, uncovered DESC, bank
    )
    FROM per_bank
  ), '[]'::jsonb)
);
$$;

COMMENT ON FUNCTION public.bank_switch_progress(text[]) IS
  'Switch campaign counter: Enable Banking rows left to switch, uncovered and switched, across every company and per bank. Service role only.';

REVOKE ALL ON FUNCTION public.bank_switch_progress(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_switch_progress(text[]) TO service_role;

NOTIFY pgrst, 'reload schema';
