import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  seedCompany,
  insertAuthUser,
  insertCompanyMember,
  insertTransaction,
  insertDraftJournalEntry,
} from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for bank-file import undo (#1672,
 * 20260820120000_bank_file_import_undo.sql).
 *
 * Locks in:
 *   - the transactions.bank_file_import_id provenance column (FK SET NULL),
 *   - undo_bank_file_import deletes unbooked rows INCLUDING ignored ones,
 *   - booked rows (journal_entry_id AND transaction_voucher_links anchors)
 *     are never deleted, only counted as skipped,
 *   - rows with payment_match_log history are skipped (their delete is
 *     blocked by audit_log_immutable) without failing the whole undo,
 *   - owner/admin gate, idempotency (status 'undone'), the legacy
 *     no-linked-rows refusal, and company/import scoping.
 */

async function insertBankFileImport(params: {
  companyId: string
  userId: string
  status?: string
  importedCount?: number
  fileHash?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.bank_file_imports
       (id, user_id, company_id, filename, file_hash, file_format,
        transaction_count, imported_count, status)
     VALUES ($1, $2, $3, 'kontoutdrag.csv', $4, 'seb', $5, $5, $6)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fileHash ?? `hash-${id}`,
      params.importedCount ?? 0,
      params.status ?? 'completed',
    ],
  )
  return id
}

async function linkToImport(txId: string, importId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.transactions SET bank_file_import_id = $2 WHERE id = $1`,
    [txId, importId],
  )
}

async function undoImport(companyId: string, importId: string, userId: string) {
  const { rows } = await getPool().query(
    `SELECT public.undo_bank_file_import($1, $2, $3) AS report`,
    [companyId, importId, userId],
  )
  return rows[0].report as {
    deleted: number
    deleted_ignored: number
    skipped_booked: number
    skipped_matched: number
  }
}

async function transactionExists(txId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM public.transactions WHERE id = $1`,
    [txId],
  )
  return rows.length > 0
}

describe('transactions.bank_file_import_id column', () => {
  it('accepts the batch link and clears it when the import row is deleted', async () => {
    const { userId, companyId } = await seedCompany()
    const importId = await insertBankFileImport({ companyId, userId, importedCount: 1 })
    const txId = await insertTransaction({ companyId, userId, externalId: `ext-${randomUUID()}` })
    await linkToImport(txId, importId)

    await getPool().query(`DELETE FROM public.bank_file_imports WHERE id = $1`, [importId])

    const { rows } = await getPool().query(
      `SELECT bank_file_import_id FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(rows[0].bank_file_import_id).toBeNull()
  })
})

describe('undo_bank_file_import', () => {
  it('deletes unbooked rows including ignored ones and marks the import undone', async () => {
    const { userId, companyId } = await seedCompany()
    const importId = await insertBankFileImport({ companyId, userId, importedCount: 3 })

    const plain = await insertTransaction({ companyId, userId, externalId: `ext-${randomUUID()}` })
    const ignored = await insertTransaction({
      companyId,
      userId,
      isIgnored: true,
      externalId: `ext-${randomUUID()}`,
    })
    const unrelated = await insertTransaction({ companyId, userId, externalId: `ext-${randomUUID()}` })
    await linkToImport(plain, importId)
    await linkToImport(ignored, importId)

    const report = await undoImport(companyId, importId, userId)

    expect(report.deleted).toBe(2)
    expect(report.deleted_ignored).toBe(1)
    expect(report.skipped_booked).toBe(0)
    expect(report.skipped_matched).toBe(0)

    expect(await transactionExists(plain)).toBe(false)
    expect(await transactionExists(ignored)).toBe(false)
    // A transaction never linked to the batch is untouched.
    expect(await transactionExists(unrelated)).toBe(true)

    const { rows } = await getPool().query(
      `SELECT status FROM public.bank_file_imports WHERE id = $1`,
      [importId],
    )
    expect(rows[0].status).toBe('undone')
  })

  it('never deletes booked rows (journal_entry_id) and reports them as skipped', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const importId = await insertBankFileImport({ companyId, userId, importedCount: 2 })

    const jeId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
    })
    const booked = await insertTransaction({
      companyId,
      userId,
      journalEntryId: jeId,
      externalId: `ext-${randomUUID()}`,
    })
    const unbooked = await insertTransaction({ companyId, userId, externalId: `ext-${randomUUID()}` })
    await linkToImport(booked, importId)
    await linkToImport(unbooked, importId)

    const report = await undoImport(companyId, importId, userId)

    expect(report.deleted).toBe(1)
    expect(report.skipped_booked).toBe(1)
    expect(await transactionExists(booked)).toBe(true)
    expect(await transactionExists(unbooked)).toBe(false)

    // The posted verifikat itself is untouched (BFL immutability territory).
    const { rows } = await getPool().query(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [jeId],
    )
    expect(rows[0].status).toBe('posted')
  })

  it('treats a transaction_voucher_links anchor as booked (N:1 samlingsverifikation)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const importId = await insertBankFileImport({ companyId, userId, importedCount: 1 })

    const jeId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
    })
    const linked = await insertTransaction({ companyId, userId, externalId: `ext-${randomUUID()}` })
    await linkToImport(linked, importId)
    await getPool().query(
      `INSERT INTO public.transaction_voucher_links
         (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
       VALUES ($1, $2, $3, $4, -100, 'bank_line')`,
      [userId, companyId, linked, jeId],
    )

    const report = await undoImport(companyId, importId, userId)

    expect(report.deleted).toBe(0)
    expect(report.skipped_booked).toBe(1)
    expect(await transactionExists(linked)).toBe(true)
  })

  it('skips rows with payment_match_log history instead of failing the undo', async () => {
    const { userId, companyId } = await seedCompany()
    const importId = await insertBankFileImport({ companyId, userId, importedCount: 2 })

    const withHistory = await insertTransaction({ companyId, userId, externalId: `ext-${randomUUID()}` })
    const plain = await insertTransaction({ companyId, userId, externalId: `ext-${randomUUID()}` })
    await linkToImport(withHistory, importId)
    await linkToImport(plain, importId)
    await getPool().query(
      `INSERT INTO public.payment_match_log (user_id, transaction_id, action)
       VALUES ($1, $2, 'auto_suggested')`,
      [userId, withHistory],
    )

    const report = await undoImport(companyId, importId, userId)

    expect(report.deleted).toBe(1)
    expect(report.skipped_matched).toBe(1)
    expect(await transactionExists(withHistory)).toBe(true)
    expect(await transactionExists(plain)).toBe(false)
  })

  it('rejects callers who are not owner or admin', async () => {
    const { userId, companyId } = await seedCompany()
    const importId = await insertBankFileImport({ companyId, userId, importedCount: 0 })

    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    await expect(undoImport(companyId, importId, memberId)).rejects.toThrow(
      /owners and admins/i,
    )
  })

  it('rejects an already-undone import (idempotency stop)', async () => {
    const { userId, companyId } = await seedCompany()
    const importId = await insertBankFileImport({
      companyId,
      userId,
      status: 'undone',
      importedCount: 1,
    })

    await expect(undoImport(companyId, importId, userId)).rejects.toThrow(
      /not in an undoable status/i,
    )
  })

  it('refuses a legacy import with imported rows but no batch links', async () => {
    const { userId, companyId } = await seedCompany()
    const importId = await insertBankFileImport({ companyId, userId, importedCount: 5 })

    await expect(undoImport(companyId, importId, userId)).rejects.toThrow(
      /no linked transactions/i,
    )
  })

  it('is scoped to the given company: another company cannot undo the import', async () => {
    const { userId, companyId } = await seedCompany()
    const other = await seedCompany()
    const importId = await insertBankFileImport({ companyId, userId, importedCount: 1 })
    const txId = await insertTransaction({ companyId, userId, externalId: `ext-${randomUUID()}` })
    await linkToImport(txId, importId)

    // The other company's owner cannot see the import at all.
    await expect(undoImport(other.companyId, importId, other.userId)).rejects.toThrow(
      /not found/i,
    )
    expect(await transactionExists(txId)).toBe(true)
  })
})
