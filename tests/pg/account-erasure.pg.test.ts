import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod } from './fixtures'

/**
 * Account erasure (migration *_complete_account_erasure.sql).
 *
 * Accounted never deletes auth.users: account deletion keeps the row as a
 * banned tombstone so BFL-retained bookkeeping keeps its foreign keys. No
 * `REFERENCES auth.users ON DELETE CASCADE` therefore ever fires, and personal
 * data is erased only where public.erase_user_personal_data says so. A prod
 * audit on 2026-09-10 found erased users' plaintext personnummer
 * (bankid_enrichment), live PSD2 consents, Skatteverket tokens, assistant
 * conversations, Google profiles and sessions left behind, all in tables that
 * were added after the RPC was written.
 *
 * The first test is the ratchet that stops that recurring: every foreign key
 * from public to auth.users must be classified here, so a new user-keyed table
 * fails CI until someone decides whether account deletion erases it.
 */

/** Removed, or revoked and shredded, by public.erase_user_personal_data. */
const ERASED = new Set([
  // Access and credentials
  'api_keys.user_id',
  'calendar_feeds.user_id',
  'company_members.user_id',
  'oauth_client_registrations.user_id',
  'oauth_flows.user_id',
  'provider_otc.user_id',
  'skatteverket_tokens.user_id',
  'team_members.user_id',
  // Identity
  'bankid_enrichment.user_id',
  'bankid_identities.user_id',
  'profiles.id',
  'whatsapp_link_codes.user_id',
  'whatsapp_phone_links.user_id',
  // Personal settings and per-user operational state
  'agent_rate_counters.user_id',
  'email_change_requests.user_id',
  'extension_toggles.user_id',
  'idempotency_keys.user_id',
  'mcp_tasks.user_id',
  'notice_dismissals.user_id',
  'notification_log.user_id',
  'notification_settings.user_id',
  'push_subscriptions.user_id',
  'sandbox_seed_attempts.user_id',
  'user_preferences.user_id',
  // Conversations
  'agent_conversations.user_id',
  'chat_messages.user_id',
  'chat_sessions.user_id',
  // Consents given for a company: revoked in place, the rows stay
  'bank_connections.user_id',
  'mail_connections.connected_by',
])

/**
 * Company-owned records that outlive the person: bookkeeping and its
 * processing history under BFL 7 kap. 2 §, payroll and filings, company
 * configuration and integrations. The column points at the tombstone id,
 * which carries no personal data once erasure has run.
 */
const RETAINED = new Set([
  // Bookkeeping, documents and their processing history
  'account_reconciliation_attachments.removed_by',
  'account_reconciliation_attachments.uploaded_by',
  'account_reconciliations.reopened_by',
  'account_reconciliations.signed_by',
  'accrual_schedule_installments.user_id',
  'accrual_schedules.user_id',
  'assets.user_id',
  'bank_file_imports.user_id',
  'bokslut_checklist_items.done_by',
  'bokslut_checklist_items.updated_by',
  'chart_of_accounts.user_id',
  'depreciation_schedules.user_id',
  'document_attachments.uploaded_by',
  'document_attachments.user_id',
  'event_log.user_id',
  'fiscal_period_tax_adjustments.user_id',
  'fiscal_periods.user_id',
  'journal_entries.user_id',
  'journal_entry_no_doc_required.user_id',
  'operations.user_id',
  'payment_match_log.user_id',
  'pending_operations.user_id',
  'receipts.user_id',
  'sie_account_mappings.user_id',
  'sie_imports.user_id',
  'skattekonto_file_imports.user_id',
  'transaction_voucher_links.user_id',
  'transactions.user_id',
  'voucher_gap_explanations.user_id',
  'voucher_sequences.user_id',
  // Invoicing, purchasing and sales channels
  'articles.user_id',
  'customers.user_id',
  'invoice_deliveries.user_id',
  'invoice_inbox_items.user_id',
  'invoice_payments.user_id',
  'invoice_reminders.user_id',
  'invoices.user_id',
  'peppol_access.requested_by',
  'peppol_deliveries.user_id',
  'peppol_registrations.user_id',
  'recurring_invoice_schedules.user_id',
  'rot_rut_payout_requests.user_id',
  'sales_orders.user_id',
  'supplier_invoice_payments.user_id',
  'supplier_invoices.user_id',
  'supplier_payment_batches.cancelled_by',
  'supplier_payment_batches.user_id',
  'suppliers.user_id',
  'webshop_orders.manually_booked_by',
  'webshop_orders.user_id',
  // Payroll, expenses and filings
  'agi_declarations.submitted_by',
  'agi_declarations.user_id',
  'employee_benefits.user_id',
  'employee_opening_balances.created_by',
  'employee_opening_balances.updated_by',
  'employee_recurring_lines.user_id',
  'employees.user_id',
  'expense_claims.user_id',
  'expense_payout_batches.user_id',
  'mileage_trips.user_id',
  'salary_payslip_deliveries.user_id',
  'salary_payslip_links.user_id',
  'salary_runs.approved_by',
  'salary_runs.booked_by',
  'salary_runs.user_id',
  'shift_premium_rules.created_by',
  'tax_assessment_notices.user_id',
  'vacation_year_closures.closed_by',
  // Annual reports and Bolagsverket
  'annual_report_profiles.user_id',
  'annual_report_validation_runs.user_id',
  'annual_report_versions.finalized_by',
  'annual_report_versions.user_id',
  'arsredovisning_narratives.user_id',
  'arsredovisning_signature_requests.evidence_recorded_by',
  'arsredovisning_signature_requests.user_id',
  'arsredovisning_submissions.user_id',
  'bolagsverket_avtal_acceptances.user_id',
  'bolagsverket_subscriptions.user_id',
  // Company, team and configuration
  'agent_memory.created_by_user_id',
  'agent_profiles.verified_by_user_id',
  'api_keys.sod_acknowledged_by',
  'booking_template_hidden.hidden_by',
  'booking_template_library.created_by',
  'brand_signup_allowlist.created_by',
  'categorization_templates.user_id',
  'companies.created_by',
  'company_invitations.invited_by',
  'company_members.invited_by',
  'company_settings.user_id',
  'cost_centers.user_id',
  'counterparty_aliases.user_id',
  'deadlines.user_id',
  'extension_data.user_id',
  'mapping_rules.user_id',
  'parties.user_id',
  'party_decisions.user_id',
  'party_facts.user_id',
  'party_identities.user_id',
  'projects.user_id',
  'team_invitations.invited_by',
  'teams.created_by',
  // Company integrations: the company's accounts, not the person's
  'shopify_connections.user_id',
  'skatteverket_company_connections.created_by',
  'stripe_connections.user_id',
  'webshop_store_settings.user_id',
  'woocommerce_connections.user_id',
  'zettle_connections.user_id',
])

/** Erased tables the behavioural test seeds and expects to be emptied for the user. */
const DELETED_FOR_USER = [
  'agent_conversations',
  'agent_rate_counters',
  'bankid_enrichment',
  'bankid_identities',
  'calendar_feeds',
  'chat_messages',
  'chat_sessions',
  'company_members',
  'email_change_requests',
  'extension_toggles',
  'idempotency_keys',
  'mcp_tasks',
  'notice_dismissals',
  'notification_log',
  'notification_settings',
  'oauth_client_registrations',
  'oauth_flows',
  'push_subscriptions',
  'sandbox_seed_attempts',
  'skatteverket_tokens',
  'user_preferences',
] as const

describe('account erasure (pg)', () => {
  it('classifies every foreign key from public to auth.users as erased or retained', async () => {
    const { rows } = await getPool().query<{ fk: string }>(
      `SELECT c.relname || '.' || a.attname AS fk
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN LATERAL unnest(con.conkey) AS k(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       WHERE con.contype = 'f' AND con.confrelid = 'auth.users'::regclass`,
    )
    const actual = new Set(rows.map((r) => r.fk))

    const unclassified = [...actual].filter((fk) => !ERASED.has(fk) && !RETAINED.has(fk)).sort()
    const stale = [...ERASED, ...RETAINED].filter((fk) => !actual.has(fk)).sort()
    const both = [...ERASED].filter((fk) => RETAINED.has(fk))

    expect(
      unclassified,
      'New foreign key to auth.users. Its ON DELETE CASCADE never fires (deleted accounts keep a ' +
        'tombstone auth.users row), so decide: erase it in public.erase_user_personal_data and add ' +
        'it to ERASED, or add it to RETAINED because the company must keep it.',
    ).toEqual([])
    expect(stale, 'Classified foreign key no longer exists: remove it from the list.').toEqual([])
    expect(both).toEqual([])
  })

  it('erase_user_personal_data reaches every table classified as erased', async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_functiondef('public.erase_user_personal_data(uuid)'::regprocedure) AS def`,
    )
    const def = rows[0]!.def
    const missing = [...new Set([...ERASED].map((fk) => fk.split('.')[0]!))].filter(
      (table) => !new RegExp(`public\\.${table}\\b`).test(def),
    )
    expect(missing).toEqual([])
  })

  it('erase_user_personal_data cannot be executed by anon, authenticated or service_role', async () => {
    // It has no auth.uid() check of its own: only anonymize_user_account
    // (after its guards) and the migration role may run it.
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT
         has_function_privilege('anon', 'public.erase_user_personal_data(uuid)', 'EXECUTE') AS anon,
         has_function_privilege('authenticated', 'public.erase_user_personal_data(uuid)', 'EXECUTE') AS authenticated,
         has_function_privilege('service_role', 'public.erase_user_personal_data(uuid)', 'EXECUTE') AS service`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service: false })
  })

  it('erases personal data, revokes consents and keeps company records', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({
      createdBy: userId,
      name: 'Erasure Test EF',
      entityType: 'enskild_firma',
    })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    // Owning only archived companies is what lets a user delete the account.
    await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [companyId])

    await withUserContext(userId, async (client) => {
      // Seed as the session superuser inside the transaction, so every row
      // rolls back with it; then call the RPC as the user.
      await client.query('RESET ROLE')

      await client.query(
        `INSERT INTO public.profiles (id, email, full_name, avatar_url)
         VALUES ($1, $2, 'PG Erasure', 'https://example.test/a.png')
         ON CONFLICT (id) DO UPDATE
           SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, avatar_url = EXCLUDED.avatar_url`,
        [userId, `pg-real-${userId}@test.invalid`],
      )
      await client.query(
        `UPDATE auth.users SET raw_user_meta_data = '{"full_name": "PG Erasure"}'::jsonb WHERE id = $1`,
        [userId],
      )
      // A Google identity whose email is the account address: if identities
      // were deleted after the email is cleared, unlink_old_address_identities
      // would re-insert an email identity for the tombstone.
      await client.query(
        `INSERT INTO auth.identities (id, user_id, provider, provider_id, identity_data, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'google', $2, $3::jsonb, now(), now())`,
        [
          userId,
          `google-${userId}`,
          JSON.stringify({
            sub: `google-${userId}`,
            email: `pg-real-${userId}@test.invalid`,
            full_name: 'PG Erasure',
            avatar_url: 'https://example.test/a.png',
          }),
        ],
      )
      await client.query(`INSERT INTO auth.refresh_tokens (token, user_id, revoked) VALUES ($1, $2, false)`, [
        randomUUID(),
        userId,
      ])
      // GoTrue creates auth.sessions at startup; the pg-real image has none.
      await client.query(
        `CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL)`,
      )
      await client.query(`INSERT INTO auth.sessions (id, user_id) VALUES (gen_random_uuid(), $1)`, [userId])

      await client.query(
        `INSERT INTO public.bankid_identities (user_id, personal_number_hash, personal_number_enc)
         VALUES ($1, $2, '\\x00'::bytea)`,
        [userId, randomUUID()],
      )
      await client.query(`INSERT INTO public.bankid_enrichment (user_id, company_roles) VALUES ($1, $2::jsonb)`, [
        userId,
        JSON.stringify([
          { companyRegistrationNumber: '1900010100000000', legalEntityType: 'Enskild näringsidkare' },
        ]),
      ])
      await client.query(
        `INSERT INTO public.skatteverket_tokens (user_id, company_id, access_token, refresh_token, expires_at)
         VALUES ($1, $2, 'access', 'refresh', now() + interval '1 hour')`,
        [userId, companyId],
      )
      const { rows: conversationRows } = await client.query<{ id: string }>(
        `INSERT INTO public.agent_conversations (company_id, user_id, intent_id)
         VALUES ($1, $2, 'pg-erasure') RETURNING id`,
        [companyId, userId],
      )
      const conversationId = conversationRows[0]!.id
      await client.query(
        `INSERT INTO public.agent_messages (conversation_id, role, content) VALUES ($1, 'user', '{"text": "hej"}'::jsonb)`,
        [conversationId],
      )
      await client.query(
        `INSERT INTO public.agent_rate_counters (user_id, window_kind, window_key) VALUES ($1, 'day', '2026-09-10')`,
        [userId],
      )
      const { rows: chatRows } = await client.query<{ id: string }>(
        `INSERT INTO public.chat_sessions (user_id, company_id) VALUES ($1, $2) RETURNING id`,
        [userId, companyId],
      )
      await client.query(
        `INSERT INTO public.chat_messages (session_id, user_id, role, content, company_id)
         VALUES ($1, $2, 'user', 'hej', $3)`,
        [chatRows[0]!.id, userId, companyId],
      )
      await client.query(
        `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1, 'https://push.example.test/1', 'p256dh', 'auth')`,
        [userId],
      )
      await client.query(`INSERT INTO public.notification_settings (user_id) VALUES ($1)`, [userId])
      await client.query(
        `INSERT INTO public.notification_log (user_id, notification_type, reference_id, days_before)
         VALUES ($1, 'tax_deadline', gen_random_uuid(), 7)`,
        [userId],
      )
      await client.query(
        `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id) VALUES ($1, $2, 'pg-erasure')`,
        [companyId, userId],
      )
      await client.query(
        `INSERT INTO public.email_change_requests (user_id, target_email) VALUES ($1, 'new@example.test')`,
        [userId],
      )
      await client.query(`INSERT INTO public.calendar_feeds (user_id, company_id) VALUES ($1, $2)`, [
        userId,
        companyId,
      ])
      await client.query(
        `INSERT INTO public.oauth_flows (id, kind, company_id, user_id, origin, redirect_uri, expires_at)
         VALUES ($1, 'skatteverket', $2, $3, 'https://app.example.test', 'https://app.example.test/cb', now() + interval '10 minutes')`,
        [randomUUID(), companyId, userId],
      )
      await client.query(
        `INSERT INTO public.oauth_client_registrations (user_id, client_name, redirect_uri)
         VALUES ($1, 'pg-erasure', 'https://client.example.test/cb')`,
        [userId],
      )
      await client.query(
        `INSERT INTO public.idempotency_keys (user_id, company_id, key, request_hash, response_status)
         VALUES ($1, $2, $3, 'hash', 'success')`,
        [userId, companyId, randomUUID()],
      )
      await client.query(`INSERT INTO public.mcp_tasks (company_id, user_id, tool_name) VALUES ($1, $2, 'pg_erasure')`, [
        companyId,
        userId,
      ])
      await client.query(
        `INSERT INTO public.extension_toggles (user_id, sector_slug, extension_slug) VALUES ($1, 'general', 'tic')`,
        [userId],
      )
      await client.query(`INSERT INTO public.sandbox_seed_attempts (user_id, status) VALUES ($1, 'complete')`, [
        userId,
      ])
      await client.query(`INSERT INTO public.user_preferences (user_id) VALUES ($1)`, [userId])
      const { rows: bankRows } = await client.query<{ id: string }>(
        `INSERT INTO public.bank_connections (user_id, company_id, provider, status, session_id, authorization_id, oauth_state, accounts_data)
         VALUES ($1, $2, 'seb-se', 'active', 'session-1', 'authorization-1', 'state-1', '[{"iban": "SE0000000000000000000000"}]'::jsonb)
         RETURNING id`,
        [userId, companyId],
      )
      const { rows: mailRows } = await client.query<{ id: string }>(
        `INSERT INTO public.mail_connections (company_id, provider, email_address, encrypted_refresh_token, encrypted_access_token, connected_by, status)
         VALUES ($1, 'gmail', 'person@example.test', 'enc-refresh', 'enc-access', $2, 'active')
         RETURNING id`,
        [companyId, userId],
      )

      for (const table of DELETED_FOR_USER) {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.${table} WHERE user_id = $1`,
          [userId],
        )
        expect(rows[0]!.n, `seeded ${table}`).toBeGreaterThan(0)
      }

      await client.query('SET LOCAL ROLE authenticated')
      await client.query('SELECT public.anonymize_user_account($1)', [userId])
      await client.query('RESET ROLE')

      for (const table of DELETED_FOR_USER) {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.${table} WHERE user_id = $1`,
          [userId],
        )
        expect(rows[0]!.n, `${table} after erasure`).toBe(0)
      }

      const { rows: messageRows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.agent_messages WHERE conversation_id = $1`,
        [conversationId],
      )
      expect(messageRows[0]!.n).toBe(0)

      const { rows: bank } = await client.query(
        `SELECT status, session_id, authorization_id, oauth_state, accounts_data
         FROM public.bank_connections WHERE id = $1`,
        [bankRows[0]!.id],
      )
      expect(bank[0]).toEqual({
        status: 'revoked',
        session_id: null,
        authorization_id: null,
        oauth_state: null,
        accounts_data: null,
      })

      const { rows: mail } = await client.query<{
        status: string
        email_address: string
        encrypted_refresh_token: string
        encrypted_access_token: string | null
        connected_by: string | null
      }>(
        `SELECT status, email_address, encrypted_refresh_token, encrypted_access_token, connected_by
         FROM public.mail_connections WHERE id = $1`,
        [mailRows[0]!.id],
      )
      expect(mail[0]!.status).toBe('revoked')
      expect(mail[0]!.email_address).not.toContain('person@example.test')
      expect(mail[0]!.encrypted_refresh_token).toBe('')
      expect(mail[0]!.encrypted_access_token).toBeNull()
      expect(mail[0]!.connected_by).toBeNull()

      const { rows: profile } = await client.query(
        `SELECT email, full_name, avatar_url, anonymized_at IS NOT NULL AS anonymized
         FROM public.profiles WHERE id = $1`,
        [userId],
      )
      expect(profile[0]).toEqual({ email: null, full_name: null, avatar_url: null, anonymized: true })

      const { rows: authUser } = await client.query(
        `SELECT email, raw_user_meta_data AS user_meta FROM auth.users WHERE id = $1`,
        [userId],
      )
      expect(authUser[0]).toEqual({ email: null, user_meta: {} })

      const { rows: authLeft } = await client.query<{ identities: number; refresh_tokens: number; sessions: number }>(
        `SELECT
           (SELECT count(*)::int FROM auth.identities WHERE user_id = $1) AS identities,
           (SELECT count(*)::int FROM auth.refresh_tokens WHERE user_id = $1::text) AS refresh_tokens,
           (SELECT count(*)::int FROM auth.sessions WHERE user_id = $1) AS sessions`,
        [userId],
      )
      expect(authLeft[0]).toEqual({ identities: 0, refresh_tokens: 0, sessions: 0 })

      // Company records stay, pointing at the tombstone id.
      const { rows: kept } = await client.query<{ companies: number; fiscal_periods: number }>(
        `SELECT
           (SELECT count(*)::int FROM public.companies WHERE id = $1 AND created_by = $3) AS companies,
           (SELECT count(*)::int FROM public.fiscal_periods WHERE id = $2) AS fiscal_periods`,
        [companyId, fiscalPeriodId, userId],
      )
      expect(kept[0]).toEqual({ companies: 1, fiscal_periods: 1 })

      // The repair pass runs the same function over tombstones that were
      // already anonymized: a second run must be a clean no-op.
      await client.query('SELECT public.erase_user_personal_data($1)', [userId])
      const { rows: again } = await client.query<{ status: string }>(
        `SELECT status FROM public.bank_connections WHERE id = $1`,
        [bankRows[0]!.id],
      )
      expect(again[0]!.status).toBe('revoked')
    })
  })
})
