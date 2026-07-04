import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertBalancedLines, seedCompany } from '@/tests/pg/fixtures'

// Post a journal entry with balanced lines, going through draft so the
// line-immutability + balance triggers are satisfied. Returns the entry id.
async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  notes?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status, notes)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-06-01', 'Test entry', 'manual', 'draft', $6)`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber, params.notes ?? null],
  )
  await insertBalancedLines(id)
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [id],
  )
  return id
}

describe('enforce_journal_entry_immutability.pg: notes-only edits', () => {
  it('allows setting notes on a posted entry (the reported bug)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })

    await getPool().query(
      `UPDATE public.journal_entries SET notes = $1 WHERE id = $2`,
      ['Underlag saknas, frågar kunden', entryId],
    )
    const after = await getPool().query<{ notes: string | null; status: string }>(
      `SELECT notes, status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(after.rows[0]!.notes).toBe('Underlag saknas, frågar kunden')
    expect(after.rows[0]!.status).toBe('posted')
  })

  it('allows clearing notes (set to NULL) on a posted entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, notes: 'existing note',
    })

    await getPool().query(
      `UPDATE public.journal_entries SET notes = NULL WHERE id = $1`,
      [entryId],
    )
    const after = await getPool().query<{ notes: string | null }>(
      `SELECT notes FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(after.rows[0]!.notes).toBeNull()
  })

  it('allows notes edits on a reversed entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [entryId],
    )

    await getPool().query(
      `UPDATE public.journal_entries SET notes = 'Makulerad pga dubbelbokning' WHERE id = $1`,
      [entryId],
    )
    const after = await getPool().query<{ notes: string | null; status: string }>(
      `SELECT notes, status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(after.rows[0]!.notes).toBe('Makulerad pga dubbelbokning')
    expect(after.rows[0]!.status).toBe('reversed')
  })

  it('still blocks editing a bookkeeping field on a posted entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET description = 'tampered' WHERE id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/Cannot modify a posted journal entry/i)
  })

  // Defense in depth: a real bookkeeping change must not slip through just
  // because `notes` also changed in the same UPDATE. The to_jsonb diff sees
  // the entry_date change and the whole statement is rejected.
  it('blocks a notes edit bundled with a bookkeeping field change', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })

    await expect(
      getPool().query(
        `UPDATE public.journal_entries
           SET notes = 'looks innocent', entry_date = '2026-07-01'
         WHERE id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/Cannot modify a posted journal entry/i)

    const after = await getPool().query<{ notes: string | null; entry_date: string }>(
      `SELECT notes, entry_date::text FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(after.rows[0]!.notes).toBeNull()
    expect(after.rows[0]!.entry_date).toBe('2026-06-01')
  })

  // Scope guard: notes carve-out does NOT override the period lock. Editing
  // notes on a committed entry in a locked period is still rejected by
  // enforce_period_lock (which fires after this trigger).
  it('still blocks notes edits when the fiscal period is locked', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
      [fiscalPeriodId],
    )

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET notes = 'too late' WHERE id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/locked\/closed fiscal period/i)
  })
})
