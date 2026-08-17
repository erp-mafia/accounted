-- Backfill transaction_method for existing FEED rows and strip the trailing
-- channel phrase from unedited feed titles.
--
-- One-shot, point-in-time backfill: it deliberately duplicates the trailing-
-- phrase vocabulary of classifyTransactionMethod() (lib/transactions/
-- transaction-method.ts) in SQL. This is NOT a live mirror that must stay in
-- sync (contrast normalize_counterparty_key): rows ingested after this
-- migration are classified in TS at the ingest boundary.
--
-- SCOPE: bank/feed rows only: a live bank_connection_id, OR an
-- import_source that is present and not manual/mcp (the isImportedTransaction
-- predicate from lib/transactions/origin.ts; bank_connection_id covers the
-- oldest PSD2 rows that predate the import_source column). User-created rows
-- (manual UI adds have import_source NULL or 'manual', MCP/agent rows 'mcp')
-- carry user-authored titles like "Egen insättning": classifying or rewriting
-- those from a channel vocabulary would corrupt meaning, so they are excluded
-- from every statement below. The same invariant holds at ingest.
--
-- Classification reads coalesce(original_description, description): the
-- immutable bank original when present (title edits never touch it), the
-- working title for legacy rows predating the column. Historical rows carry
-- no ISO codes (they were dropped at insert before this feature), so text is
-- the only available signal; MCC and the Stripe feed's own description
-- prefixes fill the gaps.
--
-- Title stripping only touches rows the user has NOT renamed
-- (title_edited_at IS NULL), never empties a title (a description that IS
-- just the phrase, e.g. a bare "Insättning", is kept), and never strips when
-- the remaining title would end in a possessive/scope adjective (the
-- adjective guard: "Egen insättning" must not become "Egen"; the method
-- classification still applies). Stripping a TRAILING phrase leaves a prefix
-- of the original string, so the content-dedup bridge (descriptionsBridge:
-- symmetric prefix containment against original_description ?? description)
-- still bridges re-imports. Booked rows are included: transactions.description
-- is staging/display data, not räkenskapsinformation (see 20260605120000);
-- the verifikat text lives on the journal entry.

-- ===== 1. Classify from the trailing channel phrase (feed rows only) =====
-- Most-specific vocabularies first; the generic bare "överföring" runs last.
-- Postgres POSIX regexes prefer the longest alternation match, so
-- "överföring via internet" always beats "överföring" within one pattern.

UPDATE public.transactions
SET transaction_method = 'card'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(kortköp/uttag|kortköp|kortbetalning|webbköp)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'bankgiro'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(bg-bet\. via internet|bg-bet via internet|bg-betalning|bg betalning|bgmax|bg-inb|bankgiro|bg-bet\.?)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'plusgiro'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(pg-betalning|pg betalning|plusgiro)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'international'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(europabetalning|utlandsbetalning)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'salary'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(löneinsättning|lönebetalning|löneutbetalning|lön)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'e_invoice'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(e-faktura|efaktura)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'swish'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND (
    coalesce(original_description, description) ~* '(^|[[:space:]])(swish-betalning|swish betalning|swish)[[:space:]]*$'
    OR coalesce(original_description, description) ~* '^swish (till|från)([[:space:]]|$)'
  );

UPDATE public.transactions
SET transaction_method = 'autogiro'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(autogirobetalning|autogiro)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'fee'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(pris betalning|prisbetalning|avgift)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'interest'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(insättningsränta|ränta)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'deposit'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(kontantinsättning|insättning)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'withdrawal'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(bankomatuttag|kontantuttag|uttag)[[:space:]]*$';

UPDATE public.transactions
SET transaction_method = 'transfer'
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND coalesce(original_description, description) ~* '(^|[[:space:]])(överföring via internet|överföring via mobil|överföring via app|överföring inom banken|överföring inom bank|överföring mellan konton|direktöverföring|direktbetalning|internetbetalning|mobilbetalning|överföring)[[:space:]]*$';

-- ===== 2. MCC fallback (card rail; 6011 = ATM cash disbursement) =====

UPDATE public.transactions
SET transaction_method = CASE WHEN mcc_code = 6011 THEN 'withdrawal' ELSE 'card' END
WHERE transaction_method IS NULL
  AND (bank_connection_id IS NOT NULL OR (import_source IS NOT NULL AND import_source NOT IN ('manual', 'mcp')))
  AND mcc_code IS NOT NULL;

-- ===== 3. Stripe feed rows: the sync's own description prefixes are a =====
-- ===== reliable type discriminator (describeBalanceTxn is deterministic) ====

UPDATE public.transactions
SET transaction_method = 'fee'
WHERE transaction_method IS NULL
  AND import_source = 'stripe'
  AND (
    coalesce(original_description, description) LIKE 'Stripe-avgift%'
    OR coalesce(original_description, description) LIKE 'Stripe: Billing%'
    OR coalesce(original_description, description) LIKE 'Stripe: Automatic Taxes%'
  );

UPDATE public.transactions
SET transaction_method = 'card'
WHERE transaction_method IS NULL
  AND import_source = 'stripe'
  AND (
    coalesce(original_description, description) LIKE 'Stripe-betalning%'
    OR coalesce(original_description, description) LIKE 'Stripe-återbetalning%'
  );

UPDATE public.transactions
SET transaction_method = 'transfer'
WHERE transaction_method IS NULL
  AND import_source = 'stripe'
  AND coalesce(original_description, description) LIKE 'Stripe-utbetalning%';

UPDATE public.transactions
SET transaction_method = 'adjustment'
WHERE transaction_method IS NULL
  AND import_source = 'stripe'
  AND (
    coalesce(original_description, description) LIKE 'Stripe-justering%'
    OR coalesce(original_description, description) LIKE 'Stripe-tvist%'
  );

-- ===== 4. Strip the trailing channel phrase from unedited FEED titles =====
-- The union of every trailing vocabulary above. Guarded so a title is never
-- emptied, never rewritten to itself, never rewritten on a user-created row,
-- and never left ending in a possessive/scope adjective ("Egen insättning"
-- keeps its full title; the method column still says deposit).
-- original_description keeps the full bank string, so the rewrite is exactly
-- reversible and "restore original" still works. That invariant already holds
-- on any DB that replayed 20260605120000 (its backfill filled every NULL, and
-- ingest writes the column on every insert since), but the strip below
-- ENFORCES it rather than assuming it: a row that somehow reached this point
-- with original_description NULL gets its pre-strip description preserved in
-- the same statement, so the full bank string can never be lost.

WITH pat AS (
  SELECT '(^|[[:space:]])(kortköp/uttag|kortköp|kortbetalning|webbköp|bg-bet\. via internet|bg-bet via internet|bg-betalning|bg betalning|bgmax|bg-inb|bankgiro|bg-bet\.?|pg-betalning|pg betalning|plusgiro|europabetalning|utlandsbetalning|löneinsättning|lönebetalning|löneutbetalning|lön|e-faktura|efaktura|swish-betalning|swish betalning|swish|autogirobetalning|autogiro|pris betalning|prisbetalning|avgift|insättningsränta|ränta|kontantinsättning|insättning|bankomatuttag|kontantuttag|uttag|överföring via internet|överföring via mobil|överföring via app|överföring inom banken|överföring inom bank|överföring mellan konton|direktöverföring|direktbetalning|internetbetalning|mobilbetalning|överföring)[[:space:]]*$'::text AS p
),
stripped AS (
  SELECT t.id,
         btrim(regexp_replace(t.description, pat.p, '', 'i')) AS new_desc
  FROM public.transactions t, pat
  WHERE t.title_edited_at IS NULL
    AND (t.bank_connection_id IS NOT NULL OR (t.import_source IS NOT NULL AND t.import_source NOT IN ('manual', 'mcp')))
    AND t.description ~* pat.p
)
UPDATE public.transactions t
SET description = s.new_desc,
    original_description = coalesce(t.original_description, t.description)
FROM stripped s
WHERE t.id = s.id
  AND s.new_desc <> ''
  AND s.new_desc <> t.description
  -- Adjective guard: the last remaining word must not be a possessive/scope
  -- adjective whose meaning depended on the stripped noun.
  AND lower(regexp_replace(s.new_desc, '^.*[[:space:]]', '')) NOT IN
      ('egen', 'eget', 'egna', 'privat', 'privata', 'intern', 'interna', 'extern', 'externa');
