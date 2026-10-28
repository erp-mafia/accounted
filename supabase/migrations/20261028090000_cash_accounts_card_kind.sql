-- Company cards (företagskort) as cash accounts on the liability side.
--
-- A card is a kind of cash account, not a new subsystem: its statement rows
-- import, categorize, book and reconcile against the card's own ledger the
-- way the Stripe balance on 1686 already does. What this migration adds:
--
--   cash_accounts.kind ('bank' | 'card', default 'bank')
--     Every existing row stays 'bank' (bank, till and PSP clearing are still
--     told apart by ledger range), so no backfill. Production held no 2xxx
--     cash account when this was written, so the shape CHECK below holds for
--     every existing row.
--
--   cash_accounts.card_issuer, cash_accounts.card_last4
--     Who issued the card and the last four digits of the cards billed on the
--     statement. Card rows only.
--
--   cash_accounts_card_shape
--     A card books on a liability account: 2480-2489 (kontokredit) or 2890,
--     2894, 2896, 2899. 2893 (skulder till närstående) and the other 289x
--     accounts carry other BAS meanings and are refused by construction. A
--     card is never a customer payee, never the primary account, carries no
--     IBAN and no bank connection, and is typed in by hand. A bank row never
--     books on a 2xxx account.
--
--   The NULL-row fallback counts banks only
--     A transaction with no cash_account_id books on the company's only
--     enabled account in its currency, else 1930. Counting a card there would
--     flip every such row from the real bank ledger to 1930 the day a company
--     with one non-1930 bank account adds a card in the same currency. The
--     count now reads kind = 'bank' in all three places that compute it:
--     bank_anchor_settlement_account, capture_bank_booking_context and
--     guard_bank_booking_context. They must agree with each other and with
--     resolveSettlementAccount / resolveDefaultCashAccount /
--     resolveAccount in src/, which make the same change.
--
--   Ledger statistics skip card ledgers
--     get_ledger_usage_stats and get_ledger_deep_context leave the 19xx
--     settlement leg out of a counterparty's dominant account. A card row's
--     settlement leg is the card ledger, so it is left out the same way;
--     otherwise every card merchant's dominant account would read 2890.
--
-- Every function body below is the production definition, compared byte for
-- byte (md5 of prosrc) with the latest migration that defines it before this
-- was written, with only the lines named above changed. Same signatures, so
-- CREATE OR REPLACE keeps the grants; the ledger functions restate theirs as
-- their last definition did.
--
-- Schema only, no data UPDATE.
--
-- pg-test: tests/pg/card-account-kind.pg.test.ts

ALTER TABLE public.cash_accounts
  ADD COLUMN kind text NOT NULL DEFAULT 'bank',
  ADD COLUMN card_issuer text,
  ADD COLUMN card_last4 text[];

ALTER TABLE public.cash_accounts
  ADD CONSTRAINT cash_accounts_kind_check CHECK (kind IN ('bank', 'card'));

ALTER TABLE public.cash_accounts ADD CONSTRAINT cash_accounts_card_shape CHECK (
  CASE WHEN kind = 'card' THEN
         ledger_account ~ '^(248[0-9]|289[0469])$'
     AND NOT invoice_payee
     AND NOT is_primary
     AND iban IS NULL
     AND bank_connection_id IS NULL
     AND source = 'manual'
  ELSE ledger_account !~ '^2' AND card_issuer IS NULL AND card_last4 IS NULL
  END
);

ALTER TABLE public.cash_accounts ADD CONSTRAINT cash_accounts_card_issuer_shape CHECK (
  card_issuer IS NULL OR card_issuer ~ '^[a-z_]{1,32}$'
);

ALTER TABLE public.cash_accounts ADD CONSTRAINT cash_accounts_card_last4_shape CHECK (
  card_last4 IS NULL OR (
    cardinality(card_last4) BETWEEN 1 AND 20
    AND array_position(card_last4, NULL) IS NULL
    AND array_to_string(card_last4, ',') ~ '^[0-9]{4}(,[0-9]{4})*$'
  )
);

COMMENT ON COLUMN public.cash_accounts.kind IS
  'bank: a bank, till or payment-provider clearing account (told apart by ledger range). card: a company card whose statement rows book against a liability account (2480-2489, 2890, 2894, 2896, 2899).';
COMMENT ON COLUMN public.cash_accounts.card_last4 IS
  'Card rows only: the last four digits of the cards billed on this statement.';

-- public.bank_anchor_settlement_account: last full definition in
-- 20260921183218_guard_cash_transaction_anchors. Only the NULL-row count
-- changes (AND kind = 'bank').
CREATE OR REPLACE FUNCTION public.bank_anchor_settlement_account(p_company_id uuid, p_cash_account_id uuid, p_currency text)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_ledger text; v_count integer;
BEGIN
  IF p_cash_account_id IS NOT NULL THEN
    SELECT ledger_account INTO v_ledger FROM public.cash_accounts
      WHERE company_id = p_company_id AND id = p_cash_account_id AND currency = COALESCE(p_currency, 'SEK');
    IF NOT FOUND THEN RAISE EXCEPTION 'BANK_ANCHOR_CASH_ACCOUNT_CHANGED' USING ERRCODE = 'PT409'; END IF;
  ELSE
    SELECT count(*), min(ledger_account) INTO v_count, v_ledger FROM public.cash_accounts
      WHERE company_id = p_company_id AND enabled AND kind = 'bank' AND currency = COALESCE(p_currency, 'SEK');
    IF v_count <> 1 THEN v_ledger := '1930'; END IF;
  END IF;
  RETURN v_ledger;
END;
$function$;

-- public.capture_bank_booking_context: last full definition in
-- 20261012100100_restate_patched_functions. Only the NULL-row count changes.
CREATE OR REPLACE FUNCTION public.capture_bank_booking_context(p_company_id uuid, p_transaction_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_transaction public.transactions%ROWTYPE;
  v_ledger text;
  v_count integer;
  v_seen integer := 0;
  v_context jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.lock_cash_account_booking_state(p_company_id);
  IF p_transaction_ids IS NULL OR cardinality(p_transaction_ids) = 0
     OR array_position(p_transaction_ids, NULL) IS NOT NULL
     OR cardinality(p_transaction_ids) <> (SELECT count(DISTINCT id) FROM unnest(p_transaction_ids) ids(id)) THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_transaction IN
    SELECT * FROM public.transactions
    WHERE company_id = p_company_id AND id = ANY(p_transaction_ids)
    ORDER BY id FOR UPDATE
  LOOP
    v_seen := v_seen + 1;
    IF v_transaction.cash_account_id IS NOT NULL THEN
      SELECT ledger_account INTO v_ledger FROM public.cash_accounts
        WHERE company_id = p_company_id AND id = v_transaction.cash_account_id
          AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF NOT FOUND THEN
        RAISE EXCEPTION 'BANK_BOOKING_CASH_ACCOUNT_MISSING' USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT count(*), min(ledger_account) INTO v_count, v_ledger
        FROM public.cash_accounts
        WHERE company_id = p_company_id AND enabled AND kind = 'bank' AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF v_count <> 1 THEN v_ledger := '1930'; END IF;
    END IF;
    v_context := v_context || jsonb_build_array(jsonb_build_object(
      'transaction_id', v_transaction.id, 'cash_account_id', v_transaction.cash_account_id,
      'date', to_char(v_transaction.date, 'YYYY-MM-DD'), 'amount', v_transaction.amount,
      'currency', COALESCE(v_transaction.currency, 'SEK'), 'settlement_account', v_ledger
    ));
  END LOOP;
  IF v_seen <> cardinality(p_transaction_ids) THEN
    RAISE EXCEPTION 'BANK_BOOKING_SOURCE_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  RETURN v_context;
END;
$function$
;

-- public.guard_bank_booking_context: last full definition in
-- 20261012100100_restate_patched_functions. Only the NULL-row count changes.
CREATE OR REPLACE FUNCTION public.guard_bank_booking_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_context jsonb;
  v_transaction public.transactions%ROWTYPE;
  v_cash public.cash_accounts%ROWTYPE;
  v_target public.cash_accounts%ROWTYPE;
  v_ledger text;
  v_count integer;
  v_target_id uuid;
  v_own_released boolean;
  v_target_live boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'reversed')
     AND NEW.bank_booking_context IS DISTINCT FROM OLD.bank_booking_context THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'posted' OR (TG_OP = 'UPDATE' AND OLD.status = 'posted') THEN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
       AND OLD.status IN ('posted', 'reversed') THEN
      PERFORM public.observe_cash_account_company(NEW.company_id);
    END IF;
    RETURN NEW;
  END IF;

  -- All posting participates in keeper-history serialization, including
  -- manual/import entries that do not originate from a bank transaction.
  PERFORM public.observe_cash_account_company(NEW.company_id);
  IF NEW.source_type = 'bank_transaction' AND (NEW.source_id IS NULL OR NOT (
    NEW.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', NEW.source_id))
  )) THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  PERFORM public.validate_journal_bank_anchors(NEW.company_id, NEW.id);
  IF jsonb_array_length(NEW.bank_booking_context) = 0 THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.bank_booking_context) c
    WHERE jsonb_typeof(c) <> 'object'
       OR NOT (c ?& ARRAY['transaction_id','cash_account_id','settlement_account','date','amount','currency'])
       OR jsonb_typeof(c->'transaction_id') <> 'string'
       OR jsonb_typeof(c->'cash_account_id') NOT IN ('string','null')
       OR jsonb_typeof(c->'settlement_account') <> 'string'
       OR jsonb_typeof(c->'date') <> 'string'
       OR jsonb_typeof(c->'amount') <> 'number'
       OR jsonb_typeof(c->'currency') <> 'string'
       OR (c ? 'target_cash_account_id' AND jsonb_typeof(c->'target_cash_account_id') <> 'string')
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.bank_booking_context) c
    GROUP BY c->>'transaction_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_INVALID' USING ERRCODE = '23514';
  END IF;

  -- Same order as ingest and promotion. The company lock also serializes
  -- account creation/configuration once those writers use this protocol.
  PERFORM 1 FROM public.bank_connections WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.transactions t WHERE t.company_id = NEW.company_id
    AND t.id IN (SELECT (c->>'transaction_id')::uuid FROM jsonb_array_elements(NEW.bank_booking_context) c)
    ORDER BY t.id FOR UPDATE NOWAIT;

  FOR v_context IN SELECT c FROM jsonb_array_elements(NEW.bank_booking_context) c ORDER BY c->>'transaction_id' LOOP
    SELECT * INTO v_transaction FROM public.transactions
      WHERE company_id = NEW.company_id AND id = (v_context->>'transaction_id')::uuid;
    IF NOT FOUND OR v_transaction.cash_account_id IS DISTINCT FROM (v_context->>'cash_account_id')::uuid
      OR v_transaction.date IS DISTINCT FROM (v_context->>'date')::date
      OR v_transaction.amount IS DISTINCT FROM (v_context->>'amount')::numeric
      OR COALESCE(v_transaction.currency, 'SEK') IS DISTINCT FROM v_context->>'currency' THEN
      RAISE EXCEPTION 'BANK_BOOKING_SOURCE_CHANGED' USING ERRCODE = 'PT409';
    END IF;

    v_target_id := (v_context->>'target_cash_account_id')::uuid;
    IF v_target_id IS NOT NULL AND v_target_id IS DISTINCT FROM v_transaction.cash_account_id THEN
      SELECT * INTO v_cash FROM public.cash_accounts WHERE company_id = NEW.company_id AND id = v_transaction.cash_account_id;
      SELECT * INTO v_target FROM public.cash_accounts WHERE company_id = NEW.company_id AND id = v_target_id;
      IF v_cash.id IS NULL OR v_target.id IS NULL OR NOT v_target.enabled
        OR nullif(regexp_replace(upper(v_cash.iban), '\s', '', 'g'), '') IS NULL
        OR regexp_replace(upper(v_cash.iban), '\s', '', 'g') IS DISTINCT FROM regexp_replace(upper(v_target.iban), '\s', '', 'g')
        OR v_cash.currency IS DISTINCT FROM v_target.currency
        OR v_target.currency IS DISTINCT FROM COALESCE(v_transaction.currency, 'SEK')
        OR NOT public.cash_transaction_is_movable(NEW.company_id, v_transaction.id) THEN
        RAISE EXCEPTION 'BANK_BOOKING_REBIND_REFUSED' USING ERRCODE = '23514';
      END IF;
      -- Match shouldRepointToSibling: live destination, or released source
      -- with no live sibling. Same-currency, enabled physical siblings only.
      v_target_live := EXISTS (SELECT 1 FROM public.bank_connections b
        WHERE b.id = v_target.bank_connection_id AND b.company_id = NEW.company_id AND b.status = 'active');
      v_own_released := v_cash.bank_connection_id IS NULL OR EXISTS (SELECT 1 FROM public.bank_connections b
        WHERE b.id = v_cash.bank_connection_id AND b.company_id = NEW.company_id AND b.status = 'revoked');
      IF NOT v_target_live AND (NOT v_own_released OR EXISTS (
        SELECT 1 FROM public.cash_accounts c JOIN public.bank_connections b ON b.id = c.bank_connection_id AND b.company_id = c.company_id
        WHERE c.company_id = NEW.company_id AND c.id <> v_cash.id AND c.enabled AND b.status = 'active'
          AND c.currency = v_cash.currency
          AND regexp_replace(upper(c.iban), '\s', '', 'g') = regexp_replace(upper(v_cash.iban), '\s', '', 'g')
      )) THEN
        RAISE EXCEPTION 'BANK_BOOKING_REBIND_REFUSED' USING ERRCODE = '23514';
      END IF;
      UPDATE public.transactions SET cash_account_id = v_target_id WHERE company_id = NEW.company_id AND id = v_transaction.id;
      v_transaction.cash_account_id := v_target_id;
    END IF;

    IF v_transaction.cash_account_id IS NOT NULL THEN
      SELECT ledger_account INTO v_ledger FROM public.cash_accounts
        WHERE company_id = NEW.company_id AND id = v_transaction.cash_account_id AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF NOT FOUND THEN RAISE EXCEPTION 'BANK_BOOKING_CASH_ACCOUNT_MISSING' USING ERRCODE = '23514'; END IF;
    ELSE
      -- Match resolveSettlementAccount's existing unbound-row fallback.
      SELECT count(*), min(ledger_account) INTO v_count, v_ledger FROM public.cash_accounts
        WHERE company_id = NEW.company_id AND enabled AND kind = 'bank' AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF v_count <> 1 THEN v_ledger := '1930'; END IF;
    END IF;
    IF v_ledger IS DISTINCT FROM v_context->>'settlement_account' OR NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id = NEW.id AND l.account_number = v_ledger
        AND ((v_transaction.amount < 0 AND l.credit_amount > 0) OR (v_transaction.amount > 0 AND l.debit_amount > 0))
    ) THEN
      RAISE EXCEPTION 'BANK_BOOKING_SETTLEMENT_CHANGED' USING ERRCODE = 'PT409';
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$
;

-- public.get_ledger_usage_stats and public.get_ledger_deep_context: last full
-- definitions in 20261019184200_ledger_supplier_patterns_kontering_only. Each
-- NOT LIKE '19%' settlement filter also leaves out the company's card ledgers.
CREATE OR REPLACE FUNCTION public.get_ledger_usage_stats(
  p_company_id uuid,
  p_from_date date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'account_usage',
    (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'account_number', au.account_number,
            'account_name', au.account_name,
            'postings', au.postings,
            'last_used', au.last_used
          )
          ORDER BY au.postings DESC, au.account_number
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT
          l.account_number,
          max(coa.account_name) AS account_name,
          count(*)::bigint AS postings,
          max(je.entry_date) AS last_used
        FROM public.journal_entry_lines l
        JOIN public.journal_entries je ON je.id = l.journal_entry_id
        LEFT JOIN public.chart_of_accounts coa
          ON coa.company_id = p_company_id
         AND coa.account_number = l.account_number
        WHERE je.company_id = p_company_id
          AND je.status = 'posted'
          -- Stornos annul: counting their swapped lines re-inflates the
          -- account the correction moved away from. Corrections stay.
          AND je.source_type <> 'storno'
          AND je.entry_date >= p_from_date
        GROUP BY l.account_number
        ORDER BY count(*) DESC, l.account_number
        LIMIT 20
      ) au
    ),
    'counterparty_patterns',
    (
      WITH booked AS (
        SELECT
          public.normalize_counterparty_key(t.merchant_name) AS counterparty_key,
          t.merchant_name,
          t.category,
          t.journal_entry_id,
          t.date
        FROM public.transactions t
        JOIN public.journal_entries je ON je.id = t.journal_entry_id
        WHERE t.company_id = p_company_id
          AND t.journal_entry_id IS NOT NULL
          AND je.status = 'posted'
          -- Defensive: no code path should link a transaction to a storno
          -- (correctEntry relinks to the correction, reverseEntry unlinks),
          -- but legacy rows may predate the unlink behavior. Corrections are
          -- deliberately NOT excluded: they are the live booking.
          AND je.source_type <> 'storno'
          AND t.merchant_name IS NOT NULL
          AND trim(t.merchant_name) <> ''
          AND t.date >= p_from_date
      ),
      keyed AS (
        -- All-digit/reference-only merchant labels normalize to '': no
        -- identity, no pattern.
        SELECT * FROM booked WHERE counterparty_key <> ''
      ),
      totals AS (
        SELECT
          counterparty_key,
          mode() WITHIN GROUP (ORDER BY merchant_name) AS display_name,
          count(*)::bigint AS occurrences,
          max(date) AS last_booked
        FROM keyed
        GROUP BY counterparty_key
      ),
      dominant_category AS (
        SELECT DISTINCT ON (counterparty_key)
          counterparty_key,
          category,
          cnt
        FROM (
          SELECT counterparty_key, category, count(*)::bigint AS cnt
          FROM keyed
          WHERE category IS NOT NULL AND category <> 'uncategorized'
          GROUP BY counterparty_key, category
        ) c
        ORDER BY counterparty_key, cnt DESC, category
      ),
      dominant_account AS (
        SELECT DISTINCT ON (counterparty_key)
          counterparty_key,
          account_number
        FROM (
          SELECT b.counterparty_key, l.account_number, count(*)::bigint AS cnt
          FROM keyed b
          JOIN public.journal_entry_lines l ON l.journal_entry_id = b.journal_entry_id
          WHERE l.account_number NOT LIKE '19%'
            AND NOT EXISTS (SELECT 1 FROM public.cash_accounts ca
              WHERE ca.company_id = p_company_id AND ca.kind = 'card' AND ca.ledger_account = l.account_number)
            -- Exclude VAT accounts (26xx): on a reverse-charge purchase the
            -- expense, 2645 and 2614 lines tie, and the account_number
            -- tiebreak would otherwise pick the low VAT number over the
            -- expense. 26xx is always moms, never the informative contra.
            AND l.account_number NOT LIKE '26%'
          GROUP BY b.counterparty_key, l.account_number
        ) a
        ORDER BY counterparty_key, cnt DESC, account_number
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'counterparty', t.display_name,
            'counterparty_key', t.counterparty_key,
            'occurrences', t.occurrences,
            'last_booked', t.last_booked,
            'dominant_category', dc.category,
            'dominant_category_count', coalesce(dc.cnt, 0),
            'dominant_account_number', da.account_number
          )
          ORDER BY t.occurrences DESC, t.display_name
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT * FROM totals ORDER BY occurrences DESC, display_name LIMIT 25
      ) t
      LEFT JOIN dominant_category dc ON dc.counterparty_key = t.counterparty_key
      LEFT JOIN dominant_account da ON da.counterparty_key = t.counterparty_key
    ),
    'supplier_patterns',
    (
      -- AP-side booking patterns: bank-transaction patterns only see rows
      -- with a merchant_name, so an invoice-heavy company would be half
      -- blind without this. Supplier identity here is exact (FK), no
      -- normalization needed.
      WITH sinv AS (
        SELECT si.id, si.supplier_id, s.name AS supplier_name,
               si.invoice_date, si.vat_treatment
        FROM public.supplier_invoices si
        JOIN public.suppliers s ON s.id = si.supplier_id
        WHERE si.company_id = p_company_id
          AND si.invoice_date >= p_from_date
          -- Reversed bookings and credited invoices are undone business;
          -- credit notes repeat their original's accounts with flipped sign.
          AND si.status NOT IN ('reversed', 'credited')
          AND si.is_credit_note = false
      ),
      totals AS (
        SELECT
          supplier_id,
          max(supplier_name) AS supplier_name,
          count(*)::bigint AS invoices,
          max(invoice_date) AS last_invoice,
          mode() WITHIN GROUP (ORDER BY vat_treatment) AS dominant_vat
        FROM sinv
        GROUP BY supplier_id
      ),
      dominant_account AS (
        -- Invoices (not lines) touching each account, so a many-line invoice
        -- does not outvote ten single-line ones.
        SELECT DISTINCT ON (supplier_id)
          supplier_id,
          account_number,
          cnt
        FROM (
          SELECT v.supplier_id, i.account_number, count(DISTINCT v.id)::bigint AS cnt
          FROM sinv v
          JOIN public.supplier_invoice_items i ON i.supplier_invoice_id = v.id
          -- The invoice's kontering only. Rows on 26xx (moms), 244x (the
          -- skuld), 19xx (bank) and 3740 (öresavrundning) are legal rows,
          -- booked as they stand (20260928150100), but they recur on every
          -- invoice whatever it bought: counted, a 2641 row ties with the
          -- cost row and wins the account_number tiebreak (crm#1310).
          WHERE i.account_number NOT LIKE '19%'
            AND NOT EXISTS (SELECT 1 FROM public.cash_accounts ca
              WHERE ca.company_id = p_company_id AND ca.kind = 'card' AND ca.ledger_account = i.account_number)
            AND i.account_number NOT LIKE '244%'
            AND i.account_number NOT LIKE '26%'
            AND i.account_number <> '3740'
          GROUP BY v.supplier_id, i.account_number
        ) a
        ORDER BY supplier_id, cnt DESC, account_number
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'supplier', t.supplier_name,
            'invoices', t.invoices,
            'last_invoice', t.last_invoice,
            'vat_treatment', t.dominant_vat,
            'dominant_account_number', da.account_number,
            'dominant_account_count', coalesce(da.cnt, 0)
          )
          ORDER BY t.invoices DESC, t.supplier_name
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT * FROM totals ORDER BY invoices DESC, supplier_name LIMIT 15
      ) t
      LEFT JOIN dominant_account da ON da.supplier_id = t.supplier_id
    ),
    'vat_treatments_used',
    (
      SELECT coalesce(jsonb_agg(DISTINCT vt), '[]'::jsonb)
      FROM (
        SELECT i.vat_treatment AS vt
        FROM public.invoices i
        WHERE i.company_id = p_company_id
          AND i.invoice_date >= p_from_date
          AND i.vat_treatment IS NOT NULL
        UNION
        SELECT si.vat_treatment AS vt
        FROM public.supplier_invoices si
        WHERE si.company_id = p_company_id
          AND si.invoice_date >= p_from_date
          AND si.vat_treatment IS NOT NULL
      ) treatments
    ),
    'median_booking_lag_days',
    (
      -- committed_at (when the voucher was POSTED), not entry_date (the
      -- accounting date the bank flow sets to the transaction date, making
      -- entry_date - date a ~0 tautology). This is real posting promptness.
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (je.committed_at::date - t.date))
      FROM public.transactions t
      JOIN public.journal_entries je ON je.id = t.journal_entry_id
      WHERE t.company_id = p_company_id
        AND je.status = 'posted'
        -- A legacy transaction still linked to a storno (a reversal posted
        -- long after the transaction) would inject a spurious large lag into
        -- the very metric this migration exists to make honest. Exclude it,
        -- matching account_usage and counterparty_patterns.
        AND je.source_type <> 'storno'
        AND je.committed_at IS NOT NULL
        AND t.date >= p_from_date
    )
  );
$$;

REVOKE ALL ON FUNCTION public.get_ledger_usage_stats(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_usage_stats(uuid, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_ledger_deep_context(
  p_company_id uuid,
  p_from_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'counterparty_entities',
    (
      WITH booked AS (
        SELECT
          public.normalize_counterparty_key(t.merchant_name) AS k,
          t.merchant_name,
          t.journal_entry_id,
          t.date,
          -- SEK, or NULL when no SEK value can be established. NULL is the whole
          -- point: it drops out of sum() below instead of entering the total at
          -- its foreign face value.
          CASE
            -- SEK row: amount_sek is NULL here by design and `amount` already IS
            -- kronor, so this is the pre-existing coalesce untouched.
            WHEN upper(coalesce(nullif(btrim(t.currency), ''), 'SEK')) = 'SEK'
              THEN abs(coalesce(t.amount_sek, t.amount))
            -- Foreign row converted at ingest.
            WHEN t.amount_sek IS NOT NULL
              THEN abs(t.amount_sek)
            -- Foreign row carrying the rate it was recorded at.
            WHEN t.exchange_rate IS NOT NULL AND t.exchange_rate > 0
              THEN round(abs(t.amount) * t.exchange_rate, 2)
            -- Foreign row with neither: unknown in SEK, never assumed.
            ELSE NULL
          END AS amount
        FROM public.transactions t
        JOIN public.journal_entries je ON je.id = t.journal_entry_id
        WHERE t.company_id = p_company_id
          AND t.journal_entry_id IS NOT NULL
          AND je.status = 'posted'
          AND je.source_type <> 'storno'
          AND t.merchant_name IS NOT NULL
          AND trim(t.merchant_name) <> ''
          AND (p_from_date IS NULL OR t.date >= p_from_date)
      ),
      keyed AS (SELECT * FROM booked WHERE k <> ''),
      -- Median gap between distinct booking dates -> recurrence cadence.
      distinct_dates AS (SELECT DISTINCT k, date FROM keyed),
      gaps AS (
        SELECT k, (date - lag(date) OVER (PARTITION BY k ORDER BY date)) AS gap
        FROM distinct_dates
      ),
      recur AS (
        SELECT k, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::int AS cadence_days
        FROM gaps WHERE gap IS NOT NULL GROUP BY k
      ),
      -- Dominant contra account + its share, over the entity's verifikat lines.
      -- Rows with no SEK value stay in here on purpose: which account a booking
      -- went to is a fact that does not depend on the currency.
      acct_counts AS (
        SELECT b.k, l.account_number, count(*)::bigint AS cnt
        FROM keyed b
        JOIN public.journal_entry_lines l ON l.journal_entry_id = b.journal_entry_id
        WHERE l.account_number NOT LIKE '19%'
          AND NOT EXISTS (SELECT 1 FROM public.cash_accounts ca
            WHERE ca.company_id = p_company_id AND ca.kind = 'card' AND ca.ledger_account = l.account_number)
          AND l.account_number NOT LIKE '26%'
        GROUP BY b.k, l.account_number
      ),
      acct_totals AS (SELECT k, sum(cnt) AS total FROM acct_counts GROUP BY k),
      dominant_account AS (
        SELECT DISTINCT ON (ac.k) ac.k, ac.account_number, ac.cnt, at.total
        FROM acct_counts ac JOIN acct_totals at ON at.k = ac.k
        ORDER BY ac.k, ac.cnt DESC, ac.account_number
      ),
      agg AS (
        SELECT
          k,
          mode() WITHIN GROUP (ORDER BY merchant_name) AS display_name,
          count(*)::bigint AS occurrences,
          count(DISTINCT merchant_name)::int AS variant_count,
          (array_agg(DISTINCT merchant_name))[1:8] AS variants,
          -- sum() skips the NULLs from case 4. COALESCE keeps the field a number
          -- when every row was unconvertible.
          coalesce(sum(amount), 0) AS total_amount,
          (count(*) FILTER (WHERE amount IS NULL))::int AS unconverted_fx_count,
          min(date) AS first_seen,
          max(date) AS last_seen
        FROM keyed GROUP BY k
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', a.display_name,
            'key', a.k,
            'variants', to_jsonb(a.variants),
            'variant_count', a.variant_count,
            'occurrences', a.occurrences,
            'total_amount', round(a.total_amount)::bigint,
            -- Bookings whose SEK value could not be established, and which are
            -- therefore NOT in total_amount above.
            'unconverted_fx_count', a.unconverted_fx_count,
            'first_seen', a.first_seen,
            'last_seen', a.last_seen,
            'cadence_days', r.cadence_days,
            'dominant_account_number', da.account_number,
            -- Laplace-smoothed: n=1 no longer reads as 100%.
            'dominant_account_share',
              CASE WHEN da.total > 0 THEN round((da.cnt + 1)::numeric / (da.total + 2), 2) ELSE NULL END,
            'dominant_account_count', da.cnt,
            'dominant_account_total', da.total
          )
          ORDER BY a.occurrences DESC, a.total_amount DESC, a.display_name
        ),
        '[]'::jsonb
      )
      FROM (SELECT * FROM agg ORDER BY occurrences DESC, total_amount DESC, display_name LIMIT 40) a
      LEFT JOIN recur r ON r.k = a.k
      LEFT JOIN dominant_account da ON da.k = a.k
    ),
    'supplier_entities',
    (
      WITH sinv AS (
        SELECT si.id, si.supplier_id, s.name AS supplier_name,
               si.invoice_date, si.vat_treatment,
               -- Same four cases as the counterparty side. total_sek is NULL on
               -- every foreign invoice registered without an exchange_rate, so
               -- case 4 is the live cohort here, not an edge case.
               CASE
                 WHEN upper(coalesce(nullif(btrim(si.currency), ''), 'SEK')) = 'SEK'
                   THEN coalesce(si.total_sek, si.total, 0)
                 WHEN si.total_sek IS NOT NULL
                   THEN si.total_sek
                 WHEN si.exchange_rate IS NOT NULL AND si.exchange_rate > 0
                   THEN round(coalesce(si.total, 0) * si.exchange_rate, 2)
                 ELSE NULL
               END AS amount
        FROM public.supplier_invoices si
        JOIN public.suppliers s ON s.id = si.supplier_id
        WHERE si.company_id = p_company_id
          AND si.status NOT IN ('reversed', 'credited')
          AND si.is_credit_note = false
          AND (p_from_date IS NULL OR si.invoice_date >= p_from_date)
      ),
      distinct_dates AS (SELECT DISTINCT supplier_id, invoice_date FROM sinv),
      gaps AS (
        SELECT supplier_id,
               (invoice_date - lag(invoice_date) OVER (PARTITION BY supplier_id ORDER BY invoice_date)) AS gap
        FROM distinct_dates
      ),
      recur AS (
        SELECT supplier_id, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::int AS cadence_days
        FROM gaps WHERE gap IS NOT NULL GROUP BY supplier_id
      ),
      acct_counts AS (
        SELECT v.supplier_id, i.account_number, count(DISTINCT v.id)::bigint AS cnt
        FROM sinv v JOIN public.supplier_invoice_items i ON i.supplier_invoice_id = v.id
        -- The invoice's kontering only, as in get_ledger_usage_stats: moms,
        -- skuld, bank and öresavrundning rows are not where the cost goes,
        -- and counted they also inflate dominant_account_total (crm#1310).
        WHERE i.account_number NOT LIKE '19%'
          AND NOT EXISTS (SELECT 1 FROM public.cash_accounts ca
            WHERE ca.company_id = p_company_id AND ca.kind = 'card' AND ca.ledger_account = i.account_number)
          AND i.account_number NOT LIKE '244%'
          AND i.account_number NOT LIKE '26%'
          AND i.account_number <> '3740'
        GROUP BY v.supplier_id, i.account_number
      ),
      acct_totals AS (SELECT supplier_id, sum(cnt) AS total FROM acct_counts GROUP BY supplier_id),
      dominant_account AS (
        SELECT DISTINCT ON (ac.supplier_id) ac.supplier_id, ac.account_number, ac.cnt, at.total
        FROM acct_counts ac JOIN acct_totals at ON at.supplier_id = ac.supplier_id
        ORDER BY ac.supplier_id, ac.cnt DESC, ac.account_number
      ),
      agg AS (
        SELECT
          supplier_id,
          max(supplier_name) AS supplier_name,
          count(*)::bigint AS occurrences,
          coalesce(sum(amount), 0) AS total_amount,
          (count(*) FILTER (WHERE amount IS NULL))::int AS unconverted_fx_count,
          min(invoice_date) AS first_seen,
          max(invoice_date) AS last_seen,
          mode() WITHIN GROUP (ORDER BY vat_treatment) AS dominant_vat
        FROM sinv GROUP BY supplier_id
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', a.supplier_name,
            'key', a.supplier_id::text,
            'variants', to_jsonb(ARRAY[a.supplier_name]),
            'variant_count', 1,
            'occurrences', a.occurrences,
            'total_amount', round(a.total_amount)::bigint,
            -- Invoices whose SEK total could not be established, and which are
            -- therefore NOT in total_amount above.
            'unconverted_fx_count', a.unconverted_fx_count,
            'first_seen', a.first_seen,
            'last_seen', a.last_seen,
            'cadence_days', r.cadence_days,
            'dominant_account_number', da.account_number,
            -- Laplace-smoothed: n=1 no longer reads as 100%.
            'dominant_account_share',
              CASE WHEN da.total > 0 THEN round((da.cnt + 1)::numeric / (da.total + 2), 2) ELSE NULL END,
            'dominant_account_count', da.cnt,
            'dominant_account_total', da.total,
            'dominant_vat', a.dominant_vat
          )
          ORDER BY a.occurrences DESC, a.total_amount DESC, a.supplier_name
        ),
        '[]'::jsonb
      )
      FROM (SELECT * FROM agg ORDER BY occurrences DESC, total_amount DESC, supplier_name LIMIT 20) a
      LEFT JOIN recur r ON r.supplier_id = a.supplier_id
      LEFT JOIN dominant_account da ON da.supplier_id = a.supplier_id
    )
  );
$$;

REVOKE ALL ON FUNCTION public.get_ledger_deep_context(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_deep_context(uuid, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
