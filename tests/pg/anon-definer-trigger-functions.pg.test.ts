import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from '@/tests/pg/setup'

// Pins 20261028041247_revoke_anon_execute_on_definer_trigger_functions.sql.
//
// anon-definer-functions.pg.test.ts holds the non-trigger SECURITY DEFINER
// functions to "no EXECUTE for anon". This file covers the trigger functions
// the advisor still listed after that: EXECUTE revoked from PUBLIC and anon,
// authenticated and service_role kept, the enforcement functions of migration
// 017 left as they were, and (the property the whole migration rests on) a
// trigger whose function a role cannot EXECUTE still fires for that role.

// The 52 trigger functions production listed under lint 0028 on 2026-10-28,
// minus the two enforcement functions. Signatures are all zero-argument.
const REVOKED_FROM_ANON = [
  'api_keys_guard_service_account()',
  'assert_webhook_delivery_company_match()',
  'assign_franvaro_specifikationsnummer()',
  'assign_franvaro_specifikationsnummer_on_update()',
  'audit_service_accounts()',
  'auto_provision_company_inbox()',
  'block_booked_mileage_trip_deletion()',
  'block_sent_invoice_document_deletion()',
  'block_transaction_link_to_opening_balance()',
  'block_webhook_delivery_terminal_delete()',
  'clear_je_suggestions_on_reversal()',
  'clear_sibling_je_suggestions_on_link()',
  'dimension_retag_log_immutable()',
  'enforce_booked_mileage_trip_immutability()',
  'enforce_company_writer_role_via_parent()',
  'enforce_credit_note_total_within_original()',
  'enforce_dimension_registry_guards()',
  'enforce_dimension_value_retention()',
  'enforce_document_metadata_immutability()',
  'enforce_invoice_delivery_immutability()',
  'enforce_invoice_email_recipient_settings_admin()',
  'enforce_operation_immutability()',
  'enforce_sales_order_item_invoiced_qty()',
  'enforce_sales_order_item_quantity_floor()',
  'enforce_webhook_delivery_immutability()',
  'guard_company_sending_domain_tenant_write()',
  'guard_sie_company_lock_date()',
  'handle_new_user()',
  'handoff_sie_replacement()',
  'invoices_converted_source_guard()',
  'invoices_quote_decision_guard()',
  'journal_entry_rattelse_log_immutable()',
  'mark_company_pays_salaries_on_booked_run()',
  'payment_match_log_immutable()',
  'project_sie_operation()',
  'remove_team_member_from_companies()',
  'resync_team_member_role_to_companies()',
  'sales_order_completion_from_invoice_items()',
  'sales_order_completion_from_invoice_status()',
  'sales_order_completion_from_order_items()',
  'sales_orders_source_guard()',
  'seed_byra_team_multi_user()',
  'seed_trial_capability_grants()',
  'service_accounts_guard()',
  'service_accounts_revoke_keys()',
  'set_invoice_delivery_retention_expiry()',
  'signing_signer_audit()',
  'sync_profile_email()',
  'sync_team_member_to_companies()',
  'validate_invoice_delivery_tenant()',
  'write_audit_log()',
  'write_invoice_delivery_audit()',
]

// Migration 017's enforcement functions: deliberately not part of the sweep.
const ENFORCEMENT_KEPT = ['block_document_deletion()', 'enforce_retention_journal_entries()']

interface GrantRow {
  exists: boolean
  anon_can: boolean | null
  public_can: boolean | null
  auth_can: boolean | null
  service_can: boolean | null
}

// Same shape as anon-definer-functions.pg.test.ts: to_regprocedure() so a
// drifted signature fails on `exists`, and PUBLIC read from the ACL itself
// because has_function_privilege() has no PUBLIC pseudo-role.
async function grantsFor(signature: string): Promise<GrantRow> {
  const { rows } = await getPool().query<GrantRow>(
    `SELECT to_regprocedure($1) IS NOT NULL AS exists,
            has_function_privilege('anon', to_regprocedure($1)::oid, 'EXECUTE') AS anon_can,
            EXISTS (
              SELECT 1
                FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE p.oid = to_regprocedure($1)::oid
                 AND a.grantee = 0
                 AND a.privilege_type = 'EXECUTE'
            ) AS public_can,
            has_function_privilege('authenticated', to_regprocedure($1)::oid, 'EXECUTE') AS auth_can,
            has_function_privilege('service_role', to_regprocedure($1)::oid, 'EXECUTE') AS service_can`,
    [`public.${signature}`],
  )
  return rows[0]!
}

// One transaction, always rolled back, so the scratch objects below never
// outlive the test.
async function inRolledBackTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('SECURITY DEFINER trigger functions: anon EXECUTE revoked.pg', () => {
  it.each(REVOKED_FROM_ANON)('%s: anon and PUBLIC revoked, authenticated and service_role kept', async (sig) => {
    const grants = await grantsFor(sig)
    expect(grants.exists).toBe(true)
    expect(grants.anon_can).toBe(false)
    expect(grants.public_can).toBe(false)
    expect(grants.auth_can).toBe(true)
    expect(grants.service_can).toBe(true)
  })

  it.each(ENFORCEMENT_KEPT)('%s: migration 017 function left as it was (anon still holds EXECUTE)', async (sig) => {
    const grants = await grantsFor(sig)
    expect(grants.exists).toBe(true)
    expect(grants.anon_can).toBe(true)
  })

  it('refuses anon a direct call to a revoked trigger function with 42501', async () => {
    // Before the revoke plpgsql answered 0A000 "trigger functions can only be
    // called as triggers"; now the grant refuses it first.
    await inRolledBackTx(async (client) => {
      await client.query('SET LOCAL ROLE anon')
      await expect(client.query('SELECT public.write_audit_log()')).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/permission denied for function write_audit_log/),
      })
    })
  })
})

describe('a trigger fires for a role that cannot EXECUTE its function.pg', () => {
  // The migration is safe only because Postgres checks EXECUTE on a trigger
  // function at CREATE TRIGGER, never when it fires. handle_new_user and
  // sync_profile_email fire as supabase_auth_admin, which held EXECUTE only
  // through PUBLIC; anon-key writes fire triggers as anon. Prove the property
  // on this server with a SECURITY DEFINER trigger function that no API role
  // may execute.
  it.each(['anon', 'authenticated', 'service_role'])('fires for %s', async (role) => {
    await inRolledBackTx(async (client) => {
      await client.query(
        `CREATE TABLE public.zz_t1028_fire_probe (id int, fired boolean NOT NULL DEFAULT false)`,
      )
      await client.query(
        `CREATE FUNCTION public.zz_t1028_fire_probe_set() RETURNS trigger
           LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
           AS $fn$ BEGIN NEW.fired := true; RETURN NEW; END $fn$`,
      )
      await client.query(
        `CREATE TRIGGER zz_t1028_fire_probe_set BEFORE INSERT ON public.zz_t1028_fire_probe
           FOR EACH ROW EXECUTE FUNCTION public.zz_t1028_fire_probe_set()`,
      )
      await client.query(
        `REVOKE EXECUTE ON FUNCTION public.zz_t1028_fire_probe_set()
           FROM PUBLIC, anon, authenticated, service_role`,
      )
      await client.query(`GRANT INSERT, SELECT ON public.zz_t1028_fire_probe TO ${role}`)

      const { rows: probe } = await client.query<{ can: boolean }>(
        `SELECT has_function_privilege($1, 'public.zz_t1028_fire_probe_set()', 'EXECUTE') AS can`,
        [role],
      )
      expect(probe[0]?.can).toBe(false)

      await client.query(`SET LOCAL ROLE ${role}`)
      await client.query(`INSERT INTO public.zz_t1028_fire_probe (id) VALUES (1)`)
      const { rows } = await client.query<{ fired: boolean }>(
        `SELECT fired FROM public.zz_t1028_fire_probe WHERE id = 1`,
      )
      expect(rows).toEqual([{ fired: true }])

      // The same role is refused a direct call: the grant is real.
      await client.query('SAVEPOINT direct_call')
      await expect(client.query('SELECT public.zz_t1028_fire_probe_set()')).rejects.toMatchObject({
        code: '42501',
      })
      await client.query('ROLLBACK TO SAVEPOINT direct_call')
    })
  })
})
