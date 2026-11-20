/**
 * relinkPaymentRowsToEntry: a corrected payment verifikat's invoice payment
 * rows follow the correction, as the bank rows and the underlag do (PH 227).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { correctionCarriesPaymentRows, relinkPaymentRowsToEntry } from '../correction-payment-relink'

type Result = { error: { message: string } | null }

function makeClient(results: Record<string, Result> = {}) {
  const calls: Array<{ table: string; payload: unknown; eqs: unknown[][] }> = []
  const from = vi.fn((table: string) => {
    const call = { table, payload: undefined as unknown, eqs: [] as unknown[][] }
    calls.push(call)
    const b: Record<string, unknown> = {}
    b.update = vi.fn((payload: unknown) => {
      call.payload = payload
      return b
    })
    b.eq = vi.fn((...args: unknown[]) => {
      call.eqs.push(args)
      return b
    })
    b.then = (resolve: (v: Result) => void) => resolve(results[table] ?? { error: null })
    return b
  })
  return { client: { from } as never, calls, from }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('correctionCarriesPaymentRows', () => {
  it('is true for the four payment source types and for a correction', () => {
    for (const t of ['invoice_paid', 'invoice_cash_payment', 'supplier_invoice_paid', 'supplier_invoice_cash_payment', 'correction']) {
      expect(correctionCarriesPaymentRows(t)).toBe(true)
    }
  })

  it('is false for every other source type', () => {
    for (const t of ['manual', 'bank_transaction', 'invoice_created', 'storno', null, undefined]) {
      expect(correctionCarriesPaymentRows(t)).toBe(false)
    }
  })
})

describe('relinkPaymentRowsToEntry', () => {
  it('re-points the customer and supplier payment rows and the supplier invoice pointer, scoped by company', async () => {
    const { client, calls } = makeClient()
    const error = await relinkPaymentRowsToEntry(client, 'company-1', { id: 'c2', source_type: 'invoice_paid' }, 'c4')

    expect(error).toBeUndefined()
    expect(calls).toEqual([
      { table: 'invoice_payments', payload: { journal_entry_id: 'c4' }, eqs: [['company_id', 'company-1'], ['journal_entry_id', 'c2']] },
      { table: 'supplier_invoice_payments', payload: { journal_entry_id: 'c4' }, eqs: [['company_id', 'company-1'], ['journal_entry_id', 'c2']] },
      { table: 'supplier_invoices', payload: { payment_journal_entry_id: 'c4' }, eqs: [['company_id', 'company-1'], ['payment_journal_entry_id', 'c2']] },
    ])
  })

  it('follows a correction of a correction', async () => {
    const { client, calls } = makeClient()
    await relinkPaymentRowsToEntry(client, 'company-1', { id: 'c4', source_type: 'correction' }, 'c6')
    expect(calls).toHaveLength(3)
  })

  it('runs no query for a verifikat that carries no payment rows', async () => {
    const { client, from } = makeClient()
    const error = await relinkPaymentRowsToEntry(client, 'company-1', { id: 'a1', source_type: 'manual' }, 'a3')
    expect(error).toBeUndefined()
    expect(from).not.toHaveBeenCalled()
  })

  it('returns the first failure without throwing and still moves the other tables', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, calls } = makeClient({ invoice_payments: { error: { message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' } } })
    const error = await relinkPaymentRowsToEntry(client, 'company-1', { id: 'c2', source_type: 'invoice_paid' }, 'c4')
    expect(error).toBe('BANK_ANCHOR_SETTLEMENT_CHANGED')
    expect(calls.map((c) => c.table)).toEqual(['invoice_payments', 'supplier_invoice_payments', 'supplier_invoices'])
  })
})
