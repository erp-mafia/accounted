-- Group the submitted bank sources before correlating journal lines. PostgreSQL
-- cannot correlate the JSON input value through GROUP BY on an expression.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)'::regprocedure);
  v_old text := $old$      SELECT 1 FROM jsonb_array_elements(v_bank_context) c
      GROUP BY c->>'settlement_account'
      HAVING ABS(SUM((c->>'amount')::numeric) - COALESCE(($old$;
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 2 THEN
    RAISE EXCEPTION 'Unexpected bulk bank totals definition';
  END IF;
  v_definition := replace(v_definition, v_old, $new$      SELECT 1 FROM (
        SELECT c->>'settlement_account' AS ledger, SUM((c->>'amount')::numeric) AS amount
        FROM jsonb_array_elements(v_bank_context) c
        GROUP BY c->>'settlement_account'
      ) bank_totals
      WHERE ABS(bank_totals.amount - COALESCE(($new$);
  v_definition := replace(v_definition, $old$l.account_number = c->>'settlement_account'$old$, 'l.account_number = bank_totals.ledger');
  EXECUTE v_definition;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
