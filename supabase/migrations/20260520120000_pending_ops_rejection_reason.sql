-- Migration: pending_operations rejection reason — close the agent feedback loop
--
-- Before this migration, rejecting a pending operation was fire-and-forget:
-- status flipped to 'rejected', no signal back to the agent or the audit log.
-- Agents kept staging the same wrong operation because they had no idea what
-- failed. The two new columns capture WHY the human said no:
--
--   rejection_category  — fixed enum so we can aggregate ("70% of rejections
--                         this month were wrong_category") and route the
--                         signal to the right corrective surface (mapping
--                         rules, tool description, skill update).
--   rejection_reason    — free-text supplement when the category isn't enough
--                         ("the agent matched against last year's invoice").
--
-- Both are NULL on existing rows (no backfill possible). The reject API route
-- accepts them as an optional body — old clients (current web UI) still post
-- without a body and the row gets NULL for both fields.

ALTER TABLE public.pending_operations
  ADD COLUMN rejection_category TEXT
    CHECK (rejection_category IS NULL OR rejection_category IN (
      'wrong_category',
      'wrong_amount',
      'duplicate',
      'wrong_period',
      'other'
    )),
  ADD COLUMN rejection_reason TEXT;

-- Index for "show me recent rejections of this category" queries from the
-- new gnubok_get_recent_rejections MCP tool (Phase 2D companion).
CREATE INDEX idx_pending_ops_rejection_category
  ON public.pending_operations (company_id, rejection_category, resolved_at DESC)
  WHERE rejection_category IS NOT NULL;

NOTIFY pgrst, 'reload schema';
