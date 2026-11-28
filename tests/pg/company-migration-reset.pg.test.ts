import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertTransaction,
  seedCompany,
} from './fixtures'

interface RpcResult {
  ok: boolean
  code?: string
  reset_id?: string
  source_company_id?: string
  replacement_company_id?: string
  eligibility?: {
    eligible: boolean
    blockers: Array<{ code: string; count: number }>
    counts: Record<string, number>
  }
  details?: {
    blockers: Array<{ code: string; count: number }>
  }
}

async function preview(userId: string, companyId: string): Promise<RpcResult> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ result: RpcResult }>(
      `SELECT public.get_company_migration_reset_eligibility($1) AS result`,
      [companyId],
    )
    return rows[0]!.result
  })
}

async function execute(
  userId: string,
  companyId: string,
  overrides: Partial<{
    name: string
    reason: string
    noFilings: boolean
    retainedArchive: boolean
  }> = {},
): Promise<RpcResult> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ result: RpcResult }>(
      `SELECT public.reset_company_for_migration($1, $2, $3, $4, $5) AS result`,
      [
        companyId,
        overrides.name ?? 'Test AB',
        overrides.reason ?? 'The first migration used the wrong fiscal periods.',
        overrides.noFilings ?? true,
        overrides.retainedArchive ?? true,
      ],
    )
    return rows[0]!.result
  })
}

describe('company migration reset RPCs (pg)', () => {
  it('exposes only the two owner entry points to authenticated callers', async () => {
    const { rows } = await getPool().query<{
      preview_anon: boolean
      preview_authenticated: boolean
      execute_anon: boolean
      execute_authenticated: boolean
      snapshot_authenticated: boolean
      snapshot_service_role: boolean
    }>(`
      SELECT
        has_function_privilege(
          'anon',
          'public.get_company_migration_reset_eligibility(uuid)',
          'EXECUTE'
        ) AS preview_anon,
        has_function_privilege(
          'authenticated',
          'public.get_company_migration_reset_eligibility(uuid)',
          'EXECUTE'
        ) AS preview_authenticated,
        has_function_privilege(
          'anon',
          'public.reset_company_for_migration(uuid,text,text,boolean,boolean)',
          'EXECUTE'
        ) AS execute_anon,
        has_function_privilege(
          'authenticated',
          'public.reset_company_for_migration(uuid,text,text,boolean,boolean)',
          'EXECUTE'
        ) AS execute_authenticated,
        has_function_privilege(
          'authenticated',
          'public.company_migration_reset_snapshot(uuid)',
          'EXECUTE'
        ) AS snapshot_authenticated,
        has_function_privilege(
          'service_role',
          'public.company_migration_reset_snapshot(uuid)',
          'EXECUTE'
        ) AS snapshot_service_role
    `)

    expect(rows[0]).toEqual({
      preview_anon: false,
      preview_authenticated: true,
      execute_anon: false,
      execute_authenticated: true,
      snapshot_authenticated: false,
      snapshot_service_role: false,
    })
  })

  // 20261012100700 flattened the rename-and-wrap chain into one body per
  // function: none of the renamed layers may linger as a callable path.
  it('keeps no renamed snapshot or reset layer', async () => {
    const legacy = [
      'public.company_migration_reset_snapshot_before_20260818141018(uuid)',
      'public.company_migration_reset_snapshot_before_20260818143004(uuid)',
      'public.company_migration_reset_snapshot_before_20260818224000(uuid)',
      'public.company_migration_reset_snapshot_before_20260818231500(uuid)',
      'public.company_migration_reset_snapshot_before_20260826150000(uuid)',
      'public.company_migration_reset_snapshot_before_20260909100400(uuid)',
      'public.company_migration_reset_snapshot_before_sie_jobs(uuid)',
      'public.company_migration_reset_snapshot_before_20261011203600(uuid)',
      'public.reset_company_for_migration_before_20260909100400(uuid,text,text,boolean,boolean)',
    ]
    const { rows } = await getPool().query<{ signature: string; dropped: boolean }>(
      `SELECT signature, to_regprocedure(signature) IS NULL AS dropped
       FROM unnest($1::text[]) AS signature`,
      [legacy],
    )
    expect(rows).toEqual(legacy.map((signature) => ({ signature, dropped: true })))
  })

  it('denies anon at call time', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(
        client.query(
          `SELECT public.reset_company_for_migration($1, 'Test AB', $2, true, true)`,
          [randomUUID(), 'This is a sufficiently long audit reason.'],
        ),
      ).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('returns not found to outsiders and forbidden to non-owner members', async () => {
    const { companyId } = await seedCompany()
    const outsiderId = await insertAuthUser()
    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })

    await expect(preview(outsiderId, companyId)).resolves.toMatchObject({
      ok: false,
      code: 'COMPANY_RESET_NOT_FOUND',
    })
    await expect(preview(adminId, companyId)).resolves.toMatchObject({
      ok: false,
      code: 'COMPANY_RESET_FORBIDDEN',
    })
    await expect(execute(outsiderId, companyId)).resolves.toMatchObject({
      ok: false,
      code: 'COMPANY_RESET_NOT_FOUND',
    })
    await expect(execute(adminId, companyId)).resolves.toMatchObject({
      ok: false,
      code: 'COMPANY_RESET_FORBIDDEN',
    })
  })

  it('fails closed on locks, filings, live bank sync, and age', async () => {
    const locked = await seedCompany({ isClosed: true })
    const lockedPreview = await preview(locked.userId, locked.companyId)
    expect(lockedPreview.eligibility?.blockers).toContainEqual({
      code: 'locked_or_closed_periods',
      count: 1,
    })

    const filed = await seedCompany()
    await getPool().query(
      `INSERT INTO public.skatteverket_api_audit_log
         (company_id, user_id, endpoint, outcome, response_status)
       VALUES ($1, $2, 'agi/submit', 'ok', 200)`,
      [filed.companyId, filed.userId],
    )
    const filedPreview = await preview(filed.userId, filed.companyId)
    expect(filedPreview.eligibility?.blockers).toContainEqual({
      code: 'authority_submission_detected',
      count: 1,
    })

    const vatFiled = await seedCompany()
    await getPool().query(
      `INSERT INTO public.skatteverket_api_audit_log
         (company_id, user_id, endpoint, outcome, response_status)
       VALUES ($1, $2, 'declaration/submit', 'ok', 200)`,
      [vatFiled.companyId, vatFiled.userId],
    )
    const vatFiledPreview = await preview(vatFiled.userId, vatFiled.companyId)
    expect(vatFiledPreview.eligibility?.blockers).toContainEqual({
      code: 'authority_submission_detected',
      count: 1,
    })

    const vatDraft = await seedCompany()
    await getPool().query(
      `INSERT INTO public.extension_data
         (user_id, company_id, extension_id, key, value)
       VALUES ($1, $2, 'skatteverket', 'submission_202606',
               to_jsonb($3::text))`,
      [
        vatDraft.userId,
        vatDraft.companyId,
        JSON.stringify({ status: 'draft_saved', redovisningsperiod: '202606' }),
      ],
    )
    const vatDraftPreview = await preview(vatDraft.userId, vatDraft.companyId)
    expect(vatDraftPreview.eligibility?.blockers).toContainEqual({
      code: 'authority_submission_detected',
      count: 1,
    })

    const agiPendingSignature = await seedCompany()
    await getPool().query(
      `INSERT INTO public.agi_declarations
         (company_id, user_id, period_year, period_month, xml_content, status,
          individuppgifter)
       VALUES ($1, $2, 2026, 8, '<agd/>', 'pending_signature', '[]'::jsonb)`,
      [agiPendingSignature.companyId, agiPendingSignature.userId],
    )
    await getPool().query(
      `INSERT INTO public.extension_data
         (user_id, company_id, extension_id, key, value)
       VALUES ($1, $2, 'skatteverket', 'agi_submission_2026-08',
               to_jsonb($3::text))`,
      [
        agiPendingSignature.userId,
        agiPendingSignature.companyId,
        JSON.stringify({ status: 'underlag_submitted', period: '2026-08' }),
      ],
    )
    const agiPendingPreview = await preview(
      agiPendingSignature.userId,
      agiPendingSignature.companyId,
    )
    expect(agiPendingPreview.eligibility?.blockers).toContainEqual({
      code: 'authority_submission_detected',
      count: 1,
    })

    const rotRutGenerated = await seedCompany()
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_requests
         (company_id, user_id, deduction_type, name, status, requested_total,
          file_name)
       VALUES ($1, $2, 'rot', 'TESTBEGARAN', 'generated', 1000,
               'rot-begaran.xml')`,
      [rotRutGenerated.companyId, rotRutGenerated.userId],
    )
    const rotRutGeneratedPreview = await preview(
      rotRutGenerated.userId,
      rotRutGenerated.companyId,
    )
    expect(rotRutGeneratedPreview.eligibility?.blockers).toContainEqual({
      code: 'authority_submission_detected',
      count: 1,
    })

    const bankConnected = await seedCompany()
    await getPool().query(
      `INSERT INTO public.bank_connections
         (company_id, user_id, provider, bank_name, status)
       VALUES ($1, $2, 'enable_banking', 'Test Bank', 'active')`,
      [bankConnected.companyId, bankConnected.userId],
    )
    const bankPreview = await preview(bankConnected.userId, bankConnected.companyId)
    expect(bankPreview.eligibility?.blockers).toContainEqual({
      code: 'live_bank_connections',
      count: 1,
    })

    // A bank file import, not a legacy SIE row: since 20260920190300 a
    // sie_imports row without a durable job cannot claim 'pending' (#2566). An
    // unfinished durable SIE job is pinned in lib/import/__tests__/sie-job.pg.test.ts.
    const importing = await seedCompany()
    await getPool().query(
      `INSERT INTO public.bank_file_imports
         (user_id, company_id, filename, file_hash, file_format, status)
       VALUES ($1, $2, 'pending.csv', $3, 'seb', 'pending')`,
      [importing.userId, importing.companyId, randomUUID()],
    )
    const importingPreview = await preview(importing.userId, importing.companyId)
    expect(importingPreview.eligibility?.blockers).toContainEqual({
      code: 'imports_in_progress',
      count: 1,
    })

    const automated = await seedCompany()
    await getPool().query(
      `INSERT INTO public.stripe_connections (company_id, user_id, status)
       VALUES ($1, $2, 'pending')`,
      [automated.companyId, automated.userId],
    )
    const automatedPreview = await preview(automated.userId, automated.companyId)
    expect(automatedPreview.eligibility?.blockers).toContainEqual({
      code: 'active_integrations_or_schedules',
      count: 1,
    })

    // A pending Zettle connection is an integration too (20260909100400 wraps
    // the snapshot instead of re-issuing its body).
    const pos = await seedCompany()
    await getPool().query(
      `INSERT INTO public.zettle_connections (company_id, user_id, status)
       VALUES ($1, $2, 'pending')`,
      [pos.companyId, pos.userId],
    )
    const posPreview = await preview(pos.userId, pos.companyId)
    expect(posPreview.eligibility?.blockers).toContainEqual({
      code: 'active_integrations_or_schedules',
      count: 1,
    })

    // So is a live POS sales connection (20261011203600), and it adds to the
    // same blocker; an ended one does not count.
    await getPool().query(
      `INSERT INTO public.pos_connections
         (company_id, provider, provider_name, venue_ref, venue_name, connection_handle, sync_from)
       VALUES ($1, 'heynow', 'Heynow', 'venue-1', 'Restaurang Test', 'pos_' || repeat('h', 40), '2026-09-30'),
              ($1, 'heynow', 'Heynow', 'venue-2', 'Restaurang Test', 'pos_' || repeat('i', 40), '2026-09-30')`,
      [pos.companyId],
    )
    await getPool().query(
      `UPDATE public.pos_connections
          SET status = 'disconnected', ended_at = now(), connection_handle = NULL
        WHERE company_id = $1 AND venue_ref = 'venue-2'`,
      [pos.companyId],
    )
    expect((await preview(pos.userId, pos.companyId)).eligibility?.blockers).toContainEqual({
      code: 'active_integrations_or_schedules',
      count: 2,
    })
    const tills = await seedCompany()
    await getPool().query(
      `INSERT INTO public.pos_connections
         (company_id, provider, provider_name, venue_ref, venue_name, connection_handle, sync_from)
       VALUES ($1, 'heynow', 'Heynow', 'venue-1', 'Restaurang Test', 'pos_' || repeat('h', 40), '2026-09-30')`,
      [tills.companyId],
    )
    const tillsPreview = await preview(tills.userId, tills.companyId)
    expect(tillsPreview.eligibility?.eligible).toBe(false)
    expect(tillsPreview.eligibility?.blockers).toContainEqual({
      code: 'active_integrations_or_schedules',
      count: 1,
    })

    const busy = await seedCompany()
    await getPool().query(
      `INSERT INTO public.operations (company_id, user_id, operation_type, status)
       VALUES ($1, $2, 'imports.sie', 'queued')`,
      [busy.companyId, busy.userId],
    )
    const busyPreview = await preview(busy.userId, busy.companyId)
    expect(busyPreview.eligibility?.blockers).toContainEqual({
      code: 'background_work_in_progress',
      count: 1,
    })

    const old = await seedCompany()
    await getPool().query(
      `UPDATE public.companies SET created_at = now() - interval '91 days' WHERE id = $1`,
      [old.companyId],
    )
    const oldPreview = await preview(old.userId, old.companyId)
    expect(oldPreview.eligibility?.blockers).toContainEqual({
      code: 'migration_window_expired',
      count: 1,
    })

    // The self-service window is 90 days from creation.
    const recent = await seedCompany()
    await getPool().query(
      `UPDATE public.companies SET created_at = now() - interval '89 days' WHERE id = $1`,
      [recent.companyId],
    )
    const recentPreview = await preview(recent.userId, recent.companyId)
    expect(recentPreview.eligibility?.blockers.map((b) => b.code)).not.toContain(
      'migration_window_expired',
    )
    const { rows: windowRows } = await getPool().query<{ days: number }>(
      `SELECT extract(day FROM (public.company_migration_reset_snapshot($1)->>'window_ends_at')::timestamptz - created_at)::int AS days
       FROM public.companies WHERE id = $1`,
      [recent.companyId],
    )
    expect(windowRows[0]!.days).toBe(90)

    const sandbox = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings
         (user_id, company_id, entity_type, company_name, is_sandbox)
       VALUES ($1, $2, 'aktiebolag', 'Sandbox AB', true)`,
      [sandbox.userId, sandbox.companyId],
    )
    const sandboxPreview = await preview(sandbox.userId, sandbox.companyId)
    expect(sandboxPreview.eligibility?.blockers).toContainEqual({
      code: 'sandbox_company',
      count: 1,
    })
  })

  // The preview lists blockers in a fixed order and the UI renders them in
  // that order, so the order is part of the contract. Three fixtures raise
  // several blockers at once: one with every counted blocker (Zettle and POS
  // folded into the integrations count), one with the two late appends (a
  // Zettle-only integration after the authority blocker, and a durable SIE
  // job that replaces the counted import blocker with a count-less one at the
  // end), and one where a POS-only integration comes after even that.
  it('lists combined blockers in a fixed order', async () => {
    const all = await seedCompany()
    await insertDraftJournalEntry({
      ...all,
      status: 'posted',
      sourceType: 'manual',
      voucherSeries: 'A',
      voucherNumber: 1,
    })
    await getPool().query(
      `INSERT INTO public.invoices
         (user_id, company_id, invoice_number, invoice_date, due_date, status)
       VALUES ($1, $2, 1, '2026-08-01', '2026-08-31', 'sent')`,
      [all.userId, all.companyId],
    )
    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
      [all.fiscalPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.company_settings
         (user_id, company_id, entity_type, company_name, is_sandbox)
       VALUES ($1, $2, 'aktiebolag', 'Sandbox AB', true)`,
      [all.userId, all.companyId],
    )
    await getPool().query(
      `INSERT INTO public.bank_connections
         (company_id, user_id, provider, bank_name, status)
       VALUES ($1, $2, 'enable_banking', 'Test Bank', 'active')`,
      [all.companyId, all.userId],
    )
    await getPool().query(
      `INSERT INTO public.bank_file_imports
         (user_id, company_id, filename, file_hash, file_format, status)
       VALUES ($1, $2, 'pending.csv', $3, 'seb', 'pending')`,
      [all.userId, all.companyId, randomUUID()],
    )
    await getPool().query(
      `INSERT INTO public.stripe_connections (company_id, user_id, status)
       VALUES ($1, $2, 'pending')`,
      [all.companyId, all.userId],
    )
    await getPool().query(
      `INSERT INTO public.zettle_connections (company_id, user_id, status)
       VALUES ($1, $2, 'pending')`,
      [all.companyId, all.userId],
    )
    await getPool().query(
      `INSERT INTO public.pos_connections
         (company_id, provider, provider_name, venue_ref, venue_name, connection_handle, sync_from)
       VALUES ($1, 'heynow', 'Heynow', 'venue-1', 'Restaurang Test', 'pos_' || repeat('h', 40), '2026-09-30')`,
      [all.companyId],
    )
    await getPool().query(
      `INSERT INTO public.operations (company_id, user_id, operation_type, status)
       VALUES ($1, $2, 'imports.sie', 'queued')`,
      [all.companyId, all.userId],
    )
    // Five authority evidence sources, one each: an AGI submit, a direct VAT
    // submit for another period, an unlogged VAT draft, an AGI awaiting
    // signature (row and cache are one workflow) and a generated ROT file.
    await getPool().query(
      `INSERT INTO public.skatteverket_api_audit_log
         (company_id, user_id, endpoint, outcome, response_status, redovisningsperiod)
       VALUES ($1, $2, 'agi/submit', 'ok', 200, NULL),
              ($1, $2, 'declaration/submit', 'ok', 200, '202605')`,
      [all.companyId, all.userId],
    )
    await getPool().query(
      `INSERT INTO public.extension_data
         (user_id, company_id, extension_id, key, value)
       VALUES ($1, $2, 'skatteverket', 'submission_202606', to_jsonb('{}'::text)),
              ($1, $2, 'skatteverket', 'agi_submission_2026-08', to_jsonb('{}'::text))`,
      [all.userId, all.companyId],
    )
    await getPool().query(
      `INSERT INTO public.agi_declarations
         (company_id, user_id, period_year, period_month, xml_content, status,
          individuppgifter)
       VALUES ($1, $2, 2026, 8, '<agd/>', 'pending_signature', '[]'::jsonb)`,
      [all.companyId, all.userId],
    )
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_requests
         (company_id, user_id, deduction_type, name, status, requested_total,
          file_name)
       VALUES ($1, $2, 'rot', 'TESTBEGARAN', 'generated', 1000,
               'rot-begaran.xml')`,
      [all.companyId, all.userId],
    )
    await getPool().query(
      `UPDATE public.companies
       SET created_at = now() - interval '91 days', archived_at = now()
       WHERE id = $1`,
      [all.companyId],
    )

    const allPreview = await preview(all.userId, all.companyId)
    expect(allPreview.eligibility?.eligible).toBe(false)
    expect(allPreview.eligibility?.blockers).toEqual([
      { code: 'company_already_archived', count: 1 },
      { code: 'migration_window_expired', count: 1 },
      { code: 'sandbox_company', count: 1 },
      { code: 'locked_or_closed_periods', count: 1 },
      { code: 'live_bank_connections', count: 1 },
      { code: 'imports_in_progress', count: 1 },
      { code: 'active_integrations_or_schedules', count: 3 },
      { code: 'background_work_in_progress', count: 1 },
      { code: 'authority_submission_detected', count: 5 },
    ])

    const late = await seedCompany()
    await getPool().query(
      `INSERT INTO public.bank_connections
         (company_id, user_id, provider, bank_name, status)
       VALUES ($1, $2, 'enable_banking', 'Test Bank', 'active')`,
      [late.companyId, late.userId],
    )
    await getPool().query(
      `INSERT INTO public.bank_file_imports
         (user_id, company_id, filename, file_hash, file_format, status)
       VALUES ($1, $2, 'pending.csv', $3, 'seb', 'pending')`,
      [late.userId, late.companyId, randomUUID()],
    )
    await getPool().query(
      `INSERT INTO public.zettle_connections (company_id, user_id, status)
       VALUES ($1, $2, 'pending')`,
      [late.companyId, late.userId],
    )
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_requests
         (company_id, user_id, deduction_type, name, status, requested_total,
          file_name)
       VALUES ($1, $2, 'rot', 'TESTBEGARAN', 'generated', 1000,
               'rot-begaran.xml')`,
      [late.companyId, late.userId],
    )
    // A running durable SIE job (its operations projection is background
    // work too).
    await getPool().query(
      `INSERT INTO public.sie_imports
         (user_id, company_id, filename, file_hash, sie_type, status,
          job_state, job_phase)
       VALUES ($1, $2, 'running.se', $3, 4, 'pending', 'running', 'vouchers')`,
      [late.userId, late.companyId, randomUUID()],
    )

    const latePreview = await preview(late.userId, late.companyId)
    expect(latePreview.eligibility?.eligible).toBe(false)
    expect(latePreview.eligibility?.blockers).toEqual([
      { code: 'live_bank_connections', count: 1 },
      { code: 'background_work_in_progress', count: 1 },
      { code: 'authority_submission_detected', count: 1 },
      { code: 'active_integrations_or_schedules', count: 1 },
      { code: 'imports_in_progress' },
    ])

    // A POS connection with no other integration is appended last
    // (20261011203600), after the count-less durable import blocker.
    const tills = await seedCompany()
    await getPool().query(
      `INSERT INTO public.bank_connections
         (company_id, user_id, provider, bank_name, status)
       VALUES ($1, $2, 'enable_banking', 'Test Bank', 'active')`,
      [tills.companyId, tills.userId],
    )
    await getPool().query(
      `INSERT INTO public.pos_connections
         (company_id, provider, provider_name, venue_ref, venue_name, connection_handle, sync_from)
       VALUES ($1, 'heynow', 'Heynow', 'venue-1', 'Restaurang Test', 'pos_' || repeat('h', 40), '2026-09-30'),
              ($1, 'heynow', 'Heynow', 'venue-2', 'Restaurang Test', 'pos_' || repeat('i', 40), '2026-09-30')`,
      [tills.companyId],
    )
    await getPool().query(
      `INSERT INTO public.rot_rut_payout_requests
         (company_id, user_id, deduction_type, name, status, requested_total,
          file_name)
       VALUES ($1, $2, 'rot', 'TESTBEGARAN', 'generated', 1000,
               'rot-begaran.xml')`,
      [tills.companyId, tills.userId],
    )
    await getPool().query(
      `INSERT INTO public.sie_imports
         (user_id, company_id, filename, file_hash, sie_type, status,
          job_state, job_phase)
       VALUES ($1, $2, 'running.se', $3, 4, 'pending', 'running', 'vouchers')`,
      [tills.userId, tills.companyId, randomUUID()],
    )

    const tillsPreview = await preview(tills.userId, tills.companyId)
    expect(tillsPreview.eligibility?.eligible).toBe(false)
    expect(tillsPreview.eligibility?.blockers).toEqual([
      { code: 'live_bank_connections', count: 1 },
      { code: 'background_work_in_progress', count: 1 },
      { code: 'authority_submission_detected', count: 1 },
      { code: 'imports_in_progress' },
      { code: 'active_integrations_or_schedules', count: 2 },
    ])
  })

  // Journal entries, voucher sequences, and linked documents are retained
  // data, not blockers (20260826150000). The reset must leave every one of
  // them on the write-closed source and give the replacement a fresh voucher
  // namespace.
  it('retains drafts, postings, linked documents, and voucher sequence state instead of blocking', async () => {
    const draft = await seedCompany()
    await insertDraftJournalEntry({
      ...draft,
      status: 'draft',
      sourceType: 'manual',
    })
    const draftPreview = await preview(draft.userId, draft.companyId)
    expect(draftPreview.eligibility?.eligible).toBe(true)
    expect(draftPreview.eligibility?.blockers).toEqual([])
    expect(draftPreview.eligibility?.counts.journal_entries).toBe(1)

    const imported = await seedCompany()
    const importEntryId = await insertDraftJournalEntry({
      ...imported,
      status: 'posted',
      sourceType: 'import',
      voucherSeries: 'A',
      voucherNumber: 40,
    })
    const manualEntryId = await insertDraftJournalEntry({
      ...imported,
      status: 'posted',
      sourceType: 'manual',
      voucherSeries: 'A',
      voucherNumber: 41,
    })
    const documentId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, storage_path, file_name, sha256_hash,
          upload_source, journal_entry_id)
       VALUES ($1, $2, $3, $4, 'posted-underlag.pdf', $5, 'file_upload', $6)`,
      [
        documentId,
        imported.userId,
        imported.companyId,
        `${imported.companyId}/posted-underlag.pdf`,
        'b'.repeat(64),
        importEntryId,
      ],
    )
    await getPool().query(
      `INSERT INTO public.voucher_sequences
         (user_id, company_id, fiscal_period_id, voucher_series, last_number)
       VALUES ($1, $2, $3, 'A', 41)`,
      [imported.userId, imported.companyId, imported.fiscalPeriodId],
    )

    const importedPreview = await preview(imported.userId, imported.companyId)
    expect(importedPreview.eligibility?.eligible).toBe(true)
    expect(importedPreview.eligibility?.blockers).toEqual([])
    expect(importedPreview.eligibility?.counts).toMatchObject({
      journal_entries: 2,
      committed_import_entries: 1,
      voucher_sequences: 1,
      documents: 1,
    })

    // withUserContext rolls back, so the post-reset state is read inside the
    // same transaction, mirroring the atomic archive-and-replace test below.
    await withUserContext(imported.userId, async (client) => {
      const { rows } = await client.query<{ result: RpcResult }>(
        `SELECT public.reset_company_for_migration($1, $2, $3, true, true) AS result`,
        [imported.companyId, 'Test AB', 'The fiscal years were imported in the wrong order.'],
      )
      const result = rows[0]!.result
      expect(result).toMatchObject({ ok: true, source_company_id: imported.companyId })
      const replacementId = result.replacement_company_id!
      await client.query('RESET ROLE')

      const retained = await client.query<{
        source_archived: boolean
        import_entry_exists: boolean
        manual_entry_exists: boolean
        linked_document_exists: boolean
        sequence_last_number: number
        recorded_journal_entries: number
        replacement_entries: number
        replacement_sequences: number
      }>(
        `SELECT
           (SELECT archived_at IS NOT NULL FROM public.companies WHERE id = $1) AS source_archived,
           EXISTS (
             SELECT 1 FROM public.journal_entries
             WHERE id = $2 AND company_id = $1 AND status = 'posted'
           ) AS import_entry_exists,
           EXISTS (
             SELECT 1 FROM public.journal_entries
             WHERE id = $3 AND company_id = $1 AND status = 'posted'
           ) AS manual_entry_exists,
           EXISTS (
             SELECT 1 FROM public.document_attachments
             WHERE id = $4 AND company_id = $1 AND journal_entry_id = $2
           ) AS linked_document_exists,
           (SELECT last_number::int FROM public.voucher_sequences
            WHERE company_id = $1 AND voucher_series = 'A') AS sequence_last_number,
           (SELECT (source_counts ->> 'journal_entries')::int
            FROM public.company_migration_resets
            WHERE source_company_id = $1) AS recorded_journal_entries,
           (SELECT count(*)::int FROM public.journal_entries
            WHERE company_id = $5) AS replacement_entries,
           (SELECT count(*)::int FROM public.voucher_sequences
            WHERE company_id = $5) AS replacement_sequences`,
        [imported.companyId, importEntryId, manualEntryId, documentId, replacementId],
      )
      expect(retained.rows[0]).toEqual({
        source_archived: true,
        import_entry_exists: true,
        manual_entry_exists: true,
        linked_document_exists: true,
        sequence_last_number: 41,
        recorded_journal_entries: 2,
        replacement_entries: 0,
        replacement_sequences: 0,
      })
    })
  })

  it('retains customer and supplier invoice records instead of blocking', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.invoices
         (user_id, company_id, invoice_number, invoice_date, due_date, status)
       VALUES ($1, $2, 1, '2026-08-01', '2026-08-31', 'sent')`,
      [userId, companyId],
    )
    const supplierId = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name)
       VALUES ($1, $2, $3, 'Leverantor AB')`,
      [supplierId, userId, companyId],
    )
    await getPool().query(
      `INSERT INTO public.supplier_invoices
         (user_id, company_id, supplier_id, arrival_number,
          supplier_invoice_number, invoice_date, due_date)
       VALUES ($1, $2, $3, 1, 'SUP-1', '2026-08-01', '2026-08-31')`,
      [userId, companyId, supplierId],
    )

    const invoicePreview = await preview(userId, companyId)
    expect(invoicePreview.eligibility?.eligible).toBe(true)
    expect(invoicePreview.eligibility?.blockers).toEqual([])
    expect(invoicePreview.eligibility?.counts).toMatchObject({
      invoices: 1,
      supplier_invoices: 1,
      suppliers: 1,
    })

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: RpcResult }>(
        `SELECT public.reset_company_for_migration($1, $2, $3, true, true) AS result`,
        [companyId, 'Test AB', 'The invoice import mapped the wrong accounts.'],
      )
      const result = rows[0]!.result
      expect(result).toMatchObject({ ok: true, source_company_id: companyId })
      const replacementId = result.replacement_company_id!
      await client.query('RESET ROLE')

      const retained = await client.query<{
        source_archived: boolean
        source_invoices: number
        source_supplier_invoices: number
        replacement_invoices: number
        replacement_supplier_invoices: number
        replacement_suppliers: number
      }>(
        `SELECT
           (SELECT archived_at IS NOT NULL FROM public.companies WHERE id = $1) AS source_archived,
           (SELECT count(*)::int FROM public.invoices WHERE company_id = $1) AS source_invoices,
           (SELECT count(*)::int FROM public.supplier_invoices WHERE company_id = $1) AS source_supplier_invoices,
           (SELECT count(*)::int FROM public.invoices WHERE company_id = $2) AS replacement_invoices,
           (SELECT count(*)::int FROM public.supplier_invoices WHERE company_id = $2) AS replacement_supplier_invoices,
           (SELECT count(*)::int FROM public.suppliers WHERE company_id = $2) AS replacement_suppliers`,
        [companyId, replacementId],
      )
      expect(retained.rows[0]).toEqual({
        source_archived: true,
        source_invoices: 1,
        source_supplier_invoices: 1,
        replacement_invoices: 0,
        replacement_supplier_invoices: 0,
        replacement_suppliers: 0,
      })
    })
  })

  it('write-closes retained filing and connection evidence after reset', async () => {
    const fixture = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, company_name)
       VALUES ($1, $2, 'Test AB')`,
      [fixture.userId, fixture.companyId],
    )
    const salaryRunId = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_runs
         (id, company_id, user_id, period_year, period_month, payment_date)
       VALUES ($1, $2, $3, 2026, 8, '2026-08-25')`,
      [salaryRunId, fixture.companyId, fixture.userId],
    )

    await withUserContext(fixture.userId, async (client) => {
      const { rows: resetRows } = await client.query<{ result: RpcResult }>(
        `SELECT public.reset_company_for_migration($1, $2, $3, true, true) AS result`,
        [fixture.companyId, 'Test AB', 'The first migration used the wrong fiscal periods.'],
      )
      const result = resetRows[0]!.result
      expect(result.ok).toBe(true)
      const replacementId = result.replacement_company_id!

      // Keep the reset and guard probes in one transaction. withUserContext
      // rolls back on return, so probing through a separate pool connection
      // would observe the pre-reset state instead of the retained archive.
      await client.query('SET LOCAL ROLE postgres')
      const resetLink = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM public.company_migration_resets
         WHERE source_company_id = $1 AND replacement_company_id = $2`,
        [fixture.companyId, replacementId],
      )
      expect(resetLink.rows[0]!.n).toBe(1)

      await client.query('SAVEPOINT immutable_salary_run')
      await expect(
        client.query(`UPDATE public.salary_runs SET status = 'review' WHERE id = $1`, [
          salaryRunId,
        ]),
      ).rejects.toThrow(/source records are immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT immutable_salary_run')

      await client.query('SAVEPOINT immutable_company_settings')
      await expect(
        client.query(
          `UPDATE public.company_settings SET company_name = 'Changed'
           WHERE company_id = $1`,
          [fixture.companyId],
        ),
      ).rejects.toThrow(/source records are immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT immutable_company_settings')

      await client.query('SAVEPOINT immutable_source_company')
      await expect(
        client.query(`UPDATE public.companies SET name = 'Changed' WHERE id = $1`, [
          fixture.companyId,
        ]),
      ).rejects.toThrow(/source company is immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT immutable_source_company')

      const replacementSalaryRunId = randomUUID()
      await client.query(
        `INSERT INTO public.salary_runs
           (id, company_id, user_id, period_year, period_month, payment_date)
         VALUES ($1, $2, $3, 2026, 9, '2026-09-25')`,
        [replacementSalaryRunId, replacementId, fixture.userId],
      )
      await client.query('SAVEPOINT reject_move_into_source')
      await expect(
        client.query(`UPDATE public.salary_runs SET company_id = $1 WHERE id = $2`, [
          fixture.companyId,
          replacementSalaryRunId,
        ]),
      ).rejects.toThrow(/source records are immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT reject_move_into_source')

      await client.query('SAVEPOINT reject_source_authority_audit')
      await expect(
        client.query(
          `INSERT INTO public.skatteverket_api_audit_log
             (company_id, user_id, endpoint, outcome, response_status)
           VALUES ($1, $2, 'declaration/validate', 'ok', 200)`,
          [fixture.companyId, fixture.userId],
        ),
      ).rejects.toThrow(/source records are immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT reject_source_authority_audit')

      await client.query('SAVEPOINT reject_source_vat_state')
      await expect(
        client.query(
          `INSERT INTO public.extension_data
             (user_id, company_id, extension_id, key, value)
           VALUES ($1, $2, 'skatteverket', 'submission_202606',
                   to_jsonb($3::text))`,
          [
            fixture.userId,
            fixture.companyId,
            JSON.stringify({ status: 'draft_locked', redovisningsperiod: '202606' }),
          ],
        ),
      ).rejects.toThrow(/source authority workflow state is immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT reject_source_vat_state')

      await client.query('SAVEPOINT reject_source_agi_state')
      await expect(
        client.query(
          `INSERT INTO public.extension_data
             (user_id, company_id, extension_id, key, value)
           VALUES ($1, $2, 'skatteverket', 'agi_submission_2026-08',
                   to_jsonb($3::text))`,
          [
            fixture.userId,
            fixture.companyId,
            JSON.stringify({ status: 'underlag_submitted', period: '2026-08' }),
          ],
        ),
      ).rejects.toThrow(/source authority workflow state is immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT reject_source_agi_state')

      const guardedTables = [
        'agi_declarations',
        'arsredovisning_submissions',
        'bank_connections',
        'company_settings',
        'rot_rut_payout_requests',
        'salary_line_items',
        'salary_payment_files',
        'salary_run_employees',
        'salary_runs',
        'skatteverket_api_audit_log',
      ]
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT c.relname AS table_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND NOT t.tgisinternal
           AND t.tgname = left(
             c.relname || '_block_migration_reset_source_mutation',
             63
           )
           AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [guardedTables],
      )
      expect(rows.map((row) => row.table_name)).toEqual(guardedTables)
    })
  })

  it('does not archive or create anything when execution is ineligible', async () => {
    const fixture = await seedCompany({ isClosed: true })
    const before = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.companies WHERE created_by = $1`,
      [fixture.userId],
    )

    const result = await execute(fixture.userId, fixture.companyId)
    expect(result).toMatchObject({ ok: false, code: 'COMPANY_RESET_INELIGIBLE' })

    const source = await getPool().query<{ archived_at: string | null }>(
      `SELECT archived_at FROM public.companies WHERE id = $1`,
      [fixture.companyId],
    )
    const after = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.companies WHERE created_by = $1`,
      [fixture.userId],
    )
    const resets = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM public.company_migration_resets
       WHERE source_company_id = $1`,
      [fixture.companyId],
    )

    expect(source.rows[0]!.archived_at).toBeNull()
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n)
    expect(resets.rows[0]!.n).toBe(0)
  })

  it('rolls back the archive and replacement when an audit write fails', async () => {
    const fixture = await seedCompany()
    const before = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.companies WHERE created_by = $1`,
      [fixture.userId],
    )

    await getPool().query(`
      CREATE OR REPLACE FUNCTION public.pg_test_fail_company_reset_audit()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'forced reset audit failure';
      END;
      $function$;

      DROP TRIGGER IF EXISTS pg_test_fail_company_reset_audit
        ON public.company_migration_resets;
      CREATE TRIGGER pg_test_fail_company_reset_audit
        BEFORE INSERT ON public.company_migration_resets
        FOR EACH ROW EXECUTE FUNCTION public.pg_test_fail_company_reset_audit();
    `)

    try {
      await expect(execute(fixture.userId, fixture.companyId)).rejects.toThrow(
        /forced reset audit failure/i,
      )

      const source = await getPool().query<{ archived_at: string | null }>(
        `SELECT archived_at FROM public.companies WHERE id = $1`,
        [fixture.companyId],
      )
      const after = await getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.companies WHERE created_by = $1`,
        [fixture.userId],
      )
      const resets = await getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM public.company_migration_resets
         WHERE source_company_id = $1`,
        [fixture.companyId],
      )

      expect(source.rows[0]!.archived_at).toBeNull()
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n)
      expect(resets.rows[0]!.n).toBe(0)
    } finally {
      await getPool().query(`
        DROP TRIGGER IF EXISTS pg_test_fail_company_reset_audit
          ON public.company_migration_resets;
        DROP FUNCTION IF EXISTS public.pg_test_fail_company_reset_audit();
      `)
    }
  })

  it('moves the invoice sending domain to the replacement with its verification intact (crm#1288)', async () => {
    const { userId, companyId } = await seedCompany()
    const domain = `reset-${randomUUID().slice(0, 8)}.example`
    const resendDomainId = `rd_${randomUUID()}`
    const seeded = await getPool().query<{ id: string; verified_at: string }>(
      `INSERT INTO public.company_sending_domains
         (company_id, domain, status, sender_local_part, resend_domain_id, dns_records,
          verified_at, last_checked_at)
       VALUES ($1, $2, 'verified', 'ekonomi', $3, '[{"record":"DKIM"}]'::jsonb, now(), now())
       RETURNING id, verified_at::text`,
      [companyId, domain, resendDomainId],
    )
    const row = seeded.rows[0]!

    // The reset runs under the owner's tenant JWT claims, so the sending-domain
    // tenant guard is live for the move (20261018134300).
    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: RpcResult }>(
        `SELECT public.reset_company_for_migration($1, $2, $3, true, true) AS result`,
        [companyId, 'Test AB', 'The first migration used the wrong fiscal periods.'],
      )
      const result = rows[0]!.result
      expect(result.ok).toBe(true)
      const replacementId = result.replacement_company_id!
      await client.query('RESET ROLE')

      const moved = await client.query(
        `SELECT id, company_id::text, status, sender_local_part, resend_domain_id, dns_records,
                verified_at::text
         FROM public.company_sending_domains
         WHERE domain = $1`,
        [domain],
      )
      expect(moved.rows).toEqual([
        {
          id: row.id,
          company_id: replacementId,
          status: 'verified',
          sender_local_part: 'ekonomi',
          resend_domain_id: resendDomainId,
          dns_records: [{ record: 'DKIM' }],
          verified_at: row.verified_at,
        },
      ])

      const snapshot = await client.query<{ n: number }>(
        `SELECT (confirmation_snapshot ->> 'sending_domains_transferred')::int AS n
         FROM public.company_migration_resets
         WHERE id = $1`,
        [result.reset_id],
      )
      expect(snapshot.rows[0]!.n).toBe(1)

      // Only the recorded source -> replacement direction passes the guard:
      // moving it back under the same tenant claims is refused.
      await client.query('SAVEPOINT sending_domain_back_to_source')
      await expect(
        client.query(`UPDATE public.company_sending_domains SET company_id = $1 WHERE domain = $2`, [
          companyId,
          domain,
        ]),
      ).rejects.toThrow(/server-managed/)
      await client.query('ROLLBACK TO SAVEPOINT sending_domain_back_to_source')
    })
  })

  it('records zero sending domains transferred for a company without one', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: RpcResult }>(
        `SELECT public.reset_company_for_migration($1, $2, $3, true, true) AS result`,
        [companyId, 'Test AB', 'The first migration used the wrong fiscal periods.'],
      )
      const result = rows[0]!.result
      expect(result.ok).toBe(true)
      await client.query('RESET ROLE')
      const snapshot = await client.query<{ n: number }>(
        `SELECT (confirmation_snapshot ->> 'sending_domains_transferred')::int AS n
         FROM public.company_migration_resets
         WHERE id = $1`,
        [result.reset_id],
      )
      expect(snapshot.rows[0]!.n).toBe(0)
    })
  })

  it('requires the exact display name, audit reason, and both attestations', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings
         (user_id, company_id, entity_type, company_name, org_number, onboarding_complete)
       VALUES ($1, $2, 'aktiebolag', 'Visat Namn AB', '5590000000', true)`,
      [userId, companyId],
    )

    await expect(execute(userId, companyId)).resolves.toMatchObject({
      ok: false,
      code: 'COMPANY_RESET_CONFIRMATION_MISMATCH',
    })
    await expect(execute(userId, companyId, {
      name: 'Visat Namn AB',
      reason: 'Too short',
    })).resolves.toMatchObject({ ok: false, code: 'COMPANY_RESET_REASON_INVALID' })
    await expect(execute(userId, companyId, {
      name: 'Visat Namn AB',
      noFilings: false,
    })).resolves.toMatchObject({ ok: false, code: 'COMPANY_RESET_CONFIRMATION_REQUIRED' })
    await expect(execute(userId, companyId, {
      name: 'Visat Namn AB',
      retainedArchive: false,
    })).resolves.toMatchObject({ ok: false, code: 'COMPANY_RESET_CONFIRMATION_REQUIRED' })
  })

  it('atomically archives and replaces while retaining every source record unchanged', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const memberId = await insertAuthUser()
    const lateMemberId = await insertAuthUser()
    const lateTeamMemberId = await insertAuthUser()
    const teamId = randomUUID()
    await getPool().query(
      `INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Test team', $2)`,
      [teamId, userId],
    )
    await getPool().query(
      `INSERT INTO public.team_members (team_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [teamId, userId],
    )
    await getPool().query(`UPDATE public.companies SET team_id = $1 WHERE id = $2`, [
      teamId,
      companyId,
    ])
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    await getPool().query(
      `UPDATE public.company_members SET source = 'team'
       WHERE company_id = $1 AND user_id = $2`,
      [companyId, memberId],
    )
    await getPool().query(
      `INSERT INTO public.company_settings
         (user_id, company_id, entity_type, company_name, org_number,
          onboarding_complete, onboarding_step, next_invoice_number, next_arrival_number,
          initial_setup_path, initial_setup_completed_at)
       VALUES ($1, $2, 'aktiebolag', 'Migration AB', '5590000001', true, 4, 41, 17,
               'migration', now())`,
      [userId, companyId],
    )
    // The replacement is the same legal entity. Values above 1 pin that the
    // invoice and arrival-number series continue rather than silently restart.
    // onboarding_complete / onboarding_step 4 is what company creation writes:
    // the source here is an onboarded company that finished its setup checklist.
    const sieImportId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type, status)
       VALUES ($1, $2, $3, 'migration.se', $4, 4, 'completed')`,
      [sieImportId, userId, companyId, randomUUID()],
    )

    const transactionId = await insertTransaction({ companyId, userId })
    const documentId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, storage_path, file_name, sha256_hash,
          upload_source)
       VALUES ($1, $2, $3, $4, 'underlag.pdf', $5, 'file_upload')`,
      [
        documentId,
        userId,
        companyId,
        `${companyId}/underlag.pdf`,
        'a'.repeat(64),
      ],
    )
    const consentId = randomUUID()
    await getPool().query(
      `INSERT INTO public.provider_consents (id, company_id, name, status, provider)
       VALUES ($1, $2, 'migration-source', 1, 'fortnox')`,
      [consentId, companyId],
    )
    const inviteId = randomUUID()
    await getPool().query(
      `INSERT INTO public.company_invitations
         (id, company_id, email, role, token_hash, invited_by, status, expires_at)
       VALUES ($1, $2, 'invitee@example.com', 'member', $3, $4, 'pending', now() + interval '1 day')`,
      [inviteId, companyId, randomUUID(), userId],
    )
    await getPool().query(
      `INSERT INTO public.user_preferences (user_id, active_company_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
      [userId, companyId],
    )

    const originalTrial = await getPool().query<{ capability_key: string; expires_at: string }>(
      `SELECT capability_key, expires_at::text
       FROM public.capability_grants
       WHERE company_id = $1 AND source = 'trial'
       ORDER BY capability_key`,
      [companyId],
    )

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: RpcResult }>(
        `SELECT public.reset_company_for_migration($1, $2, $3, true, true) AS result`,
        [companyId, 'Migration AB', 'The imported fiscal periods were mapped incorrectly.'],
      )
      const result = rows[0]!.result
      expect(result.ok).toBe(true)
      expect(result.source_company_id).toBe(companyId)
      expect(result.replacement_company_id).toBeTruthy()

      const replacementId = result.replacement_company_id!
      await client.query('RESET ROLE')

      const source = await client.query<{ archived_at: string | null; archived_by: string | null }>(
        `SELECT archived_at::text, archived_by::text FROM public.companies WHERE id = $1`,
        [companyId],
      )
      expect(source.rows[0]!.archived_at).not.toBeNull()
      expect(source.rows[0]!.archived_by).toBe(userId)

      const retained = await client.query<{
        journal_entries: number
        journal_entry_lines: number
        transactions: number
        documents: number
        periods: number
        sequences: number
        sie_imports: number
      }>(
        `SELECT
           (SELECT count(*)::int FROM public.journal_entries WHERE company_id = $1) AS journal_entries,
           (SELECT count(*)::int FROM public.journal_entry_lines line
            JOIN public.journal_entries entry ON entry.id = line.journal_entry_id
            WHERE entry.company_id = $1) AS journal_entry_lines,
           (SELECT count(*)::int FROM public.transactions WHERE company_id = $1) AS transactions,
           (SELECT count(*)::int FROM public.document_attachments WHERE company_id = $1) AS documents,
           (SELECT count(*)::int FROM public.fiscal_periods WHERE company_id = $1) AS periods,
           (SELECT count(*)::int FROM public.voucher_sequences WHERE company_id = $1) AS sequences,
           (SELECT count(*)::int FROM public.sie_imports WHERE company_id = $1) AS sie_imports`,
        [companyId],
      )
      expect(retained.rows[0]).toEqual({
        journal_entries: 0,
        journal_entry_lines: 0,
        transactions: 1,
        documents: 1,
        periods: 1,
        sequences: 0,
        sie_imports: 1,
      })

      const exactRows = await client.query<{
        transaction_exists: boolean
        document_exists: boolean
        sie_import_exists: boolean
      }>(
        `SELECT
           EXISTS (SELECT 1 FROM public.transactions WHERE id = $1) AS transaction_exists,
           EXISTS (SELECT 1 FROM public.document_attachments WHERE id = $2) AS document_exists,
           EXISTS (SELECT 1 FROM public.sie_imports WHERE id = $3) AS sie_import_exists`,
        [transactionId, documentId, sieImportId],
      )
      expect(exactRows.rows[0]).toEqual({
        transaction_exists: true,
        document_exists: true,
        sie_import_exists: true,
      })

      const replacement = await client.query<{
        journal_entries: number
        transactions: number
        documents: number
        periods: number
        sequences: number
        sie_imports: number
        chart_accounts: number
        cash_accounts: number
      }>(
        `SELECT
           (SELECT count(*)::int FROM public.journal_entries WHERE company_id = $1) AS journal_entries,
           (SELECT count(*)::int FROM public.transactions WHERE company_id = $1) AS transactions,
           (SELECT count(*)::int FROM public.document_attachments WHERE company_id = $1) AS documents,
           (SELECT count(*)::int FROM public.fiscal_periods WHERE company_id = $1) AS periods,
           (SELECT count(*)::int FROM public.voucher_sequences WHERE company_id = $1) AS sequences,
           (SELECT count(*)::int FROM public.sie_imports WHERE company_id = $1) AS sie_imports,
           (SELECT count(*)::int FROM public.chart_of_accounts WHERE company_id = $1) AS chart_accounts,
           (SELECT count(*)::int FROM public.cash_accounts WHERE company_id = $1) AS cash_accounts`,
        [replacementId],
      )
      expect(replacement.rows[0]).toMatchObject({
        journal_entries: 0,
        transactions: 0,
        documents: 0,
        periods: 0,
        sequences: 0,
        sie_imports: 0,
      })
      expect(replacement.rows[0]!.chart_accounts).toBeGreaterThan(0)
      expect(replacement.rows[0]!.cash_accounts).toBe(1)

      const operational = await client.query<{
        provider_company_id: string
        invitation_company_id: string
        active_company_id: string
        member_count: number
        team_member_count: number
        source_active_inboxes: number
        replacement_active_inboxes: number
        next_invoice_number: number
        next_arrival_number: number
        onboarding_complete: boolean
        onboarding_step: number
        initial_setup_path: string | null
        initial_setup_completed_at: string | null
      }>(
        `SELECT
           (SELECT company_id::text FROM public.provider_consents WHERE id = $2) AS provider_company_id,
           (SELECT company_id::text FROM public.company_invitations WHERE id = $5) AS invitation_company_id,
           (SELECT active_company_id::text FROM public.user_preferences WHERE user_id = $3) AS active_company_id,
           (SELECT count(*)::int FROM public.company_members WHERE company_id = $1) AS member_count,
           (SELECT count(*)::int FROM public.company_members
            WHERE company_id = $1 AND source = 'team') AS team_member_count,
           (SELECT count(*)::int FROM public.company_inboxes WHERE company_id = $4 AND status = 'active') AS source_active_inboxes,
           (SELECT count(*)::int FROM public.company_inboxes WHERE company_id = $1 AND status = 'active') AS replacement_active_inboxes,
           (SELECT next_invoice_number::int FROM public.company_settings WHERE company_id = $1) AS next_invoice_number,
           (SELECT next_arrival_number::int FROM public.company_settings WHERE company_id = $1) AS next_arrival_number,
           (SELECT onboarding_complete FROM public.company_settings WHERE company_id = $1) AS onboarding_complete,
           (SELECT onboarding_step::int FROM public.company_settings WHERE company_id = $1) AS onboarding_step,
           (SELECT initial_setup_path FROM public.company_settings WHERE company_id = $1) AS initial_setup_path,
           (SELECT initial_setup_completed_at::text FROM public.company_settings WHERE company_id = $1) AS initial_setup_completed_at`,
        [replacementId, consentId, userId, companyId, inviteId],
      )
      expect(operational.rows[0]).toEqual({
        provider_company_id: replacementId,
        invitation_company_id: replacementId,
        active_company_id: replacementId,
        member_count: 2,
        team_member_count: 1,
        source_active_inboxes: 0,
        replacement_active_inboxes: 1,
        next_invoice_number: 41,
        next_arrival_number: 17,
        // The replacement carries a copy of every answer onboarding collects,
        // so it inherits "onboarded". A forced false here sent the owner from
        // Hem ("Att göra") into the create-a-new-company journey, a state
        // nothing in the product could ever leave (20260920190800).
        onboarding_complete: true,
        onboarding_step: 4,
        // The setup checklist re-opens instead: it is the guide for filling
        // the company again, and unlike the flag above it can be completed.
        initial_setup_path: null,
        initial_setup_completed_at: null,
      })

      const replacementTrial = await client.query<{ capability_key: string; expires_at: string }>(
        `SELECT capability_key, expires_at::text
         FROM public.capability_grants
         WHERE company_id = $1 AND source = 'trial'
         ORDER BY capability_key`,
        [replacementId],
      )
      expect(replacementTrial.rows).toEqual(originalTrial.rows)

      const resetAudit = await client.query<{
        n: number
        source_documents: number
        source_journal_lines: number
        source_sie_imports: number
      }>(
        `SELECT count(*)::int AS n,
                max((source_counts ->> 'documents')::int)::int AS source_documents,
                max((source_counts ->> 'journal_entry_lines')::int)::int AS source_journal_lines,
                max((source_counts ->> 'sie_imports')::int)::int AS source_sie_imports
         FROM public.company_migration_resets
         WHERE id = $1
           AND source_company_id = $2
           AND replacement_company_id = $3`,
        [result.reset_id, companyId, replacementId],
      )
      expect(resetAudit.rows[0]).toEqual({
        n: 1,
        source_documents: 1,
        source_journal_lines: 0,
        source_sie_imports: 1,
      })

      const auditLog = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM public.audit_log
         WHERE record_id IN ($1, $2)
           AND new_state ->> 'migration_reset_id' = $3`,
        [companyId, replacementId, result.reset_id],
      )
      expect(auditLog.rows[0]!.n).toBe(2)

      await client.query(
        `INSERT INTO public.team_members (team_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [teamId, lateTeamMemberId],
      )
      const lateTeamMembership = await client.query<{
        source_memberships: number
        replacement_memberships: number
      }>(
        `SELECT
           (SELECT count(*)::int FROM public.company_members
            WHERE company_id = $1 AND user_id = $3) AS source_memberships,
           (SELECT count(*)::int FROM public.company_members
            WHERE company_id = $2 AND user_id = $3) AS replacement_memberships`,
        [companyId, replacementId, lateTeamMemberId],
      )
      expect(lateTeamMembership.rows[0]).toEqual({
        source_memberships: 0,
        replacement_memberships: 1,
      })

      await client.query('SAVEPOINT immutable_audit')
      await expect(
        client.query(
          `UPDATE public.company_migration_resets SET reason = 'Changed after the fact' WHERE id = $1`,
          [result.reset_id],
        ),
      ).rejects.toThrow(/cannot be modified or deleted/i)
      await client.query('ROLLBACK TO SAVEPOINT immutable_audit')

      await client.query('SAVEPOINT immutable_audit_delete')
      await expect(
        client.query(`DELETE FROM public.company_migration_resets WHERE id = $1`, [result.reset_id]),
      ).rejects.toThrow(/cannot be modified or deleted/i)
      await client.query('ROLLBACK TO SAVEPOINT immutable_audit_delete')

      await client.query('SAVEPOINT immutable_audit_truncate')
      await expect(
        client.query(`TRUNCATE public.company_migration_resets`),
      ).rejects.toThrow(/cannot be modified or deleted/i)
      await client.query('ROLLBACK TO SAVEPOINT immutable_audit_truncate')

      await client.query('SAVEPOINT archived_source_membership')
      await expect(
        client.query(
          `INSERT INTO public.company_members (company_id, user_id, role)
           VALUES ($1, $2, 'member')`,
          [companyId, lateMemberId],
        ),
      ).rejects.toThrow(/archived migration reset source/i)
      await client.query('ROLLBACK TO SAVEPOINT archived_source_membership')

      await client.query('SAVEPOINT immutable_source_transaction')
      await expect(
        client.query(`UPDATE public.transactions SET description = 'Changed' WHERE id = $1`, [
          transactionId,
        ]),
      ).rejects.toThrow(/source records are immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT immutable_source_transaction')

      await client.query('SAVEPOINT immutable_source_sequence')
      await expect(
        client.query(
          `INSERT INTO public.voucher_sequences
             (user_id, company_id, fiscal_period_id, voucher_series, last_number)
           VALUES ($1, $2, $3, 'A', 1)`,
          [userId, companyId, fiscalPeriodId],
        ),
      ).rejects.toThrow(/source records are immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT immutable_source_sequence')

      await client.query('SAVEPOINT immutable_source_archive')
      await expect(
        client.query(`UPDATE public.companies SET archived_at = NULL WHERE id = $1`, [companyId]),
      ).rejects.toThrow(/archive markers are immutable/i)
      await client.query('ROLLBACK TO SAVEPOINT immutable_source_archive')
    })
  })
})

// A company created through POST /api/v1/companies or the MCP tools without a
// named team got no team until #3995, and its reset handed the replacement no
// team either, although the owner has a personal team (20261126150000).
describe('company migration reset: the replacement team (pg)', () => {
  const reason = 'The first migration used the wrong fiscal periods.'

  interface Queryable {
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
  }

  interface AfterReset {
    source_team: string | null
    replacement_team: string | null
    members: Array<{ user_id: string; role: string; source: string }>
    personal_teams: string[]
  }

  async function addTeam(userId: string, kind: 'personal' | 'byra', createdAt: string): Promise<string> {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.teams (id, name, created_by, kind, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [id, kind === 'byra' ? 'Byrån' : 'Personal', userId, kind, createdAt],
    )
    await getPool().query(
      `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [id, userId],
    )
    return id
  }

  async function readAfterReset(
    db: Queryable,
    userId: string,
    sourceId: string,
    replacementId: string,
  ): Promise<AfterReset> {
    const { rows } = await db.query(
      `SELECT
         (SELECT team_id::text FROM public.companies WHERE id = $1) AS source_team,
         (SELECT team_id::text FROM public.companies WHERE id = $2) AS replacement_team,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', user_id::text, 'role', role, 'source', source)), '[]'::jsonb)
            FROM public.company_members WHERE company_id = $2) AS members,
         (SELECT coalesce(array_agg(t.id::text), '{}')
            FROM public.teams t JOIN public.team_members tm ON tm.team_id = t.id
            WHERE tm.user_id = $3 AND t.kind = 'personal') AS personal_teams`,
      [sourceId, replacementId, userId],
    )
    return rows[0] as AfterReset
  }

  /** The owner's own reset, read back inside its transaction: withUserContext rolls back. */
  async function ownerReset(userId: string, companyId: string): Promise<AfterReset> {
    return withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: RpcResult }>(
        `SELECT public.reset_company_for_migration($1, 'Test AB', $2, true, true) AS result`,
        [companyId, reason],
      )
      const result = rows[0]!.result
      expect(result).toMatchObject({ ok: true })
      await client.query('RESET ROLE')
      return readAfterReset(client, userId, companyId, result.replacement_company_id!)
    })
  }

  it("gives the replacement of a company without a team the owner's personal team, never an older byrå team", async () => {
    const { userId, companyId } = await seedCompany()
    await addTeam(userId, 'byra', '2026-01-01T00:00:00Z')
    const personal = await addTeam(userId, 'personal', '2026-02-01T00:00:00Z')

    const after = await ownerReset(userId, companyId)

    expect(after.replacement_team).toBe(personal)
    // The source is retained unchanged, and the owner stays the replacement's
    // owner: the team's sync adds no second row for them.
    expect(after.source_team).toBeNull()
    expect(after.members).toEqual([{ user_id: userId, role: 'owner', source: 'direct' }])
  })

  it('gives the replacement a new personal team when the owner has none, as the web app does', async () => {
    const { userId, companyId } = await seedCompany()

    const after = await ownerReset(userId, companyId)

    expect(after.personal_teams).toHaveLength(1)
    expect(after.replacement_team).toBe(after.personal_teams[0])
    expect(after.members).toEqual([{ user_id: userId, role: 'owner', source: 'direct' }])
  })

  it("keeps the source's team, a byrå client's byrå team included, though the owner has a personal team", async () => {
    const { userId, companyId } = await seedCompany()
    await addTeam(userId, 'personal', '2026-01-01T00:00:00Z')
    const byra = await addTeam(userId, 'byra', '2026-02-01T00:00:00Z')
    await getPool().query(`UPDATE public.companies SET team_id = $1 WHERE id = $2`, [byra, companyId])

    const after = await ownerReset(userId, companyId)

    expect(after.replacement_team).toBe(byra)
    expect(after.source_team).toBe(byra)
  })

  it("gives the owner's personal team on a support-run reset too", async () => {
    const { userId, companyId } = await seedCompany()
    const personal = await addTeam(userId, 'personal', '2026-02-01T00:00:00Z')

    const { rows } = await getPool().query<{ result: RpcResult }>(
      `SELECT public.support_reset_company_for_migration($1, $2, 'Test AB', 'case-1', 'support', $3) AS result`,
      [companyId, userId, reason],
    )
    const result = rows[0]!.result
    expect(result).toMatchObject({ ok: true })

    const after = await readAfterReset(getPool(), userId, companyId, result.replacement_company_id!)
    expect(after.replacement_team).toBe(personal)
    expect(after.source_team).toBeNull()
  })

  it('makes no team when the reset is refused', async () => {
    const mismatch = await seedCompany()
    const closed = await seedCompany({ isClosed: true })
    const cases = [
      { ...mismatch, name: 'Fel Namn AB', code: 'COMPANY_RESET_CONFIRMATION_MISMATCH' },
      { ...closed, name: 'Test AB', code: 'COMPANY_RESET_INELIGIBLE' },
    ]

    for (const { userId, companyId, name, code } of cases) {
      // A refusal returns rather than raises, so a team made before it would
      // still be there: count inside the call's transaction.
      const { result, teams } = await withUserContext(userId, async (client) => {
        const { rows } = await client.query<{ result: RpcResult }>(
          `SELECT public.reset_company_for_migration($1, $2, $3, true, true) AS result`,
          [companyId, name, reason],
        )
        await client.query('RESET ROLE')
        const count = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.team_members WHERE user_id = $1`,
          [userId],
        )
        return { result: rows[0]!.result, teams: count.rows[0]!.n }
      })
      expect(result).toMatchObject({ ok: false, code })
      expect(teams).toBe(0)
    }
  })
})
