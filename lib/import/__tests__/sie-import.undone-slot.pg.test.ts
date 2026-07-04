import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Migration 20260529120000_sie_imports_undone_release_slot.sql extends
// the partial unique index sie_imports_company_id_file_hash_active_idx
// to also exclude 'undone'. Without this, undo_sie_import marks a row
// 'undone' but the slot stays held: the caller cannot re-import the
// same file.

async function insertSIEImport(params: {
  companyId: string
  userId: string
  fileHash: string
  status: 'pending' | 'mapped' | 'completed' | 'failed' | 'replaced' | 'undone'
  fiscalPeriodId?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, accounts_count, transactions_count,
        status, fiscal_period_id, imported_at)
     VALUES ($1, $2, $3, 'undone-test.se', $4, 4,
             '2026-01-01', '2026-12-31', 0, 0,
             $5, $6, $7)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fileHash,
      params.status,
      params.fiscalPeriodId ?? null,
      params.status === 'completed' ? new Date().toISOString() : null,
    ],
  )
  return id
}

describe('sie_imports partial unique index: undone status releases the slot', () => {
  it('still blocks a duplicate active row (regression guard)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    await insertSIEImport({ companyId, userId, fileHash: hash, status: 'completed', fiscalPeriodId })

    await expect(
      insertSIEImport({ companyId, userId, fileHash: hash, status: 'pending', fiscalPeriodId }),
    ).rejects.toThrow(/sie_imports_company_id_file_hash_active_idx/)
  })

  it('allows a new pending row once the prior is undone', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    const priorId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    // Mimic undo_sie_import's terminal write (we don't run the RPC here:
    // the RPC also detaches docs + deletes JEs which need richer setup).
    await getPool().query(
      `UPDATE public.sie_imports SET status = 'undone', replaced_at = now() WHERE id = $1`,
      [priorId],
    )

    const newId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'pending',
      fiscalPeriodId,
    })
    expect(newId).toBeTruthy()
  })

  it('allows a re-import after a 0-entry vacuous import is backfilled to failed', async () => {
    // Mirrors the Lookma AB recovery path: 0-entry 'completed' rows are
    // backfilled to 'failed' by the same migration; the partial index
    // already excludes 'failed', so a fresh re-import succeeds.
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    const stuckId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    await getPool().query(
      `UPDATE public.sie_imports SET status = 'failed' WHERE id = $1`,
      [stuckId],
    )

    const newId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'pending',
      fiscalPeriodId,
    })
    expect(newId).toBeTruthy()
  })
})
