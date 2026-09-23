-- Key the kontantmetod year-end cut-off on a written marker, not on Swedish
-- display text.
--
-- Why this exists: postKontantmetodCutoff() posts four verifikat (kundfordringar
-- and leverantörsskulder at period end, plus each one's vändning on day one of
-- the next period) and never recorded what it created. Every reader then had to
-- reconstruct the set from journal_entries.description:
--
--   - the service's own finder (lib/core/bookkeeping/kontantmetod-cutoff.ts),
--   - the filed VAT figure, get_vat_declaration_totals (20260813124510),
--   - its drill-down, get_vat_ruta_source_lines (20260828172003).
--
-- A rewording, typo fix or localisation of the vändning descriptions stops
-- matching in all three at once, and the two vändningar would then be counted
-- as new VAT activity in a filed momsdeklaration, undoing the final-period
-- reporting that bokslutsmetoden requires. The reconcile test in
-- tests/pg/vat-ruta-drilldown-reconcile.pg.test.ts cannot catch that: the two
-- SQL readers hold identical copies of the literal, so they drift together and
-- stay consistent with each other while both become wrong against the ledger
-- (issue #2053).
--
-- The fix: the writer records what it created, and the readers join. Free text
-- stops being load-bearing; the four descriptions below appear exactly once
-- more, in the one-time backfill, and nowhere else afterwards.
--
-- Deliberate departures from the new-table template:
--   - no updated_at column or trigger: a marker row is immutable once written,
--     and there is nothing in it to amend.
--   - no UPDATE or DELETE policy and no UPDATE/DELETE grant: a marker that can
--     be re-pointed or removed would silently put an excluded vändning back
--     into a filed declaration. Rows leave only with the journal entry,
--     fiscal period or company they belong to (ON DELETE CASCADE).
--   - no audit trigger: the marker is 1:1 with a journal entry whose INSERT and
--     COMMIT are already in audit_log, so a second row per marker would be
--     audit noise carrying no fact the entry's own trail does not have.
--
-- pg-test: tests/pg/kontantmetod-cutoff-unique.pg.test.ts,
--          tests/pg/vat-declaration-totals-rpc.pg.test.ts,
--          tests/pg/vat-ruta-drilldown-reconcile.pg.test.ts

CREATE TABLE public.kontantmetod_cutoff_entries (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The fiscal year being CLOSED, for all four rows. The two vändningar are
  -- dated in the following period but belong to this cut-off, which is also
  -- what journal_entries.source_id already carries on every one of them.
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'receivable', 'receivable_reversal', 'payable', 'payable_reversal'
  )),
  journal_entry_id uuid NOT NULL UNIQUE REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Deliberately NOT UNIQUE (company_id, fiscal_period_id, kind).
--
-- A cut-off whose vändning fails is stornoed through reverseEntry(), which
-- leaves the original posted entry at status 'reversed' and its marker behind.
-- Re-running the cut-off after such a storno is a supported path today: the
-- race guard on journal_entries (20260813124509) is partial on status = 'posted'
-- and lets the replacement pair post. A unique key per (period, kind) here
-- would be STRICTER than the journal's own guard, and would fail the marker
-- INSERT after the replacement verifikat had already committed, leaving exactly
-- the unmarked vändning this table exists to prevent. Uniqueness per journal
-- entry is what the readers need; serialising live cut-offs stays the job of
-- the race guard at the immutable journal, which is unchanged by this migration.
CREATE INDEX idx_kontantmetod_cutoff_entries_company_period
  ON public.kontantmetod_cutoff_entries (company_id, fiscal_period_id);

ALTER TABLE public.kontantmetod_cutoff_entries ENABLE ROW LEVEL SECURITY;

-- SELECT mirrors journal_entries_select exactly. That symmetry is the point:
-- both VAT functions are SECURITY INVOKER, so a caller who can see an entry can
-- always see its marker. If the marker were hidden where the entry is not, the
-- NOT EXISTS below would flip to true and count an excluded vändning.
CREATE POLICY kontantmetod_cutoff_entries_select
  ON public.kontantmetod_cutoff_entries FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- INSERT mirrors journal_entries_insert (active company + write role), so a
-- session that could post the verifikat can always mark it, and a viewer can
-- do neither.
CREATE POLICY kontantmetod_cutoff_entries_insert
  ON public.kontantmetod_cutoff_entries FOR INSERT
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.current_user_can_write()
  );

REVOKE ALL ON public.kontantmetod_cutoff_entries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.kontantmetod_cutoff_entries TO authenticated, service_role;

-- One-time backfill. This is the ONLY place the four Swedish descriptions may
-- appear from here on: every cut-off posted after this migration is marked by
-- the writer. Both 'posted' and 'reversed' are taken, because that is exactly
-- the status set the VAT functions scope to, so the backfill reproduces today's
-- exclusions row for row rather than changing any filed figure.
--
-- backfill:begin
INSERT INTO public.kontantmetod_cutoff_entries (company_id, fiscal_period_id, kind, journal_entry_id)
SELECT e.company_id,
       e.source_id,
       CASE e.description
         WHEN 'Kundfordringar vid bokslut (kontantmetoden)' THEN 'receivable'
         WHEN 'Vändning kundfordringar bokslut (kontantmetoden)' THEN 'receivable_reversal'
         WHEN 'Leverantörsskulder vid bokslut (kontantmetoden)' THEN 'payable'
         WHEN 'Vändning leverantörsskulder bokslut (kontantmetoden)' THEN 'payable_reversal'
       END,
       e.id
FROM public.journal_entries e
WHERE e.source_type = 'year_end'
  AND e.status IN ('posted', 'reversed')
  AND e.source_id IS NOT NULL
  AND e.description IN (
    'Kundfordringar vid bokslut (kontantmetoden)',
    'Vändning kundfordringar bokslut (kontantmetoden)',
    'Leverantörsskulder vid bokslut (kontantmetoden)',
    'Vändning leverantörsskulder bokslut (kontantmetoden)'
  )
  -- source_id is a fiscal period on every row the service ever wrote. Proving
  -- it here keeps one stray legacy row from aborting the whole backfill on the
  -- foreign key, which would leave the migration unapplied and the readers
  -- keyed on nothing.
  AND EXISTS (
    SELECT 1 FROM public.fiscal_periods fp
    WHERE fp.id = e.source_id AND fp.company_id = e.company_id
  )
ON CONFLICT (journal_entry_id) DO NOTHING;
-- backfill:end

-- Structural guard, created AFTER the backfill so historical rows are taken as
-- they are. A marker is what keeps a verifikat out of a filed momsdeklaration,
-- so the row has to be provably a cut-off posting and not merely asserted to be
-- one. Two conditions, both checked against the ledger:
--
--   1. the marked verifikat is a source_type 'year_end' entry in the same
--      company, anchored to the period the marker claims. An ordinary sales or
--      bank verifikat can never satisfy this.
--
--   2. for the two vändning kinds, which are the only ones the VAT functions
--      exclude, a marker of the paired cut-off kind must already exist for the
--      same company and period whose verifikat is this one's exact mirror,
--      line for line, debit for credit. That is what binds the marker to the
--      cut-off writer without any shared secret: it is the only party that
--      posts a matching pair. It also makes the abuse it prevents pointless.
--      Hiding an arbitrary VAT-bearing entry would first require posting and
--      marking its exact mirror, and that mirror is INCLUDED in the figure, so
--      the amount comes straight back with the opposite sign.
--
-- Enforced for the API roles only, the established pattern for guards of this
-- shape in this schema (see guard_sie_repair_item, 20260911145105). Migrations
-- and superuser repairs run as the table owner and are trusted by other means;
-- the backfill above is exactly such a caller, which also keeps this file
-- replayable in either order.
--
-- SECURITY INVOKER on purpose. current_user inside a SECURITY DEFINER function
-- is the owner, which would make the role gate above always skip. Running as
-- the caller also means a member only ever proves the marker against entries
-- their own RLS lets them see, and service_role (the MCP commit path) bypasses
-- RLS as it does everywhere else.
CREATE OR REPLACE FUNCTION public.guard_kontantmetod_cutoff_entry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_pair_kind text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.journal_entries e
    WHERE e.id = NEW.journal_entry_id
      AND e.company_id = NEW.company_id
      AND e.source_type = 'year_end'
      AND e.source_id = NEW.fiscal_period_id
  ) THEN
    RAISE EXCEPTION 'kontantmetod cut-off marker must reference a year_end journal entry in the same company, anchored to the closed period'
      USING ERRCODE = '23514';
  END IF;

  v_pair_kind := CASE NEW.kind
    WHEN 'receivable_reversal' THEN 'receivable'
    WHEN 'payable_reversal' THEN 'payable'
  END;

  IF v_pair_kind IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.kontantmetod_cutoff_entries k
    WHERE k.company_id = NEW.company_id
      AND k.fiscal_period_id = NEW.fiscal_period_id
      AND k.kind = v_pair_kind
      AND NOT EXISTS (
        (SELECT account_number, debit_amount, credit_amount
           FROM public.journal_entry_lines WHERE journal_entry_id = NEW.journal_entry_id)
        EXCEPT ALL
        (SELECT account_number, credit_amount, debit_amount
           FROM public.journal_entry_lines WHERE journal_entry_id = k.journal_entry_id)
      )
      AND NOT EXISTS (
        (SELECT account_number, credit_amount, debit_amount
           FROM public.journal_entry_lines WHERE journal_entry_id = k.journal_entry_id)
        EXCEPT ALL
        (SELECT account_number, debit_amount, credit_amount
           FROM public.journal_entry_lines WHERE journal_entry_id = NEW.journal_entry_id)
      )
  ) THEN
    RAISE EXCEPTION 'kontantmetod vändning marker requires an already marked cut-off for the same period whose verifikat it mirrors line for line'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_kontantmetod_cutoff_entry() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER guard_kontantmetod_cutoff_entry
  BEFORE INSERT ON public.kontantmetod_cutoff_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_kontantmetod_cutoff_entry();

-- =============================================================================
-- The figure. Body is 20260813124510 verbatim, with the description filter in
-- non_settlement_entries replaced by the marker join.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_vat_declaration_totals(
  p_company_id uuid,
  p_start date,
  p_end date,
  p_accounts text[],
  p_ruta_accounts text[],
  p_net_accounts text[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
WITH closing_entries AS (
  SELECT fp.closing_entry_id AS id
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND fp.closing_entry_id IS NOT NULL
),
scoped_entries AS (
  SELECT e.id, e.status, e.entry_date, e.source_type, e.description,
         e.voucher_series, e.voucher_number
  FROM public.journal_entries e
  WHERE e.company_id = p_company_id
    AND e.status IN ('posted', 'reversed')
    AND e.entry_date >= p_start
    AND e.entry_date <= p_end
    AND NOT (
      e.status = 'posted'
      AND EXISTS (SELECT 1 FROM closing_entries c WHERE c.id = e.id)
    )
),
non_settlement_entries AS (
  SELECT * FROM scoped_entries e
  WHERE e.source_type IS DISTINCT FROM 'vat_settlement'
    AND NOT EXISTS (
      SELECT 1 FROM public.kontantmetod_cutoff_entries k
      WHERE k.journal_entry_id = e.id
        AND k.kind IN ('receivable_reversal', 'payable_reversal')
    )
),
vat_lines AS (
  SELECT l.journal_entry_id, l.account_number, l.debit_amount, l.credit_amount
  FROM public.journal_entry_lines l
  JOIN non_settlement_entries e ON e.id = l.journal_entry_id
  WHERE l.account_number = ANY (p_accounts)
),
shaped AS (
  SELECT e.id, e.status, e.entry_date, e.source_type, e.voucher_series, e.voucher_number
  FROM non_settlement_entries e
  WHERE e.source_type IS DISTINCT FROM 'opening_balance'
    AND EXISTS (
      SELECT 1 FROM vat_lines l
      WHERE l.journal_entry_id = e.id AND l.account_number = ANY (p_ruta_accounts)
    )
    AND EXISTS (
      SELECT 1 FROM vat_lines l
      WHERE l.journal_entry_id = e.id AND l.account_number = ANY (p_net_accounts)
    )
)
SELECT jsonb_build_object(
  'totals', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM vat_lines l
      WHERE NOT EXISTS (SELECT 1 FROM shaped s WHERE s.id = l.journal_entry_id)
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'settlement_shaped_entries', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id,
      'status', s.status,
      'entry_date', s.entry_date,
      'source_type', s.source_type,
      'voucher_series', s.voucher_series,
      'voucher_number', s.voucher_number
    ) ORDER BY s.entry_date, s.id)
    FROM shaped s
  ), '[]'::jsonb),
  'source_type_counts', COALESCE((
    SELECT jsonb_object_agg(COALESCE(c.source_type, ''), c.n)
    FROM (
      SELECT source_type, count(*)::int AS n
      FROM scoped_entries
      GROUP BY source_type
    ) c
  ), '{}'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) TO authenticated, service_role;

-- =============================================================================
-- The drill-down. Body is 20260828172003 verbatim, with the same replacement.
-- The exclusion CTEs stay lifted verbatim from the figure for the reason that
-- migration gives: a copy that reads identically is easy to diff. What changed
-- is that the copied text is no longer a Swedish sentence.
--
-- CREATE OR REPLACE on the existing 11-arg signature: no DROP, so the ACL from
-- 20260829090500 (no EXECUTE for anon) survives untouched.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_vat_ruta_source_lines(
  p_company_id uuid,
  p_start date,
  p_end date,
  p_accounts text[],
  p_ruta_accounts text[],
  p_net_accounts text[],
  p_cursor_date date DEFAULT NULL,
  p_cursor_voucher_number integer DEFAULT NULL,
  p_cursor_entry_id uuid DEFAULT NULL,
  p_cursor_line_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 501
)
RETURNS TABLE (
  line_id uuid,
  journal_entry_id uuid,
  voucher_number integer,
  voucher_series text,
  entry_date date,
  description text,
  debit_amount numeric,
  credit_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH closing_entries AS (
    SELECT fp.closing_entry_id AS id
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND fp.closing_entry_id IS NOT NULL
  ),
  scoped_entries AS (
    SELECT e.id, e.status, e.entry_date, e.source_type, e.description,
           e.voucher_series, e.voucher_number
    FROM public.journal_entries e
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND e.entry_date >= p_start
      AND e.entry_date <= p_end
      AND NOT (
        e.status = 'posted'
        AND EXISTS (SELECT 1 FROM closing_entries c WHERE c.id = e.id)
      )
  ),
  non_settlement_entries AS (
    SELECT * FROM scoped_entries e
    WHERE e.source_type IS DISTINCT FROM 'vat_settlement'
      AND NOT EXISTS (
        SELECT 1 FROM public.kontantmetod_cutoff_entries k
        WHERE k.journal_entry_id = e.id
          AND k.kind IN ('receivable_reversal', 'payable_reversal')
      )
  ),
  shaped AS (
    SELECT e.id
    FROM non_settlement_entries e
    WHERE e.source_type IS DISTINCT FROM 'opening_balance'
      AND EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number = ANY (p_ruta_accounts)
      )
      AND EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number = ANY (p_net_accounts)
      )
  )
  SELECT
    l.id AS line_id,
    je.id AS journal_entry_id,
    je.voucher_number,
    COALESCE(je.voucher_series, 'A') AS voucher_series,
    je.entry_date,
    COALESCE(je.description, '') AS description,
    l.debit_amount,
    l.credit_amount
  FROM non_settlement_entries je
  JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
  WHERE l.account_number = ANY (p_accounts)
    AND NOT EXISTS (SELECT 1 FROM shaped s WHERE s.id = je.id)
    AND (
      p_cursor_date IS NULL
      OR (
        je.entry_date,
        je.voucher_number,
        je.id,
        l.id
      ) > (
        p_cursor_date,
        p_cursor_voucher_number,
        COALESCE(p_cursor_entry_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid),
        COALESCE(p_cursor_line_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
      )
    )
  ORDER BY je.entry_date, je.voucher_number, je.id, l.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 501), 1), 501);
$$;

NOTIFY pgrst, 'reload schema';
