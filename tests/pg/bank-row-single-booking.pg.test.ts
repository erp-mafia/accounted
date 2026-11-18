/**
 * #205: a bank row is booked once, decided where the verifikat is posted.
 *
 * A booking door asks the gate, posts the verifikat, then claims the row in a
 * second write. Two bookings of one row that both passed the gate were both
 * posted (a double submit, two tabs), and a verifikat whose claim never
 * landed was booked beside again. The verifikat names its bank rows in the
 * transaction that posts it (bank_booking_context); guard_bank_row_single_booking
 * now refuses the posting when another posted verifikat already books one of
 * them, under the company and row locks the posting holds. On real Postgres:
 *
 *   - a second verifikat booked from the row is refused at commit_journal_entry,
 *     stays a draft and uses no voucher number;
 *   - so is one over a row another verifikat names only in its context, or
 *     that a pointer or a bank_line link books; a supplementary link does not
 *     book the row;
 *   - a storno opens the row again; a correction does not, it books the
 *     money on;
 *   - two commits at once: the second waits for the first and is refused;
 *   - a pair posted before this rule stays, and a third booking is refused.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { insertPostedBankJournalEntry, insertTransaction } from './fixtures'
import { AMOUNT, DATE, bankLines, books, correctionOf, entry, link, reverse, setPointer, type Books } from './bank-row-shapes'

const BOOKED = { code: 'PT409', message: 'BANK_ROW_ALREADY_BOOKED' }

async function bankRow(b: Books): Promise<string> {
  return insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: -AMOUNT, cashAccountId: b.cash })
}

/** The row as a door declares it in bank_booking_context. */
async function contextOf(txs: string[]) {
  const { rows } = await getPool().query(
    `SELECT t.id AS transaction_id, t.cash_account_id, t.date::text AS date, t.amount::float8 AS amount,
            COALESCE(t.currency, 'SEK') AS currency,
            public.bank_anchor_settlement_account(t.company_id, t.cash_account_id, t.currency) AS settlement_account
       FROM public.transactions t WHERE t.id = ANY($1) ORDER BY t.id`,
    [txs],
  )
  return rows
}

/** A draft as a door leaves it before commit_journal_entry: booked from `tx`, or naming `names` in its context only. */
async function draft(b: Books, opts: { from?: string; names?: string[] }): Promise<string> {
  const id = randomUUID()
  const named = [...(opts.from ? [opts.from] : []), ...(opts.names ?? [])]
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description,
        source_type, source_id, status, bank_booking_context)
     VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Bankavgift', $6, $7, 'draft', $8::jsonb)`,
    [id, b.userId, b.companyId, b.period, DATE, opts.from ? 'bank_transaction' : 'manual', opts.from ?? null, JSON.stringify(await contextOf(named))],
  )
  for (const [index, line] of bankLines(-AMOUNT).entries()) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, $2, $3, $4, 'SEK', $5)`,
      [id, line.accountNumber, line.debitAmount, line.creditAmount, index],
    )
  }
  return id
}

const commit = (b: Books, entryId: string) =>
  getPool().query<{ voucher_number: number }>('SELECT * FROM public.commit_journal_entry($1, $2)', [b.companyId, entryId])

async function state(entryId: string) {
  const { rows } = await getPool().query(`SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`, [entryId])
  return rows[0]
}

async function lastNumber(b: Books): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT last_number FROM public.voucher_sequences WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
    [b.companyId, b.period],
  )
  return rows[0]?.last_number ?? 0
}

async function postedFrom(tx: string): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT id FROM public.journal_entries WHERE source_type = 'bank_transaction' AND source_id = $1 AND status = 'posted' ORDER BY id`,
    [tx],
  )
  return rows.map((r) => r.id)
}

describe('a second verifikat over a booked bank row', () => {
  it('is refused where it is numbered, stays a draft and uses no voucher number', async () => {
    const b = await books()
    const tx = await bankRow(b)
    const first = await draft(b, { from: tx })
    expect((await commit(b, first)).rows[0].voucher_number).toBe(1)

    const second = await draft(b, { from: tx })
    const refusal = await commit(b, second).then(() => null, (error) => error)
    expect(refusal).toMatchObject(BOOKED)
    expect(JSON.parse(refusal.detail)).toEqual({ transaction_id: tx, journal_entry_id: first })
    expect(await state(second)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await lastNumber(b)).toBe(1)

    // The series goes on with no gap.
    const other = await draft(b, { from: await bankRow(b) })
    expect((await commit(b, other)).rows[0].voucher_number).toBe(2)
    expect(await postedFrom(tx)).toEqual([first])
  }, 30000)

  it('is refused when the first names the row only in its bank booking context', async () => {
    const b = await books()
    const tx = await bankRow(b)
    const payment = await draft(b, { names: [tx] })
    await commit(b, payment)

    await expect(commit(b, await draft(b, { from: tx }))).rejects.toMatchObject(BOOKED)
  }, 30000)

  it('is refused when the row is booked by its pointer or a bank_line link, not by a supplementary link', async () => {
    const b = await books()
    const pointed = await bankRow(b)
    await setPointer(pointed, await entry(b, -AMOUNT))
    await expect(commit(b, await draft(b, { from: pointed }))).rejects.toMatchObject(BOOKED)

    const linked = await bankRow(b)
    await link(b, linked, await entry(b, -AMOUNT), -AMOUNT)
    await expect(commit(b, await draft(b, { from: linked }))).rejects.toMatchObject(BOOKED)

    const residual = await bankRow(b)
    await link(b, residual, await entry(b, -10), -10, 'other')
    const booked = await draft(b, { from: residual })
    await commit(b, booked)
    expect((await state(booked)).status).toBe('posted')
  }, 30000)

  it('refuses a samlingsverifikat as a whole when one of its rows is booked', async () => {
    const b = await books()
    const open = await bankRow(b)
    const booked = await bankRow(b)
    await commit(b, await draft(b, { from: booked }))

    const samling = await draft(b, { names: [open, booked] })
    await expect(commit(b, samling)).rejects.toMatchObject(BOOKED)
    expect((await state(samling)).status).toBe('draft')
  }, 30000)

  it('is refused once the first is corrected: the correction books the row\'s money on', async () => {
    const b = await books()
    const tx = await bankRow(b)
    const first = await draft(b, { from: tx })
    await commit(b, first)
    const correction = await correctionOf(b, first, -AMOUNT)
    await reverse(first)

    const refusal = await commit(b, await draft(b, { from: tx })).then(() => null, (error) => error)
    expect(refusal).toMatchObject(BOOKED)
    expect(JSON.parse(refusal.detail)).toEqual({ transaction_id: tx, journal_entry_id: correction })
  }, 30000)

  it('is posted once the first is reversed: the storno names no bank row', async () => {
    const b = await books()
    const tx = await bankRow(b)
    const first = await draft(b, { from: tx })
    await commit(b, first)
    await reverse(first)

    const again = await draft(b, { from: tx })
    await commit(b, again)
    expect(await postedFrom(tx)).toEqual([again])
  }, 30000)
})

describe('two bookings of one row at once', () => {
  it('posts the first; the second waits for it and is refused', async () => {
    const b = await books()
    const tx = await bankRow(b)
    const a = await draft(b, { from: tx })
    const c = await draft(b, { from: tx })

    const holder = await getClient()
    let outcome: Promise<unknown>
    try {
      await holder.query('BEGIN')
      await holder.query("SET LOCAL lock_timeout = '10s'")
      await holder.query('SELECT * FROM public.commit_journal_entry($1, $2)', [b.companyId, a])

      // Both passed the gate; the second commit starts while the first is open.
      outcome = commit(b, c).then(() => 'posted', (error) => error)
      for (let tries = 0; ; tries++) {
        const { rows } = await getPool().query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%commit_journal_entry%' AND pid <> $1
              AND datname = current_database()`,
          [(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid],
        )
        if (rows[0].n > 0) break
        if (tries > 100) throw new Error('the second commit never waited on the first')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await holder.query('COMMIT')
    } catch (error) {
      await holder.query('ROLLBACK')
      throw error
    } finally {
      holder.release()
    }

    expect(await outcome).toMatchObject(BOOKED)
    expect(await postedFrom(tx)).toEqual([a])
    expect(await state(c)).toEqual({ status: 'draft', voucher_number: 0 })
    expect(await lastNumber(b)).toBe(1)
  }, 30000)
})

describe('a row booked twice before this rule', () => {
  it('keeps both, and refuses a third', async () => {
    const b = await books()
    const tx = await bankRow(b)
    const params = { userId: b.userId, companyId: b.companyId, fiscalPeriodId: b.period, entryDate: DATE, transactionId: tx, lines: bankLines(-AMOUNT) }
    // The 22 production pairs were posted before the trigger existed.
    await getPool().query('ALTER TABLE public.journal_entries DISABLE TRIGGER guard_bank_row_single_booking')
    let pair: string[]
    try {
      pair = [
        await insertPostedBankJournalEntry({ ...params, voucherNumber: 31 }),
        await insertPostedBankJournalEntry({ ...params, voucherNumber: 33 }),
      ]
    } finally {
      await getPool().query('ALTER TABLE public.journal_entries ENABLE TRIGGER guard_bank_row_single_booking')
    }

    await expect(commit(b, await draft(b, { from: tx }))).rejects.toMatchObject(BOOKED)
    expect(await postedFrom(tx)).toEqual([...pair].sort())
  }, 30000)
})
