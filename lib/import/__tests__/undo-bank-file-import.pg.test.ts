import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import {
  seedCompany,
  insertAuthUser,
  insertCompanyMember,
  insertPostedJournalEntry,
  insertTransaction,
} from '@/tests/pg/fixtures'

// Migration 20260820071500_undo_bank_file_import.sql (issue #1672):
// transactions.bank_file_import_id links every bank-file-imported row to its
// batch, and undo_bank_file_import bulk-deletes the batch's unbooked rows
// (ignored INCLUDED) while skipping booked rows and rows with
// payment_match_log history. The actor gate mirrors undo_sie_import
// (20260727121000): p_user_id honored only for service_role callers, every
// other caller pinned to its own auth.uid(), 42501 otherwise.

async function insertCompletedBankImport(params: {
  companyId: string
  userId: string
  status?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.bank_file_imports
       (id, user_id, company_id, filename, file_hash, file_format,
        transaction_count, imported_count, status, date_from, date_to)
     VALUES ($1, $2, $3, 'lunar-2026.csv', $4, 'lunar',
             3, 3, $5, '2026-01-01', '2026-06-30')`,
    [id, params.userId, params.companyId, `hash-${id}`, params.status ?? 'completed'],
  )
  return id
}

type UndoReport = {
  deleted: number
  skipped_booked: number
  skipped_match_history: number
}

async function callUndo(
  companyId: string,
  importId: string,
  actor: string | null,
): Promise<UndoReport> {
  const res = await runAsServiceRole((client) =>
    client.query<{ report: UndoReport }>(
      `SELECT public.undo_bank_file_import($1::uuid, $2::uuid, $3::uuid) AS report`,
      [companyId, importId, actor],
    ),
  )
  return res.rows[0].report
}

describe('undo_bank_file_import', () => {
  it('deletes the batch unbooked rows (ignored included), skips booked and match-history rows, and reports', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedBankImport({ companyId, userId })

    // Two plain unbooked rows, one of them ignored: both must go.
    const plainTx = await insertTransaction({
      companyId,
      userId,
      bankFileImportId: importId,
    })
    const ignoredTx = await insertTransaction({
      companyId,
      userId,
      isIgnored: true,
      bankFileImportId: importId,
    })

    // A booked row from the same batch: must stay.
    const jeId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const bookedTx = await insertTransaction({
      companyId,
      userId,
      journalEntryId: jeId,
      bankFileImportId: importId,
    })

    // An unbooked row carrying append-only match history: must stay (its
    // payment_match_log rows cascade on delete, which audit_log_immutable
    // blocks; same rule as the single-row DELETE route).
    const historyTx = await insertTransaction({
      companyId,
      userId,
      bankFileImportId: importId,
    })
    await getPool().query(
      `INSERT INTO public.payment_match_log (user_id, transaction_id, action)
       VALUES ($1, $2, 'auto_suggested')`,
      [userId, historyTx],
    )

    // Rows OUTSIDE the batch: another import's row and an unlinked (PSD2-ish)
    // row. Strict scoping means neither is touched.
    const otherImportId = await insertCompletedBankImport({ companyId, userId })
    const otherBatchTx = await insertTransaction({
      companyId,
      userId,
      bankFileImportId: otherImportId,
    })
    const unlinkedTx = await insertTransaction({ companyId, userId })

    const report = await callUndo(companyId, importId, userId)

    expect(report.deleted).toBe(2)
    expect(report.skipped_booked).toBe(1)
    expect(report.skipped_match_history).toBe(1)

    const { rows: remaining } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.transactions WHERE company_id = $1`,
      [companyId],
    )
    const remainingIds = new Set(remaining.map((r) => r.id))
    expect(remainingIds.has(plainTx)).toBe(false)
    expect(remainingIds.has(ignoredTx)).toBe(false)
    expect(remainingIds.has(bookedTx)).toBe(true)
    expect(remainingIds.has(historyTx)).toBe(true)
    expect(remainingIds.has(otherBatchTx)).toBe(true)
    expect(remainingIds.has(unlinkedTx)).toBe(true)

    const { rows: impRows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.bank_file_imports WHERE id = $1`,
      [importId],
    )
    expect(impRows[0].status).toBe('undone')

    // Behandlingshistorik: the bulk delete leaves one audit_log summary row.
    const { rows: auditRows } = await getPool().query<{
      new_state: { deleted_transactions: number }
    }>(
      `SELECT new_state FROM public.audit_log
        WHERE table_name = 'transactions' AND record_id = $1 AND action = 'DELETE'`,
      [importId],
    )
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].new_state.deleted_transactions).toBe(2)
  })

  it('raises when the import is not in completed status', async () => {
    const { companyId, userId } = await seedCompany()
    const importId = await insertCompletedBankImport({
      companyId,
      userId,
      status: 'processing',
    })
    const txId = await insertTransaction({ companyId, userId, bankFileImportId: importId })

    await expect(callUndo(companyId, importId, userId)).rejects.toThrow(
      /not in completed status/i,
    )

    const { rows } = await getPool().query(
      `SELECT 1 FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(rows).toHaveLength(1)
  })

  it('raises 42501 for a plain member and for a stranger', async () => {
    const { companyId, userId } = await seedCompany()
    const importId = await insertCompletedBankImport({ companyId, userId })

    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    await expect(callUndo(companyId, importId, memberId)).rejects.toThrow(
      /owners and admins/i,
    )
    await expect(callUndo(companyId, importId, randomUUID())).rejects.toThrow(
      /owners and admins/i,
    )
    await expect(callUndo(companyId, importId, null)).rejects.toThrow(
      /owners and admins/i,
    )
  })

  it('ignores a spoofed p_user_id from an authenticated (non-service) caller', async () => {
    const { companyId, userId: ownerId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const importId = await insertCompletedBankImport({ companyId, userId: ownerId })
    const txId = await insertTransaction({
      companyId,
      userId: ownerId,
      bankFileImportId: importId,
    })

    await withUserContext(memberId, async (client) => {
      let raised: (Error & { code?: string }) | null = null
      try {
        await client.query(
          `SELECT public.undo_bank_file_import($1::uuid, $2::uuid, $3::uuid)`,
          [companyId, importId, ownerId],
        )
      } catch (err) {
        raised = err as Error & { code?: string }
      }
      expect(raised, 'spoofed p_user_id must not authorize').not.toBeNull()
      expect(raised!.message).toMatch(/owners and admins/i)
      expect(raised!.code).toBe('42501')
    })

    // The gate fired before any mutation.
    const { rows: impRows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.bank_file_imports WHERE id = $1`,
      [importId],
    )
    expect(impRows[0].status).toBe('completed')
    const { rows: txRows } = await getPool().query(
      `SELECT 1 FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(txRows).toHaveLength(1)
  })

  it('resolves the actor from auth.uid() for an authenticated owner (session-client fallback)', async () => {
    const { companyId, userId } = await seedCompany()
    const importId = await insertCompletedBankImport({ companyId, userId })
    await insertTransaction({ companyId, userId, bankFileImportId: importId })

    const report = await withUserContext(userId, async (client) => {
      const res = await client.query<{ report: UndoReport }>(
        `SELECT public.undo_bank_file_import($1::uuid, $2::uuid) AS report`,
        [companyId, importId],
      )
      const imp = await client.query<{ status: string }>(
        `SELECT status FROM public.bank_file_imports WHERE id = $1`,
        [importId],
      )
      expect(imp.rows[0].status).toBe('undone')
      return res.rows[0].report
    })
    expect(report.deleted).toBe(1)
  })

  it('does not grant EXECUTE to anon or PUBLIC (least privilege)', async () => {
    const { rows } = await getPool().query<{
      anon_can: boolean
      public_can: boolean
      authenticated_can: boolean
      service_role_can: boolean
    }>(
      `SELECT has_function_privilege('anon', 'public.undo_bank_file_import(uuid,uuid,uuid)', 'EXECUTE') AS anon_can,
              has_function_privilege('public', 'public.undo_bank_file_import(uuid,uuid,uuid)', 'EXECUTE') AS public_can,
              has_function_privilege('authenticated', 'public.undo_bank_file_import(uuid,uuid,uuid)', 'EXECUTE') AS authenticated_can,
              has_function_privilege('service_role', 'public.undo_bank_file_import(uuid,uuid,uuid)', 'EXECUTE') AS service_role_can`,
    )
    expect(rows[0].anon_can, 'anon must not be able to call undo_bank_file_import').toBe(false)
    expect(rows[0].public_can, 'PUBLIC must not hold EXECUTE').toBe(false)
    expect(rows[0].authenticated_can).toBe(true)
    expect(rows[0].service_role_can).toBe(true)
  })
})
