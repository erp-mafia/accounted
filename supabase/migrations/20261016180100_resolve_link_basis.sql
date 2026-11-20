-- resolve_link_basis: the SQL twin of src/lib/links/stamp.ts, for the SQL
-- functions that write a link (src/lib/links/link-basis.ts).
-- pg-test: tests/pg/link-basis.pg.test.ts
--
-- The application writers stamp link_basis through linkBasisColumns(door):
-- the door names its own basis and the request scope adds who acted. Eight
-- SQL functions write links too and stamped nothing, so every link they made
-- reads "not recorded" (the coverage ratchet in
-- src/lib/links/__tests__/link-basis-coverage.test.ts lists them). This
-- helper gives them the same rule, with the actor the database can see:
--
--   actor  = p_actor_type when the caller passes one (the posting RPCs take it
--            from the application's commit actor), else the transaction-local
--            gnubok.actor_type setting that commit_journal_entry and the other
--            posting paths set; '' and unset mean no actor.
--   door user_confirmed / user_created (a person-shaped door):
--            api_key, mcp_oauth, service_account, agent_chat -> client_asserted
--            cron, system                                    -> system_derived
--            any other actor, or none                        -> the door
--   door rule_ocr_reference, rule_amount_date, rule_counterparty,
--        import_carried_over, system_derived                 -> the door
--   anything else as a door                                  -> NULL
--
-- exactly resolveLinkBasis() without a pending operation (a unit of the
-- pg-real suite compares the two over every door and actor).
--
-- What the database cannot see is the pending-operation approval the
-- application keeps in an AsyncLocalStorage: a SQL writer run inside an
-- approval records the approver's basis (user_* for a person in Accounted,
-- client_asserted for a credential relaying it), where the application
-- writers record agent_proposed_user_approved.
--
-- Never raises and never blocks a booking: plain SQL over its arguments and
-- current_setting(..., missing_ok => true), no table read, and it only ever
-- returns a value every <table>_link_basis_check accepts, or NULL. A garbage
-- actor is "any other actor" and leaves the door's basis.
--
-- SECURITY INVOKER and search_path '': it reads nothing but its arguments and
-- one setting. EXECUTE for authenticated and service_role
-- (relink_stranded_transactions is SECURITY INVOKER and runs as
-- service_role), not PUBLIC or anon.

CREATE OR REPLACE FUNCTION public.resolve_link_basis(p_door text, p_actor_type text DEFAULT NULL::text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_door IS NULL
      OR p_door NOT IN (
        'user_confirmed', 'user_created', 'rule_ocr_reference', 'rule_amount_date',
        'rule_counterparty', 'import_carried_over', 'system_derived'
      ) THEN NULL
    WHEN p_door NOT IN ('user_confirmed', 'user_created') THEN p_door
    WHEN scope.actor IN ('api_key', 'mcp_oauth', 'service_account', 'agent_chat') THEN 'client_asserted'
    WHEN scope.actor IN ('cron', 'system') THEN 'system_derived'
    ELSE p_door
  END
  FROM (
    SELECT COALESCE(
      NULLIF(p_actor_type, ''),
      NULLIF(pg_catalog.current_setting('gnubok.actor_type', true), '')
    ) AS actor
  ) AS scope
$function$;

COMMENT ON FUNCTION public.resolve_link_basis(text, text) IS
  'The link_basis a SQL link writer records: its door basis (user_confirmed, user_created, a rule_* value, import_carried_over or system_derived) resolved against the actor (p_actor_type, else the gnubok.actor_type setting): a person-shaped door becomes client_asserted on a machine credential and system_derived on cron or system. Mirrors resolveLinkBasis in src/lib/links/link-basis.ts without the pending-operation scope. Never raises; NULL for a value outside the door vocabulary (20261016180100).';

REVOKE ALL ON FUNCTION public.resolve_link_basis(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_link_basis(text, text) TO authenticated, service_role;
