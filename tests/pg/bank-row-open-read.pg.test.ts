/**
 * One answer to "is this bank row open work?" at every door: the same row of
 * every shape goes through each door that asks, on real Postgres, and each must
 * give the one answer public.bank_row_anchors holds
 * (tests/pg/bank-row-anchors.pg.test.ts pins the database's side). The doors
 * assert softly, so a broken rule names every door it breaks.
 */
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertTransaction } from './fixtures'
import { AMOUNT, DATE, SHAPES, books, entry, link, reverse, row, setPointer, type Expected, type Shape } from './bank-row-shapes'
import { assertTransactionBookable, decideBankRowRebooking } from '@/lib/transactions/is-booked'
import { countUnbookedBankTransactions } from '@/lib/transactions/unbooked'
import { hasOpenTransactions } from '@/lib/cash-accounts/service'
import { fetchCandidateTransactions } from '@/lib/receipt-hunt/hunt'
import { fetchPurchasesWithoutUnderlag } from '@/lib/receipt-hunt/purchases-without-underlag'
import { searchUnmatchedOutgoingTransactions } from '@/lib/transactions/outgoing-transaction-search'
import { loadUnexplainedInboundRows } from '@/lib/collections/bank-check'
import { detectVoucherDuplicates } from '@/lib/bookkeeping/voucher-duplicate-check'
import { detectBookedDuplicateTransaction } from '@/lib/transactions/booking-duplicate-detection'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { listAccountItems } from '@/lib/reconciliation/items'
import { tools } from '@/extensions/general/mcp-server/server'

async function listed(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<string[]> {
  const { data, error } = await q
  if (error) throw new Error(JSON.stringify(error))
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
}

const tool = (name: string) => tools.find((t) => t.name === name)!

describe.each(Object.entries(SHAPES) as Array<[Shape, Expected]>)('%s', (shape, expected) => {
  it('money in: the gate and the lists give one answer', async () => {
    const b = await books()
    const tx = await row(b, shape, AMOUNT)
    const client = b.client

    const unbooked = await listed(client.from('open_bank_rows').select('id').eq('company_id', b.companyId) as never)
    expect.soft(unbooked.includes(tx)).toBe(expected.open)

    const counts = await countUnbookedBankTransactions(client, b.companyId)
    expect.soft(counts.total).toBe(expected.open ? 1 : 0)

    expect.soft(await hasOpenTransactions(client, b.companyId, b.cash)).toBe(expected.open)

    const inbound = await loadUnexplainedInboundRows(
      client,
      b.companyId,
      { invoice_date: '2026-01-01' } as never,
      '2026-12-31',
    )
    expect.soft(inbound.some((r) => r.id === tx)).toBe(expected.open)

    if (expected.gate) {
      const stored = (await getPool().query(`SELECT id, journal_entry_id, reconciliation_method, is_ignored FROM public.transactions WHERE id = $1`, [tx])).rows[0]
      const gate = await decideBankRowRebooking(client, b.companyId, stored, { replace: false })
      expect.soft(gate.outcome === 'refuse' ? `refuse:${gate.via}` : gate.outcome).toBe(expected.gate)
      if (shape !== 'ignored') {
        const verdict = await assertTransactionBookable(client, b.companyId, stored)
        expect.soft(verdict.ok).toBe(expected.gate === 'open')
      }
    }

    const items = await listAccountItems(client, b.companyId, `bank:${b.cash}`, { windowFrom: '2026-01-01', windowTo: '2026-12-31' })
    const item = items?.items.find((i) => i.item_id === tx)
    expect.soft(item?.bucket).toBe(expected.booked ? 'matched' : shape === 'ignored' ? 'ignored' : 'unmatched_external')

    const auto = (await tool('gnubok_auto_match_period').execute(
      { date_from: '2026-03-01', date_to: '2026-03-31', dry_run: true, confidence_threshold: 0.5 },
      b.companyId,
      b.userId,
      client as never,
    )) as { scanned_transactions: number }
    expect.soft(auto.scanned_transactions).toBe(expected.open ? 1 : 0)

    const receipts = (await tool('gnubok_receipt_matcher').execute({ limit: 20 }, b.companyId, b.userId, client as never)) as {
      transactions: Array<{ id: string }>
    }
    expect.soft(receipts.transactions.some((t) => t.id === tx)).toBe(expected.open)
  }, 60000)

  it('money out: the purchase lists give the same answer', async () => {
    const b = await books()
    const tx = await row(b, shape, -AMOUNT)

    const hunted = await fetchCandidateTransactions(b.client, b.companyId)
    expect.soft(hunted.some((r) => r.id === tx)).toBe(expected.open)

    const purchases = await fetchPurchasesWithoutUnderlag(b.client, b.companyId, { lookbackMonths: 1200 })
    expect.soft(purchases.some((r) => r.id === tx)).toBe(expected.open)

    const outgoing = await searchUnmatchedOutgoingTransactions(b.client, b.companyId, '')
    expect.soft(outgoing.rows.some((r) => r.id === tx)).toBe(expected.open)
  }, 60000)
})

describe('readers that name the verifikat', () => {
  it('the status and the list read a stale pointer alike, on the row\'s own date', async () => {
    const b = await books()
    const original = await entry(b, AMOUNT, { entryDate: '2026-02-20' })
    const tx = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: AMOUNT, cashAccountId: b.cash })
    await setPointer(tx, original)
    await reverse(original)
    const march = await getReconciliationStatus(b.client, b.companyId, '2026-03-01', '2026-03-31', '1930', 'SEK', b.cash, true)
    expect(march.bank_transaction_count).toBe(1)
    expect(march.unmatched_transaction_count).toBe(1)
    const february = await getReconciliationStatus(b.client, b.companyId, '2026-02-01', '2026-02-28', '1930', 'SEK', b.cash, true)
    expect(february.bank_transaction_count).toBe(0)
    const list = await listAccountItems(b.client, b.companyId, `bank:${b.cash}`, { windowFrom: '2026-03-01', windowTo: '2026-03-31' })
    expect(list?.items.find((i) => i.item_id === tx)?.bucket).toBe('unmatched_external')
  }, 30000)

  it('the booking guard reads a sibling with a stale pointer as open, not as a booked twin', async () => {
    const b = await books()
    const original = await entry(b, -345.5)
    const stored = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: -345.5, cashAccountId: b.cash })
    await setPointer(stored, original)
    await reverse(original)
    const target = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: -345.5, cashAccountId: b.cash })
    const hit = await detectBookedDuplicateTransaction(b.client, b.companyId, {
      id: target, date: DATE, amount: -345.5, currency: 'SEK', cash_account_id: b.cash,
    } as never)
    expect(hit).toBeNull()
  }, 30000)

  it('the voucher check warns on a row booked through a link, as on a pointer', async () => {
    const b = await books()
    const tx = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: DATE, amount: 2222, cashAccountId: b.cash })
    await link(b, tx, await entry(b, 2222), 2222)
    const warnings = await detectVoucherDuplicates(b.client, b.companyId, {
      entry_date: DATE,
      description: 'Inbetalning kund',
      lines: [
        { account_number: '1930', debit_amount: 2222, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 2222 },
      ],
    } as never)
    expect(JSON.stringify(warnings)).toContain(tx)
  }, 30000)
})
