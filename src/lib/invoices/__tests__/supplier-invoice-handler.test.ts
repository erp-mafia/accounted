import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeSupplierInvoice } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: vi.fn(),
}))

vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { makeTransaction } from '@/tests/helpers'
import { registerSupplierInvoiceHandler } from '../supplier-invoice-handler'

const mockCreateClient = vi.mocked(createClient)
const mockServiceClient = vi.mocked(createServiceClientNoCookies)
const mockCreateEntry = vi.mocked(createSupplierInvoiceRegistrationEntry)
const mockLogMatch = vi.mocked(logMatchEvent)

/**
 * Minimal Supabase mock for the retro-match handler that RECORDS the
 * transactions `.update()` payloads (the queued proxy mock can't), so we can
 * assert it writes a suggestion column rather than an auto-link.
 */
function makeRetroMock(opts: {
  invoice: unknown
  linkedCount: number
  candidates: unknown[]
  /** What the guarded suggestion write answers; one updated row by default. */
  update?: { data: unknown; error: unknown }
}) {
  const updates: Record<string, unknown>[] = []
  const chain = (result: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return () => chain(result)
        },
      },
    )
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'supplier_invoices') return chain({ data: opts.invoice, error: null })
      if (table === 'open_bank_rows') return chain({ data: opts.candidates, error: null })
      if (table === 'transactions') {
        return {
          select: () => chain({ count: opts.linkedCount, data: null, error: null }),
          update: (payload: Record<string, unknown>) => {
            updates.push(payload)
            return chain(opts.update ?? { data: [{ id: 'tx-retro' }], error: null })
          },
        }
      }
      return chain({ data: null, error: null })
    }),
  }
  return { supabase, updates }
}

function emitRegistered(invoiceId: string) {
  return eventBus.emit({
    type: 'supplier_invoice.registered',
    payload: {
      supplierInvoice: { id: invoiceId } as never,
      userId: 'user-1',
      companyId: 'company-1',
    },
  })
}

describe('Supplier Invoice Core Handler', () => {
  let unsubscribe: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    unsubscribe = registerSupplierInvoiceHandler()
  })

  afterEach(() => {
    unsubscribe()
  })

  // The registration entry is posted by the flow that creates the invoice,
  // per booksInvoicesOnIssue(); a deferred one by the Bokför step. A core
  // subscriber on .confirmed used to post it a second way, on
  // accounting_method alone, and booked deferred companies at registration.
  it('never books on supplier_invoice.confirmed, even for an unlinked invoice', async () => {
    const invoice = makeSupplierInvoice({ id: 'si-1', supplier_id: 'sup-1', registration_journal_entry_id: null })

    await eventBus.emit({
      type: 'supplier_invoice.confirmed',
      payload: {
        inboxItem: { id: 'inbox-1' } as never,
        supplierInvoice: invoice,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(mockCreateEntry).not.toHaveBeenCalled()
    expect(mockCreateClient).not.toHaveBeenCalled()
    expect(mockServiceClient).not.toHaveBeenCalled()
  })

  describe('retroactive match on supplier_invoice.registered', () => {
    const baseInvoice = () =>
      makeSupplierInvoice({
        id: 'si-retro',
        status: 'registered',
        remaining_amount: 29890,
        total: 29890,
        invoice_date: '2026-06-05',
        due_date: '2026-07-05',
        transaction_id: null,
        payment_reference: null,
      })

    const matchingTx = () =>
      makeTransaction({
        id: 'tx-retro',
        amount: -29890, // exact, in-window → Pass 3 amount_date (0.85)
        date: '2026-06-08',
        description: 'Bg-bet via internet',
        reference: null,
        supplier_invoice_id: null,
        journal_entry_id: null,
      })

    it('writes a SUGGESTION (never an auto-link) for an exact in-window payment', async () => {
      const { supabase, updates } = makeRetroMock({
        invoice: baseInvoice(),
        linkedCount: 0,
        candidates: [matchingTx()],
      })
      mockServiceClient.mockReturnValue(supabase as never)

      await emitRegistered('si-retro')

      // The whole point of "pre-fill, confirm to book": suggestion column only.
      expect(updates).toEqual([{ potential_supplier_invoice_id: 'si-retro' }])
      expect(mockLogMatch).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'tx-retro',
        'auto_suggested',
        expect.objectContaining({
          supplierInvoiceId: 'si-retro',
          matchMethod: 'amount_date',
          matchConfidence: 0.85,
        }),
      )
    })

    // B14: registered over MCP, v1 or a webhook there is no session cookie and
    // the cookie client is the anon role: it found no invoice (406 on
    // .single()) and the retro-match silently never ran. Same outcome now
    // whichever path emitted the event.
    it.each([
      ['a dashboard request (session cookie)', 'session'],
      ['an MCP, v1 or webhook request (anon cookie client)', 'anon'],
      ['a cron or the outbox dispatcher (no request scope)', 'no-request'],
    ] as const)('suggests the payment when emitted from %s', async (_label, mode) => {
      const { supabase, updates } = makeRetroMock({
        invoice: baseInvoice(),
        linkedCount: 0,
        candidates: [matchingTx()],
      })
      const anon = makeRetroMock({ invoice: null, linkedCount: 0, candidates: [] }).supabase
      mockCreateClient.mockImplementation(async () => {
        if (mode === 'no-request') throw new Error('cookies() was called outside a request scope')
        return (mode === 'session' ? supabase : anon) as never
      })
      mockServiceClient.mockReturnValue(supabase as never)

      await emitRegistered('si-retro')

      expect(updates).toEqual([{ potential_supplier_invoice_id: 'si-retro' }])
      expect(mockLogMatch).toHaveBeenCalledWith(
        supabase,
        'user-1',
        'tx-retro',
        'auto_suggested',
        expect.objectContaining({ supplierInvoiceId: 'si-retro' }),
      )
      expect(mockCreateClient).not.toHaveBeenCalled()
    })

    it('no-ops when the invoice is already tied to a transaction', async () => {
      const { supabase, updates } = makeRetroMock({
        invoice: { ...baseInvoice(), transaction_id: 'tx-existing' },
        linkedCount: 0,
        candidates: [matchingTx()],
      })
      mockServiceClient.mockReturnValue(supabase as never)
      await emitRegistered('si-retro')
      expect(updates).toHaveLength(0)
      expect(mockLogMatch).not.toHaveBeenCalled()
    })

    it('no-ops (idempotent) when a transaction is already linked to the invoice', async () => {
      const { supabase, updates } = makeRetroMock({
        invoice: baseInvoice(),
        linkedCount: 1,
        candidates: [matchingTx()],
      })
      mockServiceClient.mockReturnValue(supabase as never)
      await emitRegistered('si-retro')
      expect(updates).toHaveLength(0)
      expect(mockLogMatch).not.toHaveBeenCalled()
    })

    it('logs no suggestion when the transaction was linked between the scan and the write', async () => {
      const { supabase, updates } = makeRetroMock({
        invoice: baseInvoice(),
        linkedCount: 0,
        candidates: [matchingTx()],
        update: { data: [], error: null },
      })
      mockServiceClient.mockReturnValue(supabase as never)
      await emitRegistered('si-retro')
      expect(updates).toHaveLength(1)
      expect(mockLogMatch).not.toHaveBeenCalled()
    })

    it('logs no suggestion when the suggestion write was refused', async () => {
      const { supabase } = makeRetroMock({
        invoice: baseInvoice(),
        linkedCount: 0,
        candidates: [matchingTx()],
        update: { data: null, error: { message: 'permission denied' } },
      })
      mockServiceClient.mockReturnValue(supabase as never)
      await emitRegistered('si-retro')
      expect(mockLogMatch).not.toHaveBeenCalled()
    })

    it('no-ops when no candidate transaction matches', async () => {
      const { supabase, updates } = makeRetroMock({
        invoice: baseInvoice(),
        linkedCount: 0,
        candidates: [],
      })
      mockServiceClient.mockReturnValue(supabase as never)
      await emitRegistered('si-retro')
      expect(updates).toHaveLength(0)
      expect(mockLogMatch).not.toHaveBeenCalled()
    })
  })
})
