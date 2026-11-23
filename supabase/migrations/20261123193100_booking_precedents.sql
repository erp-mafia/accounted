-- booking_precedents: how a company booked the bank rows of given
-- counterparties before (2 of 2; its index is 20261123193000).
--
-- The caller hands the counterparty texts of the bank rows it is about to
-- propose bookings for (the merchant name, else the bank's original
-- description, else the description) and gets back, per counterparty key,
-- the newest booked bank rows of the company with that key and the lines of
-- the verifikat that books each. One call for all the texts.
--
-- * The key is normalize_counterparty_key, the key categorization_templates
--   are stored under, over the same text on both sides: the texts handed in
--   and the stored rows.
-- * A text that names no counterparty (grant_names_counterparty: only the
--   bank's wording for how it was paid) or whose key is shorter than two
--   characters has no key, on either side: it is absent from `names`, and a
--   stored row with such a text is never returned.
-- * A stored row counts when it belongs to the company, is dated on or after
--   p_from_date, and points at a verifikat of the company that is posted and
--   is not a storno. A correction is the live booking and counts.
-- * Newest first by the row's date, at most p_per_counterparty rows per key
--   (default 20, never more than 50), so the answer stays small for a
--   counterparty booked every day.
-- * The lines are returned as they stand (account, debit, credit). Which
--   account a booking is "on" and which VAT it carries is decided by the
--   caller (src/lib/transactions/booking-precedent.ts), not here.
-- * settlement_ledger is the ledger account of the row's own cash account,
--   null for a row without one.
--
-- Answer:
--   { "names":    { "<text handed in>": "<key>", ... },
--     "bookings": { "<key>": [ { "transaction_id", "date", "amount",
--                                "journal_entry_id", "settlement_ledger",
--                                "lines": [ { "account", "debit", "credit" } ] } ] } }
--
-- SECURITY INVOKER: the caller's row level security applies, and every read
-- filters on p_company_id as well, since the service role has none.
-- Read-only. Functions only, no data change.
--
-- pg-test: tests/pg/booking-precedents.pg.test.ts

CREATE OR REPLACE FUNCTION public.booking_precedents(
  p_company_id uuid,
  p_names text[],
  p_from_date date,
  p_per_counterparty integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH named AS MATERIALIZED (
    -- Keyed once per distinct text: the key function is the expensive step.
    SELECT d.raw_name, public.normalize_counterparty_key(d.raw_name) AS counterparty_key
    FROM (
      SELECT DISTINCT u.raw_name
      FROM unnest(p_names) AS u(raw_name)
      WHERE u.raw_name IS NOT NULL AND u.raw_name <> ''
    ) d
    WHERE public.grant_names_counterparty(d.raw_name)
  ),
  keys AS MATERIALIZED (
    SELECT DISTINCT counterparty_key
    FROM named
    WHERE char_length(counterparty_key) >= 2
  ),
  booked AS MATERIALIZED (
    SELECT k.counterparty_key, b.transaction_id, b.date, b.amount, b.journal_entry_id, b.cash_account_id
    FROM keys k
    CROSS JOIN LATERAL (
      -- The key expression and "journal_entry_id IS NOT NULL" are those of
      -- idx_transactions_booked_counterparty_key, word for word.
      SELECT t.id AS transaction_id, t.date, t.amount, t.journal_entry_id, t.cash_account_id
      FROM public.transactions t
      JOIN public.journal_entries je ON je.id = t.journal_entry_id
      WHERE t.company_id = p_company_id
        AND public.normalize_counterparty_key(coalesce(nullif(t.merchant_name, ''), nullif(t.original_description, ''), t.description)) = k.counterparty_key
        AND t.journal_entry_id IS NOT NULL
        AND t.date >= p_from_date
        AND public.grant_names_counterparty(coalesce(nullif(t.merchant_name, ''), nullif(t.original_description, ''), t.description))
        AND je.company_id = p_company_id
        AND je.status = 'posted'
        AND je.source_type <> 'storno'
      ORDER BY t.date DESC, t.id DESC
      LIMIT greatest(1, least(coalesce(p_per_counterparty, 20), 50))
    ) b
  )
  SELECT jsonb_build_object(
    'names',
    (
      SELECT coalesce(jsonb_object_agg(n.raw_name, n.counterparty_key), '{}'::jsonb)
      FROM named n
      WHERE char_length(n.counterparty_key) >= 2
    ),
    'bookings',
    (
      SELECT coalesce(jsonb_object_agg(g.counterparty_key, g.bookings), '{}'::jsonb)
      FROM (
        SELECT
          b.counterparty_key,
          jsonb_agg(
            jsonb_build_object(
              'transaction_id', b.transaction_id,
              'date', b.date,
              'amount', b.amount,
              'journal_entry_id', b.journal_entry_id,
              'settlement_ledger',
              (
                SELECT ca.ledger_account
                FROM public.cash_accounts ca
                WHERE ca.id = b.cash_account_id
                  AND ca.company_id = p_company_id
              ),
              'lines',
              (
                SELECT coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'account', l.account_number,
                      'debit', l.debit_amount,
                      'credit', l.credit_amount
                    )
                    ORDER BY l.sort_order, l.id
                  ),
                  '[]'::jsonb
                )
                FROM public.journal_entry_lines l
                WHERE l.journal_entry_id = b.journal_entry_id
              )
            )
            ORDER BY b.date DESC, b.transaction_id DESC
          ) AS bookings
        FROM booked b
        GROUP BY b.counterparty_key
      ) g
    )
  );
$$;

REVOKE ALL ON FUNCTION public.booking_precedents(uuid, text[], date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.booking_precedents(uuid, text[], date, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
