/**
 * The customer invoice ingest matcher with the company's auto-book switch
 * (crm#2226): a row whose reference names its invoice exactly is booked when
 * the switch is on, and gets today's hint when it is off or the booking is
 * refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeInvoice, makeTransaction } from '@/tests/helpers'
import { createIngestClaims, type IngestBatch } from '@/lib/transactions/ingest-matcher'
import type { IngestResult, RawTransaction } from '@/types'
import type { MatchableInvoice } from '../invoice-matching'

const { mockAutoBook, mockReadSwitch } = vi.hoisted(() => ({ mockAutoBook: vi.fn(), mockReadSwitch: vi.fn() }))
vi.mock('../customer-payment-auto-book', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../customer-payment-auto-book')>()),
  autoBookCustomerPayment: mockAutoBook,
  readCustomerPaymentAutoBook: mockReadSwitch,
}))

const { customerInvoiceIngestMatcher } = await import('../customer-invoice-ingest-matcher')

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const INVOICE = makeInvoice({ id: 'inv-a', invoice_number: '202600425', status: 'sent', total: 1000, remaining_amount: 1000 }) as MatchableInvoice

function setup(invoices: MatchableInvoice[] = [INVOICE]) {
  const updates: unknown[] = []
  const query = {
    update: (payload: unknown) => {
      updates.push(payload)
      return query
    },
    eq: () => Promise.resolve({ error: null }),
  }
  const result = { auto_matched_invoices: 0 } as IngestResult
  const logMatch = vi.fn(async () => undefined)
  const batch = {
    supabase: { from: () => query },
    companyId: 'company-1',
    userId: 'user-1',
    log,
    result,
    claims: createIngestClaims(),
    pools: { customerInvoices: async () => ({ invoices }), supplierInvoices: [] },
    logMatch,
  } as unknown as IngestBatch
  return { batch, updates, result, logMatch }
}

const raw = {} as RawTransaction
const row = (reference: string | null, amount = 1000) => ({
  tx: makeTransaction({ id: 'tx-1', amount, currency: 'SEK', reference, description: 'Inbetalning', merchant_name: null }),
  raw,
  reread: false,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('customerInvoiceIngestMatcher with auto_book_customer_payments', () => {
  it('books a row whose OCR names its invoice, when the switch is on', async () => {
    mockReadSwitch.mockResolvedValue(true)
    mockAutoBook.mockResolvedValue({ ok: true, journalEntryId: 'je-1', invoiceStatus: 'paid' })
    const { batch, updates, result, logMatch } = setup()
    const state = await customerInvoiceIngestMatcher.prepare!(batch)

    expect(await customerInvoiceIngestMatcher.match(batch, state, row('202600425'))).toBe('explained')

    expect(mockAutoBook).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({ id: 'tx-1' }),
      expect.objectContaining({ id: 'inv-a' }),
    )
    expect(result).toMatchObject({ auto_matched_invoices: 1, auto_booked_payments: 1 })
    expect(batch.claims.has('customer_invoice', 'inv-a')).toBe(true)
    // Booked, so no hint and no suggestion log.
    expect(updates).toEqual([])
    expect(logMatch).not.toHaveBeenCalled()
  })

  it('hints as today when the switch is off', async () => {
    mockReadSwitch.mockResolvedValue(false)
    const { batch, updates, result } = setup()
    const state = await customerInvoiceIngestMatcher.prepare!(batch)

    expect(await customerInvoiceIngestMatcher.match(batch, state, row('202600425'))).toBe('explained')

    expect(mockAutoBook).not.toHaveBeenCalled()
    expect(updates).toEqual([{ potential_invoice_id: 'inv-a' }])
    expect(result.auto_booked_payments).toBeUndefined()
  })

  it('hints when the booking is refused', async () => {
    mockReadSwitch.mockResolvedValue(true)
    mockAutoBook.mockResolvedValue({ ok: false, code: 'MATCH_INVOICE_UNATTENDED_FILED_VAT_PERIOD' })
    const { batch, updates, result } = setup()
    const state = await customerInvoiceIngestMatcher.prepare!(batch)

    expect(await customerInvoiceIngestMatcher.match(batch, state, row('202600425'))).toBe('explained')

    expect(updates).toEqual([{ potential_invoice_id: 'inv-a' }])
    expect(result).toMatchObject({ auto_matched_invoices: 1 })
    expect(result.auto_booked_payments).toBeUndefined()
  })

  it('only hints a row matched by amount, or by a reference in a message', async () => {
    mockReadSwitch.mockResolvedValue(true)
    const { batch, updates } = setup()
    const state = await customerInvoiceIngestMatcher.prepare!(batch)

    await customerInvoiceIngestMatcher.match(batch, state, row(null))
    await customerInvoiceIngestMatcher.match(setup().batch, state, row('Faktura 202600425'))

    expect(mockAutoBook).not.toHaveBeenCalled()
    expect(updates).toEqual([{ potential_invoice_id: 'inv-a' }])
  })

  it('reads an unreadable switch as off', async () => {
    mockReadSwitch.mockRejectedValue(new Error('down'))
    const { batch, updates } = setup()
    const state = await customerInvoiceIngestMatcher.prepare!(batch)

    expect(await customerInvoiceIngestMatcher.match(batch, state, row('202600425'))).toBe('explained')

    expect(mockAutoBook).not.toHaveBeenCalled()
    expect(updates).toEqual([{ potential_invoice_id: 'inv-a' }])
  })

  it('reads the switch once per batch, and only for a row it could book', async () => {
    mockReadSwitch.mockResolvedValue(false)
    const { batch } = setup()
    const state = await customerInvoiceIngestMatcher.prepare!(batch)
    expect(mockReadSwitch).not.toHaveBeenCalled()

    await customerInvoiceIngestMatcher.match(batch, state, row(null))
    expect(mockReadSwitch).not.toHaveBeenCalled()

    await customerInvoiceIngestMatcher.match(setup().batch, state, row('202600425'))
    await customerInvoiceIngestMatcher.match(setup().batch, state, row('202600425'))
    expect(mockReadSwitch).toHaveBeenCalledTimes(1)
  })
})
