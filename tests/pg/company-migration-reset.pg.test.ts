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
      legacy_snapshot_141018_authenticated: boolean
      legacy_snapshot_143004_authenticated: boolean
      legacy_snapshot_224000_authenticated: boolean
      legacy_snapshot_231500_authenticated: boolean
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
          'authenticated',
          'public.company_migration_reset_snapshot_before_20260818141018(uuid)',
          'EXECUTE'
        ) AS legacy_snapshot_141018_authenticated,
        has_function_privilege(
          'authenticated',
          'public.company_migration_reset_snapshot_before_20260818143004(uuid)',
          'EXECUTE'
        ) AS legacy_snapshot_143004_authenticated,
        has_function_privilege(
          'authenticated',
          'public.company_migration_reset_snapshot_before_20260818224000(uuid)',
          'EXECUTE'
        ) AS legacy_snapshot_224000_authenticated,
        has_function_privilege(
          'authenticated',
          'public.company_migration_reset_snapshot_before_20260818231500(uuid)',
          'EXECUTE'
        ) AS legacy_snapshot_231500_authenticated
    `)

    expect(rows[0]).toEqual({
      preview_anon: false,
      preview_authenticated: true,
      execute_anon: false,
      execute_authenticated: true,
      snapshot_authenticated: false,
      legacy_snapshot_141018_authenticated: false,
      legacy_snapshot_143004_authenticated: false,
      legacy_snapshot_224000_authenticated: false,
      legacy_snapshot_231500_authenticated: false,
    })
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

  it('fails closed on locks, journal entries, filings, live bank sync, and age', async () => {
    const locked = await seedCompany({ isClosed: true })
    const lockedPreview = await preview(locked.userId, locked.companyId)
    expect(lockedPreview.eligibility?.blockers).toContainEqual({
      code: 'locked_or_closed_periods',
      count: 1,
    })

    const nonImport = await seedCompany()
    await insertDraftJournalEntry({
      ...nonImport,
      status: 'posted',
      sourceType: 'manual',
      voucherNumber: 1,
    })
    const nonImportPreview = await preview(nonImport.userId, nonImport.companyId)
    expect(nonImportPreview.eligibility?.blockers).toContainEqual({
      code: 'journal_entries_exist',
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

    const importing = await seedCompany()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (user_id, company_id, filename, file_hash, sie_type, status)
       VALUES ($1, $2, 'pending.se', $3, 4, 'pending')`,
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
      `UPDATE public.companies SET created_at = now() - interval '31 days' WHERE id = $1`,
      [old.companyId],
    )
    const oldPreview = await preview(old.userId, old.companyId)
    expect(oldPreview.eligibility?.blockers).toContainEqual({
      code: 'migration_window_expired',
      count: 1,
    })

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

  it('blocks drafts, imported postings, linked documents, and voucher sequence state', async () => {
    const draft = await seedCompany()
    await insertDraftJournalEntry({
      ...draft,
      status: 'draft',
      sourceType: 'manual',
    })
    const draftPreview = await preview(draft.userId, draft.companyId)
    expect(draftPreview.eligibility?.blockers).toContainEqual({
      code: 'journal_entries_exist',
      count: 1,
    })

    const imported = await seedCompany()
    const importEntryId = await insertDraftJournalEntry({
      ...imported,
      status: 'posted',
      sourceType: 'import',
      voucherSeries: 'A',
      voucherNumber: 40,
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
       VALUES ($1, $2, $3, 'A', 40)`,
      [imported.userId, imported.companyId, imported.fiscalPeriodId],
    )

    const importedPreview = await preview(imported.userId, imported.companyId)
    expect(importedPreview.eligibility?.blockers).toEqual(expect.arrayContaining([
      { code: 'journal_entries_exist', count: 1 },
      { code: 'voucher_sequence_state_exists', count: 1 },
    ]))
    expect(importedPreview.eligibility?.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'non_import_committed_entries' }),
    )

    await expect(execute(imported.userId, imported.companyId)).resolves.toMatchObject({
      ok: false,
      code: 'COMPANY_RESET_INELIGIBLE',
    })
    const retained = await getPool().query<{
      archived_at: string | null
      entry_exists: boolean
      linked_document_exists: boolean
      sequence_last_number: number
      reset_count: number
    }>(
      `SELECT
         (SELECT archived_at::text FROM public.companies WHERE id = $1) AS archived_at,
         EXISTS (SELECT 1 FROM public.journal_entries WHERE id = $2) AS entry_exists,
         EXISTS (
           SELECT 1 FROM public.document_attachments
           WHERE id = $3 AND journal_entry_id = $2
         ) AS linked_document_exists,
         (SELECT last_number::int FROM public.voucher_sequences
          WHERE company_id = $1 AND voucher_series = 'A') AS sequence_last_number,
         (SELECT count(*)::int FROM public.company_migration_resets
          WHERE source_company_id = $1) AS reset_count`,
      [imported.companyId, importEntryId, documentId],
    )
    expect(retained.rows[0]).toEqual({
      archived_at: null,
      entry_exists: true,
      linked_document_exists: true,
      sequence_last_number: 40,
      reset_count: 0,
    })

    const sequenceOnly = await seedCompany()
    await getPool().query(
      `INSERT INTO public.voucher_sequences
         (user_id, company_id, fiscal_period_id, voucher_series, last_number)
       VALUES ($1, $2, $3, 'B', 0)`,
      [sequenceOnly.userId, sequenceOnly.companyId, sequenceOnly.fiscalPeriodId],
    )
    const sequencePreview = await preview(sequenceOnly.userId, sequenceOnly.companyId)
    expect(sequencePreview.eligibility?.blockers).toContainEqual({
      code: 'voucher_sequence_state_exists',
      count: 1,
    })
  })

  it('blocks customer and supplier invoice records before any voucher exists', async () => {
    const customerInvoice = await seedCompany()
    await getPool().query(
      `INSERT INTO public.invoices
         (user_id, company_id, invoice_number, invoice_date, due_date, status)
       VALUES ($1, $2, 1, '2026-08-01', '2026-08-31', 'sent')`,
      [customerInvoice.userId, customerInvoice.companyId],
    )
    const customerPreview = await preview(customerInvoice.userId, customerInvoice.companyId)
    expect(customerPreview.eligibility?.blockers).toContainEqual({
      code: 'invoice_records_exist',
      count: 1,
    })
    expect(customerPreview.eligibility?.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'journal_entries_exist' }),
    )

    const supplierInvoice = await seedCompany()
    const supplierId = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name)
       VALUES ($1, $2, $3, 'Leverantor AB')`,
      [supplierId, supplierInvoice.userId, supplierInvoice.companyId],
    )
    await getPool().query(
      `INSERT INTO public.supplier_invoices
         (user_id, company_id, supplier_id, arrival_number,
          supplier_invoice_number, invoice_date, due_date)
       VALUES ($1, $2, $3, 1, 'SUP-1', '2026-08-01', '2026-08-31')`,
      [supplierInvoice.userId, supplierInvoice.companyId, supplierId],
    )
    const supplierPreview = await preview(supplierInvoice.userId, supplierInvoice.companyId)
    expect(supplierPreview.eligibility?.blockers).toContainEqual({
      code: 'invoice_records_exist',
      count: 1,
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
          onboarding_complete, next_invoice_number, next_arrival_number)
       VALUES ($1, $2, 'aktiebolag', 'Migration AB', '5590000001', true, 41, 17)`,
      [userId, companyId],
    )
    // The replacement is the same legal entity. Values above 1 pin that the
    // invoice and arrival-number series continue rather than silently restart.
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
           (SELECT onboarding_complete FROM public.company_settings WHERE company_id = $1) AS onboarding_complete`,
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
        onboarding_complete: false,
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
