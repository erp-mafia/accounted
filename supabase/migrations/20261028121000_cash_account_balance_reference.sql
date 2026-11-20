-- cash_accounts.balance_reference: the day and type the bank gave with its
-- balance.
--
-- Why: the balance check (lib/reconciliation/bank-balance-check.ts) compares
-- the bank's balance with the books at the end of "the bank's day", and that
-- day was the Stockholm day of the fetch. A bank that answers with an earlier
-- day's closing balance (closingBooked) then had the rows since on the book
-- side only. Enable Banking returns reference_date and balance_type in the
-- same response; they were dropped.
--
-- One jsonb column, written only by persist_bank_sync_result and in the same
-- statement as the balance: {date, type, fetched_at}, fetched_at being the
-- balance_updated_at it belongs to. The other writers that move a balance
-- between rows (twin healing, account selection, the bank callback, the Open
-- Payments feed) do not carry it, so a reader trusts it only while fetched_at
-- equals the row's balance_updated_at, and otherwise falls back to the fetch
-- day. A newer balance without a reference clears it; the same observation
-- sent again without one (a sync that skipped the refresh) keeps it. It stays
-- out of bank_connections.accounts_data, where nothing would read it.
--
-- The reference belongs to the balance observation, not to the account's
-- configuration. Five places compared a cash account's configuration by
-- removing the observation columns, each listing them by hand: the
-- configuration writer guard, the bank configuration token, the twin plan
-- fingerprint, and the twin proof's capture and check. Without the new column
-- in those lists, every sync would read as a configuration change: a stale
-- token refuses the account selection, disconnect and bank callback, and a
-- moved fingerprint refuses a reviewed twin repair.
-- cash_account_observation_keys() now names the columns once, and all five
-- use it. With the column removed again, the token, fingerprint and proofs
-- of existing rows are unchanged by this migration.
--
-- The six functions are restated from their live bodies. The only changes
-- are the observation keys and, in persist_bank_sync_result, the added
-- reference.
-- pg-test: covered-by tests/pg/bank-sync-result.pg.test.ts
-- pg-test: covered-by tests/pg/cash-account-twin-heal.pg.test.ts

ALTER TABLE public.cash_accounts ADD COLUMN balance_reference jsonb;

COMMENT ON COLUMN public.cash_accounts.balance_reference IS
  'The bank''s own day and type for balance: {date, type, fetched_at}. Belongs to balance only while fetched_at equals balance_updated_at. Written by persist_bank_sync_result.';

CREATE OR REPLACE FUNCTION public.cash_account_observation_keys()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT ARRAY['balance', 'available_balance', 'balance_updated_at', 'balance_reference', 'updated_at']
$function$;

COMMENT ON FUNCTION public.cash_account_observation_keys() IS
  'The cash_accounts columns a bank balance observation writes. Every comparison of a cash account''s configuration removes them, so a sync never reads as a configuration change.';

CREATE OR REPLACE FUNCTION public.guard_bank_configuration_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'bank_connections' THEN
    IF coalesce(has_function_privilege(current_user, to_regprocedure('public.erase_user_personal_data(uuid)')::oid, 'EXECUTE'), false)
       AND NEW.status = 'revoked'
       AND NEW.session_id IS NULL
       AND NEW.authorization_id IS NULL
       AND NEW.oauth_state IS NULL
       AND NEW.accounts_data IS NULL
       AND (to_jsonb(NEW) - ARRAY['status','session_id','authorization_id','oauth_state','accounts_data','updated_at'])
         = (to_jsonb(OLD) - ARRAY['status','session_id','authorization_id','oauth_state','accounts_data','updated_at']) THEN
      -- The protected caller already authorized erasure. Keep the same
      -- company coordination, including after membership removal and for an
      -- archived company, but never wait while holding a connection row.
      BEGIN
        PERFORM 1 FROM public.companies WHERE id = NEW.company_id FOR NO KEY UPDATE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
      END;
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'cash_accounts' THEN
      IF to_jsonb(NEW) - public.cash_account_observation_keys()
        = to_jsonb(OLD) - public.cash_account_observation_keys() THEN RETURN NEW; END IF;
    ELSIF public.bank_connection_configuration_state(to_jsonb(NEW))
      = public.bank_connection_configuration_state(to_jsonb(OLD)) THEN RETURN NEW;
    END IF;
  END IF;
  FOR v_company IN SELECT DISTINCT id FROM unnest(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.company_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.company_id END
  ]) id WHERE id IS NOT NULL ORDER BY id LOOP
    -- Parent deletion already holds this company's row lock. Its FK cascade
    -- runs after the parent row is gone and cannot create a new bank claim.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.companies WHERE id = v_company) THEN CONTINUE; END IF;
    PERFORM public.lock_cash_account_company(v_company, false);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bank_configuration_token(p_company_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
  SELECT encode(extensions.digest(jsonb_build_object('version', 1, 'company', p_company_id,
    'connections', (SELECT coalesce(jsonb_agg(public.bank_connection_configuration_state(to_jsonb(b)) ORDER BY b.id), '[]')
      FROM public.bank_connections b WHERE b.company_id = p_company_id),
    'cash', (SELECT coalesce(jsonb_agg(to_jsonb(c) - public.cash_account_observation_keys() ORDER BY c.id), '[]')
      FROM public.cash_accounts c WHERE c.company_id = p_company_id),
    'posted_ledgers', (SELECT coalesce(jsonb_agg(account_number ORDER BY account_number), '[]') FROM (
      SELECT DISTINCT l.account_number FROM public.journal_entry_lines l JOIN public.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = p_company_id AND j.status IN ('posted','reversed') AND l.account_number ~ '^19[0-9]{2}$'
    ) ledgers)
  )::text, 'sha256'), 'hex');
$function$;

CREATE OR REPLACE FUNCTION public.plan_cash_account_twins(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_snapshot jsonb;
  v_groups jsonb := '[]';
  v_group record;
  v_keeper public.cash_accounts;
  v_live public.cash_accounts;
  v_row public.cash_accounts;
  v_posted text[];
  v_live_ids uuid[];
  v_ledger text;
  v_retired jsonb;
  v_report jsonb;
  v_skip text;
  v_movable integer;
  v_total integer;
  v_dependencies text[];
  v_changes boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- JSONB canonicalizes object keys; every array is explicitly ordered.
  -- Keep full relevant identity/configuration and reference sets in the hash,
  -- including transaction IDs (counts alone miss equal-count replacements).
  -- Balance observations and last-sync timestamps do not affect this plan.
  SELECT jsonb_build_object('version', 1, 'company', p_company_id,
    'cash', (SELECT coalesce(jsonb_agg(to_jsonb(c) - public.cash_account_observation_keys() ORDER BY c.id), '[]')
      FROM public.cash_accounts c WHERE c.company_id = p_company_id),
    'connections', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'session', b.session_id,
      'status', b.status, 'superseded', b.superseded_by, 'accounts', (
        SELECT coalesce(jsonb_agg(a - ARRAY['balance','available_balance','balance_updated_at','accepted_history_days'] ORDER BY a->>'uid'), '[]')
        FROM jsonb_array_elements(b.accounts_data) a)) ORDER BY b.id), '[]')
      FROM public.bank_connections b WHERE b.company_id = p_company_id),
    'transactions', (SELECT coalesce(jsonb_agg(to_jsonb(t) - 'updated_at' ORDER BY t.id), '[]')
      FROM public.transactions t WHERE t.company_id = p_company_id AND t.cash_account_id IS NOT NULL),
    'voucher_links', (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]')
      FROM public.transaction_voucher_links a WHERE a.company_id = p_company_id),
    'invoice_payments', (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]')
      FROM public.invoice_payments a WHERE a.company_id = p_company_id),
    'supplier_payments', (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]')
      FROM public.supplier_invoice_payments a WHERE a.company_id = p_company_id),
    'posted_lines', (SELECT coalesce(jsonb_agg(jsonb_build_array(e.id, e.status, l.id, l.account_number) ORDER BY e.id, l.id), '[]')
      FROM public.journal_entries e JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id AND e.status IN ('posted','reversed') AND EXISTS (
        SELECT 1 FROM public.cash_accounts c WHERE c.company_id = p_company_id AND c.ledger_account = l.account_number)),
    'invoice_defaults', (SELECT coalesce(jsonb_agg(to_jsonb(d) - 'updated_at' ORDER BY d.id), '[]')
      FROM public.invoice_payee_defaults d WHERE d.company_id = p_company_id),
    'invoice_references', (SELECT coalesce(jsonb_agg(jsonb_build_array(i.id, i.payment_cash_account_id) ORDER BY i.id), '[]')
      FROM public.invoices i WHERE i.company_id = p_company_id AND i.payment_cash_account_id IS NOT NULL),
    'reconciliations', (SELECT coalesce(jsonb_agg(jsonb_build_array(r.id, r.account_key) ORDER BY r.id), '[]')
      FROM public.account_reconciliations r WHERE r.company_id = p_company_id),
    'reconciliation_attachments', (SELECT coalesce(jsonb_agg(jsonb_build_array(r.id, r.account_key) ORDER BY r.id), '[]')
      FROM public.account_reconciliation_attachments r WHERE r.company_id = p_company_id)
  ) INTO v_snapshot;

  FOR v_group IN
    SELECT upper(regexp_replace(iban, '\s', '', 'g')) || ':' || upper(currency) AS physical_key,
      array_agg(id ORDER BY id) AS ids, array_agg(ledger_account ORDER BY ledger_account) AS ledgers
    FROM public.cash_accounts WHERE company_id = p_company_id
      AND nullif(regexp_replace(iban, '\s', '', 'g'), '') IS NOT NULL
    GROUP BY upper(regexp_replace(iban, '\s', '', 'g')) || ':' || upper(currency)
    HAVING count(*) > 1 ORDER BY 1
  LOOP
    v_skip := NULL;
    v_retired := '[]';
    v_keeper := NULL;
    v_live := NULL;
    v_ledger := NULL;
    SELECT coalesce(array_agg(DISTINCT l.account_number ORDER BY l.account_number), '{}') INTO v_posted
    FROM public.journal_entry_lines l JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = p_company_id AND e.status IN ('posted', 'reversed') AND l.account_number = ANY(v_group.ledgers);
    IF cardinality(v_posted) > 1 THEN
      v_skip := 'split-ledgers';
    ELSE
      SELECT * INTO v_keeper FROM public.cash_accounts WHERE company_id = p_company_id AND id = ANY(v_group.ids)
        ORDER BY (ledger_account = ANY(v_posted)) DESC, is_primary DESC, created_at, id LIMIT 1;
      SELECT coalesce(array_agg(c.id ORDER BY c.id), '{}') INTO v_live_ids
      FROM public.cash_accounts c JOIN public.bank_connections b ON b.id = c.bank_connection_id AND b.company_id = c.company_id
      WHERE c.company_id = p_company_id AND c.id = ANY(v_group.ids) AND b.status = 'active'
        AND b.superseded_by IS NULL AND b.session_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(b.accounts_data) a WHERE a->>'uid' = c.external_uid);
      IF cardinality(v_live_ids) <> 1 THEN
        v_skip := CASE WHEN cardinality(v_live_ids) = 0 THEN 'no-live-row' ELSE 'several-live-rows' END;
      ELSE
        SELECT * INTO v_live FROM public.cash_accounts WHERE company_id = p_company_id AND id = v_live_ids[1];
        SELECT a->>'ledger_account' INTO v_ledger FROM public.bank_connections b,
          LATERAL jsonb_array_elements(b.accounts_data) a
          WHERE b.company_id = p_company_id AND b.id = v_live.bank_connection_id AND a->>'uid' = v_live.external_uid;
        IF (SELECT count(*) FROM public.bank_connections b, LATERAL jsonb_array_elements(b.accounts_data) a
          WHERE b.company_id = p_company_id AND b.id = v_live.bank_connection_id AND a->>'uid' = v_live.external_uid) <> 1
          OR EXISTS (SELECT 1 FROM public.bank_connections b, LATERAL jsonb_array_elements(b.accounts_data) a
          WHERE b.company_id = p_company_id AND b.id = v_live.bank_connection_id AND a->>'uid' = v_live.external_uid
            AND (upper(a->>'currency') IS DISTINCT FROM v_live.currency OR
              (nullif(a->>'iban', '') IS NOT NULL AND upper(regexp_replace(a->>'iban', '\s', '', 'g'))
                IS DISTINCT FROM upper(regexp_replace(v_live.iban, '\s', '', 'g')))))
        THEN
          v_skip := 'identity-mismatch';
        ELSIF v_ledger IS NOT NULL AND NOT v_ledger = ANY(v_group.ledgers) THEN
          v_skip := 'routing-outside-group';
        END IF;
      END IF;
    END IF;
    IF v_skip IS NULL THEN
      v_changes := v_live.id <> v_keeper.id OR v_ledger IS DISTINCT FROM v_keeper.ledger_account;
      FOR v_row IN SELECT * FROM public.cash_accounts WHERE company_id = p_company_id
        AND id = ANY(v_group.ids) AND id <> v_keeper.id ORDER BY ledger_account, id
      LOOP
        SELECT count(*), count(*) FILTER (WHERE public.cash_transaction_is_movable(p_company_id, t.id))
          INTO v_total, v_movable FROM public.transactions t
          WHERE t.company_id = p_company_id AND t.cash_account_id = v_row.id;
        v_dependencies := public.cash_account_retirement_dependencies(p_company_id, v_row.id);
        IF cardinality(v_dependencies) > 0 THEN v_skip := 'retirement-dependencies'; END IF;
        v_retired := v_retired || jsonb_build_array(jsonb_build_object('id', v_row.id, 'ledger_account', v_row.ledger_account,
          'movable', v_movable, 'staying', v_total - v_movable, 'dependencies', v_dependencies,
          'outcome', CASE WHEN v_row.bank_connection_id IS NULL THEN 'kept-manual'
            WHEN v_total > v_movable THEN 'demoted-to-manual' ELSE 'deleted' END));
        v_changes := v_changes OR v_row.is_primary OR v_movable > 0 OR v_row.bank_connection_id IS NOT NULL;
      END LOOP;
      IF v_skip IS NULL AND NOT v_changes THEN v_skip := 'already-merged'; END IF;
    END IF;
    v_report := jsonb_build_object('physicalKey', v_group.physical_key, 'ledgers', v_group.ledgers,
      'postedLedgers', v_posted, 'skipped', v_skip,
      'keeper', CASE WHEN v_keeper.id IS NOT NULL THEN jsonb_build_object('id', v_keeper.id, 'ledger_account', v_keeper.ledger_account) END,
      'liveRowId', v_live.id, 'accountsDataLedgerFrom', CASE WHEN v_ledger IS DISTINCT FROM v_keeper.ledger_account THEN v_ledger END,
      'retired', v_retired);
    v_groups := v_groups || jsonb_build_array(v_report);
  END LOOP;
  RETURN jsonb_build_object('companyId', p_company_id, 'dryRun', true, 'groups', v_groups,
    'fingerprint', encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.capture_cash_twin_expected_state(p_company_id uuid, p_groups jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  v_group jsonb;
  v_keeper public.cash_accounts;
  v_live public.cash_accounts;
  v_cash public.cash_accounts;
  v_tx public.transactions;
  v_state jsonb;
  v_expected jsonb;
  v_ids uuid[];
  v_tx_ids uuid[] := '{}';
  v_entry_id uuid;
  v_target uuid;
  v_transfer_primary boolean;
  v_cash_proof jsonb := '[]';
  v_tx_proof jsonb := '[]';
  v_journal_proof jsonb := '[]';
BEGIN
  FOR v_group IN SELECT a FROM jsonb_array_elements(p_groups) a WHERE a->>'skipped' IS NULL LOOP
    SELECT * INTO STRICT v_keeper FROM public.cash_accounts
      WHERE company_id = p_company_id AND id = (v_group->'keeper'->>'id')::uuid;
    SELECT * INTO STRICT v_live FROM public.cash_accounts
      WHERE company_id = p_company_id AND id = (v_group->>'liveRowId')::uuid;
    SELECT array_agg((a->>'id')::uuid) INTO v_ids FROM jsonb_array_elements(v_group->'retired') a;
    v_ids := coalesce(v_ids, '{}') || v_keeper.id;
    SELECT coalesce(bool_or(is_primary), false) INTO v_transfer_primary
      FROM public.cash_accounts WHERE company_id = p_company_id AND id = ANY(v_ids) AND id <> v_keeper.id;
    FOR v_cash IN SELECT * FROM public.cash_accounts WHERE company_id = p_company_id AND id = ANY(v_ids) ORDER BY id LOOP
      v_expected := to_jsonb(v_cash) - public.cash_account_observation_keys();
      IF v_cash.id = v_keeper.id THEN
        v_expected := v_expected || jsonb_build_object('bank_connection_id', v_live.bank_connection_id,
          'external_uid', v_live.external_uid, 'currency', upper(v_live.currency), 'iban', coalesce(v_live.iban, v_keeper.iban),
          'bban', coalesce(nullif(v_live.bban, ''), v_keeper.bban), 'name', coalesce(v_keeper.name, v_live.name),
          'enabled', v_live.enabled, 'source', 'enable_banking', 'is_primary', v_keeper.is_primary OR v_transfer_primary);
      ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(v_group->'retired') a
        WHERE a->>'id' = v_cash.id::text AND a->>'outcome' = 'deleted') THEN
        v_expected := NULL;
      ELSIF v_cash.bank_connection_id IS NULL THEN
        v_expected := v_expected || jsonb_build_object('is_primary', CASE WHEN v_transfer_primary THEN false ELSE v_cash.is_primary END);
      ELSE
        v_expected := v_expected || jsonb_build_object('bank_connection_id', NULL, 'external_uid', NULL,
          'is_primary', CASE WHEN v_transfer_primary THEN false ELSE v_cash.is_primary END);
      END IF;
      v_cash_proof := v_cash_proof || jsonb_build_array(jsonb_build_object('id', v_cash.id,
        'deleted', v_expected IS NULL, 'hash', public.cash_repair_state_hash(v_expected)));
    END LOOP;
    FOR v_tx IN SELECT * FROM public.transactions WHERE company_id = p_company_id AND cash_account_id = ANY(v_ids) ORDER BY id LOOP
      v_target := CASE WHEN v_tx.cash_account_id <> v_keeper.id AND public.cash_transaction_is_movable(p_company_id, v_tx.id)
        THEN v_keeper.id ELSE v_tx.cash_account_id END;
      v_state := public.cash_repair_transaction_state(p_company_id, v_tx.id);
      v_expected := jsonb_set(v_state, '{row,cash_account_id}', to_jsonb(v_target));
      v_tx_proof := v_tx_proof || jsonb_build_array(jsonb_build_object('id', v_tx.id, 'cashAccountId', v_target,
        'hash', public.cash_repair_state_hash(v_expected)));
      v_tx_ids := v_tx_ids || v_tx.id;
    END LOOP;
  END LOOP;
  FOR v_entry_id IN
    SELECT journal_entry_id FROM public.transactions WHERE company_id = p_company_id AND id = ANY(v_tx_ids) AND journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id = ANY(v_tx_ids)
    UNION SELECT journal_entry_id FROM public.invoice_payments WHERE company_id = p_company_id AND transaction_id = ANY(v_tx_ids) AND journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM public.supplier_invoice_payments WHERE company_id = p_company_id AND transaction_id = ANY(v_tx_ids) AND journal_entry_id IS NOT NULL
  LOOP
    v_journal_proof := v_journal_proof || jsonb_build_array(jsonb_build_object('id', v_entry_id,
      'hash', public.cash_repair_state_hash(public.cash_repair_journal_state(p_company_id, v_entry_id))));
  END LOOP;
  RETURN jsonb_build_object('schemaVersion', 1, 'cashAccounts', v_cash_proof, 'transactions', v_tx_proof, 'journals', v_journal_proof);
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_cash_twin_expected_state(p_company_id uuid, p_proof jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  v_item jsonb;
  v_current jsonb;
  v_issues jsonb := '[]';
BEGIN
  IF p_proof->>'schemaVersion' IS DISTINCT FROM '1'
    OR jsonb_typeof(p_proof->'cashAccounts') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_proof->'transactions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_proof->'journals') IS DISTINCT FROM 'array'
  THEN
    RETURN jsonb_build_object('status', 'insufficient-evidence', 'issues', '[]'::jsonb);
  END IF;
  FOR v_item IN SELECT a FROM jsonb_array_elements(p_proof->'cashAccounts') a LOOP
    SELECT to_jsonb(c) - public.cash_account_observation_keys() INTO v_current
      FROM public.cash_accounts c WHERE c.company_id = p_company_id AND c.id = (v_item->>'id')::uuid;
    IF (v_item->>'deleted')::boolean THEN
      IF v_current IS NOT NULL THEN v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'retired-account-present', 'id', v_item->>'id')); END IF;
    ELSIF v_current IS NULL OR public.cash_repair_state_hash(v_current) IS DISTINCT FROM v_item->>'hash' THEN
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'cash-account-changed', 'id', v_item->>'id'));
    END IF;
  END LOOP;
  FOR v_item IN SELECT a FROM jsonb_array_elements(p_proof->'transactions') a LOOP
    v_current := public.cash_repair_transaction_state(p_company_id, (v_item->>'id')::uuid);
    IF v_current IS NULL OR public.cash_repair_state_hash(v_current) IS DISTINCT FROM v_item->>'hash' THEN
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'transaction-or-anchor-changed', 'id', v_item->>'id',
        'expectedCashAccountId', v_item->>'cashAccountId', 'currentCashAccountId', v_current->'row'->>'cash_account_id'));
    END IF;
  END LOOP;
  FOR v_item IN SELECT a FROM jsonb_array_elements(p_proof->'journals') a LOOP
    v_current := public.cash_repair_journal_state(p_company_id, (v_item->>'id')::uuid);
    IF v_current IS NULL OR public.cash_repair_state_hash(v_current) IS DISTINCT FROM v_item->>'hash' THEN
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'journal-changed', 'id', v_item->>'id'));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('status', CASE WHEN jsonb_array_length(v_issues) = 0 THEN 'consistent' ELSE 'changed' END,
    'issues', v_issues, 'cashAccountsChecked', jsonb_array_length(p_proof->'cashAccounts'),
    'transactionsChecked', jsonb_array_length(p_proof->'transactions'), 'journalsChecked', jsonb_array_length(p_proof->'journals'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.persist_bank_sync_result(p_company_id uuid, p_connection_id uuid, p_session_id text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone, p_accounts jsonb, p_initial_sync jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_connection public.bank_connections;
  v_account jsonb;
  v_patch jsonb;
  v_next jsonb := '[]'::jsonb;
  v_balance_at timestamptz;
  v_reference_date text;
  v_reference jsonb;
  v_accounts integer := 0;
BEGIN
  IF p_started_at IS NULL OR p_completed_at IS NULL
     OR p_started_at > p_completed_at
     OR p_completed_at > clock_timestamp() + interval '5 minutes'
     OR jsonb_typeof(p_accounts) IS DISTINCT FROM 'array'
     OR (p_initial_sync IS NOT NULL AND jsonb_typeof(p_initial_sync) <> 'object') THEN
    RAISE EXCEPTION 'BANK_SYNC_RESULT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_accounts) a
     WHERE jsonb_typeof(a) <> 'object' OR nullif(a->>'uid', '') IS NULL
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_accounts) a GROUP BY a->>'uid' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'BANK_SYNC_RESULT_INVALID_ACCOUNTS' USING ERRCODE = '22023';
  END IF;


  -- Preserve the invoker's not-found/tenant contract before privileged locking.
  IF NOT EXISTS (
    SELECT 1 FROM public.bank_connections
    WHERE id = p_connection_id AND company_id = p_company_id
  ) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_found');
  END IF;
  PERFORM public.lock_cash_account_company(p_company_id);

  -- Re-read connection/session state after waiting, under the invoker's RLS.

  SELECT * INTO v_connection FROM public.bank_connections
   WHERE id = p_connection_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_found');
  END IF;
  IF v_connection.session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'session_changed');
  END IF;
  IF v_connection.status IS NULL OR v_connection.status NOT IN ('active', 'error')
     OR v_connection.superseded_by IS NOT NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'connection_inactive');
  END IF;
  IF v_connection.sync_result_started_at > p_started_at THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'newer_result_exists');
  END IF;
  -- A UID removed by reauthorization/sharing cannot be resurrected by a fetch.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_accounts) a
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(v_connection.accounts_data, '[]'::jsonb)) c
        WHERE c->>'uid' = a->>'uid'
     )
  ) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'accounts_changed');
  END IF;

  FOR v_account IN SELECT value FROM jsonb_array_elements(coalesce(v_connection.accounts_data, '[]'::jsonb)) LOOP
    SELECT value INTO v_patch FROM jsonb_array_elements(p_accounts)
     WHERE value->>'uid' = v_account->>'uid';
    IF FOUND THEN
      v_accounts := v_accounts + 1;
      -- An established external-id scope is immutable across observations.
      IF nullif(v_account->>'dedup_scope', '') IS NOT NULL
         AND nullif(v_patch->>'dedup_scope', '') IS NOT NULL
         AND v_account->>'dedup_scope' <> v_patch->>'dedup_scope' THEN
        RAISE EXCEPTION 'BANK_SYNC_DEDUP_SCOPE_CHANGED' USING ERRCODE = 'PT409';
      END IF;
      IF nullif(v_account->>'dedup_scope', '') IS NULL AND nullif(v_patch->>'dedup_scope', '') IS NOT NULL THEN
        v_account := v_account || jsonb_build_object('dedup_scope', v_patch->>'dedup_scope');
      END IF;
      IF v_patch ? 'accepted_history_days' THEN
        IF (v_patch->>'accepted_history_days')::integer < 0 THEN
          RAISE EXCEPTION 'BANK_SYNC_RESULT_INVALID_HISTORY' USING ERRCODE = '22023';
        END IF;
        v_account := v_account || jsonb_build_object('accepted_history_days', greatest(
          coalesce((v_account->>'accepted_history_days')::integer, 0),
          (v_patch->>'accepted_history_days')::integer
        ));
      END IF;
      v_balance_at := (v_patch->>'balance_updated_at')::timestamptz;
      IF v_balance_at IS NOT NULL AND v_balance_at <= p_completed_at + interval '5 minutes'
         AND (nullif(v_account->>'balance_updated_at', '') IS NULL
           OR v_balance_at >= (v_account->>'balance_updated_at')::timestamptz) THEN
        -- Whitelist observations: never accept ledger, enabled, IBAN or name.
        IF v_patch ? 'balance' THEN
          v_account := v_account || jsonb_build_object('balance', (v_patch->>'balance')::numeric);
        END IF;
        v_account := v_account || jsonb_build_object(
          'available_balance', (v_patch->>'available_balance')::numeric,
          'balance_updated_at', v_balance_at
        );
        -- The day and type the bank gave with this balance, stamped with the
        -- observation's time so a reader can tell it still belongs to the
        -- stored balance. Kept on the cash account only. Anything but a real
        -- calendar date leaves no reference; it never fails the sync.
        v_reference := NULL;
        v_reference_date := v_patch->'balance_reference'->>'date';
        IF v_patch ? 'balance'
           AND jsonb_typeof(v_patch->'balance_reference') = 'object'
           AND v_reference_date ~ '^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' THEN
          -- A day past the month's end rolls into the next month: no date.
          IF to_char(make_date(left(v_reference_date, 4)::integer, substr(v_reference_date, 6, 2)::integer, 1)
                     + (right(v_reference_date, 2)::integer - 1), 'YYYY-MM-DD') = v_reference_date THEN
            v_reference := jsonb_build_object(
              'date', v_reference_date,
              'type', left(nullif(v_patch->'balance_reference'->>'type', ''), 40),
              'fetched_at', v_balance_at
            );
          END IF;
        END IF;
        UPDATE public.cash_accounts
           SET balance = CASE WHEN v_patch ? 'balance' THEN (v_patch->>'balance')::numeric ELSE balance END,
               available_balance = (v_patch->>'available_balance')::numeric,
               balance_updated_at = v_balance_at,
               -- The same observation sent again without its day (a sync
               -- that skipped the refresh) keeps the day it has.
               balance_reference = CASE WHEN NOT (v_patch ? 'balance_reference') AND balance_updated_at = v_balance_at
                 THEN balance_reference ELSE v_reference END
         WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
           AND external_uid = v_account->>'uid'
           AND (balance_updated_at IS NULL OR balance_updated_at <= v_balance_at);
      END IF;
    END IF;
    v_next := v_next || jsonb_build_array(v_account);
  END LOOP;

  UPDATE public.bank_connections
     SET accounts_data = v_next,
         sync_result_started_at = p_started_at,
         last_synced_at = greatest(last_synced_at, p_completed_at),
         status = 'active', error_message = NULL,
         initial_sync_completed_at = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN p_completed_at ELSE initial_sync_completed_at END,
         initial_sync_requested_from = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'requested_from')::date ELSE initial_sync_requested_from END,
         initial_sync_returned_min_date = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'returned_min')::date ELSE initial_sync_returned_min_date END,
         initial_sync_returned_max_date = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'returned_max')::date ELSE initial_sync_returned_max_date END,
         initial_sync_lookback_days = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'lookback_days')::integer ELSE initial_sync_lookback_days END
   WHERE id = p_connection_id AND company_id = p_company_id;
  RETURN jsonb_build_object('applied', true, 'account_count', v_accounts);
END;
$function$;

NOTIFY pgrst, 'reload schema';
