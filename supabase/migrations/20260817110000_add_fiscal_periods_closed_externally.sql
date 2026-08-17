-- Fiscal years imported from a previous bookkeeping system (SIE) arrive with
-- is_closed = false, so the year-end page lists them as pending bokslut even
-- though the bokslut was already done in the old software. closed_externally
-- marks a period closed via the "klarmarkera" action: is_closed/closed_at are
-- set alongside, but the period has no closing entry of its own. Kept as a
-- separate column for audit clarity: it distinguishes "closed by a year-end
-- run here" from "closed in a previous system".
ALTER TABLE public.fiscal_periods
  ADD COLUMN closed_externally boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
