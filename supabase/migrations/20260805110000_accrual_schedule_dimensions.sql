-- Accrual schedules carry the origin line's dimensions bag so dissolution
-- entries can tag their lines the way the origin entry tagged its interim
-- (17xx/29xx) line. Without this, every monthly dissolution books untagged
-- and a project-tagged deferred invoice line silently disappears from the
-- per-project P&L while the tagged interim balance never nets to zero.
--
-- Shape: {sie_dim_no: object_code}, same as journal_entry_lines.dimensions;
-- the CHECK mirrors dimension_values.attributes (20260702084500). Existing
-- rows get '{}' (untagged): pre-existing schedules keep today's behavior; a
-- backfill from the origin entry is a separate follow-up.

ALTER TABLE public.accrual_schedules
  ADD COLUMN dimensions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(dimensions) = 'object');
