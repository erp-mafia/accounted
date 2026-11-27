/**
 * public.bank_rows_booked_twice: the bank rows a fiscal period books twice,
 * which the year-end readiness report names as a reminder.
 *
 * A bank row is booked twice when two or more posted verifikat of the period
 * booked from it (source_type 'bank_transaction', source_id the row) stand
 * and carry the same lines. guard_bank_row_single_booking refuses such a
 * second posting today, so the copies here are posted with it switched off,
 * as the ones posted before it were. On real Postgres:
 *
 *   - an ignored row booked three times with the same lines is reported: the
 *     first posted copy stays, the other two are extra;
 *   - the copy the bank row's pointer names stays, whichever was posted first;
 *   - a copy a posted storno reverses does not count, even while it is still
 *     labelled posted; a booking reversed and booked again is booked once;
 *   - a copy another bank row is booked on, by its pointer or a voucher link,
 *     is that row's booking, not a copy;
 *   - verifikat with different lines are not copies; beside a set of copies
 *     they are left out of it;
 *   - a row booked once is not reported;
 *   - only the company and the period asked about are read;
 *   - a caller with no access to the company reads nothing (row level
 *     security: the function is SECURITY INVOKER).
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedBankJournalEntry,
  insertTransaction,
  type PostedJournalEntryLine,
} from './fixtures'
import { AMOUNT, DATE, bankLines, books, link, setPointer, type Books } from './bank-row-shapes'

type Reported = {
  transaction_id: string
  kept_journal_entry_id: string
  kept_voucher_series: string
  kept_voucher_number: number
  extra_entries: Array<{ journal_entry_id: string; voucher_series: string; voucher_number: number }>
}

/** The same purchase as bankLines, put on another cost account. */
const OTHER_LINES: PostedJournalEntryLine[] = [
  { accountNumber: '1930', debitAmount: 0, creditAmount: AMOUNT },
  { accountNumber: '6570', debitAmount: AMOUNT, creditAmount: 0 },
]

function bankRow(b: Books, opts: { ignored?: boolean; date?: string } = {}): Promise<string> {
  return insertTransaction({
    companyId: b.companyId,
    userId: b.userId,
    date: opts.date ?? DATE,
    amount: -AMOUNT,
    cashAccountId: b.cash,
    isIgnored: opts.ignored ?? false,
  })
}

interface Copy {
  voucherNumber: number
  /** Minutes past 10:00 on the entry date: the order the copies were posted in. */
  postedAt: number
  lines?: PostedJournalEntryLine[]
}

/**
 * Verifikat booked from `tx`, posted with guard_bank_row_single_booking off:
 * the way the copies posted before that rule exist.
 */
async function bookedFrom(b: Books, tx: string, copies: Copy[], at: { period?: string; date?: string } = {}): Promise<string[]> {
  const date = at.date ?? DATE
  await getPool().query('ALTER TABLE public.journal_entries DISABLE TRIGGER guard_bank_row_single_booking')
  try {
    const ids: string[] = []
    for (const copy of copies) {
      ids.push(
        await insertPostedBankJournalEntry({
          userId: b.userId,
          companyId: b.companyId,
          fiscalPeriodId: at.period ?? b.period,
          entryDate: date,
          voucherNumber: copy.voucherNumber,
          committedAt: `${date}T10:${String(copy.postedAt).padStart(2, '0')}:00Z`,
          transactionId: tx,
          lines: copy.lines ?? bankLines(-AMOUNT),
        }),
      )
    }
    return ids
  } finally {
    await getPool().query('ALTER TABLE public.journal_entries ENABLE TRIGGER guard_bank_row_single_booking')
  }
}

/** A posted storno of `entryId`. The original keeps its status unless `markReversed`. */
async function stornoOf(b: Books, entryId: string, voucherNumber: number, markReversed = false): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Storno', 'storno', 'draft', $7)`,
      [id, b.userId, b.companyId, b.period, voucherNumber, DATE, entryId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       SELECT $1, l.account_number, l.credit_amount, l.debit_amount, 'SEK', l.sort_order
       FROM public.journal_entry_lines l WHERE l.journal_entry_id = $2`,
      [id, entryId],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  if (markReversed) {
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`, [entryId, id])
  }
  return id
}

/** The function as `userId` calls it, under row level security. */
function bookedTwice(userId: string, companyId: string, periodId: string): Promise<Reported[]> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<Reported>('SELECT * FROM public.bank_rows_booked_twice($1, $2)', [companyId, periodId])
    return rows
  })
}

const voucher = (id: string, n: number) => ({ journal_entry_id: id, voucher_series: 'A', voucher_number: n })

describe('bank_rows_booked_twice', () => {
  it('reports an ignored row booked three times with the same lines: the first posted stays', async () => {
    const b = await books()
    const tx = await bankRow(b, { ignored: true })
    const [first, second, third] = await bookedFrom(b, tx, [
      { voucherNumber: 11, postedAt: 0 },
      { voucherNumber: 12, postedAt: 1 },
      { voucherNumber: 13, postedAt: 2 },
    ])

    expect(await bookedTwice(b.userId, b.companyId, b.period)).toEqual([
      {
        transaction_id: tx,
        kept_journal_entry_id: first,
        kept_voucher_series: 'A',
        kept_voucher_number: 11,
        extra_entries: [voucher(second, 12), voucher(third, 13)],
      },
    ])
  }, 30000)

  it('keeps the copy the bank row points at, whichever was posted first', async () => {
    const b = await books()
    const tx = await bankRow(b)
    const [first, named] = await bookedFrom(b, tx, [
      { voucherNumber: 21, postedAt: 0 },
      { voucherNumber: 22, postedAt: 1 },
    ])
    await setPointer(tx, named)

    expect(await bookedTwice(b.userId, b.companyId, b.period)).toEqual([
      {
        transaction_id: tx,
        kept_journal_entry_id: named,
        kept_voucher_series: 'A',
        kept_voucher_number: 22,
        extra_entries: [voucher(first, 21)],
      },
    ])
  }, 30000)

  it('leaves out a copy a posted storno reverses, even while it is still labelled posted', async () => {
    const b = await books()

    // Two copies, one stornoed and still 'posted': one stands.
    const pair = await bankRow(b)
    const [, stornoed] = await bookedFrom(b, pair, [
      { voucherNumber: 31, postedAt: 0 },
      { voucherNumber: 32, postedAt: 1 },
    ])
    await stornoOf(b, stornoed, 33)

    // Three copies, one stornoed: the other two are still a set.
    const triple = await bankRow(b)
    const [kept, extra, reversedOne] = await bookedFrom(b, triple, [
      { voucherNumber: 41, postedAt: 0 },
      { voucherNumber: 42, postedAt: 1 },
      { voucherNumber: 43, postedAt: 2 },
    ])
    await stornoOf(b, reversedOne, 44)

    // The way it is meant to go: reversed, then booked again. Posted through
    // the guard, which lets the second booking through.
    const rebooked = await bankRow(b)
    const [original] = await bookedFrom(b, rebooked, [{ voucherNumber: 51, postedAt: 0 }])
    await stornoOf(b, original, 52, true)
    await insertPostedBankJournalEntry({
      userId: b.userId,
      companyId: b.companyId,
      fiscalPeriodId: b.period,
      entryDate: DATE,
      voucherNumber: 53,
      transactionId: rebooked,
      lines: bankLines(-AMOUNT),
    })

    expect(await bookedTwice(b.userId, b.companyId, b.period)).toEqual([
      {
        transaction_id: triple,
        kept_journal_entry_id: kept,
        kept_voucher_series: 'A',
        kept_voucher_number: 41,
        extra_entries: [voucher(extra, 42)],
      },
    ])
  }, 30000)

  it('leaves out a copy another bank row is booked on, by its pointer or a voucher link', async () => {
    const b = await books()

    const pointed = await bankRow(b)
    const [, takenByPointer] = await bookedFrom(b, pointed, [
      { voucherNumber: 61, postedAt: 0 },
      { voucherNumber: 62, postedAt: 1 },
    ])
    const otherRow = await bankRow(b)
    await setPointer(otherRow, takenByPointer)
    await getPool().query(`UPDATE public.transactions SET reconciliation_method = 'manual' WHERE id = $1`, [otherRow])

    const linked = await bankRow(b)
    const [, takenByLink] = await bookedFrom(b, linked, [
      { voucherNumber: 71, postedAt: 0 },
      { voucherNumber: 72, postedAt: 1 },
    ])
    await link(b, await bankRow(b), takenByLink, -AMOUNT)

    expect(await bookedTwice(b.userId, b.companyId, b.period)).toEqual([])
  }, 30000)

  it('reports only verifikat with the same lines', async () => {
    const b = await books()

    // Booked twice on different accounts: not copies of each other.
    const differs = await bankRow(b)
    await bookedFrom(b, differs, [
      { voucherNumber: 81, postedAt: 0 },
      { voucherNumber: 82, postedAt: 1, lines: OTHER_LINES },
    ])

    // Two copies and a third booking with other lines: the copies only.
    const mixed = await bankRow(b)
    const [copy, other, again] = await bookedFrom(b, mixed, [
      { voucherNumber: 91, postedAt: 0 },
      { voucherNumber: 92, postedAt: 1, lines: OTHER_LINES },
      { voucherNumber: 93, postedAt: 2 },
    ])

    const reported = await bookedTwice(b.userId, b.companyId, b.period)
    expect(reported).toEqual([
      {
        transaction_id: mixed,
        kept_journal_entry_id: copy,
        kept_voucher_series: 'A',
        kept_voucher_number: 91,
        extra_entries: [voucher(again, 93)],
      },
    ])
    expect(JSON.stringify(reported)).not.toContain(other)
  }, 30000)

  it('does not report a row booked once', async () => {
    const b = await books()
    const tx = await bankRow(b)
    const [once] = await bookedFrom(b, tx, [{ voucherNumber: 101, postedAt: 0 }])
    await setPointer(tx, once)

    expect(await bookedTwice(b.userId, b.companyId, b.period)).toEqual([])
  }, 30000)

  it('reads only the company asked about', async () => {
    const a = await books()
    const other = await books()
    // One person with both companies, so row level security hides neither.
    await insertCompanyMember({ companyId: other.companyId, userId: a.userId, role: 'owner' })
    const inA = await bankRow(a)
    await bookedFrom(a, inA, [
      { voucherNumber: 111, postedAt: 0 },
      { voucherNumber: 112, postedAt: 1 },
    ])
    const inOther = await bankRow(other)
    await bookedFrom(other, inOther, [
      { voucherNumber: 111, postedAt: 0 },
      { voucherNumber: 112, postedAt: 1 },
    ])

    expect((await bookedTwice(a.userId, a.companyId, a.period)).map((r) => r.transaction_id)).toEqual([inA])
    expect((await bookedTwice(a.userId, other.companyId, other.period)).map((r) => r.transaction_id)).toEqual([inOther])
    // A period of another company names nothing of this one.
    expect(await bookedTwice(a.userId, a.companyId, other.period)).toEqual([])
  }, 30000)

  it('reads only the fiscal period asked about', async () => {
    const b = await books()
    const lastYear = await insertFiscalPeriod({
      userId: b.userId,
      companyId: b.companyId,
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      name: '2025',
    })
    const tx = await bankRow(b, { date: '2025-06-10' })
    await bookedFrom(
      b,
      tx,
      [
        { voucherNumber: 121, postedAt: 0 },
        { voucherNumber: 122, postedAt: 1 },
      ],
      { period: lastYear, date: '2025-06-10' },
    )

    expect(await bookedTwice(b.userId, b.companyId, b.period)).toEqual([])
    expect((await bookedTwice(b.userId, b.companyId, lastYear)).map((r) => r.transaction_id)).toEqual([tx])
  }, 30000)

  it('gives a caller with no access to the company nothing', async () => {
    const b = await books()
    const tx = await bankRow(b, { ignored: true })
    await bookedFrom(b, tx, [
      { voucherNumber: 131, postedAt: 0 },
      { voucherNumber: 132, postedAt: 1 },
    ])
    const stranger = await insertAuthUser()

    expect(await bookedTwice(stranger, b.companyId, b.period)).toEqual([])
    expect((await bookedTwice(b.userId, b.companyId, b.period)).map((r) => r.transaction_id)).toEqual([tx])
  }, 30000)
})
