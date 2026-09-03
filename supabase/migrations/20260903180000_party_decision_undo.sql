-- Parties, phase 1e: the queue's confirm and dismiss are undoable for 30 days.
--
-- decide_parties now snapshots the suggested_reason it clears, so a confirm
-- can be reversed without losing why the row was suggested. A new decision
-- kind 'undo' records the reversal; merges keep their own 'split' record
-- (undo_party_merge, 20260902210000).

ALTER TABLE public.party_decisions DROP CONSTRAINT IF EXISTS party_decisions_kind_check;
ALTER TABLE public.party_decisions ADD CONSTRAINT party_decisions_kind_check
  CHECK (kind IN ('confirm', 'merge', 'split', 'rename', 'role', 'dismiss', 'pin', 'ignore', 'label', 'undo'));

CREATE OR REPLACE FUNCTION public.decide_parties(
  p_company_id uuid,
  p_user_id uuid,
  p_party_ids uuid[],
  p_kind text,
  p_note text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'decide_parties: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('confirm', 'dismiss') THEN
    RAISE EXCEPTION 'decide_parties: kind must be confirm or dismiss, got %', p_kind USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'confirm' THEN
    WITH target AS (
      SELECT p.id, p.suggested_reason
      FROM public.parties p
      WHERE p.company_id = p_company_id AND p.id = ANY(p_party_ids) AND p.merged_into IS NULL
        AND (p.status <> 'confirmed' OR p.archived_at IS NOT NULL)
      FOR UPDATE
    ), changed AS (
      UPDATE public.parties p
      SET status = 'confirmed', suggested_reason = NULL, archived_at = NULL
      FROM target t
      WHERE p.id = t.id
      RETURNING p.id, t.suggested_reason AS old_reason
    ), logged AS (
      INSERT INTO public.party_decisions (party_id, company_id, user_id, kind, before, after, note)
      SELECT c.id, p_company_id, p_user_id, 'confirm',
             jsonb_build_object('status', 'suggested', 'suggested_reason', c.old_reason),
             jsonb_build_object('status', 'confirmed'), p_note
      FROM changed c
      RETURNING 1
    )
    SELECT count(*) INTO v_count FROM logged;
  ELSE
    -- Dismiss is the queue's "not a party" answer: it only touches suggested
    -- rows. A confirmed party is archived through its own action later.
    WITH changed AS (
      UPDATE public.parties p
      SET archived_at = now()
      WHERE p.company_id = p_company_id AND p.id = ANY(p_party_ids) AND p.merged_into IS NULL
        AND p.status = 'suggested' AND p.archived_at IS NULL
      RETURNING p.id, p.status
    ), logged AS (
      INSERT INTO public.party_decisions (party_id, company_id, user_id, kind, before, after, note)
      SELECT c.id, p_company_id, p_user_id, 'dismiss',
             jsonb_build_object('status', c.status, 'archived', false), jsonb_build_object('status', c.status, 'archived', true), p_note
      FROM changed c
      RETURNING 1
    )
    SELECT count(*) INTO v_count FROM logged;
  END IF;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.decide_parties(uuid, uuid, uuid[], text, text) IS
  'Bulk confirm (suggested -> confirmed, reason snapshotted in the decision) or dismiss (archive a suggested party), one party_decisions row each. Reversible for 30 days through undo_party_decisions.';

-- ── Undo the latest confirm or dismiss per party ────────────────────────────
CREATE OR REPLACE FUNCTION public.undo_party_decisions(
  p_company_id uuid,
  p_user_id uuid,
  p_party_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'undo_party_decisions: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;

  -- The latest confirm/dismiss per party, unless a later decision of any
  -- kind already followed it: undo only ever reverses the most recent step.
  WITH latest AS (
    SELECT DISTINCT ON (d.party_id) d.id, d.party_id, d.kind, d.before, d.created_at
    FROM public.party_decisions d
    WHERE d.company_id = p_company_id AND d.party_id = ANY(p_party_ids)
    ORDER BY d.party_id, d.created_at DESC, d.id DESC
  ),
  eligible AS (
    SELECT l.* FROM latest l
    WHERE l.kind IN ('confirm', 'dismiss') AND l.created_at >= now() - interval '30 days'
  ),
  reverted AS (
    UPDATE public.parties p
    SET status = CASE WHEN e.kind = 'confirm' THEN 'suggested' ELSE p.status END,
        suggested_reason = CASE WHEN e.kind = 'confirm' THEN e.before->'suggested_reason' ELSE p.suggested_reason END,
        archived_at = CASE WHEN e.kind = 'dismiss' THEN NULL ELSE p.archived_at END
    FROM eligible e
    WHERE p.id = e.party_id AND p.company_id = p_company_id AND p.merged_into IS NULL
    RETURNING p.id, e.id AS decision_id, e.kind
  ),
  logged AS (
    INSERT INTO public.party_decisions (party_id, company_id, user_id, kind, before, after, note)
    SELECT r.id, p_company_id, p_user_id, 'undo',
           jsonb_build_object('decision_id', r.decision_id, 'kind', r.kind),
           jsonb_build_object('status', 'suggested', 'archived', false),
           'undo ' || r.kind
    FROM reverted r
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM logged;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.undo_party_decisions(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_party_decisions(uuid, uuid, uuid[]) TO authenticated, service_role;
COMMENT ON FUNCTION public.undo_party_decisions(uuid, uuid, uuid[]) IS
  'Reverses the latest confirm or dismiss per party within 30 days (confirm -> suggested with its reason restored; dismiss -> unarchived). Logs an undo decision. Returns the number of parties reverted.';

NOTIFY pgrst, 'reload schema';
