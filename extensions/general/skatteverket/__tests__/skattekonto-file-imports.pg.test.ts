import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * RLS + constraint smoke for skattekonto_file_imports and the provenance
 * columns migration 20260817120000 added to skattekonto_transactions.
 */

async function insertFileImport(params: {
  companyId: string
  userId: string
  fileHash?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.skattekonto_file_imports
       (id, company_id, user_id, filename, file_hash, file_variant)
     VALUES ($1, $2, $3, 'Kontoutdrag.csv', $4, 'csv')`,
    [id, params.companyId, params.userId, params.fileHash ?? randomUUID().replace(/-/g, '')],
  )
  return id
}

describe('skattekonto_file_imports.pg: RLS and constraints', () => {
  it('a user only sees import records for their own company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertFileImport({ companyId: a.companyId, userId: a.userId })
    await insertFileImport({ companyId: b.companyId, userId: b.userId })

    const rows = await withUserContext(a.userId, async (client) => {
      const res = await client.query<{ company_id: string }>(
        `SELECT company_id FROM public.skattekonto_file_imports`,
      )
      return res.rows
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.company_id).toBe(a.companyId)
  })

  it('blocks inserting an import record into another tenant', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await expect(
      withUserContext(a.userId, async (client) => {
        return client.query(
          `INSERT INTO public.skattekonto_file_imports
             (company_id, user_id, filename, file_hash, file_variant)
           VALUES ($1, $2, 'x.csv', 'hash-x', 'csv')`,
          [b.companyId, a.userId],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('enforces unique (company_id, file_hash) but allows the same hash across tenants', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertFileImport({ companyId: a.companyId, userId: a.userId, fileHash: 'same-hash' })
    await expect(
      insertFileImport({ companyId: a.companyId, userId: a.userId, fileHash: 'same-hash' }),
    ).rejects.toThrow(/duplicate key|unique/i)
    await expect(
      insertFileImport({ companyId: b.companyId, userId: b.userId, fileHash: 'same-hash' }),
    ).resolves.toBeDefined()
  })

  it('rejects unknown file variants and statuses', async () => {
    const a = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.skattekonto_file_imports
           (company_id, user_id, filename, file_hash, file_variant)
         VALUES ($1, $2, 'x.xlsx', 'hash-v', 'xlsx')`,
        [a.companyId, a.userId],
      ),
    ).rejects.toThrow(/check constraint/i)
  })
})

describe('skattekonto_transactions.pg: provenance columns', () => {
  it('defaults source to api and rejects unknown sources', async () => {
    const a = await seedCompany()
    const res = await getPool().query<{ source: string }>(
      `INSERT INTO public.skattekonto_transactions
         (company_id, dedup_key, transaktionsdatum, transaktionstext, belopp_skatteverket, status)
       VALUES ($1, 'id:777', '2026-04-15', 'Test', -100, 'booked')
       RETURNING source`,
      [a.companyId],
    )
    expect(res.rows[0]!.source).toBe('api')

    await expect(
      getPool().query(
        `INSERT INTO public.skattekonto_transactions
           (company_id, dedup_key, transaktionsdatum, transaktionstext, belopp_skatteverket, status, source)
         VALUES ($1, 'id:778', '2026-04-15', 'Test', -100, 'booked', 'smoke_signals')`,
        [a.companyId],
      ),
    ).rejects.toThrow(/check constraint/i)
  })

  it('nulls file_import_id when the import record is deleted, keeping the row', async () => {
    const a = await seedCompany()
    const importId = await insertFileImport({ companyId: a.companyId, userId: a.userId })
    const txId = randomUUID()
    await getPool().query(
      `INSERT INTO public.skattekonto_transactions
         (id, company_id, dedup_key, transaktionsdatum, transaktionstext,
          belopp_skatteverket, status, source, file_import_id)
       VALUES ($1, $2, 'h:abc', '2026-06-06', 'Kostnadsränta', -10, 'booked', 'file_import', $3)`,
      [txId, a.companyId, importId],
    )

    await getPool().query(`DELETE FROM public.skattekonto_file_imports WHERE id = $1`, [importId])

    const res = await getPool().query<{ file_import_id: string | null; source: string }>(
      `SELECT file_import_id, source FROM public.skattekonto_transactions WHERE id = $1`,
      [txId],
    )
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.file_import_id).toBeNull()
    expect(res.rows[0]!.source).toBe('file_import')
  })
})
