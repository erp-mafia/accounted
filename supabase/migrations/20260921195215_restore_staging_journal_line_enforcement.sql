CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_status text;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status FROM public.journal_entries
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'draft'
       AND current_user IN ('anon', 'authenticated')
       AND current_setting('gnubok.allow_line_rattelse', true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'journal_entry_lines: cannot add lines to a % journal entry', v_status
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Dimension retag carve-out (dimensions plan PR6, founder-approved):
  -- while the transaction-local GUC set by retag_line_dimensions is active,
  -- permit UPDATE of a POSTED line iff ONLY the dimension columns change.
  IF TG_OP = 'UPDATE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_dimension_retag', true) = 'true'
     AND (to_jsonb(NEW) - 'dimensions' - 'cost_center' - 'project')
       = (to_jsonb(OLD) - 'dimensions' - 'cost_center' - 'project') THEN
    RETURN NEW;
  END IF;

  -- Inline rättelse carve-out (BFL 5 kap 5 §, founder-approved 2026-07-23):
  -- while the transaction-local GUC set by correct_entry_lines_inline() is
  -- active, permit DELETE of a POSTED line (a struck line).
  IF TG_OP = 'DELETE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_line_rattelse', true) = 'true' THEN
    RETURN OLD;
  END IF;

  IF v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF v_status = 'cancelled' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Cannot % lines of a cancelled journal entry.', TG_OP;
  END IF;

  RAISE EXCEPTION 'Cannot % lines of a % journal entry.', TG_OP, v_status;
END; $$;
NOTIFY pgrst, 'reload schema';
