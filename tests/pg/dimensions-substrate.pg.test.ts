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

// 20260928200100: tagged lines reference a value by its (sie_dim_no, code)
// text, so a value's code, dimension and company are immutable.
describe('dimension_values identity guard', () => {
  it('blocks changing a value code, dimension or company; other columns stay editable', async () => {
    const a = await seedWithDimensions()
    const b = await seedWithDimensions()
    const aDim6 = await getDimensionId(a.companyId, 6)
    const aDim1 = await getDimensionId(a.companyId, 1)
    const bDim6 = await getDimensionId(b.companyId, 6)
    const valueId = await insertValue({ companyId: a.companyId, dimensionId: aDim6, code: 'P001' })

    const renamed = (await getPool()
      .query(`UPDATE public.dimension_values SET code = 'P999' WHERE id = $1`, [valueId])
      .then(
        () => null,
        (err: { code?: string; message: string }) => err,
      )) as { code?: string; message: string } | null
    expect(renamed?.code).toBe('P0001')
    expect(renamed?.message).toMatch(/kan inte ändras/)

    await expect(
      getPool().query(`UPDATE public.dimension_values SET dimension_id = $2 WHERE id = $1`, [
        valueId,
        aDim1,
      ]),
    ).rejects.toThrow(/kan inte flyttas/)
    await expect(
      getPool().query(
        `UPDATE public.dimension_values SET company_id = $2, dimension_id = $3 WHERE id = $1`,
        [valueId, b.companyId, bDim6],
      ),
    ).rejects.toThrow(/kan inte flyttas/)

    // What the value routes do write stays writable, and naming an identity
    // column without changing it is a no-op.
    await getPool().query(
      `UPDATE public.dimension_values
          SET name = 'Projekt Alfa', is_active = false, start_date = '2026-01-01',
              end_date = '2026-12-31', attributes = '{"ansvarig":"Eva"}', code = code
        WHERE id = $1`,
      [valueId],
    )
    const { rows } = await getPool().query(
      `SELECT code, name, is_active, company_id, dimension_id FROM public.dimension_values WHERE id = $1`,
      [valueId],
    )
    expect(rows[0]).toMatchObject({
      code: 'P001',
      name: 'Projekt Alfa',
      is_active: false,
      company_id: a.companyId,
      dimension_id: aDim6,
    })
  })

  it('refuses the rename from a writer session, so a tagged value can never slip past the retention guard', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)
    await insertValue({ companyId, dimensionId: dimId, code: 'P001' })
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertDimensionedLines(entryId, { '6': 'P001' })
    await commitEntry(companyId, entryId)

    // The PostgREST shape of the old hole: a writer PATCHes the code, which
    // would orphan the posted tag and leave the renamed row deletable.
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `UPDATE public.dimension_values SET code = 'P002' WHERE company_id = $1 AND code = 'P001'`,
          [companyId],
        ),
      ).rejects.toThrow(/kan inte ändras/)
    })

    await expect(
      getPool().query(
        `DELETE FROM public.dimension_values WHERE company_id = $1 AND code = 'P001'`,
        [companyId],
      ),
    ).rejects.toThrow(/arkivera/)
  })

  it('lets the parent_value_id ON DELETE SET NULL cascade through', async () => {
    const { companyId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)
    const parentId = await insertValue({ companyId, dimensionId: dimId, code: 'P100' })
    const childId = await insertValue({ companyId, dimensionId: dimId, code: 'P101' })
    await getPool().query(`UPDATE public.dimension_values SET parent_value_id = $2 WHERE id = $1`, [
      childId,
      parentId,
    ])

    await getPool().query(`DELETE FROM public.dimension_values WHERE id = $1`, [parentId])

    const { rows } = await getPool().query(
      `SELECT code, parent_value_id FROM public.dimension_values WHERE id = $1`,
      [childId],
    )
    expect(rows).toEqual([{ code: 'P101', parent_value_id: null }])
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

  // 20260928200200: the bag contract of DimensionsBagSchema and the
  // dimension_values.code CHECK, now enforced for every writer.
  it('rejects malformed bags on INSERT and UPDATE via jel_dimensions_well_formed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    const malformed = [
      '{"1":null}', // JSON null
      '{"x":"KS01"}', // not a dimension number
      '{"01":"KS01"}', // non-canonical number
      '{"0":"KS01"}', // there is no dimension 0
      '{"1":5}', // a number, not a code
      '{"1":{"a":"b"}}', // nested object
      '{"1":["KS01"]}', // array
      '{"1":""}', // empty code
      '{"1":"K\\"S"}', // characters that break SIE field framing
      '{"1":"K{S"}',
      '{"1":"K}S"}',
      JSON.stringify({ '1': 'K'.repeat(41) }), // longer than a registry code
      '{"1":"KS01","6":7}', // one bad pair spoils the bag
    ]
    for (const bag of malformed) {
      await expect(
        getPool().query(
          `INSERT INTO public.journal_entry_lines
             (journal_entry_id, account_number, debit_amount, credit_amount, dimensions)
           VALUES ($1, '1930', 100, 0, $2::jsonb)`,
          [entryId, bag],
        ),
        bag,
      ).rejects.toThrow(/jel_dimensions_well_formed/)
    }

    // A NOT VALID constraint still guards every new row version.
    const lineId = await insertDimensionedLines(entryId, { '6': 'P001' })
    await expect(
      getPool().query(
        `UPDATE public.journal_entry_lines SET dimensions = '{"6":5}'::jsonb WHERE id = $1`,
        [lineId],
      ),
    ).rejects.toThrow(/jel_dimensions_well_formed/)
  })

  it('accepts {} and every bag the registry code CHECK accepts', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    const wellFormed: Record<string, string>[] = [
      {},
      { '1': 'KS01' },
      { '1': 'KS01', '6': 'P001', '20': 'SYD' },
      { '6': 'Å'.repeat(40) }, // 40 characters, 80 bytes: counted in characters
      { '6': 'P 001 (gammal)' },
    ]
    for (const bag of wellFormed) {
      const lineId = await insertDimensionedLines(entryId, bag)
      const { rows } = await getPool().query(
        `SELECT dimensions FROM public.journal_entry_lines WHERE id = $1`,
        [lineId],
      )
      expect(rows[0].dimensions).toEqual(bag)
    }
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

describe('company_settings.dimensions_enabled', () => {
  // 20260928200200: the old comment claimed the flag is never load-bearing;
  // validateEntryDimensions skips registry validation while it is off.
  it('documents that the flag gates registry validation', async () => {
    const { rows } = await getPool().query<{ comment: string }>(
      `SELECT col_description('public.company_settings'::regclass, a.attnum) AS comment
         FROM pg_attribute a
        WHERE a.attrelid = 'public.company_settings'::regclass
          AND a.attname = 'dimensions_enabled'`,
    )
    expect(rows[0].comment).toMatch(/validateEntryDimensions/)
    expect(rows[0].comment).not.toMatch(/never load-bearing/i)
  })
})
