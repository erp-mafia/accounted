-- Owner reopens a fiscal year closed with a year-end run in Accounted
-- (crm#1290, PH 186).
--
-- Until now only support could undo an executed bokslut
-- (scripts/undo-year-end-closing.ts). This adds the guarded owner door. The
-- database part is the gate and the state change; the stornos stay in the
-- bookkeeping engine (lib/core/bookkeeping/fiscal-year-reopen.ts), because
-- every journal write goes through it:
--
--   1. reopen_closed_fiscal_year (this file) re-checks every gate under a row
--      lock, supersedes a ready_for_signature årsredovisning (the transition
--      re-finalizing makes; its pending signatures can no longer be signed),
--      opens and unlocks the year, resets the next year's continuity flag and
--      writes the owner's confirmation to the immutable audit_log
--      (behandlingshistorik, BFNAR 2013:2 p. 9.16).
--   2. The engine then posts a storno of the closing entry, the next year's
--      IB and 2099->2098 omföring, and the year-end's currency revaluation,
--      and detaches closing_entry_id (enforce_opening_balance_immutability
--      only lets a closing entry go once it is reversed by a posted storno).
--      Nothing is edited or deleted.
--
-- A reopen is lawful only while the årsredovisning built on the year has no
-- legal weight. The gates (fiscal_year_reopen_snapshot), all fail closed:
--   * the year is closed with a closing entry here (not klarmarkerad), or a
--     reopen stopped midway (open again, closing entry still attached:
--     resumable);
--   * no arsredovisning_submissions row, no signed signature, no version
--     signed/filed/registered;
--   * no later year is closed or holds a closing entry;
--   * the next year is not locked (its IB storno lands there);
--   * the company lock date does not cover the year end;
--   * Bolagsverket, read from the TIC snapshot on companies: fetched within
--     the last 7 days for this org number, with a complete list of annual
--     reports (financialReportsComplete), none of them for this year or a
--     later one. Missing, stale, mismatched or incomplete data refuses with
--     registry_unavailable: we do not reopen on an unknown.
-- Plus the typed confirmation: the year's name restated and the owner's
-- statement that the report was not signed, adopted at a stämma or filed
-- outside Accounted, which no record here can show.
--
-- Owner only. p_user_id is honored only for service_role callers; everyone
-- else is pinned to auth.uid() (same actor gate as reset_fiscal_year).
-- No table, trigger or enforcement function is changed.

-- ---------------------------------------------------------------------------
-- Internal snapshot: gates, what the reopen reverses, what it supersedes.
-- Shared by the preview and the execution so the two cannot drift.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fiscal_year_reopen_snapshot(
  p_company_id uuid,
  p_period_id  uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period        record;
  v_next          record;
  v_company       record;
  v_blockers      jsonb := '[]'::jsonb;
  v_lock_through  date;
  v_org_digits    text;
  v_snap_digits   text;
  v_reports       jsonb;
  v_entries       jsonb := '[]'::jsonb;
  v_versions      integer;
  v_pending       integer;
  v_agm_date      date;
BEGIN
  SELECT id, name, period_start, period_end, is_closed, closed_at, locked_at,
         closing_entry_id, closed_externally
    INTO v_period
    FROM public.fiscal_periods
   WHERE id = p_period_id
     AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_REOPEN_NOT_FOUND');
  END IF;

  -- What was closed, and how. A klarmarkerad year has its own undo
  -- (reopenExternallyClosedPeriod); a year with no closing entry has no
  -- bokslut to reverse.
  IF v_period.closing_entry_id IS NULL THEN
    IF v_period.is_closed AND v_period.closed_externally THEN
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'closed_externally'));
    ELSE
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'not_closed_with_bokslut'));
    END IF;
  END IF;

  -- The årsredovisning's legal acts.
  IF EXISTS (
    SELECT 1 FROM public.arsredovisning_submissions s
     WHERE s.company_id = p_company_id AND s.fiscal_period_id = p_period_id
  ) OR EXISTS (
    SELECT 1 FROM public.annual_report_versions v
     WHERE v.company_id = p_company_id AND v.fiscal_period_id = p_period_id
       AND v.status IN ('filed', 'registered')
  ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'annual_report_submitted'));
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.arsredovisning_signature_requests r
     WHERE r.company_id = p_company_id AND r.fiscal_period_id = p_period_id
       AND (r.status = 'signed' OR r.signed_at IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM public.annual_report_versions v
     WHERE v.company_id = p_company_id AND v.fiscal_period_id = p_period_id
       AND v.status = 'signed'
  ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'annual_report_signed'));
  END IF;

  -- A later year closed (or mid-close) was built on this year's UB.
  IF EXISTS (
    SELECT 1 FROM public.fiscal_periods p
     WHERE p.company_id = p_company_id
       AND p.period_start > v_period.period_end
       AND (p.is_closed OR p.closing_entry_id IS NOT NULL)
  ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'later_year_closed'));
  END IF;

  -- The next year: by chain, else the day after (as findNextPeriod).
  SELECT id, name, period_start, is_closed, locked_at, opening_balance_entry_id
    INTO v_next
    FROM public.fiscal_periods
   WHERE company_id = p_company_id
     AND previous_period_id = p_period_id
   LIMIT 1;
  IF NOT FOUND THEN
    SELECT id, name, period_start, is_closed, locked_at, opening_balance_entry_id
      INTO v_next
      FROM public.fiscal_periods
     WHERE company_id = p_company_id
       AND period_start = v_period.period_end + 1
     LIMIT 1;
  END IF;

  IF v_next.id IS NOT NULL AND v_next.locked_at IS NOT NULL AND NOT v_next.is_closed THEN
    v_blockers := v_blockers || jsonb_build_array(
      jsonb_build_object('code', 'next_year_locked', 'name', v_next.name)
    );
  END IF;

  SELECT bookkeeping_locked_through INTO v_lock_through
    FROM public.company_settings
   WHERE company_id = p_company_id;
  IF v_lock_through IS NOT NULL AND v_lock_through >= v_period.period_end THEN
    v_blockers := v_blockers || jsonb_build_array(
      jsonb_build_object('code', 'company_lock_date', 'date', v_lock_through)
    );
  END IF;

  -- Bolagsverket, as the TIC snapshot recorded it. Fail closed on anything
  -- we cannot read with confidence.
  SELECT org_number, tic_snapshot, tic_snapshot_fetched_at
    INTO v_company
    FROM public.companies
   WHERE id = p_company_id;
  v_org_digits := right(regexp_replace(coalesce(v_company.org_number, ''), '\D', '', 'g'), 10);
  v_snap_digits := right(regexp_replace(coalesce(v_company.tic_snapshot ->> 'orgNumber', ''), '\D', '', 'g'), 10);
  v_reports := v_company.tic_snapshot -> 'financialReports';

  IF v_company.tic_snapshot IS NULL
     OR jsonb_typeof(v_company.tic_snapshot) IS DISTINCT FROM 'object'
     OR v_company.tic_snapshot_fetched_at IS NULL
     OR v_company.tic_snapshot_fetched_at < now() - interval '7 days'
     OR length(v_org_digits) <> 10
     OR v_snap_digits IS DISTINCT FROM v_org_digits
     OR jsonb_typeof(v_reports) IS DISTINCT FROM 'array'
     OR (v_company.tic_snapshot ->> 'financialReportsComplete') IS DISTINCT FROM 'true'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_reports) r
        WHERE jsonb_typeof(r) IS DISTINCT FROM 'object'
           OR coalesce(r ->> 'periodEnd', '') !~ '^\d{4}-\d{2}-\d{2}'
     )
  THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'registry_unavailable'));
  ELSIF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_reports) r
     WHERE (r ->> 'isInterimReport') IS DISTINCT FROM 'true'
       AND left(r ->> 'periodEnd', 10)::date >= v_period.period_end
  ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'annual_report_registered'));
  END IF;

  -- What the engine reverses, in order. Posted rows only, so a resumed
  -- reopen lists what is still left.
  -- Order: the next year's omföring and IB first, then the closing entry,
  -- then the revaluation the year-end posted before it.
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', x.id,
               'kind', x.kind,
               'voucher_series', x.voucher_series,
               'voucher_number', x.voucher_number,
               'entry_date', x.entry_date,
               'fiscal_period_id', x.fiscal_period_id
             )
             ORDER BY x.ord, x.voucher_number
           ),
           '[]'::jsonb
         )
    INTO v_entries
    FROM (
      SELECT je.id, je.voucher_series, je.voucher_number, je.entry_date, je.fiscal_period_id,
             CASE
               WHEN je.id = v_period.closing_entry_id THEN 'closing_entry'
               ELSE je.source_type
             END AS kind,
             CASE
               WHEN je.source_type = 'result_appropriation' THEN 1
               WHEN je.source_type = 'opening_balance' THEN 2
               WHEN je.id = v_period.closing_entry_id THEN 3
               ELSE 4
             END AS ord
        FROM public.journal_entries je
       WHERE je.company_id = p_company_id
         AND je.status = 'posted'
         AND (
           je.id = v_period.closing_entry_id
           OR (je.fiscal_period_id = p_period_id AND je.source_type = 'currency_revaluation')
           OR (v_next.id IS NOT NULL AND je.fiscal_period_id = v_next.id
               AND je.source_type IN ('opening_balance', 'result_appropriation'))
         )
    ) x;

  SELECT count(*) INTO v_versions
    FROM public.annual_report_versions v
   WHERE v.company_id = p_company_id AND v.fiscal_period_id = p_period_id
     AND v.status = 'ready_for_signature';
  SELECT count(*) INTO v_pending
    FROM public.arsredovisning_signature_requests r
   WHERE r.company_id = p_company_id AND r.fiscal_period_id = p_period_id
     AND r.status = 'pending' AND r.signed_at IS NULL;
  SELECT n.agm_date INTO v_agm_date
    FROM public.arsredovisning_narratives n
   WHERE n.company_id = p_company_id AND n.fiscal_period_id = p_period_id
   LIMIT 1;

  RETURN jsonb_build_object(
    'ok', true,
    'eligible', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers,
    'resume', v_period.closing_entry_id IS NOT NULL AND NOT v_period.is_closed,
    'period', jsonb_build_object(
      'id', v_period.id,
      'name', v_period.name,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'closing_entry_id', v_period.closing_entry_id
    ),
    'next_period', CASE WHEN v_next.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_next.id,
      'name', v_next.name
    ) END,
    'entries', v_entries,
    'annual_report', jsonb_build_object(
      'versions_to_supersede', v_versions,
      'pending_signatures', v_pending,
      'agm_date', v_agm_date
    ),
    'registry', jsonb_build_object(
      'fetched_at', v_company.tic_snapshot_fetched_at,
      'reports', CASE WHEN jsonb_typeof(v_reports) = 'array' THEN jsonb_array_length(v_reports) ELSE NULL END
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fiscal_year_reopen_snapshot(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fiscal_year_reopen_snapshot(uuid, uuid) IS
  'Internal fail-closed gate snapshot for reopen_closed_fiscal_year. Not client-callable.';

-- ---------------------------------------------------------------------------
-- Preview for the dialog. Owner only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_fiscal_year_reopen_eligibility(
  p_company_id uuid,
  p_period_id  uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor       uuid;
  v_caller_role text;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id
     AND cm.user_id = v_actor;

  IF v_caller_role IS DISTINCT FROM 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_REOPEN_FORBIDDEN');
  END IF;

  RETURN public.fiscal_year_reopen_snapshot(p_company_id, p_period_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_fiscal_year_reopen_eligibility(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_fiscal_year_reopen_eligibility(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_fiscal_year_reopen_eligibility(uuid, uuid, uuid) IS
  'Owner-only preview for reopen_closed_fiscal_year. p_user_id is honored only for service_role callers.';

-- ---------------------------------------------------------------------------
-- The reopen: gates again under a row lock, then the state change.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reopen_closed_fiscal_year(
  p_company_id          uuid,
  p_period_id           uuid,
  p_confirmed_name      text,
  p_confirm_not_adopted boolean,
  p_user_id             uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor       uuid;
  v_caller_role text;
  v_period      record;
  v_snapshot    jsonb;
  v_superseded  uuid[] := '{}';
  v_voided      uuid[] := '{}';
  v_next_id     uuid;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id
     AND cm.user_id = v_actor;

  IF v_caller_role IS DISTINCT FROM 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_REOPEN_FORBIDDEN');
  END IF;

  -- Serialize against lock/close/year-end on the same year, and against a
  -- signature landing between the check and the supersede.
  SELECT id, name, period_start, period_end, is_closed, closed_at, locked_at, closing_entry_id
    INTO v_period
    FROM public.fiscal_periods
   WHERE id = p_period_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_REOPEN_NOT_FOUND');
  END IF;

  PERFORM 1 FROM public.annual_report_versions
   WHERE company_id = p_company_id AND fiscal_period_id = p_period_id
   FOR UPDATE;
  PERFORM 1 FROM public.arsredovisning_signature_requests
   WHERE company_id = p_company_id AND fiscal_period_id = p_period_id
   FOR UPDATE;

  v_snapshot := public.fiscal_year_reopen_snapshot(p_company_id, p_period_id);
  IF NOT (v_snapshot ->> 'ok')::boolean THEN
    RETURN v_snapshot;
  END IF;
  IF NOT (v_snapshot ->> 'eligible')::boolean THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'FISCAL_YEAR_REOPEN_INELIGIBLE',
      'blockers', v_snapshot -> 'blockers'
    );
  END IF;

  IF p_confirm_not_adopted IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_REOPEN_CONFIRMATION_REQUIRED');
  END IF;
  IF btrim(coalesce(p_confirmed_name, '')) IS DISTINCT FROM btrim(v_period.name) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_YEAR_REOPEN_CONFIRMATION_MISMATCH');
  END IF;

  -- The unsigned report and its open signature slots are void: the numbers
  -- they show are about to change. Same transition as re-finalizing; the
  -- rows stay as history. Requests are not marked declined (that records a
  -- board member refusing to sign); a superseded version cannot be signed
  -- (enforce_annual_report_signature_version_state).
  SELECT coalesce(array_agg(r.id), '{}') INTO v_voided
    FROM public.arsredovisning_signature_requests r
    JOIN public.annual_report_versions v ON v.id = r.annual_report_version_id
   WHERE r.company_id = p_company_id AND r.fiscal_period_id = p_period_id
     AND r.status = 'pending' AND r.signed_at IS NULL
     AND v.status = 'ready_for_signature';

  WITH superseded AS (
    UPDATE public.annual_report_versions
       SET status = 'superseded'
     WHERE company_id = p_company_id
       AND fiscal_period_id = p_period_id
       AND status = 'ready_for_signature'
    RETURNING id
  )
  SELECT coalesce(array_agg(id), '{}') INTO v_superseded FROM superseded;

  -- Open and unlock the year. closing_entry_id stays until the engine has
  -- posted its storno: the immutability trigger only lets it go then.
  UPDATE public.fiscal_periods
     SET is_closed = false,
         closed_at = NULL,
         locked_at = NULL
   WHERE id = p_period_id
     AND company_id = p_company_id
     AND (is_closed OR locked_at IS NOT NULL);

  v_next_id := NULLIF(v_snapshot #>> '{next_period,id}', '')::uuid;
  IF v_next_id IS NOT NULL THEN
    UPDATE public.fiscal_periods
       SET continuity_verified = NULL
     WHERE id = v_next_id
       AND company_id = p_company_id;
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description
  ) VALUES (
    v_actor, p_company_id, 'UPDATE', 'fiscal_periods', p_period_id, v_actor,
    jsonb_build_object(
      'is_closed', v_period.is_closed,
      'closed_at', v_period.closed_at,
      'locked_at', v_period.locked_at,
      'closing_entry_id', v_period.closing_entry_id
    ),
    jsonb_build_object(
      'is_closed', false,
      'closed_at', NULL,
      'locked_at', NULL,
      'resumed', (v_snapshot ->> 'resume')::boolean,
      'entries_to_reverse', v_snapshot -> 'entries',
      'superseded_annual_report_version_ids', to_jsonb(v_superseded),
      'voided_signature_request_ids', to_jsonb(v_voided),
      'confirmation', jsonb_build_object(
        'confirmed_name', p_confirmed_name,
        'annual_report_not_signed_adopted_or_filed', true
      ),
      'registry', v_snapshot -> 'registry'
    ),
    'Fiscal year reopened by the owner: ' || v_period.name || ' ('
      || v_period.period_start || ' to ' || v_period.period_end
      || '). The owner confirmed the årsredovisning was not signed, adopted at a stämma or filed; '
      || 'the year-end closing is reversed by storno, nothing is deleted.'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'period_name', v_period.name,
    'resumed', (v_snapshot ->> 'resume')::boolean,
    'closing_entry_id', v_period.closing_entry_id,
    'entries', v_snapshot -> 'entries',
    'next_period_id', v_next_id,
    'superseded_version_ids', to_jsonb(v_superseded),
    'voided_signature_request_ids', to_jsonb(v_voided)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reopen_closed_fiscal_year(uuid, uuid, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_closed_fiscal_year(uuid, uuid, text, boolean, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.reopen_closed_fiscal_year(uuid, uuid, text, boolean, uuid) IS
  'Owner-only reopen of a fiscal year closed with a year-end run in Accounted, while its årsredovisning has no legal weight (no submission, no signature, not registered at Bolagsverket per a fresh TIC snapshot). Supersedes a ready_for_signature version, opens and unlocks the year, resets the next year''s continuity flag and writes the confirmation to audit_log. The engine then reverses the closing entry, the next year''s IB and omföring, and the currency revaluation by storno, and detaches closing_entry_id. p_user_id honored only for service_role callers.';

NOTIFY pgrst, 'reload schema';
