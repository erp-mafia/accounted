/**
 * findStaleBankAnchors (PH 214): which booked rows are hand-made rows whose
 * verifikat books no bank line, the one booked shape that may be ignored.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { findStaleBankAnchors, type StaleAnchorRow } from '../stale-bank-anchor'

const COMPANY = 'company-1'

/** A sale typed in as a transaction and booked on the clearing account (PH 214). */
const saleRow: StaleAnchorRow = {
  id: 'tx-sale',
  journal_entry_id: 'je-sale',
  cash_account_id: null,
  currency: 'SEK',
  amount: 4277,
  bank_connection_id: null,
  import_source: null,
  invoice_id: null,
  supplier_invoice_id: null,
}

type Enqueue = (r: { data?: unknown; error?: unknown }) => void

/** The settlement lookup for an unbound SEK row: one enabled SEK account, 1930. */
function enqueueSettlement1930(enqueue: Enqueue) {
  enqueue({ data: [{ ledger_account: '1930' }] })
}

function enqueueNoOtherAnchors(enqueue: Enqueue) {
  enqueue({ data: [] }) // transaction_voucher_links
  enqueue({ data: [] }) // invoice_payments
  enqueue({ data: [] }) // supplier_invoice_payments
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('findStaleBankAnchors', () => {
  it('finds a hand-made deposit whose posted verifikat has no line on the bank account', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueSettlement1930(enqueue)
    enqueue({ data: [{ id: 'je-sale', status: 'posted' }] })
    // Debit 1580, credit 3001/2611: nothing on 1930, so the line read is empty.
    enqueue({ data: [] })
    enqueueNoOtherAnchors(enqueue)

    const stale = await findStaleBankAnchors(supabase as never, COMPANY, [saleRow])

    expect([...stale]).toEqual(['tx-sale'])
    // Only the settlement account's lines are read; account numbers are strings.
    expect(findCalls('journal_entry_lines', 'in')).toEqual([
      ['journal_entry_id', ['je-sale']],
      ['account_number', ['1930']],
    ])
  })

  it('leaves a normal booking alone: the verifikat debits the bank account for a deposit', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueSettlement1930(enqueue)
    enqueue({ data: [{ id: 'je-sale', status: 'posted' }] })
    enqueue({ data: [{ journal_entry_id: 'je-sale', account_number: '1930', debit_amount: 4277, credit_amount: 0 }] })

    const stale = await findStaleBankAnchors(supabase as never, COMPANY, [saleRow])

    expect(stale.size).toBe(0)
    expect(findCalls('transaction_voucher_links', 'select')).toEqual([])
  })

  it('counts a line on the bank account in the wrong direction as no bank line, as the guard does', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueSettlement1930(enqueue)
    enqueue({ data: [{ id: 'je-sale', status: 'posted' }] })
    enqueue({ data: [{ journal_entry_id: 'je-sale', account_number: '1930', debit_amount: 0, credit_amount: 4277 }] })
    enqueueNoOtherAnchors(enqueue)

    const stale = await findStaleBankAnchors(supabase as never, COMPANY, [saleRow])

    expect([...stale]).toEqual(['tx-sale'])
  })

  it('never offers a bank-feed or bank-file row: money moved there, the verifikat is what to correct', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()

    const stale = await findStaleBankAnchors(supabase as never, COMPANY, [
      { ...saleRow, id: 'tx-feed', bank_connection_id: 'conn-1' },
      { ...saleRow, id: 'tx-file', import_source: 'camt053' },
    ])

    expect(stale.size).toBe(0)
    expect(findCalls('cash_accounts', 'select')).toEqual([])
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it('never offers a row matched to an invoice or one with no pointer', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()

    const stale = await findStaleBankAnchors(supabase as never, COMPANY, [
      { ...saleRow, id: 'tx-inv', invoice_id: 'inv-1' },
      { ...saleRow, id: 'tx-sinv', supplier_invoice_id: 'sinv-1' },
      { ...saleRow, id: 'tx-open', journal_entry_id: null },
    ])

    expect(stale.size).toBe(0)
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it('leaves a row whose verifikat is reversed: storno already released it', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueSettlement1930(enqueue)
    enqueue({ data: [{ id: 'je-sale', status: 'reversed' }] })

    const stale = await findStaleBankAnchors(supabase as never, COMPANY, [saleRow])

    expect(stale.size).toBe(0)
    expect(findCalls('journal_entry_lines', 'select')).toEqual([])
  })

  it('leaves a row that a voucher link or a payment also anchors', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueSettlement1930(enqueue)
    enqueue({
      data: [
        { id: 'je-sale', status: 'posted' },
        { id: 'je-b', status: 'posted' },
      ],
    })
    enqueue({ data: [] })
    enqueue({ data: [{ transaction_id: 'tx-sale' }] }) // voucher link
    enqueue({ data: [] })
    enqueue({ data: [{ transaction_id: 'tx-b' }] }) // supplier payment

    const stale = await findStaleBankAnchors(supabase as never, COMPANY, [
      saleRow,
      { ...saleRow, id: 'tx-b', journal_entry_id: 'je-b' },
    ])

    expect(stale.size).toBe(0)
  })

  it('offers nothing when a read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueSettlement1930(enqueue)
    enqueue({ data: null, error: { message: 'db down' } })

    const stale = await findStaleBankAnchors(supabase as never, COMPANY, [saleRow])

    expect(stale.size).toBe(0)
  })
})
