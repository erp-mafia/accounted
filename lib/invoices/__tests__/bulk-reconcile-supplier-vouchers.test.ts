import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the two dependencies so we test the ORCHESTRATION logic (confidence
// gating, near-tie margin, cross-invoice voucher exclusivity, consumed-voucher
// filtering) in isolation. The matcher + RPC link are exercised by their own
// suites (supplier-voucher-matching.test.ts / .pg.test.ts).
vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAllRows: vi.fn() }))
vi.mock('../supplier-voucher-matching', () => ({
  findMatchingVouchersForSupplierInvoice: vi.fn(),
  linkSupplierInvoiceToVoucher: vi.fn(),
}))

import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  findMatchingVouchersForSupplierInvoice,
  linkSupplierInvoiceToVoucher,
} from '../supplier-voucher-matching'
import { reconcileSupplierInvoiceVouchers } from '../bulk-reconcile-supplier-vouchers'

const mFetchAll = vi.mocked(fetchAllRows)
const mFind = vi.mocked(findMatchingVouchersForSupplierInvoice)
const mLink = vi.mocked(linkSupplierInvoiceToVoucher)

interface InvOver {
  id: string
  number?: string
  status?: string
  total?: number
  remaining?: number
  due?: string
  isCredit?: boolean
}

function inv(over: InvOver) {
  const total = over.total ?? 1000
  return {
    id: over.id,
    supplier_invoice_number: over.number ?? `F-${over.id}`,
    arrival_number: 1,
    status: over.status ?? 'overdue',
    currency: 'SEK',
    total,
    paid_amount: 0,
    remaining_amount: over.remaining ?? total,
    due_date: over.due ?? '2026-02-01',
    paid_at: null,
    exchange_rate: null,
    supplier_id: 's1',
    is_credit_note: over.isCredit ?? false,
    supplier: { id: 's1', name: 'Leverantör AB' },
  }
}

function cand(over: { je: string; confidence?: number; amount?: number; n?: number }) {
  return {
    journal_entry_id: over.je,
    voucher_series: 'A',
    voucher_number: over.n ?? 1,
    entry_date: '2026-02-01',
    description: 'Leverantörsbetalning',
    ap_debit_amount: over.amount ?? 1000,
    currency: 'SEK',
    ap_line_currency: 'SEK',
    period_locked: false,
    confidence: over.confidence ?? 0.95,
    match_reason: 'test',
  }
}

/** Queue the two fetchAllRows reads: invoices, then existing payments. */
function queue(invoices: unknown[], payments: { journal_entry_id: string | null }[] = []) {
  mFetchAll.mockReset()
  mFetchAll.mockResolvedValueOnce(invoices as never).mockResolvedValueOnce(payments as never)
}

const okLink = (over: { paymentAmount?: number; status?: 'paid' | 'partially_paid'; je: string }) => ({
  ok: true as const,
  result: {
    paymentId: 'p1',
    invoiceStatus: over.status ?? ('paid' as const),
    paidAmount: 1000,
    remainingAmount: 0,
    paymentAmount: over.paymentAmount ?? 1000,
    journalEntryId: over.je,
  },
})

const run = () =>
  reconcileSupplierInvoiceVouchers({ supabase: {} as never, companyId: 'c1', userId: 'u1' })

describe('reconcileSupplierInvoiceVouchers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mFind.mockReset()
    mLink.mockReset()
  })

  it('auto-links a single unambiguous exact match and marks it paid', async () => {
    queue([inv({ id: 'i1', remaining: 1000 })])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.95, amount: 1000 })] as never)
    mLink.mockResolvedValueOnce(okLink({ je: 'v1' }) as never)

    const res = await run()

    expect(res.scanned).toBe(1)
    expect(res.autoLinked).toBe(1)
    expect(res.ambiguous).toBe(0)
    expect(res.unmatched).toBe(0)
    expect(res.links).toHaveLength(1)
    expect(res.links[0]).toMatchObject({ journal_entry_id: 'v1', invoice_status: 'paid' })
    expect(mLink).toHaveBeenCalledTimes(1)
    expect(mLink).toHaveBeenCalledWith({} , 'u1', 'c1', expect.objectContaining({
      supplierInvoiceId: 'i1',
      journalEntryId: 'v1',
    }))
  })

  it('does not auto-link a below-threshold (amount-only) candidate', async () => {
    queue([inv({ id: 'i1' })])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.8, amount: 1000 })] as never)

    const res = await run()

    expect(res.autoLinked).toBe(0)
    expect(res.ambiguous).toBe(1)
    expect(res.review[0]).toMatchObject({ supplier_invoice_id: 'i1', reason: 'low_confidence' })
    expect(mLink).not.toHaveBeenCalled()
  })

  it('does not auto-link when the top two candidates are within the margin', async () => {
    queue([inv({ id: 'i1' })])
    mFind.mockResolvedValueOnce([
      cand({ je: 'v1', confidence: 0.95, amount: 1000 }),
      cand({ je: 'v2', confidence: 0.95, amount: 1000, n: 2 }),
    ] as never)

    const res = await run()

    expect(res.autoLinked).toBe(0)
    expect(res.ambiguous).toBe(1)
    expect(res.review[0].reason).toBe('multiple_candidates')
    expect(mLink).not.toHaveBeenCalled()
  })

  it('demotes BOTH invoices when one voucher is the top pick for two of them', async () => {
    queue([inv({ id: 'i1', remaining: 1000 }), inv({ id: 'i2', remaining: 1000 })])
    // Each invoice has exactly one strong candidate — but it is the SAME voucher.
    mFind
      .mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.95, amount: 1000 })] as never)
      .mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.95, amount: 1000 })] as never)

    const res = await run()

    expect(res.autoLinked).toBe(0)
    expect(res.ambiguous).toBe(2)
    expect(res.review.every((r) => r.reason === 'voucher_contested')).toBe(true)
    expect(mLink).not.toHaveBeenCalled()
  })

  it('excludes a voucher already consumed as a payment on another invoice', async () => {
    queue([inv({ id: 'i1' })], [{ journal_entry_id: 'v1' }])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.99, amount: 1000 })] as never)

    const res = await run()

    expect(res.unmatched).toBe(1)
    expect(res.autoLinked).toBe(0)
    expect(mLink).not.toHaveBeenCalled()
  })

  it('routes a candidate whose AP debit exceeds the remaining to review', async () => {
    queue([inv({ id: 'i1', total: 1000, remaining: 500 })])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.99, amount: 1000 })] as never)

    const res = await run()

    expect(res.autoLinked).toBe(0)
    expect(res.review[0].reason).toBe('amount_exceeds_remaining')
    expect(mLink).not.toHaveBeenCalled()
  })

  it('dryRun produces the plan without writing', async () => {
    queue([inv({ id: 'i1', remaining: 1000 })])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.95, amount: 1000 })] as never)

    const res = await reconcileSupplierInvoiceVouchers({
      supabase: {} as never,
      companyId: 'c1',
      userId: 'u1',
      dryRun: true,
    })

    expect(res.autoLinked).toBe(1)
    expect(res.links[0]).toMatchObject({ journal_entry_id: 'v1', invoice_status: 'paid' })
    expect(mLink).not.toHaveBeenCalled()
  })

  it('skips credit notes and zero-remaining invoices entirely', async () => {
    queue([inv({ id: 'i1', isCredit: true }), inv({ id: 'i2', remaining: 0 })])

    const res = await run()

    expect(res.scanned).toBe(0)
    expect(res.autoLinked).toBe(0)
    expect(mFind).not.toHaveBeenCalled()
  })

  it('surfaces an RPC rejection as review rather than a successful link', async () => {
    queue([inv({ id: 'i1', remaining: 1000 })])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.95, amount: 1000 })] as never)
    mLink.mockResolvedValueOnce({ ok: false, code: 'LINK_SI_VOUCHER_ALREADY_LINKED' } as never)

    const res = await run()

    expect(res.autoLinked).toBe(0)
    expect(res.ambiguous).toBe(1)
    expect(res.review[0].reason).toBe('voucher_contested')
  })
})
