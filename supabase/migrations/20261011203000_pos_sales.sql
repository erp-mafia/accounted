-- POS sales: a company's point-of-sale connections and the business days
-- they deliver, the input of the daily takings voucher (gemensam
-- verifikation, BFL 5 kap 6 §).
--
-- The provider integration lives in Accounted Connect (the `pos` family of
-- packages/connect-contract): this ledger holds the connection and the days,
-- Connect holds the integrator credential and relays one business day at a
-- time. Nothing here names a provider; `provider` is the slug Connect
-- returned.
--
-- 1. pos_connections: one row per connected venue. The handle Connect
--    returned is secret-free by contract but is withheld from members anyway
--    (column grants): only the server presents it. Members read; every write
--    goes through the service role after the route authorised the user, so
--    no member write policy exists and no writer-role gate is needed.
--    Disconnecting ends the row (status 'disconnected', ended_at) and keeps
--    it: the days point at it.
-- 2. pos_sales_days: one row per (connection, business day), holding
--    Connect's model of the day and the provider's answer verbatim (BFL 7 kap
--    archive; TOAST compresses it). A booked day is frozen: its model, its
--    archived answer and its voucher link never change again (trigger
--    below). A later fetch that differs only raises changed_after_booking and
--    records the new hash; a correction is a storno by a person.
--
-- pg-test: tests/pg/pos-sales.pg.test.ts

BEGIN;

CREATE TABLE public.pos_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Connect's provider slug and the name it gave, kept for when Connect is down.
  provider         text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  provider_name    text NOT NULL CHECK (length(btrim(provider_name)) BETWEEN 1 AND 80),
  -- Provider code lives only in Connect: there is no direct route.
  route            text NOT NULL DEFAULT 'connect' CHECK (route = 'connect'),
  -- The provider's own, non-secret venue id, and the name it uses.
  venue_ref        text NOT NULL CHECK (length(btrim(venue_ref)) BETWEEN 1 AND 64),
  venue_name       text NOT NULL CHECK (length(btrim(venue_name)) BETWEEN 1 AND 200),
  connection_handle text CHECK (connection_handle IS NULL OR length(connection_handle) BETWEEN 16 AND 256),
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('connecting', 'needs_setup', 'active', 'disconnected')),
  health           text NOT NULL DEFAULT 'ok'
                     CHECK (health IN ('ok', 'degraded', 'action_required')),
  -- The error code behind a degraded or action_required health.
  health_code      text,
  -- First business day to fetch, and the last one fetched without a gap.
  sync_from        date NOT NULL,
  synced_through   date,
  next_run_at      timestamptz NOT NULL DEFAULT now(),
  -- Run claim: the run that holds the connection sets it; cron and a manual
  -- fetch never call the provider for the same venue at once.
  lease_until      timestamptz NOT NULL DEFAULT 'epoch',
  last_success_at  timestamptz,
  last_error_code  text,
  last_error_at    timestamptz,
  failures_in_row  integer NOT NULL DEFAULT 0 CHECK (failures_in_row >= 0),
  -- Account mapping and booking options (lib/pos-sales/settings.ts).
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ended_at         timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_connections_ended_iff_disconnected
    CHECK ((status = 'disconnected') = (ended_at IS NOT NULL)),
  CONSTRAINT pos_connections_active_has_handle
    CHECK (status <> 'active' OR connection_handle IS NOT NULL)
);

COMMENT ON TABLE public.pos_connections IS
  'Point-of-sale venues a company has connected through Accounted Connect (pos family). Ended, never deleted: the days point here.';

CREATE UNIQUE INDEX pos_connections_one_live_per_venue
  ON public.pos_connections (company_id, provider, venue_ref)
  WHERE status <> 'disconnected';

CREATE INDEX pos_connections_due
  ON public.pos_connections (next_run_at)
  WHERE status = 'active';

CREATE INDEX pos_connections_company
  ON public.pos_connections (company_id);

CREATE TRIGGER set_updated_at_pos_connections
  BEFORE UPDATE ON public.pos_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.pos_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read pos_connections"
  ON public.pos_connections FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

REVOKE ALL ON TABLE public.pos_connections FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, company_id, provider, provider_name, route, venue_ref, venue_name,
  status, health, health_code, sync_from, synced_through, next_run_at, lease_until,
  last_success_at, last_error_code, last_error_at, failures_in_row, settings,
  created_by, created_at, ended_by, ended_at, updated_at
) ON public.pos_connections TO authenticated;
GRANT ALL ON TABLE public.pos_connections TO service_role;

CREATE TABLE public.pos_sales_days (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  connection_id          uuid NOT NULL REFERENCES public.pos_connections(id) ON DELETE CASCADE,
  business_date          date NOT NULL,
  currency               text NOT NULL DEFAULT 'SEK' CHECK (currency ~ '^[A-Z]{3}$'),
  -- ready: can be booked; needs_review: something a person must decide
  -- first (review_reasons); empty: no sales; booked: journal_entry_id set.
  status                 text NOT NULL CHECK (status IN ('ready', 'needs_review', 'empty', 'booked')),
  review_reasons         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review_reasons) = 'array'),
  -- Totals of the day model, for listing without reading the model.
  gross                  numeric(14, 2) NOT NULL,
  net                    numeric(14, 2) NOT NULL,
  vat                    numeric(14, 2) NOT NULL,
  tips                   numeric(14, 2) NOT NULL DEFAULT 0,
  receipt_count          integer NOT NULL DEFAULT 0 CHECK (receipt_count >= 0),
  -- The day's payment split and VAT split, copied from the model so a list
  -- reads them without the receipts.
  tenders                jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tenders) = 'array'),
  vat_groups             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(vat_groups) = 'array'),
  -- Connect's model of the day (posDaySchema), verbatim.
  day                    jsonb NOT NULL CHECK (jsonb_typeof(day) = 'object'),
  -- The provider's answer, verbatim, and its hash.
  raw_body               text NOT NULL,
  raw_content_type       text NOT NULL,
  raw_sha256             text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  fetched_at             timestamptz NOT NULL,
  fetch_count            integer NOT NULL DEFAULT 1 CHECK (fetch_count >= 1),
  -- Set when a fetch after booking answered something else.
  changed_after_booking  boolean NOT NULL DEFAULT false,
  latest_raw_sha256      text CHECK (latest_raw_sha256 IS NULL OR latest_raw_sha256 ~ '^[0-9a-f]{64}$'),
  latest_fetched_at      timestamptz,
  journal_entry_id       uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  booked_at              timestamptz,
  booked_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_sales_days_one_per_connection_day UNIQUE (connection_id, business_date),
  -- Booking claims the row (journal_entry_id set) before the commit and marks
  -- it booked after; a booked row always says when.
  CONSTRAINT pos_sales_days_booked_has_time
    CHECK (status <> 'booked' OR booked_at IS NOT NULL)
);

COMMENT ON TABLE public.pos_sales_days IS
  'One business day of point-of-sale sales per connected venue: the day model, the provider answer verbatim (BFL 7 kap), and the daily takings voucher once booked.';

CREATE INDEX pos_sales_days_company_date
  ON public.pos_sales_days (company_id, business_date DESC);

CREATE INDEX pos_sales_days_journal_entry
  ON public.pos_sales_days (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

CREATE TRIGGER set_updated_at_pos_sales_days
  BEFORE UPDATE ON public.pos_sales_days
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A booked day is the basis of a posted verifikat: what it was booked from
-- (the model, the archived provider answer, the totals) and the link to the
-- verifikat stay as they were. Status and review fields may still move, and
-- the link may be cleared only when the verifikat itself is gone (ON DELETE
-- SET NULL) or was cancelled as a draft.
CREATE OR REPLACE FUNCTION public.pos_sales_days_freeze_booked()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.day IS DISTINCT FROM OLD.day
     OR NEW.raw_body IS DISTINCT FROM OLD.raw_body
     OR NEW.raw_sha256 IS DISTINCT FROM OLD.raw_sha256
     OR NEW.gross IS DISTINCT FROM OLD.gross
     OR NEW.net IS DISTINCT FROM OLD.net
     OR NEW.vat IS DISTINCT FROM OLD.vat
     OR NEW.tips IS DISTINCT FROM OLD.tips
     OR NEW.tenders IS DISTINCT FROM OLD.tenders
     OR NEW.vat_groups IS DISTINCT FROM OLD.vat_groups
     OR NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'pos_sales_days % is booked: its day and archived answer cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id AND NEW.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'pos_sales_days % is already linked to a verifikat', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.journal_entry_id IS NULL AND EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = OLD.journal_entry_id AND je.status IN ('posted', 'reversed')
  ) THEN
    RAISE EXCEPTION 'pos_sales_days % points at a posted verifikat: correct it with storno, never by unlinking', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pos_sales_days_freeze_booked
  BEFORE UPDATE ON public.pos_sales_days
  FOR EACH ROW EXECUTE FUNCTION public.pos_sales_days_freeze_booked();

ALTER TABLE public.pos_sales_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read pos_sales_days"
  ON public.pos_sales_days FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

REVOKE ALL ON TABLE public.pos_sales_days FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.pos_sales_days TO authenticated;
GRANT ALL ON TABLE public.pos_sales_days TO service_role;

REVOKE ALL ON FUNCTION public.pos_sales_days_freeze_booked() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
