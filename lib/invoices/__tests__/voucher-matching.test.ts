import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  findMatchingVouchersForInvoice,
  validateVoucherForInvoiceLink,
  linkInvoiceToVoucher,
} from '../voucher-matching'
import {
  makeInvoice,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

// ============================================================
// validateVoucherForInvoiceLink — happy path + reject codes
// ============================================================

describe('validateVoucherForInvoiceLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setup(invoice = makeInvoice({ remaining_amount: 1000, total: 1000, currency: 'SEK' })) {
    return invoice
  }

  it('rejects when the invoice has nothing remaining', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeInvoice({ remaining_amount: 0, paid_amount: 1000, total: 1000, currency: 'SEK' }),
    )
    enqueue({ data: null }) // unused — we short-circuit before querying
    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_VOUCHER_INVOICE_FULLY_PAID')
  })

  it('rejects when the voucher is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({ data: null, error: null }) // journal_entries.maybeSingle → null
    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-missing',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_VOUCHER_VOUCHER_NOT_FOUND')
  })

  it('rejects when the voucher is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'A',
        voucher_number: 5,
        entry_date: '2026-05-01',
        description: '',
        status: 'draft',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_VOUCHER_NOT_POSTED')
  })

  it('rejects when the voucher has no AR credit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'A',
        voucher_number: 5,
        entry_date: '2026-05-01',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0, currency: 'SEK' },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000, currency: 'SEK' },
      ],
    })
    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_VOUCHER_NO_AR_CREDIT')
  })

  it('rejects when the voucher amount exceeds the remaining', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'A',
        voucher_number: 5,
        entry_date: '2026-05-01',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '1930', debit_amount: 5000, credit_amount: 0, currency: 'SEK' },
        { account_number: '1510', debit_amount: 0, credit_amount: 5000, currency: 'SEK' },
      ],
    })
    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING')
  })

  it('rejects when the line currency does not match the invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(makeInvoice({ remaining_amount: 1000, total: 1000, currency: 'EUR' }))
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'A',
        voucher_number: 5,
        entry_date: '2026-05-01',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '1510', debit_amount: 0, credit_amount: 1000, currency: 'SEK' },
      ],
    })
    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
  })

  it('rejects when the voucher is already linked to this invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'A',
        voucher_number: 5,
        entry_date: '2026-05-01',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '1510', debit_amount: 0, credit_amount: 1000, currency: 'SEK' },
      ],
    })
    enqueue({ data: [{ id: 'pmt-1' }] })
    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_VOUCHER_ALREADY_LINKED')
  })

  it('returns ok=true with full-pay flag when amount equals remaining', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'A',
        voucher_number: 5,
        entry_date: '2026-05-01',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0, currency: 'SEK' },
        { account_number: '1510', debit_amount: 0, credit_amount: 1000, currency: 'SEK' },
      ],
    })
    enqueue({ data: [] })
    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.arCreditAmount).toBe(1000)
      expect(result.paymentAmount).toBe(1000)
      expect(result.isFullyPaid).toBe(true)
      expect(result.remainingAfter).toBe(0)
    }
  })

  it('returns ok=true with partial-pay flag when amount is less than remaining', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(makeInvoice({ remaining_amount: 1000, total: 1000, currency: 'SEK' }))
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'A',
        voucher_number: 5,
        entry_date: '2026-05-01',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '1510', debit_amount: 0, credit_amount: 400, currency: 'SEK' },
      ],
    })
    enqueue({ data: [] })
    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.paymentAmount).toBe(400)
      expect(result.isFullyPaid).toBe(false)
      expect(result.remainingAfter).toBe(600)
    }
  })
})

// ============================================================
// findMatchingVouchersForInvoice — empty + ranking smoke test
// ============================================================

describe('findMatchingVouchersForInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty when the invoice has nothing remaining', async () => {
    const { supabase } = createQueuedMockSupabase()
    const invoice = makeInvoice({ remaining_amount: 0, paid_amount: 1000, total: 1000 })
    const result = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      invoice as never,
    )
    expect(result).toEqual([])
  })

  it('returns empty when the journal lines query errors', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = makeInvoice({
      remaining_amount: 1000,
      total: 1000,
      due_date: '2026-05-01',
    })
    enqueue({ data: null, error: { message: 'db error' } })
    const result = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      invoice as never,
    )
    expect(result).toEqual([])
  })
})

// ============================================================
// linkInvoiceToVoucher — outcome shape & event emission
// ============================================================

describe('linkInvoiceToVoucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  // linkInvoiceToVoucher now delegates validation + writes to the atomic
  // link_invoice_to_voucher RPC (audit C2) — the wrapper's job is calling it
  // with the right args and mapping the jsonb result/transport errors through.
  // Guard behaviour itself is covered by voucher-matching.pg.test.ts against
  // the real RPC.

  it('passes a guard rejection from the RPC through unchanged', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: false, code: 'LINK_VOUCHER_INVOICE_FULLY_PAID', details: { status: 'paid' } },
      error: null,
    })
    const result = await linkInvoiceToVoucher(
      { rpc } as never,
      'user-1',
      'company-1',
      { invoiceId: 'inv-1', journalEntryId: 'je-1' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_VOUCHER_INVOICE_FULLY_PAID')
      expect(result.details).toEqual({ status: 'paid' })
    }
    expect(rpc).toHaveBeenCalledWith('link_invoice_to_voucher', {
      p_invoice_id: 'inv-1',
      p_journal_entry_id: 'je-1',
      p_user_id: 'user-1',
      p_company_id: 'company-1',
      p_notes: null,
    })
  })

  it('maps an RPC transport error to LINK_VOUCHER_DB_ERROR', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'connection reset' } })
    const result = await linkInvoiceToVoucher(
      { rpc } as never,
      'user-1',
      'company-1',
      { invoiceId: 'inv-1', journalEntryId: 'je-1' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_VOUCHER_DB_ERROR')
      expect(result.details).toEqual({ reason: 'connection reset' })
    }
  })

  it('maps an empty RPC response to LINK_VOUCHER_DB_ERROR', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const result = await linkInvoiceToVoucher(
      { rpc } as never,
      'user-1',
      'company-1',
      { invoiceId: 'inv-1', journalEntryId: 'je-1' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_VOUCHER_DB_ERROR')
  })
})
