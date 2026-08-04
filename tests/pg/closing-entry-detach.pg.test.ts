import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { seedCompany, insertDraftJournalEntry } from './fixtures'

// Escape hatch in enforce_opening_balance_immutability (migration
// 20260720140000): closing_entry_id may only change once set when the
// previously referenced closing entry is status='reversed' AND a posted
// storno entry with reverses_id pointing at it exists (the chain only the
// engine's reverseEntry() produces). A non-NULL replacement must be a posted
// year_end entry in the same company and period. Used by the administrative
// year-end undo flow (scripts/undo-year-end-closing.ts).

async function insertStornoOf(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  reversesId: string
  voucherNumber: number
  status?: string
  sourceType?: string
}): Promise<string> {
  const id = randomUUID()
  const status = params.status ?? 'posted'
  const client = await getPool().connect()

  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-12-31', 'Makulering', $6, $7, $8)`,
      [
        id,
        params.userId,
        params.companyId,
        params.fiscalPeriodId,
        params.voucherNumber,
        params.sourceType ?? 'storno',
        status,
        params.reversesId,
      ],
    )

    if (status === 'posted') {
      // Mirror the default closing-entry fixture so the storno is a valid,
      // balanced voucher while this suite focuses on the reversal chain.
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, '3001', 1000, 0),
                ($1, '1930', 0, 1000)`,
        [id],
      )
      await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
    }

    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

describe('closing_entry_id detach escape hatch', () => {
  let companyId: string
  let userId: string
  let fiscalPeriodId: string
  let closingEntryId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    companyId = seeded.companyId
    userId = seeded.userId
    fiscalPeriodId = seeded.fiscalPeriodId

    closingEntryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-12-31',
      description: 'Årsbokslut',
      sourceType: 'year_end',
      status: 'posted',
      voucherNumber: 1,
    })

    await getPool().query(
      `UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`,
      [closingEntryId, fiscalPeriodId],
    )
  })

  it('blocks detaching a posted (live) closing entry', async () => {
    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods SET closing_entry_id = NULL WHERE id = $1`,
        [fiscalPeriodId],
      ),
    ).rejects.toThrow(/year-end closing is immutable/)
  })

  it('blocks detaching when status is reversed but no storno chain exists', async () => {
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [closingEntryId],
    )

    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods SET closing_entry_id = NULL WHERE id = $1`,
        [fiscalPeriodId],
      ),
    ).rejects.toThrow(/year-end closing is immutable/)
  })

  it('blocks the escape hatch when the storno is not posted', async () => {
    // closingEntryId is status='reversed' from the previous test.
    await insertStornoOf({
      userId,
      companyId,
      fiscalPeriodId,
      reversesId: closingEntryId,
      voucherNumber: 2,
      status: 'cancelled',
    })

    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods SET closing_entry_id = NULL WHERE id = $1`,
        [fiscalPeriodId],
      ),
    ).rejects.toThrow(/year-end closing is immutable/)
  })

  it('blocks replacing a reversed closing entry with a non-year_end entry', async () => {
    // Complete the storno chain so the reversal itself is now legitimate.
    await insertStornoOf({
      userId,
      companyId,
      fiscalPeriodId,
      reversesId: closingEntryId,
      voucherNumber: 3,
    })

    const manualId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-12-31',
      sourceType: 'manual',
      status: 'posted',
      voucherNumber: 4,
    })

    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`,
        [manualId, fiscalPeriodId],
      ),
    ).rejects.toThrow(/must reference a posted year_end entry/)
  })

  it('allows detaching once the closing entry is reversed with a posted storno', async () => {
    await getPool().query(
      `UPDATE public.fiscal_periods SET closing_entry_id = NULL WHERE id = $1`,
      [fiscalPeriodId],
    )

    const { rows } = await getPool().query(
      `SELECT closing_entry_id FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(rows[0].closing_entry_id).toBeNull()
  })

  it('still allows setting closing_entry_id from NULL (normal year-end run)', async () => {
    const newClosingId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-12-31',
      sourceType: 'year_end',
      status: 'posted',
      voucherNumber: 5,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`,
      [newClosingId, fiscalPeriodId],
    )
    const { rows } = await getPool().query(
      `SELECT closing_entry_id FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(rows[0].closing_entry_id).toBe(newClosingId)
  })

  it('allows replacing a properly reversed closing entry with a posted year_end entry', async () => {
    // Reverse the current closing entry with a full storno chain, then swap
    // directly to a new posted year_end entry (re-run without detach first).
    const { rows: current } = await getPool().query(
      `SELECT closing_entry_id FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    const currentClosingId = current[0].closing_entry_id

    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [currentClosingId],
    )
    await insertStornoOf({
      userId,
      companyId,
      fiscalPeriodId,
      reversesId: currentClosingId,
      voucherNumber: 6,
    })

    const replacementId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-12-31',
      sourceType: 'year_end',
      status: 'posted',
      voucherNumber: 7,
    })

    await getPool().query(
      `UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`,
      [replacementId, fiscalPeriodId],
    )
    const { rows } = await getPool().query(
      `SELECT closing_entry_id FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(rows[0].closing_entry_id).toBe(replacementId)
  })

  it('opening balance immutability is unchanged', async () => {
    const ibEntryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-01-01',
      sourceType: 'opening_balance',
      status: 'posted',
      voucherNumber: 8,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods
       SET opening_balance_entry_id = $1, opening_balances_set = true
       WHERE id = $2`,
      [ibEntryId, fiscalPeriodId],
    )

    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL WHERE id = $1`,
        [fiscalPeriodId],
      ),
    ).rejects.toThrow(/opening balances are immutable/)
  })
})
