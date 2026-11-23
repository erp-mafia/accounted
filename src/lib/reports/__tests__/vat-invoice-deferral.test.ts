/**
 * The TS side of reading a periodisering an invoice booked with moms (a
 * förutbetald intäkt on 29xx, an upplupen intäkt on 17xx) as the sale on the
 * invoice's date (crm#1919): the shares the SQL decides, and one verifikat's
 * lines read through them. The SQL itself is pinned in
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
    const shares = new Map([[INVOICE, [{ target_account: '3001', share: 1 }]]])
    const read = readDeferredSaleLines(INVOICE, INVOICE_LINES, shares)
    expect(rutorFromTotals(totalsOf(read))).toMatchObject({ ruta05: 16000, ruta10: 4000 })
    // Without the reading, the sale its moms is reported on is missing.
    expect(rutorFromTotals(totalsOf(INVOICE_LINES))).toMatchObject({ ruta05: 4000, ruta10: 4000 })
  })

  it('reads a kreditfaktura with its own sign', () => {
    const credit = INVOICE_LINES.map((l) => line(l.account_number, l.credit_amount, l.debit_amount))
    const shares = new Map([[INVOICE, [{ target_account: '3001', share: 1 }]]])
    expect(rutorFromTotals(totalsOf(readDeferredSaleLines(INVOICE, credit, shares)))).toMatchObject({ ruta05: -16000, ruta10: -4000 })
  })

  it('splits a 29xx account two deferrals share by their parts, and leaves a part without moms unread', () => {
    const shares = new Map([[INVOICE, [
      { target_account: '3001', share: 0.75 },
      { target_account: '3913', share: 0.125 },
    ]]])
    expect(rutorFromTotals(totalsOf(readDeferredSaleLines(INVOICE, INVOICE_LINES, shares)))).toMatchObject({
      ruta05: 13000,
      ruta08: 1500,
    })
  })

  it('reads a release as nothing: its 29xx debit takes back the revenue it credits', () => {
    const release = [line('2970', 2000, 0), line('3001', 0, 2000)]
    const shares = new Map([[INVOICE, [{ target_account: '3001', share: 1 }]]])
    expect(rutorFromTotals(totalsOf(readDeferredSaleLines(INVOICE, release, shares)))).toMatchObject({ ruta05: 0, ruta10: 0 })
  })

  it('reads the deferral on the 29xx account a rättelse moved it to', () => {
    const moved = INVOICE_LINES.map((l) => (l.account_number === '2970' ? line('2971', l.debit_amount, l.credit_amount) : l))
    const shares = new Map([[INVOICE, [{ target_account: '3001', share: 1 }]]])
    expect(rutorFromTotals(totalsOf(readDeferredSaleLines(INVOICE, moved, shares)))).toMatchObject({ ruta05: 16000, ruta10: 4000 })
  })

  it('rounds each part to öre as the SQL rounds round(amount * share, 2), not as the float product lands', () => {
    // 1,66 x 0,75 is 1,245 exactly, 1,2449999... as a double.
    const shares = new Map([[INVOICE, [{ target_account: '3001', share: 0.75 }]]])
    const read = readDeferredSaleLines(INVOICE, [line('2970', 0, 1.66)], shares)
    expect(read.find((l) => l.account_number === '3001')).toEqual(line('3001', 0, 1.25))
  })

  it('rounds at the 12-decimal part the SQL answers, as the SQL rounds with it', () => {
    // 5/6 as vat_invoice_deferral_shares answers it: 1 500,15 x 0,833333333333
    // is 1 250,1249999995, which round(…, 2) makes 1 250,12 in SQL.
    const shares = new Map([[INVOICE, [{ target_account: '3001', share: 0.833333333333 }]]])
    const read = readDeferredSaleLines(INVOICE, [line('2970', 0, 1500.15), line('2970', 0, 300.03)], shares)
    expect(read.filter((l) => l.account_number === '3001')).toEqual([line('3001', 0, 1250.12), line('3001', 0, 250.02)])
  })

  it('reads the 17xx line of an accrued invoice sale at its accrued part, and its month before the invoice as nothing', () => {
    // An upplupen intäkt: October work invoiced in November, 25 %.
    const OCTOBER = '33333333-3333-4333-8333-333333333333'
    const shares = new Map([
      [INVOICE, [{ target_account: '3001', share: 0, accrued_share: 1 }]],
      [OCTOBER, [{ target_account: '3001', share: 0, accrued_share: 1 }]],
    ])
    const invoice = [line('1510', 10000, 0), line('1790', 0, 8000), line('2611', 0, 2000)]
    expect(rutorFromTotals(totalsOf(readDeferredSaleLines(INVOICE, invoice, shares)))).toMatchObject({ ruta05: 8000, ruta10: 2000 })
    const october = [line('1790', 8000, 0), line('3001', 0, 8000)]
    expect(rutorFromTotals(totalsOf(readDeferredSaleLines(OCTOBER, october, shares)))).toMatchObject({ ruta05: 0, ruta10: 0 })
    // A part answered without accrued_share (a database before it) reads no 17xx line.
    const before = new Map([[INVOICE, [{ target_account: '3001', share: 1 }]]])
    expect(readDeferredSaleLines(INVOICE, invoice, before)).toEqual(invoice)
  })

  it('reads each interim line of an invoice that both defers and accrues at the part of its own class', () => {
    // 6 000 deferred on 2970 towards 3001 and 10 000 accrued on 1790 towards
    // 3913: a 29xx part and a 17xx part, each of what its class booked.
    const shares = new Map([[INVOICE, [
      { target_account: '3001', share: 1, accrued_share: 0 },
      { target_account: '3913', share: 0, accrued_share: 1 },
    ]]])
    const mixed = [line('1510', 22500, 0), line('2970', 0, 6000), line('1790', 0, 10000), line('3001', 0, 2000), line('2611', 0, 4500)]
    const read = readDeferredSaleLines(INVOICE, mixed, shares)
    expect(rutorFromTotals(totalsOf(read))).toMatchObject({ ruta05: 8000, ruta08: 10000, ruta10: 4500 })
    // One line read per interim line; 1510, 2611 and the parts at 0 add nothing.
    expect(read).toHaveLength(mixed.length + 2)
    // A rättelse that lowers the 2970 line to 5 000 moves only that row's sale.
    const lowered = mixed.map((l) => (l.account_number === '2970' ? line('2970', 0, 5000) : l))
    expect(rutorFromTotals(totalsOf(readDeferredSaleLines(INVOICE, lowered, shares)))).toMatchObject({ ruta05: 7000, ruta08: 10000 })
  })

  it('leaves any other verifikat as it is', () => {
    const shares = new Map([['22222222-2222-4222-8222-222222222222', [{ target_account: '3001', share: 1 }]]])
    expect(readDeferredSaleLines(INVOICE, INVOICE_LINES, shares)).toEqual(INVOICE_LINES)
  })
})

describe('fetchInvoiceDeferralShares', () => {
  it('groups the SQL answer by verifikat, the parts as numbers', async () => {
    const mock = createTableMockSupabase({
      'rpc:vat_invoice_deferral_shares': {
        data: [
          { journal_entry_id: INVOICE, target_account: '3001', share: '0.75', accrued_share: '0' },
          { journal_entry_id: INVOICE, target_account: '3002', share: '0.25', accrued_share: '0.5' },
        ],
      },
    })
    const shares = await fetchInvoiceDeferralShares(mock.supabase as never, 'company-1')
    expect(shares.get(INVOICE)).toEqual([
      { target_account: '3001', share: 0.75, accrued_share: 0 },
      { target_account: '3002', share: 0.25, accrued_share: 0.5 },
    ])
  })

  it('reads no 17xx part from a database that answers none (20261122140000 only)', async () => {
    const mock = createTableMockSupabase({
      'rpc:vat_invoice_deferral_shares': {
        data: [{ journal_entry_id: INVOICE, target_account: '3001', share: '1' }],
      },
    })
    const shares = await fetchInvoiceDeferralShares(mock.supabase as never, 'company-1')
    expect(shares.get(INVOICE)).toEqual([{ target_account: '3001', share: 1, accrued_share: 0 }])
  })

  it('reads every page of the answer, past the 1000 rows PostgREST returns at once', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      journal_entry_id: `entry-${i}`,
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
    expect(shares.get('entry-1000')).toEqual([{ target_account: '3001', share: 1, accrued_share: 0 }])
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
