-- Invoice reminders: the ledger of the new sender (accounted#104, phase 1).
--
-- invoice_reminders becomes the record a sender writes BEFORE it sends: one
-- row per invoice and level, so a retry finds the row and sends nothing
-- twice; status reserved, then sent or failed; and the provider's message id,
-- so the delivery webhook records a bounce on the reminder it belongs to
-- (apply_invoice_reminder_provider_status, the invoice deliveries' rule).
-- The rows the old sender wrote were all sent, all carry sent_at and hold
-- no duplicate (invoice, level): they read as sent.
--
-- company_settings.reminders_enabled_at: when the company last turned
-- reminders on. Only invoices dated on or after it join the ladder by
-- themselves (#104 rule 1), so turning reminders on never reaches back into
-- imported or old invoices. A trigger moves it with send_invoice_reminders,
-- whichever path writes the toggle, and ignores a direct write.
--
-- customers.reminders_excluded: "Skicka aldrig påminnelser", kept apart from
-- the collections exclusion (customers.collections_excluded).
--
-- Nothing sends on any of this: REMINDERS_SENDING_ENABLED is false
-- (lib/invoices/reminders-enabled.ts). Schema only, no data UPDATE: the
-- archived migration-reset source companies keep their rows untouched.

ALTER TABLE public.invoice_reminders
  ADD COLUMN status text NOT NULL DEFAULT 'sent',
  ADD COLUMN channel text NOT NULL DEFAULT 'email',
  ADD COLUMN mode text,
  ADD COLUMN subject text,
  ADD COLUMN provider text,
  ADD COLUMN provider_message_id text,
  ADD COLUMN provider_status text,
  ADD COLUMN provider_status_at timestamptz,
  ADD COLUMN provider_status_detail text,
  ADD COLUMN error_code text,
  ADD COLUMN failed_at timestamptz;

-- The existing rows took 'sent' above; every new row starts reserved, with
-- no sent_at until the provider accepted it.
ALTER TABLE public.invoice_reminders ALTER COLUMN status SET DEFAULT 'reserved';
ALTER TABLE public.invoice_reminders ALTER COLUMN sent_at DROP DEFAULT;

ALTER TABLE public.invoice_reminders
  ADD CONSTRAINT invoice_reminders_status_check CHECK (status IN ('reserved', 'sent', 'failed')),
  ADD CONSTRAINT invoice_reminders_channel_check CHECK (channel IN ('email')),
  ADD CONSTRAINT invoice_reminders_mode_check CHECK (mode IS NULL OR mode IN ('approved', 'automatic', 'manual')),
  ADD CONSTRAINT invoice_reminders_provider_status_check CHECK (
    provider_status IS NULL
    OR provider_status IN ('delayed', 'delivered', 'complained', 'bounced', 'failed', 'suppressed')
  ),
  ADD CONSTRAINT invoice_reminders_sent_shape CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  ADD CONSTRAINT invoice_reminders_failed_shape CHECK (status <> 'failed' OR failed_at IS NOT NULL);

CREATE UNIQUE INDEX invoice_reminders_invoice_level_key
  ON public.invoice_reminders (invoice_id, reminder_level);

CREATE UNIQUE INDEX invoice_reminders_provider_message_key
  ON public.invoice_reminders (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- authenticated reads this table column by column: everything but
-- action_token, the customer's bearer link (tests/pg/credential-columns.pg.test.ts).
GRANT SELECT (
  status, channel, mode, subject, provider, provider_message_id, provider_status,
  provider_status_at, provider_status_detail, error_code, failed_at
) ON public.invoice_reminders TO authenticated;

COMMENT ON COLUMN public.invoice_reminders.status IS
  'reserved: written before the send, so a retry of the same invoice and level sends nothing; sent: the provider accepted it (sent_at); failed: the send failed or its outcome is unknown, and the ladder stops for a person to look.';
COMMENT ON COLUMN public.invoice_reminders.mode IS
  'How the reminder was released: approved (a person approved the daily batch), automatic (the company let clean batches send themselves), manual (picked on one invoice). NULL on the rows of the old sender.';

-- A provider's report on a sent reminder (bounce, delivered, ...), from any
-- provider's webhook (lib/email/delivery-reports.ts). Same rule as invoice
-- deliveries (apply_invoice_delivery_provider_status): a report never
-- downgrades a worse one, so a late "delivered" cannot hide a bounce.
CREATE OR REPLACE FUNCTION public.apply_invoice_reminder_provider_status(
  p_provider text,
  p_provider_message_id text,
  p_status text,
  p_occurred_at timestamptz,
  p_detail text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target public.invoice_reminders%ROWTYPE;
  new_rank integer;
  observed_at timestamptz := COALESCE(p_occurred_at, now());
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'invoice reminder provider status requires a server-controlled service role'
      USING ERRCODE = '42501';
  END IF;

  new_rank := public.invoice_delivery_provider_status_rank(p_status);
  IF new_rank = 0 THEN
    RAISE EXCEPTION 'unsupported invoice reminder provider status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  IF p_provider IS NULL OR p_provider_message_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO target
  FROM public.invoice_reminders r
  WHERE r.provider = p_provider
    AND r.provider_message_id = p_provider_message_id
  FOR UPDATE;

  IF target.id IS NULL OR target.status <> 'sent' THEN
    RETURN NULL;
  END IF;

  IF new_rank < public.invoice_delivery_provider_status_rank(target.provider_status)
    OR (
      new_rank = public.invoice_delivery_provider_status_rank(target.provider_status)
      AND target.provider_status_at IS NOT NULL
      AND observed_at <= target.provider_status_at
    )
  THEN
    RETURN target.id;
  END IF;

  UPDATE public.invoice_reminders
  SET provider_status = p_status,
      provider_status_at = observed_at,
      provider_status_detail = NULLIF(left(regexp_replace(COALESCE(p_detail, ''), '\s+', ' ', 'g'), 500), '')
  WHERE id = target.id;

  RETURN target.id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_invoice_reminder_provider_status(text, text, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_invoice_reminder_provider_status(text, text, text, timestamptz, text)
  TO service_role;

ALTER TABLE public.company_settings
  ADD COLUMN reminders_enabled_at timestamptz;

COMMENT ON COLUMN public.company_settings.reminders_enabled_at IS
  'When send_invoice_reminders last went on (NULL while off). Only invoices dated on or after it join the reminder ladder by themselves. Moved by trigger only.';

CREATE OR REPLACE FUNCTION public.stamp_reminders_enabled_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.send_invoice_reminders IS NOT DISTINCT FROM OLD.send_invoice_reminders THEN
    -- Only the toggle moves the stamp: a direct write cannot reach back
    -- into history.
    NEW.reminders_enabled_at := OLD.reminders_enabled_at;
  ELSIF NEW.send_invoice_reminders IS TRUE THEN
    NEW.reminders_enabled_at := now();
  ELSE
    NEW.reminders_enabled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_settings_stamp_reminders_enabled_at
  BEFORE INSERT OR UPDATE OF send_invoice_reminders, reminders_enabled_at ON public.company_settings
  FOR EACH ROW EXECUTE FUNCTION public.stamp_reminders_enabled_at();

ALTER TABLE public.customers
  ADD COLUMN reminders_excluded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.customers.reminders_excluded IS
  '"Skicka aldrig påminnelser": the reminder sender skips every invoice of this customer. Separate from collections_excluded.';

NOTIFY pgrst, 'reload schema';
