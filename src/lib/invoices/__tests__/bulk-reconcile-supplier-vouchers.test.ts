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
import { citesOtherInvoice, reconcileSupplierInvoiceVouchers, voucherNamesSupplier } from '../bulk-reconcile-supplier-vouchers'

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
  invoiceDate?: string
  isCredit?: boolean
  supplierName?: string
  fortnoxNumber?: string
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
    ...(over.invoiceDate ? { invoice_date: over.invoiceDate } : {}),
    ...(over.fortnoxNumber ? { fortnox_number: over.fortnoxNumber } : {}),
    due_date: over.due ?? '2026-02-01',
    paid_at: null,
    exchange_rate: null,
    supplier_id: 's1',
    is_credit_note: over.isCredit ?? false,
    supplier: { id: 's1', name: over.supplierName ?? 'Leverantör AB' },
  }
}

function cand(over: { je: string; confidence?: number; amount?: number; n?: number; date?: string; desc?: string }) {
  return {
    journal_entry_id: over.je,
    voucher_series: 'A',
    voucher_number: over.n ?? 1,
    entry_date: over.date ?? '2026-02-01',
    // Names the fixture supplier in full, as a 0.95 match must (voucherNamesSupplier).
    description: over.desc ?? 'Levbet Leverantör AB',
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

  it.each([
    ['a reference hit whose amount settles the invoice', 0.99, 'rule_ocr_reference'],
    ['the exact amount with the supplier name', 0.95, 'rule_counterparty'],
    ['the same with the date bump, which stops below a reference hit', 0.989, 'rule_counterparty'],
  ])('records the rule that chose the pair: %s', async (_case, confidence, linkBasis) => {
    queue([inv({ id: 'i1', remaining: 1000 })])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', confidence, amount: 1000 })] as never)
    mLink.mockResolvedValueOnce(okLink({ je: 'v1' }) as never)

    const res = await run()

    expect(mLink).toHaveBeenCalledWith({}, 'u1', 'c1', expect.objectContaining({ linkBasis }))
    expect(res.links[0].link_basis).toBe(linkBasis)
  })

  it('a dry run plans the rule too: the provider migration links that plan later', async () => {
    queue([inv({ id: 'i1', remaining: 1000 })])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.99, amount: 1000 })] as never)

    const res = await reconcileSupplierInvoiceVouchers({ supabase: {} as never, companyId: 'c1', userId: 'u1', dryRun: true })

    expect(res.links[0].link_basis).toBe('rule_ocr_reference')
    expect(mLink).not.toHaveBeenCalled()
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

  it('does not auto-link a reference hit whose amount differs from the invoice (0.90)', async () => {
    // Desk crm#64: "Ankomstnummer 14 omnämnt" on a 859 kr voucher against a
    // 3 156 kr invoice used to go through at 0.99 as a partial payment.
    queue([inv({ id: 'i1', total: 3156, remaining: 3156 })])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', confidence: 0.9, amount: 859 })] as never)

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
    // Each invoice has exactly one strong candidate, but it is the SAME voucher.
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

it('bounds a worker batch to its invoice IDs and candidate payment references', async () => {
  vi.clearAllMocks()
  queue([inv({ id: 'i1' })])
  mFind.mockResolvedValueOnce([cand({ je: 'consumed' })] as never)
  const calls: unknown[][] = []
  const chain = { select: (...args: unknown[]) => { calls.push(['select', ...args]); return chain },
    eq: (...args: unknown[]) => { calls.push(['eq', ...args]); return chain },
    in: (...args: unknown[]) => { calls.push(['in', ...args]); return chain },
    order: () => chain, range: () => Promise.resolve({ data: [inv({ id: 'i1' })], error: null }),
    limit: (n: number) => { calls.push(['limit', n]); return Promise.resolve({ data: [{ journal_entry_id: 'consumed' }], error: null }) } }
  mFetchAll.mockReset().mockImplementationOnce(async callback => (await callback({ from: 0, to: 999 })).data as never)
  const supabase = { from: vi.fn(() => chain) }
  const result = await reconcileSupplierInvoiceVouchers({ supabase: supabase as never, companyId: 'c1', userId: 'u1', invoiceIds: ['i1'], dryRun: true })
  expect(mFetchAll).toHaveBeenCalledOnce()
  expect(calls).toContainEqual(['in', 'id', ['i1']])
  expect(calls).toContainEqual(['eq', 'journal_entry_id', 'consumed'])
  expect(calls).toContainEqual(['limit', 1])
  expect(result.links).toEqual([])
  expect(mLink).not.toHaveBeenCalled()
})

// PH 241: a recurring supplier's earlier payment (same amount, same name)
// was auto-linked to a later invoice, before that invoice existed.
describe('reconcileSupplierInvoiceVouchers: a voucher dated before the invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mFind.mockReset()
    mLink.mockReset()
  })

  it('is never auto-linked: the invoice goes to review', async () => {
    queue([inv({ id: 'i1', invoiceDate: '2026-07-11', due: '2026-07-30' })])
    mFind.mockResolvedValueOnce([cand({ je: 'v-may', date: '2026-05-20', confidence: 0.95 })] as never)

    const res = await run()

    expect(res.autoLinked).toBe(0)
    expect(res.ambiguous).toBe(1)
    expect(res.review[0]).toMatchObject({ supplier_invoice_id: 'i1', reason: 'paid_before_invoice' })
    expect(mLink).not.toHaveBeenCalled()
  })

  it('does not block, or tie with, a payment dated after the invoice', async () => {
    queue([inv({ id: 'i1', invoiceDate: '2026-07-11', due: '2026-07-30' })])
    mFind.mockResolvedValueOnce([
      cand({ je: 'v-may', date: '2026-05-20', confidence: 0.95 }),
      cand({ je: 'v-aug', date: '2026-08-10', confidence: 0.95, n: 2 }),
    ] as never)
    mLink.mockResolvedValueOnce(okLink({ je: 'v-aug' }) as never)

    const res = await run()

    expect(res.autoLinked).toBe(1)
    expect(res.links[0]).toMatchObject({ journal_entry_id: 'v-aug' })
    expect(mLink).toHaveBeenCalledWith({}, 'u1', 'c1', expect.objectContaining({ journalEntryId: 'v-aug' }))
  })

  it('a payment on the invoice date itself still links', async () => {
    queue([inv({ id: 'i1', invoiceDate: '2026-02-01' })])
    mFind.mockResolvedValueOnce([cand({ je: 'v1', date: '2026-02-01' })] as never)
    mLink.mockResolvedValueOnce(okLink({ je: 'v1' }) as never)

    expect((await run()).autoLinked).toBe(1)
  })
})

// crm#1648: an exact amount with one word of the supplier's name (a town both
// suppliers carry) linked another supplier's payment to this invoice.
describe('reconcileSupplierInvoiceVouchers: the supplier named only in part', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mFind.mockReset()
    mLink.mockReset()
  })

  it('is never auto-linked: the invoice goes to review', async () => {
    queue([inv({ id: 'i1', total: 968, supplierName: 'Växjö Byggteam AB' })])
    mFind.mockResolvedValueOnce([
      cand({ je: 'v-other', confidence: 0.95, amount: 968, desc: 'Levbet Färgservice i Växjö AB (2247)' }),
    ] as never)

    const res = await run()

    expect(res.autoLinked).toBe(0)
    expect(res.ambiguous).toBe(1)
    expect(res.review[0]).toMatchObject({ supplier_invoice_id: 'i1', reason: 'low_confidence' })
    expect(res.review[0].candidates.map((c) => c.journal_entry_id)).toEqual(['v-other'])
    expect(mLink).not.toHaveBeenCalled()
  })

  it('neither in a dry run, which the provider migration settles from', async () => {
    queue([inv({ id: 'i1', total: 968, supplierName: 'Växjö Byggteam AB' })])
    mFind.mockResolvedValueOnce([
      cand({ je: 'v-other', confidence: 0.989, amount: 968, desc: 'Levbet Färgservice i Växjö AB (2247)' }),
    ] as never)

    const res = await reconcileSupplierInvoiceVouchers({ supabase: {} as never, companyId: 'c1', userId: 'u1', dryRun: true })

    expect(res.links).toEqual([])
    expect(res.review[0]).toMatchObject({ reason: 'low_confidence' })
  })

  it('still links the exact amount when the text names the supplier in full', async () => {
    queue([inv({ id: 'i1', total: 968, supplierName: 'Växjö Byggteam AB' })])
    mFind.mockResolvedValueOnce([
      cand({ je: 'v1', confidence: 0.95, amount: 968, desc: 'Leverantörsbetalning VÄXJÖ BYGGTEAM' }),
    ] as never)
    mLink.mockResolvedValueOnce(okLink({ je: 'v1', paymentAmount: 968 }) as never)

    const res = await run()

    expect(res.autoLinked).toBe(1)
    expect(res.links[0]).toMatchObject({ journal_entry_id: 'v1', link_basis: 'rule_counterparty' })
  })

  it('leaves a reference hit alone: the reference, not the name, identifies the invoice', async () => {
    queue([inv({ id: 'i1', total: 968, supplierName: 'Växjö Byggteam AB' })])
    mFind.mockResolvedValueOnce([
      cand({ je: 'v1', confidence: 0.99, amount: 968, desc: 'Bankgiro 123-4567 OCR 26535900' }),
    ] as never)
    mLink.mockResolvedValueOnce(okLink({ je: 'v1', paymentAmount: 968 }) as never)

    const res = await run()

    expect(res.autoLinked).toBe(1)
    expect(res.links[0].link_basis).toBe('rule_ocr_reference')
  })
})

describe('voucherNamesSupplier', () => {
  it.each([
    ['every distinctive word, any case', 'Växjö Byggteam AB', 'Levbet VÄXJÖ BYGGTEAM AB (17)', true],
    ['legal forms and short words are not required', 'Mälarbygg Handelsbolag', 'Betalning Mälarbygg', true],
    ['(publ) is a legal form too', 'Nordkraft Energi AB (publ)', 'Nordkraft Energi oktober', true],
    ['a hyphenated name, written with a hyphen', 'Wiik-Bygg AB', 'Levbet Wiik-Bygg AB (3)', true],
    ['a hyphenated name, written with a space', 'Wiik-Bygg AB', 'Levbet Wiik Bygg', true],
    ['one word of the name only', 'Växjö Byggteam AB', 'Levbet Färgservice i Växjö AB (2247)', false],
    ['the same trade, another company', 'Kronvik Installation AB', 'Levbet Kronvik Bygg AB (6045)', false],
    ['a word inside a longer word', 'Leverantör AB', 'Leverantörsbetalning', false],
    ['a name of legal forms only', 'AB', 'Levbet AB', false],
    ['no name', null, 'Levbet Leverantör AB', false],
    ['no text', 'Leverantör AB', null, false],
  ])('%s', (_case, name, text, expected) => {
    expect(voucherNamesSupplier(name, text)).toBe(expected)
  })
})

// PH 264: a recurring supplier's payment of an earlier invoice (same amount,
// same name, dated after the next invoice arrived) marked that next, unpaid
// invoice as paid.
describe('reconcileSupplierInvoiceVouchers: a voucher that cites another invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mFind.mockReset()
    mLink.mockReset()
  })

  it('is never auto-linked: the invoice goes to review', async () => {
    queue([inv({ id: 'i1', fortnoxNumber: '493', invoiceDate: '2026-10-20', due: '2026-11-19' })])
    mFind.mockResolvedValueOnce([
      cand({ je: 'v-487', date: '2026-10-21', confidence: 0.95, desc: 'Levbet Leverantör AB (487)' }),
    ] as never)

    const res = await run()

    expect(res.autoLinked).toBe(0)
    expect(res.ambiguous).toBe(1)
    expect(res.review[0]).toMatchObject({ supplier_invoice_id: 'i1', reason: 'names_other_invoice' })
    expect(mLink).not.toHaveBeenCalled()
  })

  it('does not block, or tie with, the voucher that cites this invoice', async () => {
    queue([inv({ id: 'i1', fortnoxNumber: '493', invoiceDate: '2026-10-20', due: '2026-11-19' })])
    mFind.mockResolvedValueOnce([
      cand({ je: 'v-487', date: '2026-10-21', confidence: 0.95, desc: 'Levbet Leverantör AB (487)' }),
      cand({ je: 'v-493', date: '2026-11-18', confidence: 0.95, n: 2, desc: 'Levbet Leverantör AB (493)' }),
    ] as never)
    mLink.mockResolvedValueOnce(okLink({ je: 'v-493' }) as never)

    const res = await run()

    expect(res.autoLinked).toBe(1)
    expect(res.links[0]).toMatchObject({ supplier_invoice_id: 'i1', journal_entry_id: 'v-493' })
  })

  it('decides nothing without a number on both sides', () => {
    expect(citesOtherInvoice({ description: 'Levbet Leverantör AB (487)' }, {})).toBe(false)
    expect(citesOtherInvoice({ description: 'Levbet Leverantör AB' }, { fortnox_number: '493' })).toBe(false)
    expect(citesOtherInvoice({ description: 'Levbet Leverantör AB (493)' }, { fortnox_number: '493' })).toBe(false)
    expect(citesOtherInvoice({ description: 'Levbet Leverantör AB (487)' }, { fortnox_number: '493' })).toBe(true)
  })
})
