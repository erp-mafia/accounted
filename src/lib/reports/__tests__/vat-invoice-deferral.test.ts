/**
 * The TS side of reading a förutbetald intäkt as the sale on the invoice's
 * date (crm#1919): the shares the SQL decides, and one verifikat's lines read
 * through them. The SQL itself is pinned in
 * tests/pg/vat-invoice-deferral.pg.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { fetchInvoiceDeferralShares, readDeferredSaleLines, rutorFromTotals } from '../vat-declaration'

const INVOICE = '11111111-1111-4111-8111-111111111111'

const line = (account_number: string, debit_amount: number, credit_amount: number) => ({
  account_number,
  debit_amount,
  credit_amount,
})

/** A 25 % invoice: 4 000 on 3001 and 12 000 periodiserad on 2970. */
const INVOICE_LINES = [line('1510', 20000, 0), line('2970', 0, 12000), line('3001', 0, 4000), line('2611', 0, 4000)]

function totalsOf(lines: ReturnType<typeof line>[]) {
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const t = totals.get(l.account_number) ?? { debit: 0, credit: 0 }
    totals.set(l.account_number, { debit: t.debit + l.debit_amount, credit: t.credit + l.credit_amount })
  }
  return totals
}

describe('readDeferredSaleLines', () => {
  it('reads the 29xx line of a deferred invoice sale as the sale on its revenue account', () => {
    const shares = new Map([[INVOICE, [{ balance_account: '2970', target_account: '3001', share: 1 }]]])
    const read = readDeferredSaleLines(INVOICE, INVOICE_LINES, shares)
    expect(rutorFromTotals(totalsOf(read))).toMatchObject({ ruta05: 16000, ruta10: 4000 })
    // Without the reading, the sale its moms is reported on is missing.
    expect(rutorFromTotals(totalsOf(INVOICE_LINES))).toMatchObject({ ruta05: 4000, ruta10: 4000 })
  })

  it('reads a kreditfaktura with its own sign', () => {
    const credit = INVOICE_LINES.map((l) => line(l.account_number, l.credit_amount, l.debit_amount))
    const shares = new Map([[INVOICE, [{ balance_account: '2970', target_account: '3001', share: 1 }]]])
    expect(rutorFromTotals(totalsOf(readDeferredSaleLines(INVOICE, credit, shares)))).toMatchObject({ ruta05: -16000, ruta10: -4000 })
  })

  it('splits a 29xx account two deferrals share by their parts, and leaves a part without moms unread', () => {
    const shares = new Map([[INVOICE, [
      { balance_account: '2970', target_account: '3001', share: 0.75 },
      { balance_account: '2970', target_account: '3913', share: 0.125 },
    ]]])
    expect(rutorFromTotals(totalsOf(readDeferredSaleLines(INVOICE, INVOICE_LINES, shares)))).toMatchObject({
      ruta05: 13000,
      ruta08: 1500,
    })
  })

  it('leaves any other verifikat as it is', () => {
    const shares = new Map([['22222222-2222-4222-8222-222222222222', [{ balance_account: '2970', target_account: '3001', share: 1 }]]])
    expect(readDeferredSaleLines(INVOICE, INVOICE_LINES, shares)).toEqual(INVOICE_LINES)
  })
})

describe('fetchInvoiceDeferralShares', () => {
  it('groups the SQL answer by verifikat, the parts as numbers', async () => {
    const mock = createTableMockSupabase({
      'rpc:vat_invoice_deferral_shares': {
        data: [
          { journal_entry_id: INVOICE, balance_account: '2970', target_account: '3001', share: '0.75' },
          { journal_entry_id: INVOICE, balance_account: '2970', target_account: '3002', share: '0.25' },
        ],
      },
    })
    const shares = await fetchInvoiceDeferralShares(mock.supabase as never, 'company-1')
    expect(shares.get(INVOICE)).toEqual([
      { balance_account: '2970', target_account: '3001', share: 0.75 },
      { balance_account: '2970', target_account: '3002', share: 0.25 },
    ])
  })

  it('reads every page of the answer, past the 1000 rows PostgREST returns at once', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      journal_entry_id: `entry-${i}`,
      balance_account: '2970',
      target_account: '3001',
      share: '1',
    }))
    const mock = createTableMockSupabase({
      'rpc:vat_invoice_deferral_shares': (chain: Array<{ method: string; args: unknown[] }>) => {
        const [from, to] = chain.find((c) => c.method === 'range')!.args as [number, number]
        return { data: rows.slice(from, to + 1) }
      },
    })
    const shares = await fetchInvoiceDeferralShares(mock.supabase as never, 'company-1')
    expect(shares.size).toBe(1001)
    expect(shares.get('entry-1000')).toEqual([{ balance_account: '2970', target_account: '3001', share: 1 }])
  })

  it('reads nothing as a deferred sale while the function is not deployed yet', async () => {
    const mock = createTableMockSupabase({
      'rpc:vat_invoice_deferral_shares': { error: { code: 'PGRST202', message: 'Could not find the function' } },
    })
    expect((await fetchInvoiceDeferralShares(mock.supabase as never, 'company-1')).size).toBe(0)
  })

  it('throws on any other failure', async () => {
    const mock = createTableMockSupabase({
      'rpc:vat_invoice_deferral_shares': { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    })
    await expect(fetchInvoiceDeferralShares(mock.supabase as never, 'company-1')).rejects.toThrow(/statement timeout/)
  })
})
