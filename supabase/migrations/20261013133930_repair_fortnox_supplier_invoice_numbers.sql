-- crm#1157, step 3a: correct the supplier number on supplier invoices the
-- provider migration imported from Fortnox.
--
-- Fortnox numbers every supplier invoice itself (löpnummer, GivenNumber), apart
-- from the number the supplier printed on it (InvoiceNumber). The Fortnox
-- mapper stored the löpnummer as supplier_invoice_number, so these invoices
-- show Fortnox's series where the supplier's number belongs, and a payment
-- made from Accounted without an OCR carried the löpnummer as its reference.
-- Step 1 (20261012161644) gave the löpnummer a column of its own
-- (fortnox_number) and backfilled it for the background import; invoices from
-- the older /migrate path still hold it only as their supplier number.
--
-- repair_fortnox_supplier_invoice_numbers takes ALL the Fortnox records of ONE
-- company in one call (the caller reads them from the stored import payloads
-- or from Fortnox: GivenNumber, InvoiceNumber and the header as the import
-- maps it) and decides per record:
--
--   corrected           the invoice still carries the löpnummer as its
--                       supplier number: it gets the supplier's number, and
--                       the löpnummer stays in fortnox_number.
--   reused_number       crm#1039: another live invoice of the same supplier
--                       keeps the supplier's number on another date (an
--                       autogiro or contract reference printed on every
--                       invoice). The invoice is stored the way the import
--                       stores such a record: no supplier number, the
--                       reference as its payment_reference.
--   already_correct     the supplier number already is the supplier's (or the
--                       supplier's number equals the löpnummer); an empty
--                       fortnox_number is stamped.
--   no_supplier_number  Fortnox holds no InvoiceNumber for it: the number is
--                       left alone, an empty fortnox_number is stamped.
--   changed_by_user     the number is neither the löpnummer nor the
--                       supplier's: someone changed it; left alone.
--   number_taken        crm#1039's refusal: another live invoice of the same
--                       supplier keeps the number on the same date (also one
--                       stored with it as payment_reference), or the invoice
--                       already carries another payment reference. Left
--                       alone, for a person to decide.
--   header_mismatch     the invoice holding this löpnummer has another date,
--                       total, currency or kind than the Fortnox record: left
--                       alone rather than guessed.
--   ambiguous           more than one invoice imported before fortnox_number
--                       could be the record.
--   not_found           no invoice holds this löpnummer.
--   invalid_row         the record carries no löpnummer, or repeats one.
--
-- Matching: the invoice whose fortnox_number is the löpnummer; otherwise (an
-- import from before that column) the one invoice with fortnox_number NULL,
-- the löpnummer as its supplier number and the same header.
--
-- Order: the records that change a number are decided by invoice date, then
-- by löpnummer, so the earliest invoice keeps a reused number, as a fresh
-- import would. The decision runs on the state the run leaves behind: an
-- invoice this run moves off its löpnummer frees that number, so a record
-- whose own number happens to be another invoice's löpnummer waits until that
-- invoice is decided (a further pass in the same call); one still waiting
-- when nothing moves any more is number_taken. A write locks the company's
-- supplier invoices, decides, then writes in decision order, so no write ever
-- takes a number another row still holds.
--
-- BFL: only the supplier number (and, for reused_number, the payment
-- reference) of a leverantörsreskontra row changes, never a verifikat,
-- amount, account or period, and nothing is deleted. Every change writes one
-- SupplierInvoiceNumberCorrected event (number and payment reference before
-- and after, löpnummer, actor) in the same transaction: who and when (5 kap
-- 5 §, BFNAR 2013:2 9.16). The vouchers Fortnox booked cite the löpnummer
-- ("Levfakt <supplier> (N)"); it stays on the invoice in fortnox_number, so
-- each verifikat still leads to its invoice (5 kap 7 §).
--
-- Each matched record also lists the payment files and payment orders made
-- from Accounted for that invoice with the löpnummer as their reference, so
-- the companies that paid with the wrong reference can be told.
--
-- Dry run by default: the same report, nothing written. A write needs an
-- actor. One company per call, service_role only, never from a user session.
-- A migration-reset source company is frozen and refused.
--
-- revert_fortnox_supplier_invoice_numbers undoes one run (its correlation id)
-- for one company: each corrected invoice whose supplier number and payment
-- reference are still what the run wrote gets the values from before it back,
-- in reverse write order, so a number the run moved from one invoice to
-- another is released before it is given back. An invoice changed since is
-- left alone (changed_since), and so is one whose old number another invoice
-- holds by now (number_taken). fortnox_number stays: it is Fortnox's own
-- number either way. Each restored invoice gets one
-- SupplierInvoiceNumberCorrectionReverted event under the revert's own
-- correlation id, caused by the event it reverts.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('SupplierInvoiceNumberCorrected'),
  ('SupplierInvoiceNumberCorrectionReverted')
ON CONFLICT (event_type) DO NOTHING;

CREATE FUNCTION public.repair_fortnox_supplier_invoice_numbers(
  p_company_id uuid,
  p_rows jsonb,
  p_actor jsonb,
  p_dry_run boolean DEFAULT true,
  p_correlation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_correlation_id uuid := COALESCE(p_correlation_id, gen_random_uuid());
  p record;
  v_id uuid;
  v_ids uuid[];
  v_blocked boolean;
  v_holder boolean;
  v_holder_date date;
  v_outcome text;
  v_seq integer := 0;
  v_progress boolean;
  v_written integer;
  v_report jsonb;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'repair_fortnox_supplier_invoice_numbers: p_company_id is required, this never runs across companies'
      USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'repair_fortnox_supplier_invoice_numbers: p_rows must be a json array'
      USING ERRCODE = '22023';
  END IF;
  IF NOT p_dry_run AND (
       p_actor IS NULL
       OR jsonb_typeof(p_actor) <> 'object'
       OR COALESCE(p_actor->>'type', '') = ''
       OR COALESCE(p_actor->>'id', '') = '') THEN
    RAISE EXCEPTION 'repair_fortnox_supplier_invoice_numbers: p_actor {type, id} is required for a write'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_migration_resets WHERE source_company_id = p_company_id) THEN
    RAISE EXCEPTION 'repair_fortnox_supplier_invoice_numbers: company % is a migration-reset source and stays frozen', p_company_id
      USING ERRCODE = '55000';
  END IF;

  IF NOT p_dry_run THEN
    -- The run decides and writes against one state of the company's
    -- invoices: an edit or a payment that starts meanwhile waits for it.
    PERFORM 1 FROM public.supplier_invoices WHERE company_id = p_company_id FOR UPDATE;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS fortnox_number_repair_plan (
    ord integer PRIMARY KEY,
    given text,
    given_num numeric,
    rec_date date,
    rec_total numeric,
    rec_currency text,
    rec_credit boolean,
    new_number text,
    source text,
    target uuid,
    supplier_id uuid,
    status text,
    row_date date,
    old_number text,
    old_reference text,
    fortnox text,
    outcome text,
    stamp boolean NOT NULL DEFAULT false,
    final_number text,
    final_reference text,
    seq integer
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.fortnox_number_repair_plan;
  CREATE INDEX IF NOT EXISTS fortnox_number_repair_plan_target ON pg_temp.fortnox_number_repair_plan (target);

  INSERT INTO pg_temp.fortnox_number_repair_plan
    (ord, given, given_num, rec_date, rec_total, rec_currency, rec_credit, new_number, source)
  SELECT e.ord::integer,
         NULLIF(btrim(e.value->>'given_number'), ''),
         CASE WHEN btrim(e.value->>'given_number') ~ '^[0-9]{1,30}$' THEN btrim(e.value->>'given_number')::numeric END,
         NULLIF(e.value->>'invoice_date', '')::date,
         NULLIF(e.value->>'total', '')::numeric,
         NULLIF(btrim(e.value->>'currency'), ''),
         COALESCE((e.value->>'is_credit_note')::boolean, false),
         -- The caller sends it trimmed, the value the import stores for it;
         -- a blank one still counts as none.
         CASE WHEN COALESCE(e.value->>'invoice_number', '') ~ '[^[:space:]]' THEN e.value->>'invoice_number' END,
         e.value->>'source'
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(value, ord);

  -- 1. Every record to its invoice, and every outcome no other record affects.
  FOR p IN SELECT * FROM pg_temp.fortnox_number_repair_plan ORDER BY ord LOOP
    v_id := NULL;
    v_ids := NULL;
    IF p.given IS NULL OR EXISTS (
      SELECT 1 FROM pg_temp.fortnox_number_repair_plan d WHERE d.given = p.given AND d.ord < p.ord) THEN
      UPDATE pg_temp.fortnox_number_repair_plan SET outcome = 'invalid_row' WHERE ord = p.ord;
      CONTINUE;
    END IF;
    SELECT si.id INTO v_id
      FROM public.supplier_invoices si
     WHERE si.company_id = p_company_id AND si.fortnox_number = p.given;
    IF v_id IS NULL THEN
      -- Imported before fortnox_number: the löpnummer is its supplier
      -- number, and only the same header makes it this record.
      SELECT array_agg(si.id ORDER BY si.id) INTO v_ids
        FROM public.supplier_invoices si
       WHERE si.company_id = p_company_id
         AND si.fortnox_number IS NULL
         AND si.supplier_invoice_number = p.given
         AND si.invoice_date IS NOT DISTINCT FROM p.rec_date
         AND si.total IS NOT DISTINCT FROM p.rec_total
         AND si.currency IS NOT DISTINCT FROM p.rec_currency
         AND si.is_credit_note = p.rec_credit;
      IF COALESCE(cardinality(v_ids), 0) = 1 THEN
        v_id := v_ids[1];
      ELSE
        UPDATE pg_temp.fortnox_number_repair_plan
           SET outcome = CASE
                 WHEN COALESCE(cardinality(v_ids), 0) > 1 THEN 'ambiguous'
                 WHEN EXISTS (
                   SELECT 1 FROM public.supplier_invoices si
                    WHERE si.company_id = p_company_id
                      AND si.fortnox_number IS NULL
                      AND si.supplier_invoice_number = p.given) THEN 'header_mismatch'
                 ELSE 'not_found' END
         WHERE ord = p.ord;
        CONTINUE;
      END IF;
    END IF;
    UPDATE pg_temp.fortnox_number_repair_plan pl
       SET target = si.id,
           supplier_id = si.supplier_id,
           status = si.status,
           row_date = si.invoice_date,
           old_number = si.supplier_invoice_number,
           -- As stored, so the event can be reverted to exactly this value.
           old_reference = si.payment_reference,
           fortnox = si.fortnox_number,
           outcome = CASE
             WHEN si.invoice_date IS DISTINCT FROM pl.rec_date
               OR si.total IS DISTINCT FROM pl.rec_total
               OR si.currency IS DISTINCT FROM pl.rec_currency
               OR si.is_credit_note IS DISTINCT FROM pl.rec_credit THEN 'header_mismatch'
             WHEN pl.new_number IS NULL THEN 'no_supplier_number'
             WHEN si.supplier_invoice_number IS NOT DISTINCT FROM pl.new_number THEN 'already_correct'
             WHEN si.supplier_invoice_number IS DISTINCT FROM pl.given THEN 'changed_by_user'
             ELSE 'pending' END,
           stamp = si.fortnox_number IS NULL
             AND si.invoice_date IS NOT DISTINCT FROM pl.rec_date
             AND si.total IS NOT DISTINCT FROM pl.rec_total
             AND si.currency IS NOT DISTINCT FROM pl.rec_currency
             AND si.is_credit_note IS NOT DISTINCT FROM pl.rec_credit
             AND (pl.new_number IS NULL OR si.supplier_invoice_number IS NOT DISTINCT FROM pl.new_number)
      FROM public.supplier_invoices si
     WHERE pl.ord = p.ord AND si.id = v_id;
  END LOOP;

  -- 2. The records that change a number, earliest invoice first, on the state
  -- the run leaves behind (crm#1039's rule, as commit_provider_migration_records
  -- applies it on import). A pass that decides nothing ends the loop.
  LOOP
    v_progress := false;
    FOR p IN SELECT * FROM pg_temp.fortnox_number_repair_plan
              WHERE outcome = 'pending'
              ORDER BY row_date NULLS LAST, given_num NULLS LAST, given LOOP
      v_outcome := NULL;
      IF p.status IN ('credited', 'reversed') THEN
        -- Outside the unique number rule: nothing can hold the number against it.
        v_outcome := 'corrected';
      ELSE
        -- A live invoice of this supplier with the number that this run does
        -- not move: wait for it while it is still undecided here.
        v_blocked := EXISTS (
          SELECT 1 FROM public.supplier_invoices si
            JOIN pg_temp.fortnox_number_repair_plan m ON m.target = si.id
           WHERE si.company_id = p_company_id
             AND si.supplier_id = p.supplier_id
             AND si.supplier_invoice_number = p.new_number
             AND si.status NOT IN ('credited', 'reversed')
             AND si.id <> p.target
             AND m.outcome = 'pending');
        IF v_blocked THEN
          CONTINUE;
        END IF;
        v_holder := false;
        v_holder_date := NULL;
        SELECT true, h.invoice_date INTO v_holder, v_holder_date
          FROM (
            SELECT si.invoice_date
              FROM public.supplier_invoices si
             WHERE si.company_id = p_company_id
               AND si.supplier_id = p.supplier_id
               AND si.supplier_invoice_number = p.new_number
               AND si.status NOT IN ('credited', 'reversed')
               AND si.id <> p.target
               AND NOT EXISTS (
                 SELECT 1 FROM pg_temp.fortnox_number_repair_plan m
                  WHERE m.target = si.id AND m.outcome IN ('corrected', 'reused_number'))
            UNION ALL
            SELECT m.row_date
              FROM pg_temp.fortnox_number_repair_plan m
             WHERE m.outcome = 'corrected'
               AND m.supplier_id = p.supplier_id
               AND m.final_number = p.new_number
               AND m.status NOT IN ('credited', 'reversed')
               AND m.target <> p.target
          ) h
         LIMIT 1;
        IF NOT COALESCE(v_holder, false) THEN
          v_outcome := 'corrected';
        ELSIF p.row_date IS NOT DISTINCT FROM v_holder_date
          OR EXISTS (
            -- An invoice already stored with the number as its payment
            -- reference on the same date is the same invoice too.
            SELECT 1 FROM public.supplier_invoices si
             WHERE si.company_id = p_company_id
               AND si.supplier_id = p.supplier_id
               AND si.supplier_invoice_number IS NULL
               AND si.payment_reference = p.new_number
               AND si.status NOT IN ('credited', 'reversed')
               AND si.invoice_date IS NOT DISTINCT FROM p.row_date
               AND si.id <> p.target
               AND NOT EXISTS (
                 SELECT 1 FROM pg_temp.fortnox_number_repair_plan m
                  WHERE m.target = si.id AND m.outcome IN ('corrected', 'reused_number'))
            UNION ALL
            SELECT 1 FROM pg_temp.fortnox_number_repair_plan m
             WHERE m.outcome = 'reused_number'
               AND m.supplier_id = p.supplier_id
               AND m.final_reference = p.new_number
               AND m.status NOT IN ('credited', 'reversed')
               AND m.row_date IS NOT DISTINCT FROM p.row_date
               AND m.target <> p.target)
          OR (NULLIF(p.old_reference, '') IS NOT NULL AND p.old_reference <> p.new_number) THEN
          v_outcome := 'number_taken';
        ELSE
          v_outcome := 'reused_number';
        END IF;
      END IF;

      v_seq := v_seq + 1;
      UPDATE pg_temp.fortnox_number_repair_plan
         SET outcome = v_outcome,
             seq = v_seq,
             final_number = CASE v_outcome WHEN 'corrected' THEN p.new_number END,
             final_reference = CASE v_outcome WHEN 'reused_number' THEN p.new_number END,
             stamp = v_outcome IN ('corrected', 'reused_number') AND p.fortnox IS NULL
       WHERE ord = p.ord;
      v_progress := true;
    END LOOP;
    EXIT WHEN NOT v_progress;
  END LOOP;
  -- Still waiting when nothing moves any more (two invoices each holding the
  -- other's number): left alone.
  UPDATE pg_temp.fortnox_number_repair_plan SET outcome = 'number_taken' WHERE outcome = 'pending';

  -- 3. The write, in decision order: a number is taken only after the
  -- invoice that held it has moved off it.
  IF NOT p_dry_run THEN
    FOR p IN SELECT * FROM pg_temp.fortnox_number_repair_plan
              WHERE outcome IN ('corrected', 'reused_number')
              ORDER BY seq LOOP
      UPDATE public.supplier_invoices
         SET supplier_invoice_number = p.final_number,
             payment_reference = COALESCE(p.final_reference, payment_reference),
             fortnox_number = COALESCE(fortnox_number, p.given)
       WHERE id = p.target
         AND company_id = p_company_id
         AND supplier_invoice_number = p.given;
      GET DIAGNOSTICS v_written = ROW_COUNT;
      IF v_written <> 1 THEN
        RAISE EXCEPTION 'repair_fortnox_supplier_invoice_numbers: invoice % changed during the run', p.target
          USING ERRCODE = '40001';
      END IF;
      INSERT INTO public.processing_history
        (company_id, correlation_id, aggregate_type, aggregate_id, event_type, payload, actor, occurred_at)
      VALUES (
        p_company_id,
        v_correlation_id,
        'SupplierInvoice',
        p.target,
        'SupplierInvoiceNumberCorrected',
        jsonb_build_object(
          'issue', 'crm#1157',
          'rule', CASE p.outcome WHEN 'reused_number' THEN 'reused_number_as_payment_reference'
                                 ELSE 'fortnox_lopnummer_as_supplier_number' END,
          'fortnox_number', p.given,
          'source', p.source,
          -- The write order: a revert goes back in reverse.
          'seq', p.seq,
          'before', jsonb_build_object('supplier_invoice_number', p.old_number,
                                       'payment_reference', p.old_reference,
                                       'fortnox_number', p.fortnox),
          'after', jsonb_build_object('supplier_invoice_number', p.final_number,
                                      'payment_reference', COALESCE(p.final_reference, p.old_reference),
                                      'fortnox_number', COALESCE(p.fortnox, p.given))
        ),
        p_actor,
        now()
      );
    END LOOP;
    UPDATE public.supplier_invoices si
       SET fortnox_number = pl.given
      FROM pg_temp.fortnox_number_repair_plan pl
     WHERE si.id = pl.target
       AND si.company_id = p_company_id
       AND pl.stamp
       AND pl.outcome IN ('already_correct', 'no_supplier_number')
       AND si.fortnox_number IS NULL;
  END IF;

  SELECT jsonb_build_object(
           'company_id', p_company_id,
           'dry_run', p_dry_run,
           'correlation_id', CASE WHEN p_dry_run THEN NULL ELSE v_correlation_id END,
           'counts', COALESCE((
             SELECT jsonb_object_agg(c.outcome, c.n)
               FROM (SELECT outcome, count(*) AS n FROM pg_temp.fortnox_number_repair_plan GROUP BY outcome) c), '{}'::jsonb),
           'rows', COALESCE(jsonb_agg(jsonb_build_object(
             'given_number', pl.given,
             'invoice_id', pl.target,
             'outcome', pl.outcome,
             'old_number', pl.old_number,
             'new_number', pl.new_number,
             'payment_reference', pl.final_reference,
             'stamped', pl.stamp,
             'old_reference_used', COALESCE(refs.used, '[]'::jsonb)
           ) ORDER BY pl.ord), '[]'::jsonb))
    INTO v_report
    FROM pg_temp.fortnox_number_repair_plan pl
    LEFT JOIN LATERAL (
      -- Payments made from Accounted with the löpnummer as their reference.
      SELECT jsonb_agg(x.ref ORDER BY x.ref->>'date', x.ref->>'source') AS used
        FROM (
          SELECT jsonb_build_object('source', 'payment_file', 'status', b.status, 'date', i.payment_date) AS ref
            FROM public.supplier_payment_batch_items i
            JOIN public.supplier_payment_batches b ON b.id = i.batch_id
           WHERE i.supplier_invoice_id = pl.target
             AND i.company_id = p_company_id
             AND i.reference_type = 'invoice_number'
             AND btrim(i.reference) = pl.given
          UNION ALL
          SELECT jsonb_build_object('source', 'payment_order', 'status', o.status, 'date', o.requested_execution_date)
            FROM public.payment_orders o
           WHERE o.supplier_invoice_id = pl.target
             AND o.company_id = p_company_id
             AND o.reference_type = 'message'
             AND btrim(o.reference) = pl.given
        ) x
       WHERE pl.target IS NOT NULL
         AND pl.new_number IS DISTINCT FROM pl.given
    ) refs ON true;

  RETURN v_report;
END;
$$;

COMMENT ON FUNCTION public.repair_fortnox_supplier_invoice_numbers(uuid, jsonb, jsonb, boolean, uuid) IS
  'crm#1157. For one company, matches all its Fortnox supplier invoice records (löpnummer, InvoiceNumber, header) to the imported invoices and reports (dry run, default) or corrects a supplier number that still holds the Fortnox löpnummer, applying crm#1039''s reused-number rule in invoice-date order and stamping fortnox_number, with one SupplierInvoiceNumberCorrected event per change. Also lists payments made with the löpnummer as reference. service_role only; a write needs p_actor.';

REVOKE ALL ON FUNCTION public.repair_fortnox_supplier_invoice_numbers(uuid, jsonb, jsonb, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_fortnox_supplier_invoice_numbers(uuid, jsonb, jsonb, boolean, uuid) TO service_role;

CREATE FUNCTION public.revert_fortnox_supplier_invoice_numbers(
  p_company_id uuid,
  p_correlation_id uuid,
  p_actor jsonb,
  p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_correlation_id uuid := gen_random_uuid();
  e record;
  v_before jsonb;
  v_after jsonb;
  v_outcome text;
  v_written integer;
  v_rows jsonb[] := ARRAY[]::jsonb[];
  v_counts jsonb := '{}'::jsonb;
BEGIN
  IF p_company_id IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'revert_fortnox_supplier_invoice_numbers: p_company_id and p_correlation_id are required'
      USING ERRCODE = '22023';
  END IF;
  IF NOT p_dry_run AND (
       p_actor IS NULL
       OR jsonb_typeof(p_actor) <> 'object'
       OR COALESCE(p_actor->>'type', '') = ''
       OR COALESCE(p_actor->>'id', '') = '') THEN
    RAISE EXCEPTION 'revert_fortnox_supplier_invoice_numbers: p_actor {type, id} is required for a write'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_migration_resets WHERE source_company_id = p_company_id) THEN
    RAISE EXCEPTION 'revert_fortnox_supplier_invoice_numbers: company % is a migration-reset source and stays frozen', p_company_id
      USING ERRCODE = '55000';
  END IF;

  -- A dry run makes the same writes inside this block and rolls them back
  -- at its end, so its report includes every conflict a write would meet.
  BEGIN
    IF NOT p_dry_run THEN
      PERFORM 1 FROM public.supplier_invoices WHERE company_id = p_company_id FOR UPDATE;
    END IF;

    FOR e IN
      SELECT h.event_id, h.aggregate_id, h.payload
        FROM public.processing_history h
       WHERE h.company_id = p_company_id
         AND h.correlation_id = p_correlation_id
         AND h.event_type = 'SupplierInvoiceNumberCorrected'
       ORDER BY (h.payload->>'seq')::integer DESC NULLS LAST, h.seq DESC
    LOOP
      v_before := e.payload->'before';
      v_after := e.payload->'after';
      BEGIN
        UPDATE public.supplier_invoices
           SET supplier_invoice_number = v_before->>'supplier_invoice_number',
               payment_reference = v_before->>'payment_reference'
         WHERE id = e.aggregate_id
           AND company_id = p_company_id
           AND supplier_invoice_number IS NOT DISTINCT FROM v_after->>'supplier_invoice_number'
           AND payment_reference IS NOT DISTINCT FROM v_after->>'payment_reference';
        GET DIAGNOSTICS v_written = ROW_COUNT;
        IF v_written = 1 THEN
          v_outcome := 'reverted';
          IF NOT p_dry_run THEN
            INSERT INTO public.processing_history
              (company_id, correlation_id, causation_id, aggregate_type, aggregate_id, event_type,
               payload, actor, occurred_at)
            VALUES (
              p_company_id,
              v_correlation_id,
              e.event_id,
              'SupplierInvoice',
              e.aggregate_id,
              'SupplierInvoiceNumberCorrectionReverted',
              jsonb_build_object(
                'issue', 'crm#1157',
                'reverted_correlation_id', p_correlation_id,
                'reverted_event_id', e.event_id,
                'fortnox_number', e.payload->>'fortnox_number',
                'before', jsonb_build_object('supplier_invoice_number', v_after->>'supplier_invoice_number',
                                             'payment_reference', v_after->>'payment_reference'),
                'after', jsonb_build_object('supplier_invoice_number', v_before->>'supplier_invoice_number',
                                            'payment_reference', v_before->>'payment_reference')
              ),
              p_actor,
              now()
            );
          END IF;
        ELSE
          v_outcome := 'changed_since';
        END IF;
      EXCEPTION WHEN unique_violation THEN
        v_outcome := 'number_taken';
      END;
      v_rows := array_append(v_rows, jsonb_build_object(
        'invoice_id', e.aggregate_id,
        'fortnox_number', e.payload->>'fortnox_number',
        'outcome', v_outcome,
        'current', v_after,
        'restore', v_before
      ));
      v_counts := jsonb_set(v_counts, ARRAY[v_outcome],
                            to_jsonb(COALESCE((v_counts->>v_outcome)::integer, 0) + 1));
    END LOOP;

    IF p_dry_run THEN
      RAISE EXCEPTION 'dry run' USING ERRCODE = 'FXRV0';
    END IF;
  EXCEPTION WHEN SQLSTATE 'FXRV0' THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'company_id', p_company_id,
    'dry_run', p_dry_run,
    'reverted_correlation_id', p_correlation_id,
    'correlation_id', CASE WHEN p_dry_run THEN NULL ELSE v_correlation_id END,
    'counts', v_counts,
    'rows', to_jsonb(v_rows)
  );
END;
$$;

COMMENT ON FUNCTION public.revert_fortnox_supplier_invoice_numbers(uuid, uuid, jsonb, boolean) IS
  'crm#1157. Reverts one repair_fortnox_supplier_invoice_numbers run (its correlation id) for one company: in reverse write order, an invoice whose supplier number and payment reference are still what the run wrote gets the values from before it back (fortnox_number stays), with one SupplierInvoiceNumberCorrectionReverted event each; an invoice changed since, or whose old number is taken, is left alone. Dry run by default; service_role only; a write needs p_actor.';

REVOKE ALL ON FUNCTION public.revert_fortnox_supplier_invoice_numbers(uuid, uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revert_fortnox_supplier_invoice_numbers(uuid, uuid, jsonb, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
