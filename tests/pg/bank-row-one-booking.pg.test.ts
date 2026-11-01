/**
 * One bank row, one booking, in the database (20261101023500): whatever a door
 * does, a row a posted verifikat books through a voucher link takes no pointer
 * at another verifikat, and neither anchor names a verifikat that can be no
 * bank row's movement. The application gate is decideBankRowRebooking; these
 * are the writes that get past it, a race or a door written tomorrow.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertCashAccount, insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'
import { getPool, withUserContext } from './setup'

async function company() {
  const seeded = await seedCompany()
  const cash = await insertCashAccount({ companyId: seeded.companyId, ledgerAccount: '1930', currency: 'SEK', isPrimary: true })
  return { ...seeded, cash }
}

type Seed = Awaited<ReturnType<typeof company>>

function bankEntry(s: Seed, overrides: { sourceType?: string } = {}) {
  return insertPostedJournalEntry({
    userId: s.userId,
    companyId: s.companyId,
    fiscalPeriodId: s.fiscalPeriodId,
    entryDate: '2026-03-10',
    description: 'Verifikat',
    ...overrides,
    lines: [
      { accountNumber: '1930', debitAmount: 700, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 700 },
    ],
  })
}

function row(s: Seed, journalEntryId: string | null = null) {
  return insertTransaction({
    companyId: s.companyId,
    userId: s.userId,
    date: '2026-03-10',
    amount: 700,
    cashAccountId: s.cash,
    journalEntryId,
  })
}

function link(s: Seed, tx: string, entry: string, role = 'bank_line') {
  return getPool().query(
    `INSERT INTO public.transaction_voucher_links (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, 700, $6)`,
    [randomUUID(), s.userId, s.companyId, tx, entry, role],
  )
}

const entryOwner = (s: Seed) => ({ userId: s.userId, companyId: s.companyId, fiscalPeriodId: s.fiscalPeriodId })

async function correctionOf(s: Seed, original: string, voucherNumber: number): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, correction_of_id)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-03-10', 'Rättelse', 'manual', 'draft', $6)`,
      [id, s.userId, s.companyId, s.fiscalPeriodId, voucherNumber, original],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '1930', 700, 0, 'SEK', 0), ($1, '3001', 0, 700, 'SEK', 1)`,
      [id],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const point = (tx: string, entry: string | null) =>
  getPool().query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx, entry])

describe('a pointer on a row booked through a voucher link', () => {
  it('is refused when a posted bank_line link names another verifikat', async () => {
    const s = await company()
    const tx = await row(s)
    await link(s, tx, await bankEntry(s))

    await expect(point(tx, await bankEntry(s))).rejects.toThrow(/already booked on verifikat/)
  })

  it('is allowed on the verifikat the link names: a bulk booking of one row writes both', async () => {
    const s = await company()
    const entry = await bankEntry(s)
    const tx = await row(s)
    await link(s, tx, entry)

    await expect(point(tx, entry)).resolves.toBeDefined()
  })

  it('is allowed once the linked verifikat is no longer posted: a correction moves the pointer first', async () => {
    const s = await company()
    const reversed = await bankEntry(s)
    const tx = await row(s)
    await link(s, tx, reversed)
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [reversed])

    await expect(point(tx, await bankEntry(s))).resolves.toBeDefined()
  })

  it('is allowed beside a supplementary link: a residual is no booking of the row', async () => {
    const s = await company()
    const tx = await row(s)
    await link(s, tx, await bankEntry(s), 'other')

    await expect(point(tx, await bankEntry(s))).resolves.toBeDefined()
  })

  it('lets delete_last_voucher take a row back from a correction: it moves the pointer before the link', async () => {
    const s = await company()
    const original = await insertPostedJournalEntry({ ...entryOwner(s), voucherNumber: 1 })
    const correction = await correctionOf(s, original, 2)
    const tx = await row(s, correction)
    await link(s, tx, correction)

    const anchors = await withUserContext(s.userId, async (client) => {
      await client.query(`SELECT public.delete_last_voucher($1::uuid, $2::uuid)`, [s.companyId, correction])
      const { rows } = await client.query(
        `SELECT t.journal_entry_id AS pointer, l.journal_entry_id AS link
           FROM public.transactions t
           JOIN public.transaction_voucher_links l ON l.transaction_id = t.id
          WHERE t.id = $1`,
        [tx],
      )
      return rows[0]
    })

    expect(anchors).toEqual({ pointer: original, link: original })
  })

  it('never stops a release: the pointer may always go', async () => {
    const s = await company()
    const entry = await bankEntry(s)
    const tx = await row(s, entry)
    await link(s, tx, await bankEntry(s))

    await expect(point(tx, null)).resolves.toBeDefined()
  })
})

describe('bank_row_posted_anchor', () => {
  async function anchor(s: Seed, tx: string, pointer: string | null, companyId = s.companyId) {
    const { rows } = await getPool().query<{ anchor: string | null }>(
      `SELECT public.bank_row_posted_anchor($1, $2, $3) AS anchor`,
      [companyId, tx, pointer],
    )
    return rows[0].anchor
  }

  it('names the pointer first, then a posted bank_line link, and nothing for a free row', async () => {
    const s = await company()
    const onPointer = await bankEntry(s)
    const onLink = await bankEntry(s)
    const tx = await row(s)

    expect(await anchor(s, tx, null)).toBeNull()
    await link(s, tx, onLink)
    expect(await anchor(s, tx, null)).toBe(onLink)
    expect(await anchor(s, tx, onPointer)).toBe(onPointer)
  })

  it('does not read a verifikat no longer posted, or a supplementary link, as a booking', async () => {
    const s = await company()
    const reversed = await bankEntry(s)
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [reversed])
    const tx = await row(s)
    await link(s, tx, await bankEntry(s), 'other')

    expect(await anchor(s, tx, reversed)).toBeNull()
  })

  it('reads inside the company it is asked about', async () => {
    const s = await company()
    const other = await company()
    const entry = await bankEntry(s)
    const tx = await row(s)
    await link(s, tx, entry)

    expect(await anchor(s, tx, entry, other.companyId)).toBeNull()
  })
})

describe('what can be a bank row\'s movement', () => {
  it.each(['storno', 'opening_balance'])('refuses a pointer at a %s', async (sourceType) => {
    const s = await company()
    const tx = await row(s)

    await expect(point(tx, await bankEntry(s, { sourceType }))).rejects.toThrow(/Cannot link a bank transaction/)
  })

  it.each(['storno', 'opening_balance'])('refuses a voucher link to a %s', async (sourceType) => {
    const s = await company()
    const tx = await row(s)

    await expect(link(s, tx, await bankEntry(s, { sourceType }))).rejects.toThrow(/Cannot link a bank transaction/)
  })

  it('leaves an old link alone: the guard fires when the anchor changes', async () => {
    const s = await company()
    const entry = await bankEntry(s)
    const tx = await row(s, entry)

    await expect(getPool().query(`UPDATE public.transactions SET is_business = true WHERE id = $1`, [tx])).resolves.toBeDefined()
  })
})
