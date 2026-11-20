-- Hard blocks on booking (accounted#130, step 2): "never book X without me".
--
-- Step 1 (20261030131517) let a company switch one click off and a person
-- make one learned rule always ask. A controller still could not say "this
-- counterparty, this account, anything from this amount or with this VAT
-- treatment is booked only after I have looked at it", and nothing in the
-- database held an agent, a grant, a bulk path or a one click to it. This
-- migration adds that rule and the one place that cannot be walked around:
-- commit_journal_entry.
--
-- 1. booking_review_rules: a dated processing rule (BFNAR 2013:2 p. 9.16),
--    versioned like company_grants: one row per version, never changed in
--    place or deleted, a change is a new version and archiving fills the
--    revoked_* columns once. A rule matches a booking of a bank row when
--    every criterion it sets matches:
--      accounts         the verifikat touches any of them;
--      counterparty_key a bank row it books has this grant_counterparty_key
--                       (the identity grants are keyed by);
--      amount_from_sek  that same bank row moves at least this much, in SEK;
--      vat_treatment    the verifikat's VAT lines carry it
--                       (booking_review_vat_classes below).
--    The counterparty and the amount are judged on one bank row together.
--    Written only by save_booking_review_rule and archive_booking_review_rule
--    (owner or admin, from a signed-in session), which log every change to
--    audit_log; behandlingshistorik lists them (section 6).
--
-- 2. booking_review_stamps: who reviewed a matched booking, when, the amount
--    and the booking_review attest limit it was judged on, and the rules that
--    matched. Written only by commit_reviewed_journal_entry, in the
--    transaction that posts the verifikat.
--
-- 3. booking_review_vat_classes / booking_review_entry_matches: the matching,
--    read only. Mirrored in TypeScript by src/lib/booking-review/match.ts
--    (the bank page, the Inkorg, bulk paths, grants, v1, MCP and approvals
--    ask there first, so a refusal here is the last line, not the first);
--    tests/pg/booking-review-rules.pg.test.ts pins the two together.
--    Only drafts that book a bank row (source_type bank_transaction, or a
--    manual samlingsverifikat with bank_booking_context) are matched: storno,
--    rättelse ('correction') and imports never are, whatever their lines.
--
-- 4. commit_reviewed_journal_entry: a person's commit from a review. It
--    checks the person keeps the company's books, requires a covering
--    booking_review limit in company_attest_limits when the company has set
--    any, stamps the draft and commits it through commit_journal_entry with
--    actor 'user' and commit_method 'user_accept', all in one transaction.
--
-- 5. commit_journal_entry: restated byte for byte from its newest definition
--    (20261016001100_commit_journal_entry_writes_committed_event), with the
--    SAME signature (a second overload is what broke PostgREST on
--    2026-08-31, see 20260831111519), plus one check after the draft is
--    locked: a draft a rule matches is posted only with a stamp written in
--    this same transaction by a person's reviewed commit. Everything else
--    (an API key, an agent, a grant, cron, a bulk accept, a one click, the
--    SQL posting functions) is refused with BOOKING_REVIEW_REQUIRED before a
--    voucher number is drawn, so nothing is burned. A company without rules
--    pays one index probe.
--
-- 6. behandlingshistorik_sources: restated from 20261030140000 unchanged but
--    for booking_review_rules in the audited tables (AUDITED_TABLES in
--    src/lib/reports/behandlingshistorik.ts).
--
-- Nothing here touches the migration 017 triggers, posted entries or their
-- lines. The code is live a few minutes before this runs: without the
-- tables the rules read as none (42P01) and nothing is blocked, as today.
--
-- pg-test: tests/pg/booking-review-rules.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. booking_review_rules
-- =============================================================================

CREATE TABLE public.booking_review_rules (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The rule across its versions: the id of its first version.
  rule_id            uuid NOT NULL,
  version            integer NOT NULL CONSTRAINT booking_review_rules_version_check CHECK (version >= 1),
  accounts           text[]
    CONSTRAINT booking_review_rules_accounts_check
    CHECK (accounts IS NULL OR (cardinality(accounts) BETWEEN 1 AND 50
                                AND array_position(accounts, NULL) IS NULL
                                AND array_to_string(accounts, ',') ~ '^[0-9]{4}(,[0-9]{4})*$')),
  counterparty_key   text
    CONSTRAINT booking_review_rules_counterparty_key_check
    CHECK (counterparty_key IS NULL OR char_length(counterparty_key) BETWEEN 2 AND 200),
  counterparty_label text
    CONSTRAINT booking_review_rules_counterparty_label_check
    CHECK (counterparty_label IS NULL OR char_length(counterparty_label) BETWEEN 1 AND 200),
  amount_from_sek    numeric(14, 2)
    CONSTRAINT booking_review_rules_amount_check
    CHECK (amount_from_sek IS NULL OR (amount_from_sek > 0 AND amount_from_sek <= 100000000)),
  vat_treatment      text
    CONSTRAINT booking_review_rules_vat_treatment_check
    CHECK (vat_treatment IS NULL OR vat_treatment IN ('standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'none')),
  note               text CONSTRAINT booking_review_rules_note_check CHECK (note IS NULL OR char_length(note) <= 500),
  valid_from         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES auth.users(id),
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES auth.users(id),
  revoked_reason     text
    CONSTRAINT booking_review_rules_revoked_reason_check CHECK (revoked_reason IS NULL OR revoked_reason IN ('archived', 'superseded')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_review_rules_criterion_check
    CHECK (accounts IS NOT NULL OR counterparty_key IS NOT NULL OR amount_from_sek IS NOT NULL OR vat_treatment IS NOT NULL),
  CONSTRAINT booking_review_rules_counterparty_check CHECK ((counterparty_key IS NULL) = (counterparty_label IS NULL)),
  CONSTRAINT booking_review_rules_revoked_check CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT booking_review_rules_version_key UNIQUE (rule_id, version)
);

COMMENT ON TABLE public.booking_review_rules IS
  'Hard blocks (accounted#130): a booking of a bank row that a rule matches is never booked without a person''s review, on any path. One row per version; never changed in place or deleted, only archived. Written by save_booking_review_rule and archive_booking_review_rule, which log to audit_log for behandlingshistorik (BFNAR 2013:2 p. 9.16).';
COMMENT ON COLUMN public.booking_review_rules.counterparty_key IS
  'grant_counterparty_key() of the counterparty the rule names: exact equality with the bank row''s key, never fuzzy.';
COMMENT ON COLUMN public.booking_review_rules.vat_treatment IS
  'The VAT the verifikat''s lines carry (booking_review_vat_classes): standard_25, reduced_12, reduced_6, reverse_charge, or none for a booking without VAT (export, exempt, private).';

CREATE UNIQUE INDEX booking_review_rules_one_active
  ON public.booking_review_rules (rule_id)
  WHERE revoked_at IS NULL;
CREATE INDEX booking_review_rules_company_active
  ON public.booking_review_rules (company_id)
  WHERE revoked_at IS NULL;
CREATE INDEX booking_review_rules_company_created
  ON public.booking_review_rules (company_id, created_at DESC);

ALTER TABLE public.booking_review_rules ENABLE ROW LEVEL SECURITY;

-- Members read their companies' rules (/rules, the suggestions). Every write
-- is a SECURITY DEFINER function: no write policy.
CREATE POLICY "members read booking_review_rules"
  ON public.booking_review_rules FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.booking_review_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.booking_review_rules TO service_role;
-- no-grant: anon on public.booking_review_rules (company-scoped: members only)

CREATE TRIGGER set_updated_at_booking_review_rules
  BEFORE UPDATE ON public.booking_review_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A dated rule is never rewritten: everything but the revocation is fixed,
-- and a revocation is final. Deleted only with its company.
CREATE FUNCTION public.booking_review_rules_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_revocation text[] := ARRAY['revoked_at', 'revoked_by', 'revoked_reason', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'booking_review_rules: a rule is never deleted, archive it instead' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - v_revocation) IS DISTINCT FROM (to_jsonb(OLD) - v_revocation) THEN
    RAISE EXCEPTION 'booking_review_rules: a rule is dated, change it with a new version, never in place' USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (
       NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
    OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
    RAISE EXCEPTION 'booking_review_rules: an archived rule stays archived' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_review_rules_immutable
  BEFORE UPDATE OR DELETE ON public.booking_review_rules
  FOR EACH ROW EXECUTE FUNCTION public.booking_review_rules_immutable();

-- =============================================================================
-- 2. booking_review_stamps
-- =============================================================================

CREATE TABLE public.booking_review_stamps (
  journal_entry_id uuid PRIMARY KEY REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The person who reviewed the booking and committed it.
  reviewed_by      uuid NOT NULL REFERENCES auth.users(id),
  reviewed_at      timestamptz NOT NULL DEFAULT now(),
  -- What the booking_review limit was judged on: the bank rows' SEK amount,
  -- and the reviewer's limit (NULL = no limit, or none set by the company).
  amount_sek       numeric(14, 2) NOT NULL,
  limit_sek        numeric(14, 2),
  -- The rules that matched: [{id, rule_id, version}].
  rules            jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.booking_review_stamps IS
  'A person''s review of a booking a booking_review_rules row matched: who, when, the amount and the booking_review limit it was judged on, and the matching rules. Written only by commit_reviewed_journal_entry in the transaction that posts the verifikat; commit_journal_entry refuses a matched draft without it.';

CREATE INDEX booking_review_stamps_company ON public.booking_review_stamps (company_id, reviewed_at DESC);

ALTER TABLE public.booking_review_stamps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read booking_review_stamps"
  ON public.booking_review_stamps FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

-- Read only for both roles: the one writer is commit_reviewed_journal_entry
-- (SECURITY DEFINER), and a stamp written any other way would not be one.
GRANT SELECT ON TABLE public.booking_review_stamps TO authenticated, service_role;
-- no-grant: anon on public.booking_review_stamps (company-scoped: members only)

CREATE TRIGGER set_updated_at_booking_review_stamps
  BEFORE UPDATE ON public.booking_review_stamps
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 3. Matching
-- =============================================================================

-- The VAT a verifikat's lines carry, as the rules name it. p_lines is a JSON
-- array of {account_number, debit_amount, credit_amount}. Mirrored by
-- vatClassesFromLines in src/lib/booking-review/match.ts.
--   reverse_charge  a line on an omvänd-betalningsskyldighet or import
--                   account (2614, 2615, 2624, 2625, 2634, 2635, 2645, 2647);
--   standard_25 /   a line on another utgående moms account of the rate
--   reduced_12 /    (261x, 262x, 263x), or ingående moms (2640-2649 but
--   reduced_6       2645 and 2647) at the share of the gross that rate gives,
--                   within half a percentage point: 25 % of the net is 20 %
--                   of the gross, 12 % is 10.71 %, 6 % is 5.66 %. Any other
--                   share (a partly deductible car lease, representation
--                   over the cap, mixed rates) carries all three, so a
--                   block on a rate never misses it;
--   none            no VAT line at all.
-- The gross is the larger side of the lines off 26xx (the bank leg on a bank
-- booking), so a refund reads as its purchase does.
CREATE FUNCTION public.booking_review_vat_classes(p_lines jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  rc constant text[] := ARRAY['2614', '2615', '2624', '2625', '2634', '2635', '2645', '2647'];
  v_classes text[] := '{}';
  v_input numeric := 0;
  v_debit numeric := 0;
  v_credit numeric := 0;
  v_gross numeric;
  v_line jsonb;
  v_account text;
  v_d numeric;
  v_c numeric;
BEGIN
  FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) LOOP
    v_account := v_line->>'account_number';
    v_d := coalesce((v_line->>'debit_amount')::numeric, 0);
    v_c := coalesce((v_line->>'credit_amount')::numeric, 0);
    IF v_account = ANY (rc) THEN
      v_classes := array_append(v_classes, 'reverse_charge');
    ELSIF v_account ~ '^261[0-9]$' THEN
      v_classes := array_append(v_classes, 'standard_25');
    ELSIF v_account ~ '^262[0-9]$' THEN
      v_classes := array_append(v_classes, 'reduced_12');
    ELSIF v_account ~ '^263[0-9]$' THEN
      v_classes := array_append(v_classes, 'reduced_6');
    ELSIF v_account ~ '^264[0-9]$' THEN
      v_input := v_input + v_d - v_c;
    ELSIF v_account !~ '^26' THEN
      v_debit := v_debit + v_d;
      v_credit := v_credit + v_c;
    END IF;
  END LOOP;
  IF v_input <> 0 THEN
    v_gross := greatest(v_debit, v_credit);
    IF v_gross > 0 AND abs(abs(v_input) / v_gross - 0.2) <= 0.005 THEN
      v_classes := array_append(v_classes, 'standard_25');
    ELSIF v_gross > 0 AND abs(abs(v_input) / v_gross - 0.12 / 1.12) <= 0.005 THEN
      v_classes := array_append(v_classes, 'reduced_12');
    ELSIF v_gross > 0 AND abs(abs(v_input) / v_gross - 0.06 / 1.06) <= 0.005 THEN
      v_classes := array_append(v_classes, 'reduced_6');
    ELSE
      v_classes := v_classes || ARRAY['standard_25', 'reduced_12', 'reduced_6'];
    END IF;
  END IF;
  IF cardinality(v_classes) = 0 THEN
    RETURN ARRAY['none'];
  END IF;
  RETURN ARRAY(SELECT DISTINCT c FROM unnest(v_classes) AS c ORDER BY c);
END;
$$;

REVOKE ALL ON FUNCTION public.booking_review_vat_classes(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.booking_review_vat_classes(jsonb) TO authenticated, service_role;

-- The company's active rules that match the draft, as [{id, rule_id,
-- version}], or [] (also for a draft that books no bank row, a storno, a
-- rättelse or an import). Read only; no API role calls it directly.
CREATE FUNCTION public.booking_review_entry_matches(p_company_id uuid, p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_source_type text;
  v_context jsonb;
  v_lines jsonb;
  v_accounts text[];
  v_vat text[];
  v_matches jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_review_rules r WHERE r.company_id = p_company_id AND r.revoked_at IS NULL
  ) THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT je.source_type, je.bank_booking_context
    INTO v_source_type, v_context
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id;
  IF NOT FOUND
     OR v_source_type IS NULL
     OR v_source_type NOT IN ('bank_transaction', 'manual')
     OR jsonb_array_length(coalesce(v_context, '[]'::jsonb)) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_number', l.account_number,
           'debit_amount', l.debit_amount,
           'credit_amount', l.credit_amount)), '[]'::jsonb),
         coalesce(array_agg(DISTINCT l.account_number), '{}')
    INTO v_lines, v_accounts
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = p_entry_id;
  v_vat := public.booking_review_vat_classes(v_lines);

  WITH bank_rows AS (
    SELECT public.grant_counterparty_key(t.merchant_name, t.original_description, t.description) AS counterparty_key,
           abs(coalesce(t.amount_sek, t.amount)) AS amount_sek
      FROM jsonb_array_elements(v_context) AS c(item)
      JOIN public.transactions t
        ON t.id = (c.item->>'transaction_id')::uuid
       AND t.company_id = p_company_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'rule_id', r.rule_id, 'version', r.version)
                            ORDER BY r.created_at, r.id), '[]'::jsonb)
    INTO v_matches
    FROM public.booking_review_rules r
   WHERE r.company_id = p_company_id
     AND r.revoked_at IS NULL
     AND r.valid_from <= now()
     AND (r.accounts IS NULL OR r.accounts && v_accounts)
     AND (r.vat_treatment IS NULL OR r.vat_treatment = ANY (v_vat))
     AND ((r.counterparty_key IS NULL AND r.amount_from_sek IS NULL)
          OR EXISTS (
            SELECT 1 FROM bank_rows b
             WHERE (r.counterparty_key IS NULL OR b.counterparty_key = r.counterparty_key)
               AND (r.amount_from_sek IS NULL OR b.amount_sek >= r.amount_from_sek)));
  RETURN v_matches;
END;
$$;

REVOKE ALL ON FUNCTION public.booking_review_entry_matches(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_review_entry_matches(uuid, uuid) TO service_role;

-- =============================================================================
-- 1b. Writing a rule (owner or admin, from a signed-in session)
-- =============================================================================

-- A new rule (p_supersedes NULL) or a new version of an active one: the old
-- version is archived as superseded in the same transaction. Every change is
-- logged to audit_log as the person who made it.
CREATE FUNCTION public.save_booking_review_rule(
  p_company_id uuid,
  p_accounts text[] DEFAULT NULL,
  p_counterparty text DEFAULT NULL,
  p_amount_from_sek numeric DEFAULT NULL,
  p_vat_treatment text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_supersedes uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_accounts text[];
  v_label text := nullif(left(btrim(coalesce(p_counterparty, '')), 200), '');
  v_key text;
  v_amount numeric(14, 2);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_old public.booking_review_rules;
  v_new public.booking_review_rules;
  v_id uuid := uuid_generate_v4();
  v_rule_id uuid;
  v_version integer := 1;
BEGIN
  IF v_user IS NULL OR NOT public.user_is_company_admin(p_company_id) THEN
    RAISE EXCEPTION 'BOOKING_REVIEW_RULE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF p_accounts IS NOT NULL AND cardinality(p_accounts) > 0 THEN
    IF EXISTS (SELECT 1 FROM unnest(p_accounts) a WHERE a IS NULL OR a !~ '^[0-9]{4}$') THEN
      RAISE EXCEPTION 'BOOKING_REVIEW_RULE_INVALID: accounts are four digits' USING ERRCODE = '22023';
    END IF;
    v_accounts := ARRAY(SELECT DISTINCT a FROM unnest(p_accounts) a ORDER BY a);
  END IF;
  IF v_label IS NOT NULL THEN
    v_key := public.grant_counterparty_key(v_label, NULL, NULL);
    IF v_key = '' THEN
      RAISE EXCEPTION 'BOOKING_REVIEW_RULE_UNKNOWN_COUNTERPARTY' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_amount_from_sek IS NOT NULL THEN
    IF p_amount_from_sek <= 0 OR p_amount_from_sek > 100000000 THEN
      RAISE EXCEPTION 'BOOKING_REVIEW_RULE_INVALID: amount_from_sek' USING ERRCODE = '22023';
    END IF;
    v_amount := p_amount_from_sek;
  END IF;
  IF p_vat_treatment IS NOT NULL
     AND p_vat_treatment NOT IN ('standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'none') THEN
    RAISE EXCEPTION 'BOOKING_REVIEW_RULE_INVALID: vat_treatment' USING ERRCODE = '22023';
  END IF;
  IF v_accounts IS NULL AND v_key IS NULL AND v_amount IS NULL AND p_vat_treatment IS NULL THEN
    RAISE EXCEPTION 'BOOKING_REVIEW_RULE_INVALID: a rule names at least one of accounts, counterparty, amount or VAT treatment'
      USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'BOOKING_REVIEW_RULE_INVALID: note' USING ERRCODE = '22023';
  END IF;

  v_rule_id := v_id;
  IF p_supersedes IS NOT NULL THEN
    SELECT * INTO v_old
      FROM public.booking_review_rules r
     WHERE r.rule_id = p_supersedes
       AND r.company_id = p_company_id
       AND r.revoked_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BOOKING_REVIEW_RULE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    v_rule_id := v_old.rule_id;
    v_version := v_old.version + 1;
    UPDATE public.booking_review_rules
       SET revoked_at = now(), revoked_by = v_user, revoked_reason = 'superseded'
     WHERE id = v_old.id;
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                  description, actor_type)
    SELECT v_user, p_company_id, 'UPDATE', 'booking_review_rules', r.id, v_user, to_jsonb(v_old), to_jsonb(r),
           'Booking review rule superseded by version ' || v_version, 'user'
      FROM public.booking_review_rules r WHERE r.id = v_old.id;
  END IF;

  INSERT INTO public.booking_review_rules (
    id, company_id, rule_id, version, accounts, counterparty_key, counterparty_label, amount_from_sek,
    vat_treatment, note, created_by
  )
  VALUES (
    v_id, p_company_id, v_rule_id, v_version, v_accounts, v_key, CASE WHEN v_key IS NULL THEN NULL ELSE v_label END,
    v_amount, p_vat_treatment, v_note, v_user
  )
  RETURNING * INTO v_new;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                description, actor_type)
  VALUES (
    v_user, p_company_id, 'INSERT', 'booking_review_rules', v_new.id, v_user, NULL, to_jsonb(v_new),
    'Booking review rule created (version ' || v_new.version || ')', 'user'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_new.id,
    'rule_id', v_new.rule_id,
    'version', v_new.version,
    'valid_from', v_new.valid_from,
    'superseded_id', v_old.id
  );
END;
$$;

-- A signed-in owner or admin only: the service role has no person to log.
REVOKE ALL ON FUNCTION public.save_booking_review_rule(uuid, text[], text, numeric, text, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_booking_review_rule(uuid, text[], text, numeric, text, text, uuid) TO authenticated;

CREATE FUNCTION public.archive_booking_review_rule(p_company_id uuid, p_rule_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_old public.booking_review_rules;
  v_new public.booking_review_rules;
BEGIN
  IF v_user IS NULL OR NOT public.user_is_company_admin(p_company_id) THEN
    RAISE EXCEPTION 'BOOKING_REVIEW_RULE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_old
    FROM public.booking_review_rules r
   WHERE r.rule_id = p_rule_id
     AND r.company_id = p_company_id
     AND r.revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOOKING_REVIEW_RULE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.booking_review_rules
     SET revoked_at = now(), revoked_by = v_user, revoked_reason = 'archived'
   WHERE id = v_old.id
  RETURNING * INTO v_new;
  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                description, actor_type)
  VALUES (
    v_user, p_company_id, 'UPDATE', 'booking_review_rules', v_new.id, v_user, to_jsonb(v_old), to_jsonb(v_new),
    'Booking review rule archived (version ' || v_new.version || ')', 'user'
  );
  RETURN jsonb_build_object('ok', true, 'id', v_new.id, 'rule_id', v_new.rule_id, 'version', v_new.version,
                            'revoked_at', v_new.revoked_at);
END;
$$;

REVOKE ALL ON FUNCTION public.archive_booking_review_rule(uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.archive_booking_review_rule(uuid, uuid) TO authenticated;

-- =============================================================================
-- 4. A person's reviewed commit
-- =============================================================================

-- Commit the draft as the person who reviewed it. A signed-in session is that
-- person (p_reviewer_id, when given, must be them); the service role names
-- them (an approval in the app commits as the service role on the approver's
-- behalf). The person must keep the company's books. When a rule matches the
-- draft and the company has set booking_review limits (company_attest_limits),
-- the person needs one that covers the bank rows' SEK amount; then the draft
-- is stamped and committed in this transaction, which is what lets
-- commit_journal_entry post it. A draft no rule matches commits as usual.
CREATE FUNCTION public.commit_reviewed_journal_entry(
  p_company_id uuid,
  p_entry_id uuid,
  p_reviewer_id uuid DEFAULT NULL,
  p_rubric_version text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reviewer uuid;
  v_matches jsonb;
  v_amount numeric(14, 2);
  v_limits_set boolean;
  v_limit_found boolean;
  v_limit numeric(14, 2);
BEGIN
  IF public.jwt_caller_is_end_user()
     OR current_setting('role', true) IN ('authenticated', 'anon')
     OR auth.uid() IS NOT NULL THEN
    v_reviewer := auth.uid();
    IF v_reviewer IS NULL
       OR (p_reviewer_id IS NOT NULL AND p_reviewer_id <> v_reviewer)
       OR NOT public.caller_can_write_company(p_company_id) THEN
      RAISE EXCEPTION 'BOOKING_REVIEW_REVIEWER_DENIED' USING ERRCODE = '42501';
    END IF;
  ELSE
    v_reviewer := p_reviewer_id;
    IF v_reviewer IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.company_members cm
       WHERE cm.company_id = p_company_id
         AND cm.user_id = v_reviewer
         AND cm.role NOT IN ('viewer', 'invoicer')) THEN
      RAISE EXCEPTION 'BOOKING_REVIEW_REVIEWER_DENIED' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- The lock order of commit_journal_entry: the company, then the draft.
  PERFORM public.lock_cash_account_company(p_company_id);
  PERFORM 1 FROM public.journal_entries je
   WHERE je.id = p_entry_id AND je.company_id = p_company_id AND je.status = 'draft'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  v_matches := public.booking_review_entry_matches(p_company_id, p_entry_id);
  IF v_matches <> '[]'::jsonb THEN
    SELECT coalesce(sum(abs(coalesce(t.amount_sek, t.amount))), 0)
      INTO v_amount
      FROM public.journal_entries je
      CROSS JOIN LATERAL jsonb_array_elements(je.bank_booking_context) AS c(item)
      JOIN public.transactions t
        ON t.id = (c.item->>'transaction_id')::uuid
       AND t.company_id = p_company_id
     WHERE je.id = p_entry_id;

    v_limits_set := EXISTS (
      SELECT 1 FROM public.company_attest_limits l
       WHERE l.company_id = p_company_id AND l.scope = 'booking_review');
    IF v_limits_set THEN
      SELECT true, l.max_amount_sek INTO v_limit_found, v_limit
        FROM public.company_attest_limits l
       WHERE l.company_id = p_company_id AND l.scope = 'booking_review' AND l.user_id = v_reviewer;
      IF NOT coalesce(v_limit_found, false) OR (v_limit IS NOT NULL AND v_limit < v_amount) THEN
        RAISE EXCEPTION 'BOOKING_REVIEW_LIMIT: % SEK, limit %', v_amount, coalesce(v_limit::text, 'none')
          USING ERRCODE = '42501',
                DETAIL = jsonb_build_object('amount_sek', v_amount, 'limit_sek', v_limit, 'has_limit', coalesce(v_limit_found, false))::text;
      END IF;
    END IF;

    INSERT INTO public.booking_review_stamps AS s
      (journal_entry_id, company_id, reviewed_by, reviewed_at, amount_sek, limit_sek, rules)
    VALUES (p_entry_id, p_company_id, v_reviewer, now(), v_amount, v_limit, v_matches)
    ON CONFLICT (journal_entry_id) DO UPDATE
      SET reviewed_by = EXCLUDED.reviewed_by,
          reviewed_at = EXCLUDED.reviewed_at,
          amount_sek = EXCLUDED.amount_sek,
          limit_sek = EXCLUDED.limit_sek,
          rules = EXCLUDED.rules;
  END IF;

  RETURN QUERY
    SELECT c.voucher_number
      FROM public.commit_journal_entry(p_company_id, p_entry_id, 'user_accept', p_rubric_version, 'user', p_actor_label) AS c;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_reviewed_journal_entry(uuid, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_reviewed_journal_entry(uuid, uuid, uuid, text, text) TO authenticated, service_role;

-- =============================================================================
-- 5. commit_journal_entry: the last line
-- =============================================================================

CREATE OR REPLACE FUNCTION public.commit_journal_entry(p_company_id uuid, p_entry_id uuid, p_commit_method text DEFAULT NULL::text, p_rubric_version text DEFAULT NULL::text, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
 RETURNS TABLE(voucher_number integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_next integer;
  v_fiscal_period_id uuid;
  v_series text;
  v_entry_user_id uuid;
BEGIN
  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  -- Use the same first lock as cash-account promotion, before the draft row.
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A'), je.user_id
  INTO v_fiscal_period_id, v_series, v_entry_user_id
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  -- Hard blocks (accounted#130, migration 20261031150000): a draft a
  -- booking_review_rules row matches is posted only by a person's reviewed
  -- commit, which stamps it in this same transaction
  -- (commit_reviewed_journal_entry). An API key, an agent, a grant, cron, a
  -- bulk accept, a one click and the SQL posting functions are refused here,
  -- before a voucher number is drawn. Storno, rättelse and imports are never
  -- matched (booking_review_entry_matches).
  IF public.booking_review_entry_matches(p_company_id, p_entry_id) <> '[]'::jsonb
     AND NOT (
       coalesce(p_actor_type, '') = 'user'
       AND p_commit_method IS NOT DISTINCT FROM 'user_accept'
       AND EXISTS (
         SELECT 1 FROM public.booking_review_stamps s
          WHERE s.journal_entry_id = p_entry_id
            AND s.company_id = p_company_id
            AND s.reviewed_at = now()))
  THEN
    RAISE EXCEPTION 'BOOKING_REVIEW_REQUIRED: a booking review rule matches this booking, so a person books it from its review'
      USING ERRCODE = 'P0001', HINT = 'booking_review_required';
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, COALESCE(auth.uid(), v_entry_user_id), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next,
      status = 'posted',
      commit_method = p_commit_method,
      rubric_version = p_rubric_version,
      committed_actor_type = p_actor_type,
      committed_actor_label = p_actor_label
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  -- journal_entry.committed, in the transaction that posts the verifikat
  -- (migration 20261016001100): the event exists exactly when the entry was
  -- posted. Same payload the event-bus handler stores, and the same
  -- dedupe_key, so its later write for this entry is a no-op.
  INSERT INTO public.event_log (user_id, company_id, event_type, entity_id, data, dedupe_key)
  SELECT COALESCE(auth.uid(), v_entry_user_id),
         p_company_id,
         'journal_entry.committed',
         je.id,
         jsonb_build_object(
           'entry',
           to_jsonb(je) || jsonb_build_object(
             'lines',
             COALESCE(
               (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.sort_order, l.created_at, l.id)
                  FROM public.journal_entry_lines l
                 WHERE l.journal_entry_id = je.id),
               '[]'::jsonb
             )
           )
         ),
         'journal_entry.committed:' || je.id::text
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN QUERY SELECT v_next;
END;
$function$
;


-- =============================================================================
-- 6. behandlingshistorik_sources: booking_review_rules is audited
-- =============================================================================

CREATE OR REPLACE FUNCTION public.behandlingshistorik_sources(
  p_company_id uuid,
  p_period_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_fiscal_year boolean
)
RETURNS TABLE (entries json, audit json, audit_outside json, rattelse json)
LANGUAGE plpgsql
STABLE
SET search_path TO ''
SET plan_cache_mode TO 'force_custom_plan'
AS $$
DECLARE
  v_logged_before boolean := false;
  v_logged_after boolean := false;
  v_audit json;
  v_audit_outside json := '[]';
  v_created_inside uuid[];
  v_reversal_refs text[];
  v_guard_states jsonb[];
  v_rattelse json;
  v_rattelse_refs text[];
  v_entry_refs text[] := '{}';
  v_entries json;
BEGIN
  SELECT coalesce(json_agg(a), '[]'::json),
         array_agg(a.new_state->>'reversed_by_id')
           FILTER (WHERE a.action = 'REVERSE' AND a.table_name = 'journal_entries'),
         array_agg(a.new_state) FILTER (WHERE a.action = 'GUARD_BYPASSED')
    INTO v_audit, v_reversal_refs, v_guard_states
    FROM public.audit_log a
   WHERE a.company_id = p_company_id
     AND a.created_at >= p_from
     AND a.created_at <= p_to
     AND (a.table_name = ANY (ARRAY[
            'journal_entries', 'chart_of_accounts', 'company_settings', 'fiscal_periods',
            'api_keys', 'dimensions', 'dimension_values', 'account_dimension_rules',
            'accrual_schedules', 'document_attachments', 'mapping_rules',
            'categorization_templates', 'booking_template_library', 'sie_imports',
            'sie_import_chunks', 'bank_file_imports', 'cash_accounts',
            'invoice_payee_defaults', 'mail_connections', 'collection_connections',
            'service_accounts', 'company_capability_config', 'company_grants',
            'company_grant_settings', 'company_attest_policies', 'company_attest_limits',
            'booking_review_rules'])
          OR a.action = ANY (ARRAY[
            'SECURITY_EVENT', 'INTEGRITY_FAILURE', 'RETENTION_BLOCK',
            'DOCUMENT_DELETE_BLOCKED', 'GUARD_BYPASSED']))
     AND NOT coalesce(
           (a.table_name = 'journal_entries' AND a.action IN ('INSERT', 'COMMIT'))
           OR (a.table_name = 'journal_entries' AND a.action = 'UPDATE'
               AND coalesce(a.old_state->>'status', '') NOT IN ('posted', 'reversed')
               AND coalesce(a.new_state->>'status', '') NOT IN ('posted', 'reversed'))
           OR (a.table_name = 'document_attachments' AND a.action IN ('INSERT', 'UPDATE')),
           false);

  -- Fiscal-year mode, outside the window: rows about the period's verifikat
  -- (a storno or bokslut after year end), bypassed guards naming one (dated
  -- when overridden, which can be after year end), and the receipts of the
  -- SIE chunks that imported them (an older year can be imported today). The
  -- three can meet on a row, so they are made distinct.
  IF p_fiscal_year THEN
    v_logged_before := EXISTS (
      SELECT 1 FROM public.audit_log b WHERE b.company_id = p_company_id AND b.created_at < p_from);
    v_logged_after := EXISTS (
      SELECT 1 FROM public.audit_log b WHERE b.company_id = p_company_id AND b.created_at > p_to);
    IF v_logged_before THEN
      SELECT array_agg(a.record_id)
        INTO v_created_inside
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.created_at >= p_from + interval '1 day'
         AND a.created_at <= p_to
         AND a.table_name = 'journal_entries'
         AND a.action = 'INSERT';
    END IF;

    WITH period_entries AS MATERIALIZED (
      SELECT e.id, e.import_batch_id,
             NOT EXISTS (
               SELECT 1 FROM unnest(coalesce(v_created_inside, '{}'::uuid[])) AS c(id) WHERE c.id = e.id
             ) AS may_predate_window
        FROM public.journal_entries e
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = p_period_id
    ),
    outside_window AS (
      SELECT a.*
        FROM period_entries pe
       CROSS JOIN LATERAL (
         SELECT a.*
           FROM public.audit_log a
          WHERE a.table_name = 'journal_entries'
            AND a.record_id = pe.id
            AND a.company_id = p_company_id
            AND (a.created_at < p_from OR a.created_at > p_to)
            AND NOT coalesce(
                  a.action IN ('INSERT', 'COMMIT')
                  OR (a.action = 'UPDATE'
                      AND coalesce(a.old_state->>'status', '') NOT IN ('posted', 'reversed')
                      AND coalesce(a.new_state->>'status', '') NOT IN ('posted', 'reversed')),
                  false)
       ) a
       WHERE v_logged_after OR (v_logged_before AND pe.may_predate_window)
      UNION ALL
      SELECT a.*
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.action = 'GUARD_BYPASSED'
         AND (a.created_at < p_from OR a.created_at > p_to)
         AND a.new_state->>'journal_entry_id' IN (SELECT pe.id::text FROM period_entries pe)
      UNION ALL
      SELECT a.*
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.table_name = 'sie_import_chunks'
         AND (a.created_at < p_from OR a.created_at > p_to)
         AND a.new_state->>'import_id' IN (
               SELECT pe.import_batch_id::text FROM period_entries pe WHERE pe.import_batch_id IS NOT NULL)
    )
    SELECT coalesce(json_agg(o), '[]'::json)
      INTO v_audit_outside
      FROM (SELECT DISTINCT ON (w.id) w.* FROM outside_window w ORDER BY w.id) o;
  END IF;

  SELECT coalesce(json_agg(r), '[]'::json), array_agg(r.journal_entry_id::text)
    INTO v_rattelse, v_rattelse_refs
    FROM public.journal_entry_rattelse_log r
   WHERE r.company_id = p_company_id
     AND ((r.created_at >= p_from AND r.created_at <= p_to)
          OR (p_fiscal_year AND r.journal_entry_id IN (
                SELECT e.id FROM public.journal_entries e
                 WHERE e.company_id = p_company_id
                   AND e.fiscal_period_id = p_period_id)));

  IF NOT p_fiscal_year THEN
    v_entry_refs := coalesce(v_reversal_refs, '{}') || coalesce(v_rattelse_refs, '{}') || ARRAY(
      SELECT s->>'journal_entry_id'
        FROM unnest(coalesce(v_guard_states, '{}')) s
      UNION ALL
      SELECT c->>'journal_entry_id'
        FROM unnest(coalesce(v_guard_states, '{}')) s
       CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(s->'candidates') = 'array' THEN s->'candidates' ELSE '[]'::jsonb END) c
       WHERE jsonb_typeof(c) = 'object'
    );
  END IF;

  SELECT coalesce(json_agg(t), '[]'::json)
    INTO v_entries
    FROM (
      SELECT e.id, e.voucher_series, e.voucher_number, e.entry_date, e.description, e.source_type,
             e.status, e.committed_at, e.user_id, e.committed_actor_type, e.committed_actor_label,
             e.commit_method, e.reverses_id, e.correction_of_id, e.import_batch_id,
             e.committed_auth_role, e.committed_auth_uid
        FROM public.journal_entries e
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = p_period_id
         AND (p_fiscal_year
              OR (e.committed_at >= p_from AND e.committed_at < p_to + interval '1 millisecond')
              OR e.id::text = ANY (v_entry_refs))
    ) t;

  RETURN QUERY SELECT v_entries, v_audit, v_audit_outside, v_rattelse;
END;
$$;

REVOKE ALL ON FUNCTION public.behandlingshistorik_sources(uuid, uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.behandlingshistorik_sources(uuid, uuid, timestamptz, timestamptz, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
