import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany, insertDraftJournalEntry } from '@/tests/pg/fixtures'

// Migration 20260702154500_dimension_import_provenance_undo_lockstep.sql:
// SIE import creates dimensions/dimension_values rows carrying
// created_by_import_id; undo_sie_import deletes the rows the undone import
// introduced, but ONLY when no remaining posted/reversed line references
// them, and NEVER user-created rows (created_by_import_id IS NULL).
//
// The registry guard triggers (enforce_dimension_registry_guards /
// enforce_dimension_value_retention) fire on these deletes as a backstop, so
// these tests also prove the lockstep deletes are trigger-compatible.

async function insertCompletedImport(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, accounts_count, transactions_count,
        status, fiscal_period_id, imported_at)
     VALUES ($1, $2, $3, 'undo-dims-test.se', $4, 4,
             '2026-01-01', '2026-12-31', 0, 1,
             'completed', $5, now())`,
    [id, params.userId, params.companyId, `hash-${id}`, params.fiscalPeriodId],
  )
  return id
}

/** Posted entry with dimension-tagged balanced lines. */
async function insertPostedTaggedEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  sourceType: string
  voucherNumber: number
  dimensions: Record<string, string>
}): Promise<string> {
  const jeId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    sourceType: params.sourceType,
    status: 'draft',
    voucherNumber: params.voucherNumber,
  })
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, dimensions)
     VALUES ($1, '5010', 1000, 0, $2::jsonb),
            ($1, '1930', 0, 1000, '{}'::jsonb)`,
    [jeId, JSON.stringify(params.dimensions)],
  )
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [jeId],
  )
  return jeId
}

async function insertDimension(params: {
  companyId: string
  sieDimNo: number
  name: string
  importId?: string | null
  isSystem?: boolean
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.dimensions
       (company_id, sie_dim_no, name, resets_annually, is_system, created_by_import_id)
     VALUES ($1, $2, $3, true, $4, $5)
     RETURNING id`,
    [params.companyId, params.sieDimNo, params.name, params.isSystem ?? false, params.importId ?? null],
  )
  return rows[0].id
}

async function insertDimensionValue(params: {
  companyId: string
  dimensionId: string
  code: string
  importId?: string | null
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.dimension_values
       (company_id, dimension_id, code, name, created_by_import_id)
     VALUES ($1, $2, $3, $3, $4)
     RETURNING id`,
    [params.companyId, params.dimensionId, params.code, params.importId ?? null],
  )
  return rows[0].id
}

async function callUndo(companyId: string, importId: string, actor: string) {
  return getPool().query<{ deleted: number }>(
    `SELECT public.undo_sie_import($1::uuid, $2::uuid, $3::uuid) AS deleted`,
    [companyId, importId, actor],
  )
}

async function countRows(table: string, id: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM public.${table} WHERE id = $1`,
    [id],
  )
  return rows.length
}

describe('undo_sie_import: dimension registry lockstep', () => {
  it('deletes import-created values whose references vanish with the import', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 6, name: 'Projekt' })
    const valueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'P001', importId })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '6': 'P001' },
    })

    const res = await callUndo(companyId, importId, userId)
    expect(res.rows[0].deleted).toBe(1)

    // The import's value is gone; the dimension itself (not import-created)
    // survives.
    expect(await countRows('dimension_values', valueId)).toBe(0)
    expect(await countRows('dimensions', dimId)).toBe(1)
  })

  it('keeps import-created values that other posted bookkeeping still references', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 6, name: 'Projekt' })
    const valueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'P002', importId })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '6': 'P002' },
    })
    // A MANUAL posted entry tagged with the same code: survives the undo and
    // must keep its registry row (retention trigger would block the delete;
    // the lockstep's own WHERE avoids even attempting it).
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'manual', voucherNumber: 2,
      dimensions: { '6': 'P002' },
    })

    const res = await callUndo(companyId, importId, userId)
    expect(res.rows[0].deleted).toBe(1) // only the import entry

    expect(await countRows('dimension_values', valueId)).toBe(1)
  })

  it('never touches user-created values (no provenance)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 6, name: 'Projekt' })
    const userValueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'EGEN', importId: null })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '6': 'EGEN' },
    })

    await callUndo(companyId, importId, userId)

    // Unreferenced now, but user-created → stays.
    expect(await countRows('dimension_values', userValueId)).toBe(1)
  })

  it('deletes an import-created custom dimension once empty and unreferenced', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 7, name: 'Anställd', importId })
    const valueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'ANNA', importId })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '7': 'ANNA' },
    })

    await callUndo(companyId, importId, userId)

    expect(await countRows('dimension_values', valueId)).toBe(0)
    expect(await countRows('dimensions', dimId)).toBe(0)
  })

  it('keeps an import-created dimension that still has user-created values', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 8, name: 'Kund', importId })
    const userValueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'KUND1', importId: null })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '8': 'KUND1' },
    })

    await callUndo(companyId, importId, userId)

    // The user's value anchors the dimension.
    expect(await countRows('dimension_values', userValueId)).toBe(1)
    expect(await countRows('dimensions', dimId)).toBe(1)
  })

  it('deleting an old sie_imports row nulls provenance instead of cascading', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })
    const dimId = await insertDimension({ companyId, sieDimNo: 6, name: 'Projekt' })
    const valueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'P009', importId })

    await getPool().query(`DELETE FROM public.sie_imports WHERE id = $1`, [importId])

    const { rows } = await getPool().query<{ created_by_import_id: string | null }>(
      `SELECT created_by_import_id FROM public.dimension_values WHERE id = $1`,
      [valueId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].created_by_import_id).toBeNull()
  })
})
