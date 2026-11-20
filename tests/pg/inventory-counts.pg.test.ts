/**
 * pg-real tests for 20261029233000_inventory_counts.sql: the year-end stock
 * count (inventeringslista, LIV 1955:257). Locks in:
 *   - RLS: a company sees only its own counts and rows; a viewer reads but
 *     does not write;
 *   - a count off balansdagen needs its roll-forward note (CHECK);
 *   - a signed list is frozen: its rows and dates never change, it is never
 *     deleted, and it only moves on to booked; a booked count never changes;
 *   - a draft out for BankID signing keeps its rows;
 *   - one booked count per fiscal year;
 *   - a row cannot be hung on another company's count;
 *   - the two pending operation types are allowed.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'

let companyA: { userId: string; companyId: string; fiscalPeriodId: string }
let companyB: { userId: string; companyId: string; fiscalPeriodId: string }

async function insertCount(
  company: { userId: string; companyId: string; fiscalPeriodId: string },
  overrides: { countDate?: string; rollForward?: string | null } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.inventory_counts (id, company_id, user_id, fiscal_period_id, balance_date, count_date, roll_forward_note)
     VALUES ($1, $2, $3, $4, '2026-12-31', $5, $6)`,
    [id, company.companyId, company.userId, company.fiscalPeriodId, overrides.countDate ?? '2026-12-31', overrides.rollForward ?? null],
  )
  return id
}

async function insertRow(companyId: string, countId: string, position = 1): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.inventory_count_rows (id, company_id, inventory_count_id, position, description, quantity, unit_cost, value)
     VALUES ($1, $2, $3, $4, 'Kaffe 500 g', 10, 100, 1000)`,
    [id, companyId, countId, position],
  )
  return id
}

async function sign(countId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.inventory_counts SET status = 'signed', signer_name = 'Anna Svensson', signed_at = now() WHERE id = $1`,
    [countId],
  )
}

beforeAll(async () => {
  companyA = await seedCompany()
  companyB = await seedCompany()
})

describe('inventory counts: schema', () => {
  it('needs the roll-forward note when the stock was counted on another day', async () => {
    await expect(insertCount(companyA, { countDate: '2027-01-04' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertCount(companyA, { countDate: '2027-01-04', rollForward: 'Inleveranser 1-4 jan avräknade' })).resolves.toBeTruthy()
  })

  it('refuses a negative quantity and a write-down over 100 %', async () => {
    const countId = await insertCount(companyA)
    await expect(getPool().query(
      `INSERT INTO public.inventory_count_rows (company_id, inventory_count_id, position, description, quantity, unit_cost, value)
       VALUES ($1, $2, 1, 'X', -1, 1, 0)`,
      [companyA.companyId, countId],
    )).rejects.toMatchObject({ code: '23514' })
    await expect(getPool().query(
      `INSERT INTO public.inventory_count_rows (company_id, inventory_count_id, position, description, quantity, unit_cost, write_down_percent, value)
       VALUES ($1, $2, 1, 'X', 1, 1, 101, 0)`,
      [companyA.companyId, countId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('allows the two pending operation types', async () => {
    const res = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.pending_operations'::regclass AND conname = 'pending_operations_operation_type_check'`,
    )
    expect(res.rows[0]?.def).toContain('save_inventory_count')
    expect(res.rows[0]?.def).toContain('book_inventory_count')
  })
})

describe('inventory counts: RLS', () => {
  it('shows a company only its own counts and rows', async () => {
    const countId = await insertCount(companyA)
    await insertRow(companyA.companyId, countId)
    const seenByB = await withUserContext(companyB.userId, async (client) => ({
      counts: (await client.query('SELECT id FROM public.inventory_counts WHERE id = $1', [countId])).rowCount,
      rows: (await client.query('SELECT id FROM public.inventory_count_rows WHERE inventory_count_id = $1', [countId])).rowCount,
    }))
    const seenByA = await withUserContext(companyA.userId, async (client) =>
      (await client.query('SELECT id FROM public.inventory_counts WHERE id = $1', [countId])).rowCount)
    expect(seenByB).toEqual({ counts: 0, rows: 0 })
    expect(seenByA).toBe(1)
  })

  it('refuses a row hung on another company\'s count', async () => {
    const countId = await insertCount(companyA)
    await expect(withUserContext(companyB.userId, (client) => client.query(
      `INSERT INTO public.inventory_count_rows (company_id, inventory_count_id, position, description, quantity, unit_cost, value)
       VALUES ($1, $2, 1, 'Smuggel', 1, 1, 1)`,
      [companyB.companyId, countId],
    ))).rejects.toBeTruthy()
    const rows = await getPool().query('SELECT id FROM public.inventory_count_rows WHERE inventory_count_id = $1', [countId])
    expect(rows.rowCount).toBe(0)
  })

  it('lets a viewer read the counts but not write them', async () => {
    const countId = await insertCount(companyA)
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: companyA.companyId, userId: viewerId, role: 'viewer' })
    const seen = await withUserContext(viewerId, async (client) =>
      (await client.query('SELECT id FROM public.inventory_counts WHERE id = $1', [countId])).rowCount)
    expect(seen).toBe(1)
    await expect(withUserContext(viewerId, (client) =>
      client.query(`UPDATE public.inventory_counts SET note = 'Ändrad' WHERE id = $1`, [countId]),
    )).rejects.toMatchObject({ code: '42501' })
  })
})

describe('inventory counts: a signed list is frozen', () => {
  it('lets a draft change and be deleted, rows included', async () => {
    const countId = await insertCount(companyA)
    const rowId = await insertRow(companyA.companyId, countId)
    await getPool().query(`UPDATE public.inventory_count_rows SET quantity = 12, value = 1200 WHERE id = $1`, [rowId])
    const deleted = await withUserContext(companyA.userId, async (client) =>
      (await client.query('DELETE FROM public.inventory_counts WHERE id = $1', [countId])).rowCount)
    expect(deleted).toBe(1)
  })

  it('keeps the rows of a draft that is out for BankID signing', async () => {
    const countId = await insertCount(companyA)
    const rowId = await insertRow(companyA.companyId, countId)
    // The request signs the archived PDF of the list.
    const docId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
       VALUES ($1, $2, $3, 'Inventeringslista.pdf', 'application/pdf', 2048, $4, $5, 'file_upload')`,
      [docId, companyA.userId, companyA.companyId, `documents/${companyA.companyId}/${docId}.pdf`, 'a'.repeat(64)],
    )
    const requestId = randomUUID()
    await getPool().query(
      `INSERT INTO public.signing_requests (id, company_id, created_by, created_via, document_id, document_sha256, title, expires_at)
       VALUES ($1, $2, $3, 'app', $4, $5, 'Inventeringslista', now() + interval '14 days')`,
      [requestId, companyA.companyId, companyA.userId, docId, 'a'.repeat(64)],
    )
    await getPool().query(`UPDATE public.inventory_counts SET signing_request_id = $2 WHERE id = $1`, [countId, requestId])
    await expect(getPool().query(`UPDATE public.inventory_count_rows SET quantity = 1 WHERE id = $1`, [rowId]))
      .rejects.toThrow(/INVENTORY_COUNT_LOCKED/)
  })

  it('never jumps from draft to booked', async () => {
    const countId = await insertCount(companyA)
    await expect(getPool().query(
      `UPDATE public.inventory_counts SET status = 'booked', signer_name = 'A', signed_at = now(), booked_at = now() WHERE id = $1`,
      [countId],
    )).rejects.toThrow(/INVENTORY_COUNT_NOT_SIGNED/)
  })

  it('refuses changes to a signed list, its rows and its deletion', async () => {
    const countId = await insertCount(companyA)
    const rowId = await insertRow(companyA.companyId, countId)
    await sign(countId)
    await expect(getPool().query(`UPDATE public.inventory_count_rows SET quantity = 1 WHERE id = $1`, [rowId]))
      .rejects.toThrow(/INVENTORY_COUNT_LOCKED/)
    await expect(getPool().query(`DELETE FROM public.inventory_count_rows WHERE id = $1`, [rowId]))
      .rejects.toThrow(/INVENTORY_COUNT_LOCKED/)
    await expect(insertRow(companyA.companyId, countId, 2)).rejects.toThrow(/INVENTORY_COUNT_LOCKED/)
    await expect(getPool().query(`UPDATE public.inventory_counts SET count_date = '2026-12-30', roll_forward_note = 'x' WHERE id = $1`, [countId]))
      .rejects.toThrow(/INVENTORY_COUNT_LOCKED/)
    await expect(getPool().query(`UPDATE public.inventory_counts SET status = 'draft' WHERE id = $1`, [countId]))
      .rejects.toThrow(/INVENTORY_COUNT_LOCKED/)
    await expect(getPool().query(`DELETE FROM public.inventory_counts WHERE id = $1`, [countId]))
      .rejects.toThrow(/INVENTORY_COUNT_LOCKED/)
    const policyHidden = await withUserContext(companyA.userId, async (client) =>
      (await client.query('DELETE FROM public.inventory_counts WHERE id = $1', [countId])).rowCount)
    expect(policyHidden).toBe(0)
  })

  it('books a signed count once per fiscal year and never changes it after', async () => {
    const period = companyA
    const first = await insertCount(period)
    await insertRow(companyA.companyId, first)
    await sign(first)
    const entryId = await insertPostedJournalEntry({
      userId: companyA.userId,
      companyId: companyA.companyId,
      fiscalPeriodId: companyA.fiscalPeriodId,
    })
    await getPool().query(
      `UPDATE public.inventory_counts SET status = 'booked', journal_entry_id = $2, booked_at = now() WHERE id = $1`,
      [first, entryId],
    )
    await expect(getPool().query(`UPDATE public.inventory_counts SET note = 'efteråt' WHERE id = $1`, [first]))
      .rejects.toThrow(/INVENTORY_COUNT_LOCKED/)
    await expect(getPool().query(`UPDATE public.inventory_counts SET journal_entry_id = NULL WHERE id = $1`, [first]))
      .rejects.toThrow(/INVENTORY_COUNT_LOCKED/)

    const second = await insertCount(period)
    await sign(second)
    await expect(getPool().query(
      `UPDATE public.inventory_counts SET status = 'booked', booked_at = now() WHERE id = $1`,
      [second],
    )).rejects.toMatchObject({ code: '23505' })
  })
})
