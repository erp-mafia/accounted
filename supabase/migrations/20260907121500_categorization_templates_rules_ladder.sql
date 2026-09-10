-- Rules ladder on categorization_templates (UI v2 PR 5, dev_docs/ui_v2_build_plan.md).
--
-- Founder decision 2026-09-07: the three learning systems become one word,
-- Regler. categorization_templates already IS the per-counterparty rule
-- (aliases, accounts, VAT, occurrence_count, confidence, source). This adds
-- what the Regler pages need and the engine does not yet read:
--
--   mode         proposed | propose | auto | paused. The trust ladder. Today
--                every active template proposes; 'auto' is reserved for the
--                autopilot tier (a later PR) and 'proposed' for rules the
--                system suggests before the user confirms them.
--   corrections  how many times the user changed the accounts a template
--                proposed (insertOrUpdateTemplate's correction branch).
--   paused_at    when the rule was paused.
--
-- is_active stays the column the booking engine reads. A BEFORE trigger keeps
-- the two in step in both directions, so the existing soft-delete
-- (is_active = false) reads as paused and a paused rule stops matching.

ALTER TABLE public.categorization_templates
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'propose',
  ADD COLUMN IF NOT EXISTS corrections INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

ALTER TABLE public.categorization_templates
  DROP CONSTRAINT IF EXISTS categorization_templates_mode_check;
ALTER TABLE public.categorization_templates
  ADD CONSTRAINT categorization_templates_mode_check
  CHECK (mode IN ('proposed', 'propose', 'auto', 'paused'));

ALTER TABLE public.categorization_templates
  DROP CONSTRAINT IF EXISTS categorization_templates_corrections_check;
ALTER TABLE public.categorization_templates
  ADD CONSTRAINT categorization_templates_corrections_check
  CHECK (corrections >= 0);

COMMENT ON COLUMN public.categorization_templates.mode IS
  'Rules ladder: proposed (suggested, not confirmed), propose (confirmed, each hit lands in Att göra), auto (books on its own, autopilot tier), paused. Kept in step with is_active by categorization_templates_sync_mode().';
COMMENT ON COLUMN public.categorization_templates.corrections IS
  'Times the user changed the accounts this template proposed. Shown on the Regler pages; a high number next to a high occurrence_count is a rule worth looking at.';

-- Backfill: soft-deleted templates are paused rules.
UPDATE public.categorization_templates
   SET mode = 'paused',
       paused_at = COALESCE(paused_at, updated_at)
 WHERE is_active = false
   AND mode <> 'paused';

CREATE OR REPLACE FUNCTION public.categorization_templates_sync_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.is_active THEN
      NEW.mode := 'paused';
    END IF;
    IF NEW.mode = 'paused' THEN
      NEW.is_active := false;
      NEW.paused_at := COALESCE(NEW.paused_at, now());
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: the side that changed wins. is_active is what the engine reads.
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    IF NEW.is_active THEN
      IF NEW.mode = 'paused' THEN
        NEW.mode := 'propose';
      END IF;
      NEW.paused_at := NULL;
    ELSE
      NEW.mode := 'paused';
      NEW.paused_at := COALESCE(NEW.paused_at, now());
    END IF;
  ELSIF NEW.mode IS DISTINCT FROM OLD.mode THEN
    NEW.is_active := (NEW.mode <> 'paused');
    NEW.paused_at := CASE WHEN NEW.mode = 'paused' THEN COALESCE(NEW.paused_at, now()) ELSE NULL END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_categorization_templates_sync_mode ON public.categorization_templates;
CREATE TRIGGER trg_categorization_templates_sync_mode
  BEFORE INSERT OR UPDATE ON public.categorization_templates
  FOR EACH ROW EXECUTE FUNCTION public.categorization_templates_sync_mode();

CREATE INDEX IF NOT EXISTS idx_categorization_templates_company_mode
  ON public.categorization_templates (company_id, mode);
