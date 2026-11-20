-- Migration: webhooks_event_types
--
-- A webhook subscription carries a list of event types instead of exactly
-- one, so an outside agent or harness registers one endpoint for the events
-- it acts on instead of one subscription (and one signing secret) per type.
--
-- Additive. webhooks.event_type stays NOT NULL and always names one of the
-- listed types (the first, unless the writer chose another listed one), so
-- every reader of the single column keeps working. Dispatch
-- (src/lib/webhooks/handler.ts) matches a webhook when its event_types
-- contains the emitted type.
--
-- The sync trigger keeps the two columns consistent whoever writes:
--   - a writer that sets only event_type (code from before this change,
--     tests, scripts) gets event_types = ARRAY[event_type];
--   - an UPDATE that changes only event_type moves the list with it;
--   - a writer that sets only event_types gets event_type = event_types[1],
--     and an UPDATE that replaces the list without the current event_type
--     moves event_type to the new list's first entry.
-- A statement that sets both inconsistently is refused by the CHECK below
-- rather than silently corrected.
--
-- Which strings are valid event types is the application's catalogue
-- (src/lib/webhooks/public-events.ts), validated by the v1 routes; the
-- database only guarantees shape: non-empty, no NULLs, event_type listed.

ALTER TABLE public.webhooks
  ADD COLUMN IF NOT EXISTS event_types text[];

UPDATE public.webhooks
   SET event_types = ARRAY[event_type]
 WHERE event_types IS NULL;

CREATE OR REPLACE FUNCTION public.webhooks_sync_event_types()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.event_types IS NULL OR cardinality(NEW.event_types) = 0 THEN
    NEW.event_types := ARRAY[NEW.event_type];
  ELSIF TG_OP = 'UPDATE'
        AND NEW.event_type IS DISTINCT FROM OLD.event_type
        AND NEW.event_types IS NOT DISTINCT FROM OLD.event_types THEN
    NEW.event_types := ARRAY[NEW.event_type];
  END IF;

  IF NEW.event_type IS NULL THEN
    NEW.event_type := NEW.event_types[1];
  ELSIF TG_OP = 'UPDATE'
        AND NEW.event_types IS DISTINCT FROM OLD.event_types
        AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type
        AND NOT (NEW.event_type = ANY (NEW.event_types)) THEN
    NEW.event_type := NEW.event_types[1];
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webhooks_sync_event_types ON public.webhooks;
CREATE TRIGGER webhooks_sync_event_types
  BEFORE INSERT OR UPDATE OF event_type, event_types ON public.webhooks
  FOR EACH ROW EXECUTE FUNCTION public.webhooks_sync_event_types();

ALTER TABLE public.webhooks
  ALTER COLUMN event_types SET NOT NULL;

ALTER TABLE public.webhooks
  ADD CONSTRAINT webhooks_event_types_count
    CHECK (cardinality(event_types) BETWEEN 1 AND 64),
  ADD CONSTRAINT webhooks_event_types_no_null
    CHECK (array_position(event_types, NULL) IS NULL),
  ADD CONSTRAINT webhooks_event_type_listed
    CHECK (event_type = ANY (event_types));

-- End users read webhooks through column-level grants since
-- 20260929173432_withhold_credential_columns_from_end_users (the secret is
-- withheld); a new column is invisible to them until granted. service_role
-- keeps its table-level privileges, which cover new columns.
GRANT SELECT (event_types) ON public.webhooks TO authenticated;

NOTIFY pgrst, 'reload schema';
