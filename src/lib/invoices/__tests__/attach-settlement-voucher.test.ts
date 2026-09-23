import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const fetchAllRowsMock = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...args: unknown[]) => fetchAllRowsMock(...args),
}))

const fetchSourceRefVouchersMock = vi.fn()
const fetchFiscalPeriodsMock = vi.fn()
// The index and the dated resolution stay REAL: that never-guess logic is what
// decides which verifikat a "V342" means, and is the point of these tests.
vi.mock('@/lib/documents/voucher-ref-resolver', async () => {
  const actual = await vi.importActual<typeof import('@/lib/documents/voucher-ref-resolver')>(
    '@/lib/documents/voucher-ref-resolver',
  )
  return {
    ...actual,
    fetchSourceRefVouchers: (...args: unknown[]) => fetchSourceRefVouchersMock(...args),
    fetchFiscalPeriods: (...args: unknown[]) => fetchFiscalPeriodsMock(...args),
  }
})

import {
  attachSettlementVouchersBatch,
  attachSupplierInvoiceSettlementVoucher,
  parseSourceVoucherRef,
  type SettlementLinkInput,
} from '../attach-settlement-voucher'

const COMPANY = 'co-1'
const USER = 'user-1'

const PERIODS = [
  { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true, locked_at: null },
  { id: 'fp-2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null },
]

const voucher = (id: string, period: string, date: string, number: number, series = 'V') => ({
  id,
  fiscal_period_id: period,
  entry_date: date,
  source_voucher_series: series,
  source_voucher_number: number,
})

const invoice = (id: string, number: string, date: string) => ({
  id,
  supplier_invoice_number: number,
  invoice_date: date,
})

function okResult(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    dry_run: false,
    payment_id: 'pay-1',
    supplier_invoice_id: 'si-1',
    journal_entry_id: 'je-342',
    payment_date: '2026-05-07',
    amount: 1250,
    voucher_capacity_after: 0,
    ...over,
  }
}

function makeSupabase(rpc: ReturnType<typeof vi.fn>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient
}

function seed(params: {
  invoices?: ReturnType<typeof invoice>[]
  vouchers?: ReturnType<typeof voucher>[]
}) {
  fetchAllRowsMock.mockResolvedValue(params.invoices ?? [invoice('si-1', '1001', '2026-04-01')])
  fetchSourceRefVouchersMock.mockResolvedValue(
    params.vouchers ?? [voucher('je-342', 'fp-2026', '2026-05-07', 342)],
  )
  fetchFiscalPeriodsMock.mockResolvedValue(PERIODS)
}

const LINK: SettlementLinkInput = {
  supplier_invoice_number: '1001',
  voucher: 'V342',
  voucher_date: '2026-05-07',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('parseSourceVoucherRef', () => {
  it('reads a series and a positive number, case and spacing aside', () => {
    expect(parseSourceVoucherRef('V342')).toEqual({ series: 'V', number: 342 })
    expect(parseSourceVoucherRef(' v 7 ')).toEqual({ series: 'V', number: 7 })
    expect(parseSourceVoucherRef('AB12')).toEqual({ series: 'AB', number: 12 })
  })

  it('refuses anything that is not a series plus a positive number', () => {
    for (const bad of ['342', 'V', 'V0', 'V-3', 'V3.5', '', '  ', 'V342X', null, undefined, 342]) {
      expect(parseSourceVoucherRef(bad)).toBeNull()
    }
  })
})

describe('attachSupplierInvoiceSettlementVoucher', () => {
  it('passes the pair to the RPC and maps the result', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: okResult(), error: null })

    const result = await attachSupplierInvoiceSettlementVoucher(makeSupabase(rpc), {
      companyId: COMPANY, userId: USER, supplierInvoiceId: 'si-1', journalEntryId: 'je-342', notes: 'Bokio V342',
    })

    expect(rpc).toHaveBeenCalledWith('attach_supplier_invoice_settlement_voucher', {
      p_supplier_invoice_id: 'si-1',
      p_journal_entry_id: 'je-342',
      p_user_id: USER,
      p_company_id: COMPANY,
      p_notes: 'Bokio V342',
      p_dry_run: false,
    })
    expect(result).toEqual({
      ok: true,
      dryRun: false,
      paymentId: 'pay-1',
      supplierInvoiceId: 'si-1',
      journalEntryId: 'je-342',
      paymentDate: '2026-05-07',
      amount: 1250,
      voucherCapacityAfter: 0,
    })
  })

  it('hands a refusal back with its code and details', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: false, code: 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE', details: { accounting_method: 'cash' } },
      error: null,
    })
    expect(
      await attachSupplierInvoiceSettlementVoucher(makeSupabase(rpc), {
        companyId: COMPANY, userId: USER, supplierInvoiceId: 'si-1', journalEntryId: 'je-1',
      }),
    ).toEqual({ ok: false, code: 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE', details: { accounting_method: 'cash' } })
  })

  it('reports a transport error and a malformed result as DB_ERROR, never as success', async () => {
    const failing = vi.fn().mockResolvedValue({ data: null, error: { message: 'connection reset' } })
    expect(
      await attachSupplierInvoiceSettlementVoucher(makeSupabase(failing), {
        companyId: COMPANY, userId: USER, supplierInvoiceId: 'si-1', journalEntryId: 'je-1',
      }),
    ).toEqual({ ok: false, code: 'ATTACH_SI_SETTLEMENT_DB_ERROR', details: { reason: 'connection reset' } })

    const empty = vi.fn().mockResolvedValue({ data: null, error: null })
    expect(
      await attachSupplierInvoiceSettlementVoucher(makeSupabase(empty), {
        companyId: COMPANY, userId: USER, supplierInvoiceId: 'si-1', journalEntryId: 'je-1',
      }),
    ).toMatchObject({ ok: false, code: 'ATTACH_SI_SETTLEMENT_DB_ERROR' })
  })
})

describe('attachSettlementVouchersBatch', () => {
  it('resolves the customer\'s numbers to ids and attaches', async () => {
    seed({})
    const rpc = vi.fn().mockResolvedValue({ data: okResult(), error: null })

    const result = await attachSettlementVouchersBatch(makeSupabase(rpc), {
      companyId: COMPANY, userId: USER, links: [LINK], notes: 'crm#110',
    })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_supplier_invoice_id: 'si-1', p_journal_entry_id: 'je-342', p_notes: 'crm#110', p_dry_run: false,
    })
    expect(result.counts.attached).toBe(1)
    expect(result.reports[0]).toMatchObject({
      index: 0, outcome: 'attached', supplierInvoiceId: 'si-1', journalEntryId: 'je-342',
      amount: 1250, paymentDate: '2026-05-07',
    })
  })

  it('lets the date pick the fiscal year when the old system reused the number', async () => {
    seed({
      vouchers: [
        voucher('je-342-2025', 'fp-2025', '2025-03-01', 342),
        voucher('je-342-2026', 'fp-2026', '2026-05-07', 342),
      ],
    })
    const rpc = vi.fn().mockResolvedValue({ data: okResult(), error: null })

    await attachSettlementVouchersBatch(makeSupabase(rpc), {
      companyId: COMPANY, userId: USER, links: [{ ...LINK, voucher_date: '2025-03-01' }],
    })

    expect(rpc.mock.calls[0][1]).toMatchObject({ p_journal_entry_id: 'je-342-2025' })
  })

  it('never calls the RPC for a pair it cannot resolve to exactly one of each', async () => {
    seed({
      invoices: [
        invoice('si-a', '1001', '2026-04-01'),
        invoice('si-b', '1001', '2026-06-01'),
        invoice('si-c', '2002', '2026-04-01'),
      ],
      vouchers: [
        voucher('je-dup-1', 'fp-2026', '2026-05-07', 9),
        voucher('je-dup-2', 'fp-2026', '2026-05-08', 9),
      ],
    })
    const rpc = vi.fn()

    const result = await attachSettlementVouchersBatch(makeSupabase(rpc), {
      companyId: COMPANY,
      userId: USER,
      links: [
        { supplier_invoice_number: '9999', voucher: 'V342', voucher_date: '2026-05-07' },
        { supplier_invoice_number: '1001', voucher: 'V342', voucher_date: '2026-05-07' },
        { supplier_invoice_number: '2002', voucher: 'V777', voucher_date: '2026-05-07' },
        // Two imported verifikat carry V9 in 2026: ambiguous, so undefined.
        { supplier_invoice_number: '2002', voucher: 'V9', voucher_date: '2026-05-07' },
        // The date falls in no fiscal year this company has.
        { supplier_invoice_number: '2002', voucher: 'V9', voucher_date: '2019-05-07' },
      ],
    })

    expect(rpc).not.toHaveBeenCalled()
    expect(result.reports.map((r) => r.outcome)).toEqual([
      'invoice_not_found', 'invoice_ambiguous', 'voucher_not_found', 'voucher_not_found', 'voucher_not_found',
    ])
    expect(result.reports[1].reason).toMatch(/add invoice_date/)
  })

  it('uses invoice_date to tell two invoices with one number apart', async () => {
    seed({
      invoices: [invoice('si-a', '1001', '2026-04-01'), invoice('si-b', '1001', '2026-06-01')],
    })
    const rpc = vi.fn().mockResolvedValue({ data: okResult(), error: null })

    await attachSettlementVouchersBatch(makeSupabase(rpc), {
      companyId: COMPANY, userId: USER, links: [{ ...LINK, invoice_date: '2026-06-01' }],
    })

    expect(rpc.mock.calls[0][1]).toMatchObject({ p_supplier_invoice_id: 'si-b' })
  })

  it('reports malformed rows without stopping the batch', async () => {
    seed({})
    const rpc = vi.fn().mockResolvedValue({ data: okResult(), error: null })

    const result = await attachSettlementVouchersBatch(makeSupabase(rpc), {
      companyId: COMPANY,
      userId: USER,
      links: [
        { ...LINK, supplier_invoice_number: '  ' },
        { ...LINK, voucher: '342' },
        { ...LINK, voucher_date: '7/5 2026' },
        { ...LINK, invoice_date: 'april' },
        null as unknown as SettlementLinkInput,
        LINK,
      ],
    })

    expect(result.reports.map((r) => r.outcome)).toEqual([
      'invalid_input', 'invalid_input', 'invalid_input', 'invalid_input', 'invalid_input', 'attached',
    ])
    expect(result.reports.slice(0, 4).map((r) => r.reason)).toEqual([
      'supplier_invoice_number is missing',
      'voucher must be a series and a positive number, like V342',
      'voucher_date must be YYYY-MM-DD',
      'invoice_date must be YYYY-MM-DD',
    ])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(result.total).toBe(6)
  })

  it('sorts RPC refusals: an attached pair is already_linked, a transport failure is an error', async () => {
    seed({
      invoices: [
        invoice('si-1', '1001', '2026-04-01'),
        invoice('si-2', '1002', '2026-04-01'),
        invoice('si-3', '1003', '2026-04-01'),
      ],
    })
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ok: false, code: 'ATTACH_SI_SETTLEMENT_ALREADY_LINKED' }, error: null })
      .mockResolvedValueOnce({ data: { ok: false, code: 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE', details: { accounting_method: 'cash' } }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'timeout' } })

    const result = await attachSettlementVouchersBatch(makeSupabase(rpc), {
      companyId: COMPANY,
      userId: USER,
      links: ['1001', '1002', '1003'].map((n) => ({ ...LINK, supplier_invoice_number: n })),
    })

    expect(result.reports.map((r) => [r.outcome, r.code])).toEqual([
      ['already_linked', 'ATTACH_SI_SETTLEMENT_ALREADY_LINKED'],
      ['refused', 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE'],
      ['error', 'ATTACH_SI_SETTLEMENT_DB_ERROR'],
    ])
    expect(result.counts).toMatchObject({ already_linked: 1, refused: 1, error: 1, attached: 0 })
  })

  describe('dry run agrees with the run that follows it', () => {
    it('asks the RPC to check without writing, and reports would_attach', async () => {
      seed({})
      const rpc = vi.fn().mockResolvedValue({ data: okResult({ dry_run: true, payment_id: null }), error: null })

      const result = await attachSettlementVouchersBatch(makeSupabase(rpc), {
        companyId: COMPANY, userId: USER, links: [LINK], dryRun: true,
      })

      expect(rpc.mock.calls[0][1]).toMatchObject({ p_dry_run: true })
      expect(result.dryRun).toBe(true)
      expect(result.counts).toMatchObject({ would_attach: 1, attached: 0 })
    })

    it('refuses the pair that would overrun a batch-payment verifikat, as the real run will', async () => {
      seed({
        invoices: [
          invoice('si-1', '1001', '2026-04-01'),
          invoice('si-2', '1002', '2026-04-01'),
          invoice('si-3', '1003', '2026-04-01'),
        ],
      })
      // The verifikat's settlement side is 3000 and nothing is stored yet, so
      // the RPC, which sees only what is stored, passes all three on their own.
      const rpc = vi.fn()
        .mockResolvedValueOnce({ data: okResult({ dry_run: true, payment_id: null, amount: 1000, voucher_capacity_after: 2000 }), error: null })
        .mockResolvedValueOnce({ data: okResult({ dry_run: true, payment_id: null, amount: 2000, voucher_capacity_after: 1000 }), error: null })
        .mockResolvedValueOnce({ data: okResult({ dry_run: true, payment_id: null, amount: 500, voucher_capacity_after: 2500 }), error: null })

      const result = await attachSettlementVouchersBatch(makeSupabase(rpc), {
        companyId: COMPANY,
        userId: USER,
        dryRun: true,
        links: ['1001', '1002', '1003'].map((n) => ({ ...LINK, supplier_invoice_number: n })),
      })

      expect(result.reports.map((r) => r.outcome)).toEqual(['would_attach', 'would_attach', 'refused'])
      expect(result.reports[2]).toMatchObject({
        code: 'ATTACH_SI_SETTLEMENT_EXCEEDS_VOUCHER',
        details: { unexplained: 500, capacity: 0, planned_in_batch: 3000 },
      })
    })

    it('refuses a second pair for an invoice the batch has already explained, without asking the RPC', async () => {
      seed({
        vouchers: [
          voucher('je-342', 'fp-2026', '2026-05-07', 342),
          voucher('je-343', 'fp-2026', '2026-05-08', 343),
        ],
      })
      const rpc = vi.fn().mockResolvedValue({ data: okResult({ dry_run: true, payment_id: null }), error: null })

      const result = await attachSettlementVouchersBatch(makeSupabase(rpc), {
        companyId: COMPANY,
        userId: USER,
        dryRun: true,
        links: [LINK, { ...LINK, voucher: 'V343', voucher_date: '2026-05-08' }],
      })

      expect(rpc).toHaveBeenCalledTimes(1)
      expect(result.reports.map((r) => [r.outcome, r.code])).toEqual([
        ['would_attach', undefined],
        ['refused', 'ATTACH_SI_SETTLEMENT_NOTHING_TO_EXPLAIN'],
      ])
    })

    it('keeps no tally on a real run: the RPC sees the stored rows and judges for itself', async () => {
      seed({
        invoices: [invoice('si-1', '1001', '2026-04-01'), invoice('si-2', '1002', '2026-04-01')],
      })
      const rpc = vi.fn()
        .mockResolvedValueOnce({ data: okResult({ amount: 1000, voucher_capacity_after: 0 }), error: null })
        .mockResolvedValueOnce({ data: { ok: false, code: 'ATTACH_SI_SETTLEMENT_EXCEEDS_VOUCHER' }, error: null })

      const result = await attachSettlementVouchersBatch(makeSupabase(rpc), {
        companyId: COMPANY,
        userId: USER,
        links: ['1001', '1002'].map((n) => ({ ...LINK, supplier_invoice_number: n })),
      })

      expect(rpc).toHaveBeenCalledTimes(2)
      expect(result.reports.map((r) => r.outcome)).toEqual(['attached', 'refused'])
    })
  })
})
