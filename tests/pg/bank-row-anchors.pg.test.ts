/**
 * public.bank_row_anchors is the one answer to "does a live verifikat book this
 * bank row?", and public.open_bank_rows is its complement with the triage: not
 * ignored, not private, no anchor. Each shape of a row goes through the view,
 * the is_booked column, public.is_transaction_booked and the bank status, and
 * they must say the same.
 *
 * An anchor at a reversed verifikat books nothing, with one exception this file
 * pins: when a posted correction of that verifikat books on a bank account, the
 * row's money is on the ledger through the correction (prod holds 35 such rows,
 * from before a correction was refused from moving a bank leg; correctEntry also
 * logs a failed relink and carries on), and offering the row for booking would
 * book the same money twice.
 */
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedBankJournalEntry, insertTransaction } from './fixtures'
import {
  AMOUNT,
  DATE,
  SHAPES,
  bankLines,
  books,
  correctionOf,
  entry,
  link,
  payment,
  reverse,
  row,
  setPointer,
  type Books,
  type Expected,
  type Shape,
} from './bank-row-shapes'
import { unlinkReconciliation } from '@/lib/reconciliation/bank-reconciliation'

describe.each(Object.entries(SHAPES) as Array<[Shape, Expected]>)('%s', (shape, expected) => {
  it('the view, the column, the function and the bank status give one answer', async () => {
    const b = await books()
    const tx = await row(b, shape, AMOUNT)

    const sql = await getPool().query(`SELECT public.is_transaction_booked($1) AS booked`, [tx])
    expect(sql.rows[0].booked).toBe(expected.booked)

    const anchors = await b.client.from('bank_row_anchors').select('transaction_id').eq('company_id', b.companyId)
    expect(anchors.error).toBeNull()
    expect((anchors.data ?? []).length > 0).toBe(expected.booked)

    const column = await b.client.from('transactions').select('id, is_booked').eq('id', tx).single()
    expect(column.data?.is_booked).toBe(expected.booked)

    const open = await b.client.from('open_bank_rows').select('id').eq('company_id', b.companyId)
    expect(open.error).toBeNull()
    expect((open.data ?? []).map((r) => r.id)).toEqual(expected.open ? [tx] : [])

    const facts = await b.client.rpc('get_bank_reconciliation_facts', {
      p_company_id: b.companyId,
      p_account_number: '1930',
      p_currency: 'SEK',
      p_cash_account_id: b.cash,
      p_include_unassigned: true,
      p_date_from: '2026-01-01',
      p_date_to: '2026-12-31',
    })
    const bank = (facts.data as { bank: { matched_count: number; unmatched_count: number } }).bank
    expect({ matched: bank.matched_count, unmatched: bank.unmatched_count }).toEqual({
      matched: expected.booked ? 1 : 0,
      unmatched: !expected.booked && shape !== 'ignored' ? 1 : 0,
    })
  }, 60000)
})

describe('an anchor reads inside the row\'s company', () => {
  it('a payment row of another company naming this row anchors nothing', async () => {
    const b = await books()
    const other = await books()
    const tx = await row(b, 'free', AMOUNT)
    await payment(other, tx, await entry(other, AMOUNT), AMOUNT)

    // The pool has no RLS, as the service role: only the view's join stands here.
    const { rows } = await getPool().query(`SELECT id FROM public.open_bank_rows WHERE company_id = $1`, [b.companyId])
    expect(rows.map((r) => r.id)).toEqual([tx])
  }, 60000)
})

describe('the views stay the table', () => {
  it.each(['open_bank_rows', 'unbooked_bank_rows'])('%s carries every column of transactions: a new column is added at the end of the view', async (view) => {
    const { rows } = await getPool().query<{ table_name: string; columns: string[] }>(
      `SELECT table_name, array_agg(column_name::text ORDER BY column_name) AS columns
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('transactions', $1)
       GROUP BY table_name`,
      [view],
    )
    const of = (name: string) => rows.find((r) => r.table_name === name)?.columns
    expect(of(view)).toEqual(of('transactions'))
  })
})

describe('the shape keeps its plan', () => {
  // Arms with a join or a WHERE cannot take the row's id, and the anchors of the
  // whole company get built per pass or per row: the bench read that at 2,544 ms
  // for a month count. Small tables plan any way they like, so this reads the
  // view's text: the arms hold no WHERE, the rule sits on the one join.
  it('bank_row_anchors has four arms with no WHERE and one join to journal_entries', async () => {
    const { rows } = await getPool().query<{ def: string }>(`SELECT pg_get_viewdef('public.bank_row_anchors'::regclass, true) AS def`)
    const def = rows[0].def
    const arms = def.slice(def.indexOf('FROM ('), def.lastIndexOf(') a'))
    expect(arms.match(/UNION ALL/g)).toHaveLength(3)
    expect(arms).not.toMatch(/WHERE|JOIN/)
    expect(def.match(/JOIN journal_entries/g)).toHaveLength(1)
    expect(def).toMatch(/e\.company_id = a\.company_id/)
  })

  it('a stale pointer is found from the verifikat no longer posted, through its partial index', async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_journal_entries_company_not_posted'`,
    )
    expect(rows[0]?.def).toMatch(/\(company_id, id\) WHERE \(status <> 'posted'/)
  })
})

describe('a pointer written on the row\'s own booking clears the method', () => {
  async function staleLink(b: Books) {
    const tx = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: AMOUNT, cashAccountId: b.cash })
    const reversed = await entry(b, AMOUNT)
    await setPointer(tx, reversed)
    await getPool().query(`UPDATE public.transactions SET reconciliation_method = 'auto_exact' WHERE id = $1`, [tx])
    await reverse(reversed)
    return tx
  }

  const method = async (tx: string) =>
    (await getPool().query(`SELECT reconciliation_method FROM public.transactions WHERE id = $1`, [tx])).rows[0].reconciliation_method

  it('a booking from the row over a stale link leaves no method, so Koppla bort cannot detach it', async () => {
    const b = await books()
    const tx = await staleLink(b)
    const own = await insertPostedBankJournalEntry({
      userId: b.userId, companyId: b.companyId, fiscalPeriodId: b.period, entryDate: DATE, transactionId: tx, lines: bankLines(AMOUNT),
    })
    // What categorize, the book route and the Inkorg direct booking write.
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2, is_business = true WHERE id = $1`, [tx, own])

    expect(await method(tx)).toBeNull()
    expect(await unlinkReconciliation(b.client, b.companyId, tx, b.userId)).toMatchObject({ success: false, code: 'LINK_IS_BOOKING' })
  }, 30000)

  it('a link to a verifikat that stands on its own keeps its method', async () => {
    const b = await books()
    const tx = await staleLink(b)
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2, reconciliation_method = 'manual' WHERE id = $1`, [tx, await entry(b, AMOUNT)])
    expect(await method(tx)).toBe('manual')
  }, 30000)

  it('a correction that moves the pointer keeps the link\'s method', async () => {
    const b = await books()
    const tx = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: AMOUNT, cashAccountId: b.cash })
    const original = await entry(b, AMOUNT)
    await setPointer(tx, original)
    await getPool().query(`UPDATE public.transactions SET reconciliation_method = 'manual' WHERE id = $1`, [tx])
    const corrected = await correctionOf(b, original, AMOUNT)
    await reverse(original)
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [tx, corrected])
    expect(await method(tx)).toBe('manual')
  }, 30000)
})

describe('cash_account_booked_rows', () => {
  it('counts a row booked through a link and not a stale pointer', async () => {
    const b = await books()
    const linked = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: 700, cashAccountId: b.cash })
    await link(b, linked, await entry(b, 700), 700)
    const stale = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: 800, cashAccountId: b.cash })
    const reversed = await entry(b, 800)
    await setPointer(stale, reversed)
    await reverse(reversed)
    const { rows } = await getPool().query(`SELECT public.cash_account_booked_rows($1, $2) AS n`, [b.companyId, b.cash])
    expect(rows[0].n).toBe(1)
  }, 30000)
})
