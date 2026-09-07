-- One-shot, re-runnable repair of transactions.bank_transaction_code and
-- transactions.proprietary_bank_transaction_code for Enable Banking rows.
--
-- Enable Banking serializes bank_transaction_code as an object
-- ({"description": ..., "code": ..., "sub_code": ...}); the direct sync path
-- typed it as a string and passed it through, so PostgREST wrote the object's
-- JSON text into the text column for every Enable Banking row since
-- 2026-08-09 (6,356 rows across 78 companies on prod at 2026-09-07). The
-- Connect service hit the same type lie the loud way (the wire contract
-- rejected the object) and that is the 2026-09-03 canary outage.
--
-- The converter now flattens with the contract's normalizeBankTransactionCode
-- rule; this migration applies the same rule to the rows already written:
--   code present  -> code, or code/sub_code when a sub-code exists
--   code absent   -> description
--   neither       -> NULL
-- Only rows whose value is a JSON object are touched (the regex keeps plain
-- strings out of the cast), only Enable Banking rows, and the statement is a
-- pure text rewrite of an evidence column: no journal entries, no matching,
-- no categorization, no transaction_method re-derivation. Guarded so a value
-- that is not valid JSON is left as it is rather than failing the migration.
--
-- Rows of a company that is a migration-reset source (company_migration_resets)
-- are immutable by trigger (transactions_block_migration_reset_source_mutation,
-- 20260818084050) and are skipped: 20260903170000 failed on prod for exactly
-- that reason. Those rows (110 on prod, one archived company) keep the JSON
-- text; nothing reads the column back, so nothing is lost.

CREATE OR REPLACE FUNCTION pg_temp.flatten_eb_transaction_code(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_obj jsonb;
  v_code text;
  v_sub text;
  v_desc text;
BEGIN
  IF p_raw IS NULL OR p_raw !~ '^\{.*\}$' THEN
    RETURN p_raw;
  END IF;
  BEGIN
    v_obj := p_raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN p_raw;
  END;
  IF jsonb_typeof(v_obj) <> 'object' THEN
    RETURN p_raw;
  END IF;
  v_code := NULLIF(btrim(v_obj->>'code'), '');
  v_sub := NULLIF(btrim(v_obj->>'sub_code'), '');
  v_desc := NULLIF(btrim(v_obj->>'description'), '');
  IF v_code IS NOT NULL THEN
    RETURN CASE WHEN v_sub IS NOT NULL THEN v_code || '/' || v_sub ELSE v_code END;
  END IF;
  RETURN v_desc;
END;
$$;

UPDATE public.transactions
SET
  bank_transaction_code = pg_temp.flatten_eb_transaction_code(bank_transaction_code),
  proprietary_bank_transaction_code = pg_temp.flatten_eb_transaction_code(proprietary_bank_transaction_code)
WHERE import_source = 'enable_banking'
  AND (
    bank_transaction_code ~ '^\{.*\}$'
    OR proprietary_bank_transaction_code ~ '^\{.*\}$'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.company_migration_resets r
    WHERE r.source_company_id = transactions.company_id
  );

DROP FUNCTION pg_temp.flatten_eb_transaction_code(text);
