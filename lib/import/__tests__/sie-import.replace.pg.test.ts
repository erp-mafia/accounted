import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Covers the Fortnox re-sync flow:
//  1. The partial unique index `sie_imports_company_id_file_hash_active_idx`
//     (added in migration 20260517150000) blocks duplicate (company_id,
//     file_hash) rows for active statuses but allows them once a prior row
//     is marked 'replaced' or 'failed'.
//  2. The replace_sie_import RPC hard-deletes journal entries with
//     source_type='import' (since 20260526120000), detaches user-attached
//     documents from them, clears the fiscal-period opening-balance
//     pointer if it came from the import, and resets voucher_sequences
//     so the next re-import restarts the series. User-created entries
//     (source_type='manual', 'bank_transaction', etc.) are left intact.

async function insertSIEImport(params: {
  companyId: string
  userId: string
  fileHash: string
  status: 'pending' | 'mapped' | 'completed' | 'failed' | 'replaced'
  fiscalPeriodId?: string
  openingBalanceEntryId?: string
  fiscalYearStart?: string
  fiscalYearEnd?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, accounts_count, transactions_count,
        status, fiscal_period_id, opening_balance_entry_id, imported_at)
     VALUES ($1, $2, $3, 'fortnox-export.se', $4, 4,
             $5, $6, 0, 0,
             $7, $8, $9, $10)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fileHash,
      params.fiscalYearStart ?? '2026-01-01',
      params.fiscalYearEnd ?? '2026-12-31',
      params.status,
      params.fiscalPeriodId ?? null,
      params.openingBalanceEntryId ?? null,
      params.status === 'completed' ? new Date().toISOString() : null,
    ],
  )
  return id
}

async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  sourceType: 'import' | 'manual' | 'bank_transaction'
  voucherNumber: number
  voucherSeries?: string
  entryDate?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Test entry', $8, 'posted')`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.voucherNumber,
      params.voucherSeries ?? 'A',
      params.entryDate ?? '2026-06-01',
      params.sourceType,
    ],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', 100, 0),
            ($1, '3001', 0, 100)`,
    [id],
  )
  return id
}

async function insertVoucherSequence(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  series: string
  lastNumber: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.voucher_sequences
       (company_id, user_id, fiscal_period_id, voucher_series, last_number)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.companyId, params.userId, params.fiscalPeriodId, params.series, params.lastNumber],
  )
}

async function insertDocumentAttachment(params: {
  userId: string
  companyId: string
  journalEntryId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, sha256_hash, journal_entry_id, upload_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'file_upload')`,
    [
      id,
      params.userId,
      params.companyId,
      `test/${id}.pdf`,
      `test-${id}.pdf`,
      `sha256-${id}`,
      params.journalEntryId,
    ],
  )
  return id
}

describe('sie_imports: partial unique index + replace flow', () => {
  it('blocks a second active row with the same (company_id, file_hash)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(
      insertSIEImport({
        companyId,
        userId,
        fileHash: hash,
        status: 'pending',
        fiscalPeriodId,
      }),
    ).rejects.toThrow(/sie_imports_company_id_file_hash_active_idx/)
  })

  it('allows a new pending row with the same hash once the prior row is replaced', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    const priorId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    // Mark the prior row as replaced (simulating what replace_sie_import does)
    await getPool().query(
      `UPDATE public.sie_imports SET status = 'replaced', replaced_at = now() WHERE id = $1`,
      [priorId],
    )

    // A new pending row with the same hash now succeeds
    const newId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'pending',
      fiscalPeriodId,
    })
    expect(newId).toBeTruthy()
  })

  it('replace_sie_import deletes source_type=import entries, leaves manual/bank_transaction posted, and resets voucher_sequences to MAX of remaining', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const obEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importEntry1 = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 2,
    })
    const importEntry2 = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 3,
    })
    const manualEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', voucherNumber: 4,
    })
    const txnEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'bank_transaction', voucherNumber: 5,
    })

    // Voucher_sequences advanced past the imports (5 total inserted in series A)
    await insertVoucherSequence({
      companyId, userId, fiscalPeriodId, series: 'A', lastNumber: 5,
    })

    // The fiscal period has its opening_balance_entry_id set to the OB entry,
    // matching what a real SIE import would have produced.
    await getPool().query(
      `UPDATE public.fiscal_periods
         SET opening_balance_entry_id = $1, opening_balances_set = true
       WHERE id = $2`,
      [obEntry, fiscalPeriodId],
    )

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
      openingBalanceEntryId: obEntry,
    })

    const { rows } = await getPool().query<{ replace_sie_import: number }>(
      `SELECT public.replace_sie_import($1::uuid, $2::uuid) AS replace_sie_import`,
      [companyId, importId],
    )
    expect(rows[0]!.replace_sie_import).toBe(3) // OB + 2 import entries

    // The import entries (and their lines) are gone
    const entries = await getPool().query<{ id: string; status: string }>(
      `SELECT id, status FROM public.journal_entries WHERE id = ANY($1)`,
      [[obEntry, importEntry1, importEntry2, manualEntry, txnEntry]],
    )
    const statusById = Object.fromEntries(entries.rows.map(r => [r.id, r.status]))
    expect(statusById[obEntry]).toBeUndefined()
    expect(statusById[importEntry1]).toBeUndefined()
    expect(statusById[importEntry2]).toBeUndefined()
    expect(statusById[manualEntry]).toBe('posted')
    expect(statusById[txnEntry]).toBe('posted')

    const lines = await getPool().query<{ count: string }>(
      `SELECT count(*)::text FROM public.journal_entry_lines
        WHERE journal_entry_id = ANY($1)`,
      [[obEntry, importEntry1, importEntry2]],
    )
    expect(lines.rows[0]!.count).toBe('0')

    // voucher_sequences reset to max of remaining entries in series A (5, the bank tx)
    const vs = await getPool().query<{ last_number: number }>(
      `SELECT last_number FROM public.voucher_sequences
        WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(vs.rows[0]?.last_number).toBe(5)

    // fiscal_periods OB pointer cleared
    const fp = await getPool().query<{
      opening_balance_entry_id: string | null
      opening_balances_set: boolean
    }>(
      `SELECT opening_balance_entry_id, opening_balances_set
         FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(fp.rows[0]?.opening_balance_entry_id).toBeNull()
    expect(fp.rows[0]?.opening_balances_set).toBe(false)

    // sie_imports OB FK cleared, status replaced
    const importRow = await getPool().query<{
      status: string
      replaced_at: string | null
      opening_balance_entry_id: string | null
    }>(
      `SELECT status, replaced_at, opening_balance_entry_id
         FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(importRow.rows[0]?.status).toBe('replaced')
    expect(importRow.rows[0]?.replaced_at).not.toBeNull()
    expect(importRow.rows[0]?.opening_balance_entry_id).toBeNull()
  })

  it('replace_sie_import resets voucher_sequences.last_number to 0 when no entries remain in the series', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 2,
    })

    await insertVoucherSequence({
      companyId, userId, fiscalPeriodId, series: 'A', lastNumber: 2,
    })

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await getPool().query(
      `SELECT public.replace_sie_import($1::uuid, $2::uuid)`,
      [companyId, importId],
    )

    const vs = await getPool().query<{ last_number: number }>(
      `SELECT last_number FROM public.voucher_sequences
        WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(vs.rows[0]?.last_number).toBe(0)
  })

  it('replace_sie_import detaches documents from deleted entries without losing the document rows', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const manualEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', voucherNumber: 2,
    })

    const attachedDoc = await insertDocumentAttachment({
      userId, companyId, journalEntryId: importEntry,
    })
    const manualDoc = await insertDocumentAttachment({
      userId, companyId, journalEntryId: manualEntry,
    })

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await getPool().query(
      `SELECT public.replace_sie_import($1::uuid, $2::uuid)`,
      [companyId, importId],
    )

    // The document attached to the deleted import entry is detached but preserved
    const detached = await getPool().query<{
      id: string
      journal_entry_id: string | null
      storage_path: string
      file_name: string
    }>(
      `SELECT id, journal_entry_id, storage_path, file_name
         FROM public.document_attachments WHERE id = $1`,
      [attachedDoc],
    )
    expect(detached.rows[0]).toBeTruthy()
    expect(detached.rows[0]?.journal_entry_id).toBeNull()
    expect(detached.rows[0]?.storage_path).toBeTruthy()
    expect(detached.rows[0]?.file_name).toBeTruthy()

    // The document attached to the surviving manual entry is left alone
    const untouched = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
      [manualDoc],
    )
    expect(untouched.rows[0]?.journal_entry_id).toBe(manualEntry)
  })

  it('replace_sie_import on an already-replaced import raises', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await getPool().query(
      `SELECT public.replace_sie_import($1::uuid, $2::uuid)`,
      [companyId, importId],
    )

    await expect(
      getPool().query(
        `SELECT public.replace_sie_import($1::uuid, $2::uuid)`,
        [companyId, importId],
      ),
    ).rejects.toThrow(/not found or not in completed status/)
  })
})
