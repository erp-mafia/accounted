/**
 * Orders without a supplier invoice (skattekonto, salary) are linked to
 * their own debit and executed, never booked by it: a signed order whose
 * bank keeps answering RCVD is otherwise left waiting for good.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import { createIngestClaims, type IngestBatch } from '@/lib/transactions/ingest-matcher'
import type { IngestResult, RawTransaction } from '@/types'

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  findFiscalPeriod: vi.fn(),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))

import { linkOrderToDebit, loadOpenPaymentOrders, PAYMENT_ORDER_MATCH_METHOD } from '../auto-settle'
import { debitOfTransaction, findLinkableOrderForDebit, findOrderForDebit, isDebitLinkableOrder } from '../debit-match'
import { paymentOrderIngestMatcher } from '../ingest-matcher'
import {
  ARCIM,
  arcimDebit,
  arcimOrder,
  RCVD_TAX,
  rcvdTaxBatch,
  rcvdTaxDebit,
  rcvdTaxOrder,
  salaryDebit,
  salaryOrder,
} from './fixtures'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
let db: ReturnType<typeof createTableMockSupabase>

/** The order as the loaders hand it on once its finished signing is read: signed_at from the batch. */
const signedTaxOrder = (overrides = {}) => rcvdTaxOrder({ signed_at: rcvdTaxBatch().signed_at, ...overrides })

function writes(): Array<{ table: string; method: string; args: unknown[] }> {
  return db.calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))
}

function events(): Array<Record<string, unknown>> {
  return db.findCalls('payment_order_events', 'insert').flatMap(([rows]) => rows as Array<Record<string, unknown>>)
}

beforeEach(() => {
  vi.clearAllMocks()
  db = createTableMockSupabase({
    payment_orders: [
      { data: rcvdTaxOrder() }, // read again before the link
      { data: [] }, // no other order is linked to the debit
      { data: [{ id: RCVD_TAX.orderId }] }, // the compare-and-set
    ],
    payment_order_batches: { data: [rcvdTaxBatch()] },
    transactions: { data: rcvdTaxDebit() },
    payment_order_events: { data: null },
  })
})

describe('findLinkableOrderForDebit', () => {
  const debit = debitOfTransaction(rcvdTaxDebit())

  it("links the signed skattekonto order to its booked debit by Skatteverket's hyphenated bankgiro", () => {
    expect(findLinkableOrderForDebit(debit, [signedTaxOrder()])).toEqual({ order: signedTaxOrder(), basis: 'payee' })
  })

  it('never links an order whose signing did not finish: awaiting_signature without signed_at, or still submitted', () => {
    expect(isDebitLinkableOrder(rcvdTaxOrder())).toBe(false)
    expect(findLinkableOrderForDebit(debit, [rcvdTaxOrder()])).toBeNull()
    expect(findLinkableOrderForDebit(debit, [signedTaxOrder({ status: 'submitted' })])).toBeNull()
  })

  it('never links another amount, another account, a day outside the window, or an order linked already', () => {
    expect(findLinkableOrderForDebit({ ...debit, amount: -12344 }, [signedTaxOrder()])).toBeNull()
    expect(findLinkableOrderForDebit({ ...debit, cash_account_id: null }, [signedTaxOrder()])).toBeNull()
    expect(findLinkableOrderForDebit({ ...debit, date: '2026-10-31' }, [signedTaxOrder()])).toBeNull()
    expect(findLinkableOrderForDebit(debit, [signedTaxOrder({ status: 'executed', matched_transaction_id: 'tx-other' })])).toBeNull()
  })

  it('wants the debit to name the order besides its amount: no bankgiro, no OCR, no end-to-end id is no link', () => {
    expect(findLinkableOrderForDebit({ ...debit, description: 'BETALNING' }, [signedTaxOrder()])).toBeNull()
    expect(findLinkableOrderForDebit({ ...debit, description: 'BETALNING OCR 1655446688087' }, [signedTaxOrder()])).toMatchObject({ basis: 'reference' })
    expect(
      findLinkableOrderForDebit({ ...debit, description: 'BETALNING', end_to_end_id: signedTaxOrder().end_to_end_id.toUpperCase() }, [signedTaxOrder()]),
    ).toMatchObject({ basis: 'end_to_end_id' })
  })

  it('never links by amount a debit that carries another of our end-to-end ids', () => {
    expect(findLinkableOrderForDebit({ ...debit, end_to_end_id: `ACC${'f'.repeat(32)}` }, [signedTaxOrder()])).toBeNull()
  })

  it("links a salary payment by the run's message, compared without regard to case or å/ä/ö", () => {
    const match = findLinkableOrderForDebit(debitOfTransaction(salaryDebit('tx-1')), [salaryOrder('s1')])
    expect(match).toMatchObject({ basis: 'reference' })
    expect(match?.order.id).toBe('s1')
  })

  it('does not guess between two salary payments of the same amount the message cannot tell apart, and lets the payee account decide', () => {
    const twins = [salaryOrder('s1'), salaryOrder('s2', { payee_clearing: '6000', payee_account: '123456789' })]
    expect(findLinkableOrderForDebit(debitOfTransaction(salaryDebit('tx-1')), twins)).toBeNull()

    const named = debitOfTransaction(salaryDebit('tx-1', { counterparty_account: '000608123456789' }))
    expect(findLinkableOrderForDebit(named, twins)).toMatchObject({ order: { id: 's2' }, basis: 'payee' })
  })

  it('leaves supplier invoice orders to findOrderForDebit, which still never takes an order without an invoice', () => {
    const supplierDebit = debitOfTransaction(arcimDebit())
    expect(findLinkableOrderForDebit(supplierDebit, [arcimOrder()])).toBeNull()
    expect(findOrderForDebit(supplierDebit, [arcimOrder()])).toMatchObject({ basis: 'payee', confidence: 0.98 })
    expect(findOrderForDebit(debit, [signedTaxOrder()])).toBeNull()
  })
})

describe('linkOrderToDebit', () => {
  const link = () =>
    linkOrderToDebit(db.supabase as unknown as SupabaseClient, {
      order: { id: RCVD_TAX.orderId, company_id: RCVD_TAX.companyId },
      transaction: { id: RCVD_TAX.transactionId },
      basis: 'payee',
      log,
    })

  it('moves the RCVD order of a finished signing to executed on its debit, linked, with a matched event, and books nothing', async () => {
    expect(await link()).toEqual({ ok: true, fromStatus: 'awaiting_signature' })

    // The signing is read for the order still awaiting_signature.
    expect(db.findCalls('payment_order_batches', 'in')).toEqual([['id', [RCVD_TAX.batchId]]])
    const update = db.findCall('payment_orders', 'update')?.[0] as Record<string, unknown>
    expect(update).toMatchObject({
      status: 'executed',
      executed_at: '2026-10-27T00:00:00.000Z',
      matched_transaction_id: RCVD_TAX.transactionId,
    })
    expect(typeof update.matched_at).toBe('string')
    // Compare-and-set on the status read, and never over another link.
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['status', 'awaiting_signature'])
    expect(db.findCalls('payment_orders', 'is')).toEqual(
      expect.arrayContaining([['matched_transaction_id', null], ['supplier_invoice_id', null]]),
    )
    expect(events()).toEqual([
      expect.objectContaining({
        payment_order_id: RCVD_TAX.orderId,
        event_type: 'matched',
        from_status: 'awaiting_signature',
        to_status: 'executed',
        provider_status: 'RCVD',
        detail: expect.objectContaining({
          transaction_id: RCVD_TAX.transactionId,
          by: 'debit',
          method: PAYMENT_ORDER_MATCH_METHOD,
          matched_by: 'payee',
          purpose: 'skattekonto',
        }),
      }),
    ])
    // Only the order and its event are written: no journal entry, no transaction update.
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(writes().map((w) => `${w.table}.${w.method}`)).toEqual(['payment_orders.update', 'payment_order_events.insert'])
  })

  it('keeps the time the bank reported for an order it already executed', async () => {
    db.setTable('payment_orders', [
      { data: rcvdTaxOrder({ status: 'executed', provider_status: 'ACSC', executed_at: '2026-10-27T03:00:00Z', signed_at: '2026-10-26T17:09:00Z' }) },
      { data: [] },
      { data: [{ id: RCVD_TAX.orderId }] },
    ])

    expect(await link()).toEqual({ ok: true, fromStatus: 'executed' })
    expect(db.findCall('payment_orders', 'update')?.[0]).not.toHaveProperty('executed_at', expect.anything())
  })

  it('leaves an order whose signing never finished, and writes nothing', async () => {
    db.setTable('payment_order_batches', { data: [rcvdTaxBatch({ status: 'awaiting_signature', signed_at: null })] })

    expect(await link()).toEqual({ ok: false, reason: 'order_not_linkable' })
    expect(writes()).toEqual([])
  })

  it('leaves a debit of another amount, and writes nothing', async () => {
    db.setTable('transactions', { data: rcvdTaxDebit({ amount: -12000 }) })

    expect(await link()).toEqual({ ok: false, reason: 'debit_does_not_match' })
    expect(writes()).toEqual([])
  })

  it('never links a debit another order is linked to already', async () => {
    db.setTable('payment_orders', [{ data: rcvdTaxOrder() }, { data: [{ id: 'other-order' }] }])

    expect(await link()).toEqual({ ok: false, reason: 'transaction_linked_elsewhere' })
    expect(writes()).toEqual([])
  })

  it('reports a lost compare-and-set without an event', async () => {
    db.setTable('payment_orders', [{ data: rcvdTaxOrder() }, { data: [] }, { data: [] }])

    expect(await link()).toEqual({ ok: false, reason: 'link_failed' })
    expect(events()).toEqual([])
    expect(log.warn).toHaveBeenCalled()
  })
})

describe('loadOpenPaymentOrders with orders without an invoice', () => {
  it('loads the RCVD order of a finished signing as signed, next to the supplier orders, and drops one whose signing is open', async () => {
    const open = rcvdTaxOrder({ id: 'tax-open', batch_id: 'batch-open', end_to_end_id: `ACC${'1'.repeat(32)}` })
    db.setTable('payment_orders', { data: [arcimOrder(), rcvdTaxOrder(), open] })
    db.setTable('payment_order_batches', {
      data: [rcvdTaxBatch(), rcvdTaxBatch({ id: 'batch-open', status: 'awaiting_signature', signed_at: null })],
    })

    const orders = await loadOpenPaymentOrders(db.supabase as unknown as SupabaseClient, RCVD_TAX.companyId)

    expect(orders.map((o) => [o.id, o.signed_at])).toEqual([
      [ARCIM.orderId, arcimOrder().signed_at],
      [RCVD_TAX.orderId, rcvdTaxBatch().signed_at],
    ])
    expect(db.findCalls('payment_orders', 'in')).toContainEqual(['status', ['awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed']])
  })
})

describe('the payment-order ingest pass and a debit of an order without an invoice', () => {
  function ingestBatch(): IngestBatch {
    return {
      supabase: db.supabase as unknown as SupabaseClient,
      companyId: RCVD_TAX.companyId,
      userId: RCVD_TAX.userId,
      options: {},
      log,
      result: { auto_matched_invoices: 0 } as IngestResult,
      claims: createIngestClaims(),
      pools: { customerInvoices: vi.fn(), supplierInvoices: [] },
      logMatch: vi.fn(),
    }
  }
  const raw = { date: '2026-10-27', amount: -12345, description: '5050-1055 Betalning', currency: 'SEK' } as RawTransaction

  it('links the order and leaves the row to the passes after it: nothing booked, no hint', async () => {
    const batch = ingestBatch()
    const outcome = await paymentOrderIngestMatcher.match(batch, { orders: [signedTaxOrder()] }, { tx: rcvdTaxDebit({ journal_entry_id: null }), raw, reread: false })

    expect(outcome).toBe('none')
    expect(batch.claims.has('payment_order', RCVD_TAX.orderId)).toBe(true)
    expect(db.findCall('payment_orders', 'update')?.[0]).toMatchObject({ status: 'executed', matched_transaction_id: RCVD_TAX.transactionId })
    expect(db.findCalls('transactions', 'update')).toEqual([])
    expect(batch.logMatch).not.toHaveBeenCalled()
    expect(batch.result.auto_matched_invoices).toBe(0)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('does nothing for an order whose signing did not finish', async () => {
    const batch = ingestBatch()
    const outcome = await paymentOrderIngestMatcher.match(batch, { orders: [rcvdTaxOrder()] }, { tx: rcvdTaxDebit(), raw, reread: false })

    expect(outcome).toBe('none')
    expect(writes()).toEqual([])
    expect(batch.claims.has('payment_order', RCVD_TAX.orderId)).toBe(false)
  })
})
