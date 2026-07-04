import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertDraftJournalEntry } from './fixtures'

// PR1 dimensions substrate (20260702084500_dimensions_substrate.sql):
// registry tables + RLS, ensure_company_dimensions RPC, registry guard
// triggers, jel.dimensions column + CHECK, and: the load-bearing property:
// that the dimensions map on a POSTED line is frozen by the existing
// line-immutability trigger with zero new triggers.

async function seedWithDimensions() {
  const seeded = await seedCompany()
  await getPool().query(`SELECT public.ensure_company_dimensions($1)`, [seeded.companyId])
  return seeded
}

async function getDimensionId(companyId: string, sieDimNo: number): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT id FROM public.dimensions WHERE company_id = $1 AND sie_dim_no = $2`,
    [companyId, sieDimNo],
  )
  return rows[0].id
}

async function insertValue(params: {
  companyId: string
  dimensionId: string
  code: string
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.dimension_values (id, company_id, dimension_id, code, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, params.companyId, params.dimensionId, params.code, params.name ?? params.code],
  )
  return id
}

// Insert a balanced line pair where the debit line carries a dimensions map.
async function insertDimensionedLines(
  journalEntryId: string,
  dimensions: Record<string, string>,
  amount = 1000,
): Promise<string> {
  const lineId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (id, journal_entry_id, account_number, debit_amount, credit_amount, dimensions)
     VALUES ($1, $2, '4010', $3, 0, $4),
            (gen_random_uuid(), $2, '1930', 0, $3, '{}')`,
    [
      lineId,
      journalEntryId,
      amount,
      JSON.stringify(dimensions),
    ],
  )
  return lineId
}

async function commitEntry(companyId: string, journalEntryId: string): Promise<void> {
  await getPool().query(
    `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
    [companyId, journalEntryId],
  )
}

describe('ensure_company_dimensions', () => {
  it('creates system dims 1 and 6 idempotently', async () => {
    const { companyId } = await seedCompany()
    await getPool().query(`SELECT public.ensure_company_dimensions($1)`, [companyId])
    await getPool().query(`SELECT public.ensure_company_dimensions($1)`, [companyId])

    const { rows } = await getPool().query(
      `SELECT sie_dim_no, name, resets_annually, is_system
       FROM public.dimensions WHERE company_id = $1 ORDER BY sie_dim_no`,
      [companyId],
    )
    expect(rows).toEqual([
      { sie_dim_no: 1, name: 'Kostnadsställe', resets_annually: true, is_system: true },
      { sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true },
    ])
  })

  it('rejects an authenticated caller who is not a member of the company', async () => {
    const { companyId } = await seedCompany()
    const outsider = await seedCompany()

    await expect(
      withUserContext(outsider.userId, (client) =>
        client.query(`SELECT public.ensure_company_dimensions($1)`, [companyId]),
      ),
    ).rejects.toThrow(/not a member/)
  })

  it('allows a member to call it through RLS context', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      await client.query(`SELECT public.ensure_company_dimensions($1)`, [companyId])
      const { rows } = await client.query(
        `SELECT sie_dim_no FROM public.dimensions WHERE company_id = $1 ORDER BY sie_dim_no`,
        [companyId],
      )
      expect(rows.map((r) => r.sie_dim_no)).toEqual([1, 6])
    })
  })
})

describe('registry RLS', () => {
  it('hides other companies dimensions and blocks cross-company inserts', async () => {
    const a = await seedWithDimensions()
    const b = await seedWithDimensions()

    await withUserContext(a.userId, async (client) => {
      const { rows } = await client.query(`SELECT company_id FROM public.dimensions`)
      expect(rows.every((r) => r.company_id === a.companyId)).toBe(true)

      const dimId = await getDimensionId(b.companyId, 6)
      await expect(
        client.query(
          `INSERT INTO public.dimension_values (company_id, dimension_id, code, name)
           VALUES ($1, $2, 'X', 'X')`,
          [b.companyId, dimId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  it('lets a member manage values in their own company (incl. DELETE)', async () => {
    const { userId, companyId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)

    await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.dimension_values (company_id, dimension_id, code, name)
         VALUES ($1, $2, 'P001', 'Projekt Alpha')`,
        [companyId, dimId],
      )
      await client.query(
        `UPDATE public.dimension_values SET is_active = false
         WHERE company_id = $1 AND code = 'P001'`,
        [companyId],
      )
      const del = await client.query(
        `DELETE FROM public.dimension_values WHERE company_id = $1 AND code = 'P001'`,
        [companyId],
      )
      expect(del.rowCount).toBe(1)
    })
  })
})

describe('registry guard triggers', () => {
  it('blocks deleting a system dimension', async () => {
    const { companyId } = await seedWithDimensions()
    await expect(
      getPool().query(
        `DELETE FROM public.dimensions WHERE company_id = $1 AND sie_dim_no = 6`,
        [companyId],
      ),
    ).rejects.toThrow(/kan inte tas bort/)
  })

  it('blocks renumbering a dimension', async () => {
    const { companyId } = await seedWithDimensions()
    await expect(
      getPool().query(
        `UPDATE public.dimensions SET sie_dim_no = 7 WHERE company_id = $1 AND sie_dim_no = 6`,
        [companyId],
      ),
    ).rejects.toThrow(/kan inte ändras/)
  })

  it('code CHECK forbids SIE-framing-breaking characters', async () => {
    const { companyId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)
    await expect(
      insertValue({ companyId, dimensionId: dimId, code: 'P"1' }),
    ).rejects.toThrow(/check/i)
  })
})

describe('dimension_values retention', () => {
  it('blocks deleting a value referenced by a posted line, allows unreferenced', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)
    await insertValue({ companyId, dimensionId: dimId, code: 'P001' })
    await insertValue({ companyId, dimensionId: dimId, code: 'P002' })

    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertDimensionedLines(entryId, { '6': 'P001' })
    await commitEntry(companyId, entryId)

    await expect(
      getPool().query(
        `DELETE FROM public.dimension_values WHERE company_id = $1 AND code = 'P001'`,
        [companyId],
      ),
    ).rejects.toThrow(/arkivera/)

    const del = await getPool().query(
      `DELETE FROM public.dimension_values WHERE company_id = $1 AND code = 'P002'`,
      [companyId],
    )
    expect(del.rowCount).toBe(1)
  })

  it('blocks deleting a non-system dimension whose number is on posted lines (cascade path)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedWithDimensions()
    // Custom dim 20 with a tagged, posted line
    await getPool().query(
      `INSERT INTO public.dimensions (company_id, sie_dim_no, name) VALUES ($1, 20, 'Avdelning')`,
      [companyId],
    )
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertDimensionedLines(entryId, { '20': 'SYD' })
    await commitEntry(companyId, entryId)

    await expect(
      getPool().query(
        `DELETE FROM public.dimensions WHERE company_id = $1 AND sie_dim_no = 20`,
        [companyId],
      ),
    ).rejects.toThrow(/kan inte tas bort/)
  })
})

describe('journal_entry_lines.dimensions', () => {
  it('rejects non-object values via CHECK', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await expect(
      getPool().query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, dimensions)
         VALUES ($1, '1930', 100, 0, '["not","a","map"]')`,
        [entryId],
      ),
    ).rejects.toThrow(/jel_dimensions_is_object/)
  })

  it('defaults to {} so dimension-less writers stay valid', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 100, 0), ($1, '3001', 0, 100)`,
      [entryId],
    )
    const { rows } = await getPool().query(
      `SELECT dimensions FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(rows.map((r) => r.dimensions)).toEqual([{}, {}])
  })

  it('is mutable on drafts but frozen on posted lines (inherits immutability)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)
    await insertValue({ companyId, dimensionId: dimId, code: 'P001' })

    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    const lineId = await insertDimensionedLines(entryId, { '6': 'P001' })

    // Draft: retagging is allowed (PR9: the bag alone: mirrors generate)
    await getPool().query(
      `UPDATE public.journal_entry_lines SET dimensions = '{"6":"P002"}' WHERE id = $1`,
      [lineId],
    )

    await commitEntry(companyId, entryId)

    // Posted: ANY update of the dimensions map is blocked by the existing trigger
    await expect(
      getPool().query(
        `UPDATE public.journal_entry_lines SET dimensions = '{"6":"P999"}' WHERE id = $1`,
        [lineId],
      ),
    ).rejects.toThrow(/Cannot UPDATE lines of a posted journal entry/)

    // And the committed map survived intact
    const { rows } = await getPool().query(
      `SELECT dimensions, cost_center, project FROM public.journal_entry_lines WHERE id = $1`,
      [lineId],
    )
    expect(rows[0].dimensions).toEqual({ '6': 'P002' })
    expect(rows[0].project).toBe('P002')
    expect(rows[0].cost_center).toBeNull()
  })
})
