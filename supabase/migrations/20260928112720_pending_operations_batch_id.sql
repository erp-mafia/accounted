-- pending_operations.batch_id: one id shared by every operation staged in a
-- single accounted_stage_across_companies call.
--
-- One API key is one person who may belong to many companies. When that
-- person asks for the same write on several companies at once ("lock March
-- for every client"), the MCP tool stages one pending operation per company
-- inside one request. Without a shared id those rows look exactly like
-- operations staged one by one, so they could only be listed and approved one
-- at a time. batch_id ties them together: gnubok_list_pending_operations can
-- filter on it and gnubok_approve_pending_operation can approve the low- and
-- medium-risk members in one call (high-risk operations stay one by one).
--
-- Every other staging path leaves the column NULL. It is never an
-- authorization input: approval still checks membership per row through the
-- row's own company_id, and a batch can only ever span companies the user
-- could have staged into one by one.
--
-- Trigger review: enforce_pending_operations_input_frozen (20260504100000)
-- freezes params / operation_type / preview_data only, and the terminal-state
-- blockers (20260722134114) key on status, so a new nullable column needs no
-- trigger change. The value is written at INSERT time and never updated.
--
-- pg-test: tests/pg/pending-operations-batch-id.pg.test.ts
ALTER TABLE public.pending_operations
  ADD COLUMN IF NOT EXISTS batch_id uuid;

COMMENT ON COLUMN public.pending_operations.batch_id IS
  'Set by accounted_stage_across_companies so operations staged for several companies in one call can be listed and approved as one batch. NULL for every other staging path. Never used for authorization: membership is checked per row through company_id.';

-- Batch listing and approval look rows up by batch_id; most rows have none.
CREATE INDEX IF NOT EXISTS idx_pending_operations_batch_id
  ON public.pending_operations (batch_id)
  WHERE batch_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
