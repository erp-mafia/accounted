SELECT set_config('lock_timeout', '5s', true);

-- A wrongly linked underlag: its link is struck, nothing moves and nothing is
-- deleted, and the right verifikat gets a copy.
-- pg-test: tests/pg/document-link-strike.pg.test.ts
--
-- An underlag attached to the wrong verifikat had no way off it: its link is
-- set once (enforce_document_journal_entry_immutability, 20260705100000) and a
-- document held by a posted verifikat is never deleted (block_document_deletion,
-- BFL 7 kap 2 §). Correcting it is a rättelse of the verifikation, made the way
-- a struck line is made in the same verifikat:
--
--   * nothing moves: journal_entry_id keeps naming the verifikat the document
--     was attached to, and the immutability trigger is not touched;
--   * the link is struck: link_struck_at (when), link_struck_by (who) and
--     link_struck_reason (why), set once and never changed again. BFL 5 kap
--     9 §: "Om en verifikation rättas, skall det anges när rättelsen har skett
--     och vem som har gjort den." BFNAR 2013:2 punkt 5.15: "Rättas en
--     verifikation ska det göras på sådant sätt att den ursprungliga uppgiften
--     klart framgår.";
--   * the document stays in the archive behind every WORM guard it had;
--   * the right verifikat gets a byte-identical copy (linkDocumentCopyToVoucher
--     checks the SHA-256), named in link_struck_copy_id.
--
-- 1. Four nullable columns on document_attachments and a CHECK that they are
--    set together. NOT VALID here and validated in 20261127160100, in its own
--    transaction, so this file never scans the table under the ALTER's lock.
-- 2. enforce_document_link_strike, the rules of a strike. A strike is made
--    on a linked row, never inserted. It is permanent, and a struck document
--    keeps its place: no new version over it, and its link never moves (a
--    correction's relink leaves it on the original, item 3). Only a carve-out
--    that takes the document off its verifikat altogether (delete_last_voucher,
--    under gnubok.allow_delete) ends the strike with the link, the audit row
--    keeping both. A new strike needs the current document on a posted verifikat in an
--    open, unlocked period after the company's lock date (the window of every
--    rättelse in the same verifikat), a reason, and a member of the company as
--    the person: the session's own user, else the person a server-side caller
--    names. The database clock says when. A document a bank transaction or a
--    supplier invoice holds as its own underlag is refused: those registers
--    own it, as for detach_underlag_duplicate. A copy, when named, is the same
--    bytes on another posted verifikat of the company.
-- 3. A struck link is not the verifikat's underlag: the three readers of
--    "verifikat without underlag" (verifikat_without_documents,
--    list_verifikat_missing_underlag, transactions_without_documents),
--    underlag_left_on_replaced_copies and detach_underlag_duplicate skip it,
--    and relink_documents_to_correction leaves it on the corrected original
--    while it carries the rest to the correction. Each is restated from its
--    current definition with that predicate; detach also refuses a struck
--    document.
-- 4. erase_user_personal_data keeps the name of a person who struck a link,
--    as it keeps the name of a person who corrected an entry
--    (rattelse_actor_names, BFL 5 kap 9 § and 7 kap 2 §). Restated from
--    20261123180000 with one more source of names.

-- 1. The strike, on the document's own row ----------------------------------

ALTER TABLE public.document_attachments
  ADD COLUMN link_struck_at timestamptz,
  ADD COLUMN link_struck_by uuid,
  ADD COLUMN link_struck_reason text,
  ADD COLUMN link_struck_copy_id uuid,
  ADD CONSTRAINT document_attachments_link_strike_check CHECK (
    (link_struck_at IS NULL AND link_struck_by IS NULL
      AND link_struck_reason IS NULL AND link_struck_copy_id IS NULL)
    OR (link_struck_at IS NOT NULL AND link_struck_by IS NOT NULL
      AND btrim(coalesce(link_struck_reason, '')) <> ''
      AND length(link_struck_reason) <= 500
      AND journal_entry_id IS NOT NULL)
  ) NOT VALID;

COMMENT ON COLUMN public.document_attachments.link_struck_at IS
  'When the link to journal_entry_id was struck (the document was attached to the wrong verifikat). Set once by the database clock; enforce_document_link_strike.';
COMMENT ON COLUMN public.document_attachments.link_struck_by IS
  'Who struck the link (BFL 5 kap 9 §): the session''s user, or the member a server-side caller names.';
COMMENT ON COLUMN public.document_attachments.link_struck_reason IS
  'Why the link was struck, as the person wrote it.';
COMMENT ON COLUMN public.document_attachments.link_struck_copy_id IS
  'The byte-identical copy the right verifikat got, when the strike named one.';

-- 2. The rules of a strike ---------------------------------------------------

-- SECURITY DEFINER so the checks read the verifikat, the period, the lock date,
-- the membership and the registers whatever the caller's row-level access;
-- it changes nothing but NEW.
CREATE OR REPLACE FUNCTION public.enforce_document_link_strike()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_entry record;
  v_period record;
  v_lock_date date;
  v_copy record;
BEGIN
  -- A strike is made on the row of a linked document, by the rules below,
  -- never written with a new row: an inserted one would carry whatever who,
  -- when and verifikat the writer chose.
  IF TG_OP = 'INSERT' THEN
    IF NEW.link_struck_at IS NOT NULL OR NEW.link_struck_by IS NOT NULL
       OR NEW.link_struck_reason IS NOT NULL OR NEW.link_struck_copy_id IS NOT NULL THEN
      RAISE EXCEPTION 'DOC_STRIKE_NOT_LINKED: a document is struck on its own row once it is linked, never inserted struck';
    END IF;
    RETURN NEW;
  END IF;

  -- The carve-outs that own the whole row (delete_last_voucher, the resets).
  -- One that takes the document off its verifikat ends the link the strike
  -- was about, so the strike ends with it and the document is a plain one
  -- again; the audit row of this update keeps both.
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF NEW.journal_entry_id IS NULL AND OLD.link_struck_at IS NOT NULL THEN
      NEW.link_struck_at := NULL;
      NEW.link_struck_by := NULL;
      NEW.link_struck_reason := NULL;
      NEW.link_struck_copy_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.link_struck_at IS NOT NULL THEN
    IF NEW.link_struck_at IS DISTINCT FROM OLD.link_struck_at
       OR NEW.link_struck_by IS DISTINCT FROM OLD.link_struck_by
       OR NEW.link_struck_reason IS DISTINCT FROM OLD.link_struck_reason
       OR NEW.link_struck_copy_id IS DISTINCT FROM OLD.link_struck_copy_id THEN
      RAISE EXCEPTION 'DOC_STRIKE_PERMANENT: the struck link of document % cannot change (BFL 5 kap 9 §)', OLD.id;
    END IF;
    -- A new version would put the wrong underlag back on the verifikat,
    -- unstruck, and take the strike out of the current versions.
    IF NEW.is_current_version IS DISTINCT FROM OLD.is_current_version
       OR NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id THEN
      RAISE EXCEPTION 'DOC_STRIKE_PERMANENT: document % has a struck link and keeps its place; attach the right underlag as a document of its own', OLD.id;
    END IF;
    -- The strike belongs to the verifikat it was made on: the link stays
    -- there, even where a correction's relink could move it.
    IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.journal_entry_line_id IS DISTINCT FROM OLD.journal_entry_line_id THEN
      RAISE EXCEPTION 'DOC_STRIKE_PERMANENT: document % has a struck link and stays on the verifikat it was struck from', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.link_struck_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- A new strike: of a link, on the current version, moving nothing.
  IF OLD.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'DOC_STRIKE_NOT_LINKED: document % is on no verifikat', OLD.id;
  END IF;
  IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
     OR NEW.journal_entry_line_id IS DISTINCT FROM OLD.journal_entry_line_id THEN
    RAISE EXCEPTION 'DOC_STRIKE_NOT_LINKED: a strike leaves document % on its verifikat', OLD.id;
  END IF;
  IF OLD.is_current_version IS DISTINCT FROM true OR NEW.is_current_version IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'DOC_STRIKE_NOT_CURRENT: only the current version of document % can be struck', OLD.id;
  END IF;

  SELECT je.status, je.entry_date, je.fiscal_period_id
    INTO v_entry
    FROM public.journal_entries je
   WHERE je.id = OLD.journal_entry_id
     AND je.company_id = OLD.company_id;
  IF NOT FOUND OR v_entry.status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'DOC_STRIKE_NOT_POSTED: document % is not on a posted verifikat', OLD.id;
  END IF;

  -- The window of a rättelse in the same verifikat: past a close, a lock or
  -- the lock date the verifikation stays as it is.
  SELECT fp.is_closed, fp.locked_at
    INTO v_period
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;
  IF coalesce(v_period.is_closed, false) OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'DOC_STRIKE_PERIOD_LOCKED: the verifikat of document % is in a closed or locked period', OLD.id;
  END IF;
  SELECT cs.bookkeeping_locked_through
    INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = OLD.company_id;
  IF v_lock_date IS NOT NULL AND v_entry.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'DOC_STRIKE_PERIOD_LOCKED: the books are locked through % and the verifikat of document % is dated before that', v_lock_date, OLD.id;
  END IF;

  IF btrim(coalesce(NEW.link_struck_reason, '')) = '' THEN
    RAISE EXCEPTION 'DOC_STRIKE_REASON_REQUIRED: say why the link of document % is struck', OLD.id;
  END IF;

  -- Who: a person in a session strikes as themselves; a server-side caller
  -- (no user in its claims) names the person it acts for. Either way a
  -- member of the company.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    NEW.link_struck_by := auth.uid();
  END IF;
  IF NEW.link_struck_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members cm
     WHERE cm.company_id = OLD.company_id
       AND cm.user_id = NEW.link_struck_by
  ) THEN
    RAISE EXCEPTION 'DOC_STRIKE_ACTOR_REQUIRED: a strike names a member of the company as the person who made it';
  END IF;
  -- When: the database's clock, not the caller's.
  NEW.link_struck_at := now();

  -- A document a register holds as its own underlag is changed through that
  -- register, never struck here (as for detach_underlag_duplicate).
  IF EXISTS (
    SELECT 1 FROM public.transactions t
     WHERE t.document_id = OLD.id AND t.company_id = OLD.company_id
  ) THEN
    RAISE EXCEPTION 'DOC_STRIKE_PINNED: document % is the underlag of a bank transaction', OLD.id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoices si
     WHERE si.document_id = OLD.id AND si.company_id = OLD.company_id
  ) THEN
    RAISE EXCEPTION 'DOC_STRIKE_PINNED: document % is the original underlag of a supplier invoice', OLD.id;
  END IF;

  -- The copy the right verifikat got: the same bytes, the company's own, on
  -- another posted verifikat, itself not struck.
  IF NEW.link_struck_copy_id IS NOT NULL THEN
    SELECT c.company_id, c.sha256_hash, c.journal_entry_id, c.is_current_version, c.link_struck_at,
           je.status AS entry_status
      INTO v_copy
      FROM public.document_attachments c
      LEFT JOIN public.journal_entries je
        ON je.id = c.journal_entry_id
       AND je.company_id = c.company_id
     WHERE c.id = NEW.link_struck_copy_id;
    IF NOT FOUND
       OR v_copy.company_id IS DISTINCT FROM OLD.company_id
       OR v_copy.sha256_hash IS DISTINCT FROM OLD.sha256_hash
       OR v_copy.journal_entry_id IS NULL
       OR v_copy.journal_entry_id = OLD.journal_entry_id
       OR v_copy.entry_status IS DISTINCT FROM 'posted'
       OR v_copy.is_current_version IS DISTINCT FROM true
       OR v_copy.link_struck_at IS NOT NULL THEN
      RAISE EXCEPTION 'DOC_STRIKE_COPY_INVALID: the copy named for document % is not the same underlag on another posted verifikat', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_document_link_strike() FROM PUBLIC, anon, authenticated;

-- Fires on an insert, on the strike's own columns, on the version columns
-- (a struck document cannot be superseded) and on the link columns (a struck
-- link never moves). Every other update of the row passes it by.
CREATE TRIGGER enforce_document_link_strike
  BEFORE INSERT OR UPDATE OF link_struck_at, link_struck_by, link_struck_reason, link_struck_copy_id,
    is_current_version, superseded_by_id, journal_entry_id, journal_entry_line_id
  ON public.document_attachments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_document_link_strike();

-- 3. A struck link is not the verifikat's underlag ---------------------------

CREATE OR REPLACE FUNCTION public.verifikat_without_documents(
  p_company_id uuid,
  p_since date DEFAULT NULL,
  p_min_amount numeric DEFAULT 0,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_until date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
-- Every scan here is one company's: starting parallel workers for them costs
-- more than they save.
SET max_parallel_workers_per_gather TO 0
-- Planned for the company and filters it is called with: the cached generic
-- plan was 10-20 ms slower per call.
SET plan_cache_mode TO force_custom_plan
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_min numeric := greatest(coalesce(p_min_amount, 0), 0);
  v_result jsonb;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_company_ids() AS c(id) WHERE c.id = p_company_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'VERIFIKAT_WITHOUT_DOCUMENTS_FORBIDDEN');
    END IF;
  END IF;

  -- needs_doc: the company's posted verifikat whose affärshändelse requires
  -- an underlag, read once. Each NOT EXISTS below is resolved as one hash
  -- anti join against a company-scoped set, and lines are summed only for the
  -- verifikat left over.
  WITH needs_doc AS MATERIALIZED (
    SELECT je.id, je.voucher_number, je.entry_date
    FROM journal_entries je
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      -- Only source types whose affärshändelse requires an underlag.
      -- Mirrors NEEDS_DOC_SOURCE_TYPES (lib/worklist/types.ts).
      AND je.source_type IN (
        'manual',
        'bank_transaction',
        'supplier_invoice_registered',
        'supplier_invoice_paid',
        'supplier_invoice_cash_payment',
        'import',
        'webshop_order',
        'inbox_item',
        'pos_daily_sales'
      )
      AND (p_since IS NULL OR je.entry_date >= p_since)
      AND (p_until IS NULL OR je.entry_date <= p_until)
  ),
  -- The company's current documents on a verifikat. Superseded versions do
  -- not satisfy BFL underlag, and neither does a struck link: the document
  -- was attached to the wrong verifikat (enforce_document_link_strike). Only
  -- the company's own documents count: another company's file is not this
  -- company's underlag (none is attached across companies in production),
  -- and reading them once is what lets the anti join below hash instead of
  -- probing per verifikat.
  current_documents AS MATERIALIZED (
    SELECT d.journal_entry_id
    FROM document_attachments d
    WHERE d.company_id = p_company_id
      AND d.journal_entry_id IS NOT NULL
      AND d.is_current_version = true
      AND d.link_struck_at IS NULL
  ),
  -- The company's supplier invoices whose source document is ANCHORED
  -- (journal_entry_id set): only anchored docs sit behind the WORM deletion
  -- guards, so an unanchored doc cannot legally back a posted verifikat and
  -- must keep the warning alive. Shared by the three supplier arms below.
  supplier_invoices_with_document AS MATERIALIZED (
    SELECT si.id, si.registration_journal_entry_id, si.payment_journal_entry_id
    FROM supplier_invoices si
    JOIN document_attachments sd ON sd.id = si.document_id
    WHERE si.company_id = p_company_id
      AND sd.journal_entry_id IS NOT NULL
  ),
  -- The company's ISSUED invoices: a draft or cancelled invoice is no
  -- document (outside those two statuses an invoice_number is required,
  -- migration 20260427150000). Mirrors NON_ISSUED_INVOICE_STATUSES
  -- (lib/invoices/matchable-statuses.ts). Shared by the two customer arms.
  issued_invoices AS MATERIALIZED (
    SELECT i.id, i.journal_entry_id
    FROM invoices i
    WHERE i.company_id = p_company_id
      AND i.status NOT IN ('draft', 'cancelled')
  ),
  missing AS MATERIALIZED (
    SELECT n.*
    FROM needs_doc n
    WHERE NOT EXISTS (
        SELECT 1 FROM current_documents d
        WHERE d.journal_entry_id = n.id
      )
      -- Explicitly waived (e.g. internal transfers): user decided no
      -- underlag is required; do not resurface to agents.
      AND NOT EXISTS (
        SELECT 1 FROM journal_entry_no_doc_required x
        WHERE x.company_id = p_company_id
          AND x.journal_entry_id = n.id
      )
      -- BFL 5 kap 7 §: hänvisning till underlag. An entry booked from a
      -- supplier invoice whose source document is retained is covered by
      -- that document even though the doc row hangs on the invoice's other
      -- verifikat (registration vs payment).
      AND NOT EXISTS (
        SELECT 1 FROM supplier_invoices_with_document s
        WHERE s.registration_journal_entry_id = n.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM supplier_invoices_with_document s
        WHERE s.payment_journal_entry_id = n.id
      )
      -- Partial payments link through supplier_invoice_payments instead of
      -- supplier_invoices.payment_journal_entry_id.
      AND NOT EXISTS (
        SELECT 1
        FROM supplier_invoice_payments sip
        JOIN supplier_invoices_with_document s ON s.id = sip.supplier_invoice_id
        WHERE sip.journal_entry_id = n.id
      )
      -- BFL 5 kap 7 § hänvisning, customer side (#2298): an entry a register
      -- invoice points at is backed by that invoice. The invoice Accounted
      -- issued IS the verifikation for the sale, and the payment row
      -- identifies the inbetalning. Both links are written on the invoice
      -- side (registration booking, kontantmetod inbetalning, delbetalning,
      -- "matcha mot befintligt verifikat"), so an imported or manual entry
      -- keeps its own source_type and must be resolved from here. Tenant
      -- scoped on the link row, never on the entry alone. The invoice must
      -- be ISSUED, the counterpart of the anchored-document requirement on
      -- the supplier arms.
      AND NOT EXISTS (
        SELECT 1 FROM issued_invoices i
        WHERE i.journal_entry_id = n.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM invoice_payments ip
        JOIN issued_invoices i ON i.id = ip.invoice_id
        WHERE ip.company_id = p_company_id
          AND ip.journal_entry_id = n.id
      )
  ),
  -- The verifikat whose gross amount is needed: with a min_amount, every
  -- missing one (the filter reads it); without, only the requested page,
  -- since every gross amount passes a zero minimum (they are floored at 0).
  scope AS (
    SELECT m.*
    FROM missing m
    WHERE v_min > 0
    UNION ALL
    SELECT p.*
    FROM (
      SELECT m.*
      FROM missing m
      WHERE v_min = 0
      ORDER BY m.entry_date DESC, m.voucher_number DESC, m.id DESC
      LIMIT v_limit OFFSET v_offset
    ) p
  ),
  candidates AS (
    SELECT
      s.id,
      s.voucher_number,
      s.entry_date,
      -- The debit total less every self-assessed output VAT leg (reverse
      -- charge 2614/2624/2634, import 2615/2625/2635; the output accounts
      -- of REVERSE_CHARGE_VAT_ACCOUNTS, lib/bookkeeping/vat-entries.ts).
      -- A credit leg is offset by a debit (2645, 2647, 2641, or the cost
      -- when the moms is not deductible) and a credit note's debit leg is
      -- a debit itself, so each leg inflates the total by its own amount.
      -- Floored at zero: a verifikat that only moves self-assessed moms
      -- moved no money.
      round(greatest(
        coalesce(sum(l.debit_amount), 0)
          - coalesce(sum(l.debit_amount + l.credit_amount) FILTER (
              WHERE l.account_number IN ('2614', '2624', '2634', '2615', '2625', '2635')
            ), 0),
        0
      ), 2) AS gross_amount
    FROM scope s
    LEFT JOIN journal_entry_lines l ON l.journal_entry_id = s.id
    GROUP BY s.id, s.voucher_number, s.entry_date
  ),
  -- min_amount filters on the same gross_amount the rows report: one
  -- definition, so the filter, total_count and the page cannot disagree.
  matching AS (
    SELECT * FROM candidates WHERE gross_amount >= v_min
  ),
  total AS (
    SELECT CASE WHEN v_min > 0 THEN (SELECT count(*) FROM matching)
                ELSE (SELECT count(*) FROM missing)
           END AS n
  ),
  page AS (
    SELECT * FROM matching
    ORDER BY entry_date DESC, voucher_number DESC, id DESC
    -- Without a min_amount the scope already is the page.
    LIMIT v_limit OFFSET CASE WHEN v_min > 0 THEN v_offset ELSE 0 END
  ),
  -- The rest of a page row comes from its verifikat, for the page alone.
  page_rows AS (
    SELECT p.id, je.voucher_series, p.voucher_number, p.entry_date, je.description, je.source_type, p.gross_amount
    FROM page p
    JOIN journal_entries je ON je.id = p.id
  )
  SELECT jsonb_build_object(
    'ok', true,
    'total_count', (SELECT n FROM total),
    'verifikat', coalesce(
      (SELECT jsonb_agg(
         jsonb_build_object(
           'journal_entry_id', p.id,
           'voucher_series', p.voucher_series,
           'voucher_number', p.voucher_number,
           'entry_date', p.entry_date,
           'description', p.description,
           'source_type', p.source_type,
           'gross_amount', p.gross_amount
         )
         ORDER BY p.entry_date DESC, p.voucher_number DESC, p.id DESC
       ) FROM page_rows p),
      '[]'::jsonb
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_verifikat_missing_underlag(
  p_company_id uuid,
  p_period_id uuid DEFAULT NULL,
  p_series text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_search_pattern text DEFAULT NULL,
  p_search_voucher_series text DEFAULT NULL,
  p_search_voucher_number integer DEFAULT NULL,
  p_order text[] DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  -- 1,000 = the most rows one list request carries (MAX_ROWS_PER_REQUEST).
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_token text;
  v_fragment text;
  v_terms text[] := ARRAY[]::text[];
  v_with_amount boolean := false;
  v_order_sql text;
  v_ranked_sql text;
  v_result jsonb;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_company_ids() AS c(id) WHERE c.id = p_company_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LIST_VERIFIKAT_MISSING_UNDERLAG_FORBIDDEN');
    END IF;
  END IF;

  IF coalesce(array_length(p_order, 1), 0) > 8 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LIST_VERIFIKAT_MISSING_UNDERLAG_INVALID_ORDER');
  END IF;

  FOREACH v_token IN ARRAY coalesce(p_order, ARRAY[]::text[]) LOOP
    v_fragment := CASE v_token
      WHEN 'entry_date.asc' THEN 'entry_date ASC'
      WHEN 'entry_date.desc' THEN 'entry_date DESC'
      WHEN 'voucher_series.asc' THEN 'voucher_series ASC'
      WHEN 'voucher_series.desc' THEN 'voucher_series DESC'
      WHEN 'voucher_number.asc' THEN 'voucher_number ASC'
      WHEN 'voucher_number.desc' THEN 'voucher_number DESC'
      WHEN 'description.asc' THEN 'description ASC'
      WHEN 'description.desc' THEN 'description DESC'
      WHEN 'display_amount.asc' THEN 'display_amount ASC'
      WHEN 'display_amount.desc' THEN 'display_amount DESC'
      WHEN 'id.asc' THEN 'id ASC'
      WHEN 'id.desc' THEN 'id DESC'
    END;
    IF v_fragment IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LIST_VERIFIKAT_MISSING_UNDERLAG_INVALID_ORDER');
    END IF;
    v_terms := v_terms || v_fragment;
    IF v_token LIKE 'display_amount.%' THEN
      v_with_amount := true;
    END IF;
  END LOOP;
  -- A total order whatever the caller sent: ids are unique.
  v_order_sql := array_to_string(v_terms || 'id ASC'::text, ', ');

  -- The amount the Belopp column shows, only when the sort asks for it: for
  -- the whole missing set in one statement, not one call per verifikat. Both
  -- texts are constants; no caller text reaches the statement.
  v_ranked_sql := CASE
    WHEN v_with_amount THEN
      'SELECT m.*, a.display_amount FROM missing m '
      || 'LEFT JOIN public.verifikat_display_amounts($1, ARRAY(SELECT mm.id FROM missing mm)) a '
      || 'ON a.journal_entry_id = m.id'
    ELSE
      'SELECT m.*, NULL::numeric AS display_amount FROM missing m'
  END;

  EXECUTE format($sql$
    WITH missing AS MATERIALIZED (
      SELECT
        je.id,
        je.entry_date,
        je.voucher_series,
        je.voucher_number,
        je.description
      FROM public.journal_entries je
      WHERE je.company_id = $1
        AND je.status = 'posted'
        -- Only source types whose affärshändelse requires an underlag.
        -- Mirrors NEEDS_DOC_SOURCE_TYPES (lib/worklist/types.ts).
        AND je.source_type IN (
          'manual',
          'bank_transaction',
          'supplier_invoice_registered',
          'supplier_invoice_paid',
          'supplier_invoice_cash_payment',
          'import',
          'webshop_order',
          'inbox_item',
          'pos_daily_sales'
        )
        -- Superseded document versions do not satisfy BFL underlag, and
        -- neither does a struck link (enforce_document_link_strike).
        AND NOT EXISTS (
          SELECT 1 FROM public.document_attachments d
          WHERE d.company_id = $1
            AND d.journal_entry_id = je.id AND d.is_current_version = true
            AND d.link_struck_at IS NULL
        )
        -- Explicitly waived ("Inget underlag krävs").
        AND NOT EXISTS (
          SELECT 1 FROM public.journal_entry_no_doc_required x
          WHERE x.company_id = $1
            AND x.journal_entry_id = je.id
        )
        -- BFL 5 kap 7 § hänvisning, supplier side: a supplier invoice whose
        -- retained document is ANCHORED to a journal entry covers both its
        -- registration and its payment verifikat.
        AND NOT EXISTS (
          SELECT 1
          FROM public.supplier_invoices si
          JOIN public.document_attachments sd ON sd.id = si.document_id
          WHERE si.company_id = $1
            AND sd.journal_entry_id IS NOT NULL
            AND (si.registration_journal_entry_id = je.id
              OR si.payment_journal_entry_id = je.id)
        )
        -- Partial payments link through supplier_invoice_payments.
        AND NOT EXISTS (
          SELECT 1
          FROM public.supplier_invoice_payments sip
          JOIN public.supplier_invoices sip_si ON sip_si.id = sip.supplier_invoice_id
          JOIN public.document_attachments sipd ON sipd.id = sip_si.document_id
          WHERE sip.journal_entry_id = je.id
            AND sip_si.company_id = $1
            AND sipd.journal_entry_id IS NOT NULL
        )
        -- BFL 5 kap 7 § hänvisning, customer side (#2298): an ISSUED register
        -- invoice pointing at the entry (registration link or payment row).
        AND NOT EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.company_id = $1
            AND i.journal_entry_id = je.id
            AND i.status NOT IN ('draft', 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.invoice_payments ip
          JOIN public.invoices ipi ON ipi.id = ip.invoice_id
          WHERE ip.company_id = $1
            AND ip.journal_entry_id = je.id
            AND ipi.status NOT IN ('draft', 'cancelled')
        )
        -- The list's filters.
        AND ($2::uuid IS NULL OR je.fiscal_period_id = $2)
        AND ($3::text IS NULL OR je.voucher_series = $3)
        AND ($4::date IS NULL OR je.entry_date >= $4)
        AND ($5::date IS NULL OR je.entry_date <= $5)
        -- Same search as the direct list query: the description, and a
        -- voucher-label needle ("A209") also matches series + number.
        AND (
          $6::text IS NULL
          OR je.description ILIKE $6
          OR ($7::text IS NOT NULL AND je.voucher_series = $7 AND je.voucher_number = $8)
        )
    ),
    ranked AS (
      %2$s
    ),
    page AS (
      SELECT * FROM ranked
      ORDER BY %1$s
      LIMIT $9 OFFSET $10
    )
    SELECT jsonb_build_object(
      'ok', true,
      'total_count', (SELECT count(*) FROM missing),
      'ids', coalesce((SELECT jsonb_agg(id ORDER BY %1$s) FROM page), '[]'::jsonb)
    )
  $sql$, v_order_sql, v_ranked_sql)
  INTO v_result
  USING
    p_company_id,
    p_period_id,
    p_series,
    p_date_from,
    p_date_to,
    p_search_pattern,
    p_search_voucher_series,
    p_search_voucher_number,
    v_limit,
    v_offset;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.transactions_without_documents(
  p_company_id uuid,
  p_since date DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_company_ids() AS c(id) WHERE c.id = p_company_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TRANSACTIONS_WITHOUT_DOCUMENTS_FORBIDDEN');
    END IF;
  END IF;

  WITH candidates AS (
    SELECT
      t.id,
      t.date,
      t.description,
      t.amount,
      t.currency,
      t.merchant_name,
      t.reference,
      t.is_business,
      t.category,
      t.journal_entry_id,
      t.cash_account_id,
      ca.ledger_account AS cash_account_ledger
    FROM transactions t
    JOIN journal_entries je ON je.id = t.journal_entry_id
    LEFT JOIN cash_accounts ca
      ON ca.id = t.cash_account_id
     AND ca.company_id = t.company_id
    WHERE t.company_id = p_company_id
      AND je.status = 'posted'
      -- Same predicate as verifikat_without_documents: this surface is the
      -- bank-driven subset, keyed on the SAME document truth
      -- (document_attachments), never transactions.document_id.
      AND je.source_type IN (
        'manual',
        'bank_transaction',
        'supplier_invoice_registered',
        'supplier_invoice_paid',
        'supplier_invoice_cash_payment',
        'import',
        'inbox_item'
      )
      -- A struck link is not the verifikat's underlag
      -- (enforce_document_link_strike).
      AND NOT EXISTS (
        SELECT 1 FROM document_attachments d
        WHERE d.journal_entry_id = je.id AND d.is_current_version = true
          AND d.link_struck_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM journal_entry_no_doc_required x
        WHERE x.journal_entry_id = je.id
      )
      -- BFL 5 kap 7 § hänvisning till underlag (anchored docs only); see
      -- verifikat_without_documents.
      AND NOT EXISTS (
        SELECT 1
        FROM supplier_invoices si
        JOIN document_attachments sd ON sd.id = si.document_id
        WHERE si.company_id = p_company_id
          AND sd.journal_entry_id IS NOT NULL
          AND (si.registration_journal_entry_id = je.id
            OR si.payment_journal_entry_id = je.id)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM supplier_invoice_payments sip
        JOIN supplier_invoices sip_si ON sip_si.id = sip.supplier_invoice_id
        JOIN document_attachments sipd ON sipd.id = sip_si.document_id
        WHERE sip.journal_entry_id = je.id
          AND sip_si.company_id = p_company_id
          AND sipd.journal_entry_id IS NOT NULL
      )
      -- Customer-invoice hänvisning, issued invoices only (#2298); see
      -- verifikat_without_documents.
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.company_id = p_company_id
          AND i.journal_entry_id = je.id
          AND i.status NOT IN ('draft', 'cancelled')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM invoice_payments ip
        JOIN invoices ipi ON ipi.id = ip.invoice_id
        WHERE ip.company_id = p_company_id
          AND ip.journal_entry_id = je.id
          AND ipi.status NOT IN ('draft', 'cancelled')
      )
      AND (p_since IS NULL OR t.date >= p_since)
  ),
  total AS (
    SELECT count(*) AS n FROM candidates
  ),
  page AS (
    SELECT * FROM candidates
    ORDER BY date DESC, id DESC
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'ok', true,
    'total_count', (SELECT n FROM total),
    'transactions', coalesce(
      (SELECT jsonb_agg(
         jsonb_build_object(
           'id', p.id,
           'transaction_id', p.id,
           'date', p.date,
           'description', p.description,
           'amount', p.amount,
           'currency', p.currency,
           'merchant_name', p.merchant_name,
           'reference', p.reference,
           'is_business', p.is_business,
           'category', p.category,
           'journal_entry_id', p.journal_entry_id,
           'cash_account_id', p.cash_account_id,
           'cash_account_ledger', p.cash_account_ledger
         )
         ORDER BY p.date DESC, p.id DESC
       ) FROM page p),
      '[]'::jsonb
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.underlag_left_on_replaced_copies(p_company_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public SET statement_timeout = '8s' SET plan_cache_mode = force_custom_plan
AS $$
BEGIN
  RETURN (
    SELECT count(*)::integer
    FROM journal_entries live
    JOIN fiscal_periods fp ON fp.id = live.fiscal_period_id AND fp.company_id = p_company_id
    WHERE live.company_id = p_company_id
      AND live.status = 'posted'
      AND live.source_voucher_series IS NOT NULL
      AND live.source_voucher_number IS NOT NULL
      AND NOT fp.is_closed
      AND fp.locked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM document_attachments d
        WHERE d.journal_entry_id = live.id AND d.company_id = p_company_id AND d.is_current_version
          AND d.link_struck_at IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM journal_entries rev
        JOIN document_attachments rd
          ON rd.journal_entry_id = rev.id AND rd.company_id = p_company_id AND rd.is_current_version
         AND rd.link_struck_at IS NULL
        WHERE rev.company_id = p_company_id
          AND rev.status = 'reversed'
          AND rev.fiscal_period_id = live.fiscal_period_id
          AND rev.source_voucher_series = live.source_voucher_series
          AND rev.source_voucher_number = live.source_voucher_number
      )
  );
END
$$;

CREATE OR REPLACE FUNCTION public.detach_underlag_duplicate(
  p_company_id  uuid,
  p_document_id uuid,
  p_user_id     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role     text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor        uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role  text;
  v_doc          record;
  v_entry        record;
  v_is_closed    boolean;
  v_locked_at    timestamptz;
  v_lock_date    date;
  v_siblings     integer;
  v_duplicates   integer;
  v_pinned_tx    uuid;
  v_pinned_si    uuid;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    -- A JWT caller can never act as someone else: p_user_id is only for
    -- service-role paths, which authenticate the user application-side.
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Endast användare med skrivbehörighet kan koppla bort underlag.';
  END IF;

  SELECT d.id, d.company_id, d.journal_entry_id, d.file_name, d.is_current_version, d.sha256_hash,
         d.link_struck_at
    INTO v_doc
    FROM public.document_attachments d
   WHERE d.id = p_document_id
     FOR UPDATE OF d;

  IF NOT FOUND OR v_doc.company_id <> p_company_id THEN
    RAISE EXCEPTION 'Underlaget hittades inte.';
  END IF;
  IF v_doc.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Underlaget är inte kopplat till någon verifikation.';
  END IF;
  IF v_doc.is_current_version IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Endast den aktuella versionen av ett underlag kan kopplas bort.';
  END IF;
  -- A struck link stays where it was struck: clearing it would erase the
  -- strike (BFL 5 kap 9 §, enforce_document_link_strike).
  IF v_doc.link_struck_at IS NOT NULL THEN
    RAISE EXCEPTION 'Underlaget är struket från verifikationen och ligger kvar där som spår av rättelsen.';
  END IF;

  SELECT je.id, je.entry_date, je.status, je.fiscal_period_id, je.company_id AS entry_company_id
    INTO v_entry
    FROM public.journal_entries je
   WHERE je.id = v_doc.journal_entry_id
     FOR UPDATE OF je;

  IF NOT FOUND OR v_entry.entry_company_id <> p_company_id THEN
    RAISE EXCEPTION 'Verifikationen hittades inte.';
  END IF;

  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'Underlag kan bara kopplas bort från bokförda verifikat.';
  END IF;

  SELECT fp.is_closed, fp.locked_at
    INTO v_is_closed, v_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_entry.fiscal_period_id;

  IF v_is_closed OR v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Perioden är stängd eller låst: underlaget kan inte kopplas bort.';
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND v_entry.entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bokföringen är låst t.o.m. %: underlaget kan inte kopplas bort.', v_lock_date;
  END IF;

  -- The verifikat must keep at least one anchored underlag (BFL 5 kap 7 par),
  -- and only a byte-identical duplicate may leave: a remaining sibling must
  -- carry the same immutable sha256_hash. Two different handlingar on one
  -- verifikation are each rakenskapsinformation and both stay. A struck
  -- sibling is not the verifikat's underlag, so it neither counts as the one
  -- that remains nor as the duplicate.
  SELECT count(*),
         count(*) FILTER (WHERE d.sha256_hash = v_doc.sha256_hash)
    INTO v_siblings, v_duplicates
  FROM public.document_attachments d
  WHERE d.journal_entry_id = v_doc.journal_entry_id
    AND d.company_id = p_company_id
    AND d.is_current_version = true
    AND d.link_struck_at IS NULL
    AND d.id <> v_doc.id;

  IF v_siblings = 0 THEN
    RAISE EXCEPTION 'Verifikationen skulle stå utan underlag: det sista underlaget kan inte kopplas bort. Ersätt det med en ny version i stället.';
  END IF;

  IF v_duplicates = 0 THEN
    RAISE EXCEPTION 'Underlaget är inte en dubblett: ingen identisk kopia finns kvar på verifikationen. Bara dubbletter kan kopplas bort.';
  END IF;

  -- A doc pinned to a bank transaction or serving as a supplier invoice's
  -- retained source document is replaced through those flows, never detached.
  SELECT t.id INTO v_pinned_tx
  FROM public.transactions t
  WHERE t.document_id = v_doc.id AND t.company_id = p_company_id
  LIMIT 1;
  IF v_pinned_tx IS NOT NULL THEN
    RAISE EXCEPTION 'Underlaget är kopplat till en banktransaktion och kan inte kopplas bort här. Byt transaktionens underlag i stället.';
  END IF;

  SELECT si.id INTO v_pinned_si
  FROM public.supplier_invoices si
  WHERE si.document_id = v_doc.id AND si.company_id = p_company_id
  LIMIT 1;
  IF v_pinned_si IS NOT NULL THEN
    RAISE EXCEPTION 'Underlaget är leverantörsfakturans originalunderlag och kan inte kopplas bort. Ersätt det med en ny version i stället.';
  END IF;

  -- Append-only audit FIRST: the carve-out below is only ever exercised in a
  -- transaction that has already recorded who detached what from where.
  -- company_id must be set explicitly: the audit_log SELECT policy filters on
  -- company_id IN user_company_ids(), so a NULL row is invisible to every
  -- reader (the exact delete_last_voucher defect 20260528120600 fixed).
  INSERT INTO public.audit_log
    (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description)
  VALUES
    (v_actor, p_company_id, 'UPDATE', 'document_attachments', v_doc.id, v_actor,
     jsonb_build_object('journal_entry_id', v_doc.journal_entry_id, 'company_id', p_company_id, 'file_name', v_doc.file_name),
     jsonb_build_object('journal_entry_id', NULL, 'company_id', p_company_id, 'file_name', v_doc.file_name),
     'Dubblett-underlag frånkopplat från verifikation (annat underlag kvarstår)');

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  UPDATE public.document_attachments
     SET journal_entry_id = NULL,
         journal_entry_line_id = NULL
   WHERE id = v_doc.id;

  PERFORM set_config('gnubok.allow_delete', 'false', true);

  RETURN jsonb_build_object(
    'detached', true,
    'document_id', v_doc.id,
    'journal_entry_id', v_doc.journal_entry_id,
    'remaining_documents', v_siblings
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.relink_documents_to_correction(
  p_user_id uuid,
  p_from_entry_id uuid,
  p_to_entry_id uuid
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_from journal_entries%ROWTYPE;
  v_to journal_entries%ROWTYPE;
  v_is_member boolean;
  v_moved integer;
BEGIN
  -- Caller identity. Two legitimate caller shapes:
  --   - authenticated user session (role anon/authenticated): auth.uid() is
  --     present and MUST match p_user_id (the route layer passes the user's
  --     own id; a mismatch is always malicious).
  --   - service-role / direct (pending-operations executor / MCP approve flow
  --     / migrations / pg-harness): no user JWT subject; p_user_id is trusted
  --     and still membership-checked below. See undo_sie_import's auth.uid()
  --     regression for why service-role callers must not be keyed on
  --     auth.uid().
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'Authentication required to relink documents';
    END IF;
    IF p_user_id IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'p_user_id does not match authenticated user';
    END IF;
  ELSE
    IF p_user_id IS NULL THEN
      RAISE EXCEPTION 'p_user_id is required';
    END IF;
  END IF;

  SELECT * INTO v_from FROM public.journal_entries WHERE id = p_from_entry_id;
  IF v_from.id IS NULL THEN
    RAISE EXCEPTION 'Source entry % not found', p_from_entry_id;
  END IF;

  SELECT * INTO v_to FROM public.journal_entries WHERE id = p_to_entry_id;
  IF v_to.id IS NULL THEN
    RAISE EXCEPTION 'Target entry % not found', p_to_entry_id;
  END IF;

  -- Tenant boundary: both entries in one company, and the acting user must
  -- be a member. SECURITY DEFINER bypasses RLS, so enforce it here.
  IF v_from.company_id IS DISTINCT FROM v_to.company_id THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (p_user_id, v_from.company_id, 'SECURITY_EVENT', 'document_attachments', p_from_entry_id,
      'Blocked cross-company document relink attempt to entry ' || p_to_entry_id);
    RAISE EXCEPTION 'Entries belong to different companies';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = v_from.company_id AND cm.user_id = p_user_id
  ) INTO v_is_member;
  IF NOT v_is_member THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (p_user_id, v_from.company_id, 'SECURITY_EVENT', 'document_attachments', p_from_entry_id,
      'Blocked document relink by non-member');
    RAISE EXCEPTION 'User is not a member of the entries'' company';
  END IF;

  -- The move is only legal along a genuine correction chain: the target is
  -- the posted correction of the reversed source. Anything else is an
  -- arbitrary re-link, which BFL 5 kap 6 § forbids.
  IF v_from.status <> 'reversed' THEN
    RAISE EXCEPTION 'Source entry % is not reversed (status: %)', p_from_entry_id, v_from.status;
  END IF;
  IF v_to.status <> 'posted' THEN
    RAISE EXCEPTION 'Target entry % is not posted (status: %)', p_to_entry_id, v_to.status;
  END IF;
  IF v_to.correction_of_id IS DISTINCT FROM p_from_entry_id THEN
    RAISE EXCEPTION 'Target entry % is not the correction of source entry %', p_to_entry_id, p_from_entry_id;
  END IF;

  -- Transaction-local: resets automatically at COMMIT/ROLLBACK.
  PERFORM set_config('gnubok.allow_correction_relink', 'true', true);

  -- A struck link stays on the original it was struck from: it was never that
  -- verifikat's underlag, so it is not the correction's either
  -- (enforce_document_link_strike refuses to move it).
  UPDATE public.document_attachments
  SET journal_entry_id = p_to_entry_id,
      journal_entry_line_id = NULL
  WHERE company_id = v_from.company_id
    AND journal_entry_id = p_from_entry_id
    AND link_struck_at IS NULL;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  IF v_moved > 0 THEN
    -- The row chain (correction_of_id) carries the legal traceability; this
    -- audit row makes the underlag move visible without joining timelines.
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
    VALUES (p_user_id, v_from.company_id, 'UPDATE', 'document_attachments', p_from_entry_id, p_user_id,
      'Relinked ' || v_moved || ' document(s) from reversed entry ' || p_from_entry_id || ' to correction ' || p_to_entry_id);
  END IF;

  RETURN v_moved;
END;
$function$;

-- 4. The name of a person who struck a link outlives their account -----------

CREATE OR REPLACE FUNCTION public.erase_user_personal_data(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
DECLARE
  auth_table text;
BEGIN
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'erase_user_personal_data: target_user_id is required';
  END IF;

  -- Before anything is cleared: the name of a person who corrected a
  -- company's entries stays with that company until the bevarandetid ends
  -- (public.rattelse_actor_names, BFL 5 kap. 5 § and 7 kap. 2 §). A reversal
  -- is booked and posted in one call by the person reversing, so its user_id
  -- names them (reversalActor in lib/reports/behandlingshistorik.ts); a
  -- correcting verifikat may be posted by someone other than its author, so
  -- every column that can name a person counts there. A person who struck an
  -- underlag's link corrected that verifikation (5 kap. 9 §) and is kept the
  -- same way.
  INSERT INTO public.rattelse_actor_names (company_id, user_id, full_name, email, retention_expires_at)
  SELECT c.company_id, p.id, p.full_name, p.email,
         make_date(extract(year FROM max(fp.period_end))::integer + 8, 1, 1)
    FROM (
          SELECT l.company_id, je.fiscal_period_id
            FROM public.journal_entry_rattelse_log l
            JOIN public.journal_entries je
              ON je.id = l.journal_entry_id
             AND je.company_id = l.company_id
           WHERE l.actor = target_user_id
          UNION ALL
          SELECT je.company_id, je.fiscal_period_id
            FROM public.journal_entries je
           WHERE je.user_id = target_user_id
             AND je.reverses_id IS NOT NULL
             AND je.status IN ('posted', 'reversed')
          UNION ALL
          SELECT je.company_id, je.fiscal_period_id
            FROM public.journal_entries je
           WHERE je.correction_of_id IS NOT NULL
             AND je.status IN ('posted', 'reversed')
             AND target_user_id IN (je.user_id, je.committed_by, je.committed_auth_uid)
          UNION ALL
          SELECT d.company_id, je.fiscal_period_id
            FROM public.document_attachments d
            JOIN public.journal_entries je
              ON je.id = d.journal_entry_id
             AND je.company_id = d.company_id
           WHERE d.link_struck_by = target_user_id
         ) c
    JOIN public.fiscal_periods fp ON fp.id = c.fiscal_period_id
    JOIN public.profiles p ON p.id = target_user_id
   WHERE nullif(btrim(p.full_name), '') IS NOT NULL
      OR nullif(btrim(p.email), '') IS NOT NULL
   GROUP BY c.company_id, p.id, p.full_name, p.email
  ON CONFLICT (company_id, user_id) DO NOTHING;

  -- Access: memberships and every credential the person could act through.
  DELETE FROM public.company_members            WHERE user_id = target_user_id;
  DELETE FROM public.team_members               WHERE user_id = target_user_id;
  DELETE FROM public.api_keys                   WHERE user_id = target_user_id;
  DELETE FROM public.oauth_client_registrations WHERE user_id = target_user_id;
  DELETE FROM public.oauth_flows                WHERE user_id = target_user_id;
  DELETE FROM public.provider_otc               WHERE user_id = target_user_id;
  DELETE FROM public.calendar_feeds             WHERE user_id = target_user_id;
  DELETE FROM public.skatteverket_tokens        WHERE user_id = target_user_id;

  -- BankID: the encrypted personnummer, and the CompanyRoles cache whose
  -- companyRegistrationNumber is the personnummer for an enskild näringsidkare.
  -- The remembered payment signer holds the same personnummer, encrypted.
  DELETE FROM public.bankid_identities WHERE user_id = target_user_id;
  DELETE FROM public.bankid_enrichment WHERE user_id = target_user_id;
  DELETE FROM public.payment_signers   WHERE user_id = target_user_id;

  -- Company formation drafts (company_formations): the founders' answers,
  -- personnummer sealed, before any company exists. A company already set up
  -- from one keeps its own records; the draft itself goes.
  DELETE FROM public.company_formations WHERE user_id = target_user_id;

  -- The PSU-ID a bank consent or a payment signing was created with
  -- (bank_connection_psus, payment_batch_psus): the personnummer, encrypted,
  -- kept for the connections the person owns and the signings they submitted
  -- or signed. Their consents are revoked below; nothing reads these again.
  DELETE FROM public.bank_connection_psus p
   USING public.bank_connections b
   WHERE b.id = p.connection_id
     AND b.user_id = target_user_id;
  DELETE FROM public.payment_batch_psus p
   USING public.payment_order_batches s
   WHERE s.id = p.batch_id
     AND (s.user_id = target_user_id OR s.signer_user_id = target_user_id);

  -- Personal settings and per-user operational state.
  DELETE FROM public.user_preferences      WHERE user_id = target_user_id;
  DELETE FROM public.notification_settings WHERE user_id = target_user_id;
  DELETE FROM public.notification_log      WHERE user_id = target_user_id;
  DELETE FROM public.push_subscriptions    WHERE user_id = target_user_id;
  DELETE FROM public.notice_dismissals     WHERE user_id = target_user_id;
  DELETE FROM public.email_change_requests WHERE user_id = target_user_id;
  DELETE FROM public.idempotency_keys      WHERE user_id = target_user_id;
  DELETE FROM public.mcp_tasks             WHERE user_id = target_user_id;
  DELETE FROM public.agent_rate_counters   WHERE user_id = target_user_id;
  DELETE FROM public.sandbox_seed_attempts WHERE user_id = target_user_id;

  -- Conversations. agent_messages cascade from agent_conversations.
  DELETE FROM public.agent_conversations WHERE user_id = target_user_id;
  DELETE FROM public.chat_messages       WHERE user_id = target_user_id;
  DELETE FROM public.chat_sessions       WHERE user_id = target_user_id;

  -- Consents the person gave for a company (header, point 3).
  UPDATE public.bank_connections b
     SET status           = 'revoked',
         session_id       = NULL,
         authorization_id = NULL,
         oauth_state      = NULL,
         accounts_data    = NULL
   WHERE b.user_id = target_user_id
     AND (b.status <> 'revoked'
          OR b.session_id IS NOT NULL
          OR b.authorization_id IS NOT NULL
          OR b.oauth_state IS NOT NULL
          OR b.accounts_data IS NOT NULL);

  -- The mailbox may be the person's own: its address goes too. A per-row
  -- placeholder keeps the (company_id, provider, email_address) index unique.
  UPDATE public.mail_connections m
     SET status                  = 'revoked',
         email_address           = 'erased+' || m.id::text || '@anonymized.invalid',
         encrypted_refresh_token = '',
         encrypted_access_token  = NULL,
         access_token_expires_at = NULL,
         connected_by            = NULL
   WHERE m.connected_by = target_user_id;

  -- WhatsApp channel, unchanged from 20260803090000: the link is revoked and
  -- crypto-shredded rather than deleted.
  DELETE FROM public.whatsapp_link_codes WHERE user_id = target_user_id;

  UPDATE public.whatsapp_messages m
     SET body_text   = NULL,
         raw_payload = NULL
    FROM public.whatsapp_phone_links l
   WHERE l.user_id = target_user_id
     AND m.phone_link_id = l.id
     AND (m.body_text IS NOT NULL OR m.raw_payload IS NOT NULL);

  UPDATE public.whatsapp_conversations c
     SET state      = 'idle',
         context    = '{}'::jsonb,
         company_id = NULL
    FROM public.whatsapp_phone_links l
   WHERE l.user_id = target_user_id
     AND c.phone_link_id = l.id;

  UPDATE public.whatsapp_phone_links
     SET revoked_at         = coalesce(revoked_at, now()),
         phone_enc          = '',
         phone_masked       = '+** *** ** **',
         wa_profile_name    = NULL,
         default_company_id = NULL,
         last_company_id    = NULL
   WHERE user_id = target_user_id;

  -- GoTrue-managed rows (header, point 5). refresh_tokens.user_id is varchar.
  IF to_regclass('auth.refresh_tokens') IS NOT NULL THEN
    EXECUTE 'DELETE FROM auth.refresh_tokens WHERE user_id = $1' USING target_user_id::text;
  END IF;

  FOREACH auth_table IN ARRAY ARRAY[
    'auth.sessions', 'auth.mfa_factors', 'auth.flow_state', 'auth.one_time_tokens', 'auth.identities'
  ] LOOP
    IF to_regclass(auth_table) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %s WHERE user_id = $1', auth_table) USING target_user_id;
    END IF;
  END LOOP;

  UPDATE public.profiles
     SET email         = NULL,
         full_name     = NULL,
         avatar_url    = NULL,
         deleted_at    = coalesce(deleted_at, now()),
         anonymized_at = coalesce(anonymized_at, now()),
         updated_at    = now()
   WHERE id = target_user_id;

  -- Only after identities are gone (header, point 5). email_change stays a
  -- string: GoTrue scans it into a non-nullable field.
  UPDATE auth.users
     SET email              = NULL,
         email_change       = '',
         raw_user_meta_data = '{}'::jsonb,
         raw_app_meta_data  = coalesce(raw_app_meta_data, '{}'::jsonb) - 'bankid_linked' - 'has_password'
   WHERE id = target_user_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
