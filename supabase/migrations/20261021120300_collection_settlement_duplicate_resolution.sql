-- A way out of possible_duplicate for a collections payout.
-- pg-test: tests/pg/collection-settlement-resolution.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts
--
-- Booking a payout stops at needs_mapping / possible_duplicate when a bank row
-- of its amount and reference already sits on a voucher (booked by hand).
-- A person then decides, with the payout and that voucher in view:
--
--   not a duplicate   duplicate_cleared_by / _at: the booking skips that
--                     guard from then on and books the payout;
--   handled elsewhere status 'ignored' with ignored_reason, ignored_by,
--                     ignored_at: never booked.
--
-- Both decisions are written to audit_log by the database
-- (audit_collection_settlement_decision), with the person who decided, so no
-- write path can make one without a trace.

ALTER TABLE public.collection_settlements
  ADD COLUMN duplicate_cleared_by uuid REFERENCES auth.users(id),
  ADD COLUMN duplicate_cleared_at timestamptz,
  ADD COLUMN ignored_reason text CHECK (ignored_reason IS NULL OR length(btrim(ignored_reason)) BETWEEN 1 AND 500),
  ADD COLUMN ignored_by uuid REFERENCES auth.users(id),
  ADD COLUMN ignored_at timestamptz,
  ADD CONSTRAINT collection_settlements_duplicate_cleared_shape CHECK (
    (duplicate_cleared_by IS NULL) = (duplicate_cleared_at IS NULL)
  ),
  ADD CONSTRAINT collection_settlements_ignored_shape CHECK (
    status <> 'ignored' OR (ignored_reason IS NOT NULL AND ignored_by IS NOT NULL AND ignored_at IS NOT NULL)
  );

COMMENT ON COLUMN public.collection_settlements.duplicate_cleared_by IS
  'The person who confirmed the payout is not a duplicate of a voucher booked by hand; the booking then skips that guard.';
COMMENT ON COLUMN public.collection_settlements.ignored_reason IS
  'Why a person marked the payout as handled elsewhere (status ignored); it is never booked.';

CREATE OR REPLACE FUNCTION public.audit_collection_settlement_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_desc text;
BEGIN
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'ignored' AND OLD.status IS DISTINCT FROM 'ignored' THEN
    v_actor := NEW.ignored_by;
    v_desc := 'Collections payout marked as handled elsewhere: ' || NEW.ignored_reason;
  ELSIF NEW.duplicate_cleared_at IS NOT NULL AND OLD.duplicate_cleared_at IS NULL THEN
    v_actor := NEW.duplicate_cleared_by;
    v_desc := 'Collections payout confirmed as not a duplicate of a voucher booked by hand';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_actor, NEW.company_id, 'UPDATE', TG_TABLE_NAME, NEW.id, v_actor,
    jsonb_build_object('status', OLD.status, 'needs_mapping_reason', OLD.needs_mapping_reason),
    jsonb_build_object(
      'status', NEW.status,
      'needs_mapping_reason', NEW.needs_mapping_reason,
      'duplicate_cleared_at', NEW.duplicate_cleared_at,
      'ignored_reason', NEW.ignored_reason,
      'provider_settlement_ref', NEW.provider_settlement_ref,
      'amount', NEW.amount,
      'payment_date', NEW.payment_date
    ),
    left(v_desc, 1000),
    'user',
    NULL
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_collection_settlement_decision() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER audit_collection_settlement_decision
  AFTER UPDATE ON public.collection_settlements
  FOR EACH ROW
  WHEN (
    (NEW.status = 'ignored' AND OLD.status IS DISTINCT FROM 'ignored')
    OR (NEW.duplicate_cleared_at IS NOT NULL AND OLD.duplicate_cleared_at IS NULL)
  )
  EXECUTE FUNCTION public.audit_collection_settlement_decision();

NOTIFY pgrst, 'reload schema';
