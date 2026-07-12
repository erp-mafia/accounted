-- Rot & rut: atomic apply of a Skatteverket beslut.
--
-- Why this exists: lib/invoices/rot-rut-beslut-import.ts previously issued
-- one UPDATE per rot_rut_payout_request_items row (decided_amount) followed
-- by a separate UPDATE of the rot_rut_payout_requests header (decided_total,
-- decided_at, skv_referensnummer, status). If an item update succeeded and a
-- later one, or the header update, failed, the beslut was recorded torn:
-- some items decided but the request still undecided (or vice versa).
--
-- This RPC wraps every item update plus the header update in a single
-- function call, so they share one transaction: any missing row raises and
-- the whole beslut rolls back. SECURITY INVOKER so RLS still scopes which
-- rows the caller may touch (an RLS-hidden row updates 0 rows and hits the
-- same RAISE). The MCP path calls it with the service role, which bypasses
-- RLS exactly as its direct table updates already did; the import code has
-- verified company ownership before calling.
--
-- p_items is a jsonb array of { "item_id": uuid, "decided_amount": numeric }.

CREATE OR REPLACE FUNCTION public.apply_rot_rut_beslut(
  p_request_id uuid,
  p_items jsonb,
  p_decided_total numeric,
  p_skv_referensnummer text,
  p_new_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item record;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) != 'array' THEN
    RAISE EXCEPTION 'apply_rot_rut_beslut: p_items must be a jsonb array';
  END IF;

  FOR v_item IN
    SELECT (elem ->> 'item_id')::uuid       AS item_id,
           (elem ->> 'decided_amount')::numeric AS decided_amount
    FROM jsonb_array_elements(p_items) AS elem
  LOOP
    IF v_item.item_id IS NULL OR v_item.decided_amount IS NULL THEN
      RAISE EXCEPTION 'apply_rot_rut_beslut: every item needs item_id and decided_amount';
    END IF;

    UPDATE public.rot_rut_payout_request_items
    SET decided_amount = v_item.decided_amount
    WHERE id = v_item.item_id
      AND request_id = p_request_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'apply_rot_rut_beslut: item % not found on request %',
        v_item.item_id, p_request_id;
    END IF;
  END LOOP;

  UPDATE public.rot_rut_payout_requests
  SET decided_total      = p_decided_total,
      decided_at         = now(),
      skv_referensnummer = p_skv_referensnummer,
      status             = p_new_status
  WHERE id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_rot_rut_beslut: request % not found', p_request_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_rot_rut_beslut(uuid, jsonb, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_rot_rut_beslut(uuid, jsonb, numeric, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
