import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  validateVoucherForSupplierInvoiceLink,
  linkSupplierInvoiceToVoucher,
} from '../supplier-voucher-matching'
import {
  makeSupplierInvoice,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

// ============================================================
// validateVoucherForSupplierInvoiceLink: happy path + rejects
// ============================================================

describe('validateVoucherForSupplierInvoiceLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setup(
    invoice = makeSupplierInvoice({ remaining_amount: 1000, total: 1000, currency: 'SEK' }),
  ) {
    return invoice
  }

  it('rejects when the invoice has nothing remaining', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 0,
        paid_amount: 1000,
        total: 1000,
        currency: 'SEK',
      }),
    )
    enqueue({ data: null }) // unused, short-circuits before any query
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_INVOICE_FULLY_PAID')
  })

  it('rejects when the voucher is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({ data: null, error: null }) // journal_entries.maybeSingle → null
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-missing',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_VOUCHER_NOT_FOUND')
  })

  it('rejects when the voucher is not posted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'draft',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_NOT_POSTED')
  })

  it('rejects when the voucher has no AP debit on 2440', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup()
    // journal_entries lookup
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    // journal_entry_lines: no 2440 line
    enqueue({
      data: [
        { account_number: '1930', debit_amount: 0, credit_amount: 1000, currency: 'SEK' },
        { account_number: '4010', debit_amount: 1000, credit_amount: 0, currency: 'SEK' },
      ],
    })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_NO_AP_DEBIT')
  })

  it('rejects when the AP debit exceeds invoice remaining', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 1000,
        paid_amount: 0,
        total: 1000,
        currency: 'SEK',
      }),
    )
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    // 5 000 debit on 2440: overshoots a 1 000 invoice
    enqueue({
      data: [
        { account_number: '2440', debit_amount: 5000, credit_amount: 0, currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 5000, currency: 'SEK' },
      ],
    })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING')
      expect(result.details?.ap_debit).toBe(5000)
      expect(result.details?.remaining).toBe(1000)
    }
  })

  it('accepts an exact-amount match and reports paymentAmount + isFullyPaid', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 1000,
        paid_amount: 0,
        total: 1000,
        currency: 'SEK',
      }),
    )
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '2440', debit_amount: 1000, credit_amount: 0, currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000, currency: 'SEK' },
      ],
    })
    // existingLinks lookup: none
    enqueue({ data: [], error: null })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.apDebitAmount).toBe(1000)
      expect(result.paymentAmount).toBe(1000)
      expect(result.isFullyPaid).toBe(true)
      expect(result.remainingAfter).toBe(0)
    }
  })

  it('accepts a partial-payment voucher (debit < remaining) and reports partially_paid math', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 1000,
        paid_amount: 0,
        total: 1000,
        currency: 'SEK',
      }),
    )
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '2440', debit_amount: 400, credit_amount: 0, currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 400, currency: 'SEK' },
      ],
    })
    enqueue({ data: [], error: null })
    const result = await validateVoucherForSupplierInvoiceLink(
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

  it('rejects currency mismatch', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = setup(
      makeSupplierInvoice({
        remaining_amount: 200,
        paid_amount: 0,
        total: 200,
        currency: 'EUR',
      }),
    )
    enqueue({
      data: {
        id: 'je-1',
        voucher_series: 'B',
        voucher_number: 12,
        entry_date: '2024-06-15',
        description: '',
        status: 'posted',
        source_type: 'manual',
        fiscal_period_id: 'fp-1',
        company_id: 'company-1',
      },
    })
    enqueue({
      data: [
        { account_number: '2440', debit_amount: 200, credit_amount: 0, currency: 'SEK' },
        { account_number: '1930', debit_amount: 0, credit_amount: 200, currency: 'SEK' },
      ],
    })
    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      invoice as never,
      'je-1',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
  })
})

// ============================================================
// linkSupplierInvoiceToVoucher: end-to-end advancement
// ============================================================

describe('linkSupplierInvoiceToVoucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The implementation now delegates the lock + validate + UPDATE + INSERT
  // sequence to the link_supplier_invoice_to_voucher PL/pgSQL RPC (PR #602
  // review fix). The TS wrapper only translates the RPC's structured jsonb
  // return into the lib's typed Result type and emits the paid event. These
  // tests mock the RPC response directly.

  it('rejects with INVOICE_NOT_FOUND when the RPC reports the invoice is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { ok: false, code: 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND' },
      error: null,
    })
    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-missing',
      journalEntryId: 'je-1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_INVOICE_NOT_FOUND')
  })

  it('rejects with INVOICE_FULLY_PAID when the RPC reports the invoice is already paid', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ok: false,
        code: 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID',
        details: { status: 'paid' },
      },
      error: null,
    })
    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-1',
      journalEntryId: 'je-1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_INVOICE_FULLY_PAID')
      expect(result.details?.status).toBe('paid')
    }
  })

  it('returns LINK_SI_VOUCHER_DB_ERROR when the RPC raises an error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection lost' } })
    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-1',
      journalEntryId: 'je-1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('LINK_SI_VOUCHER_DB_ERROR')
      expect(result.details?.reason).toBe('connection lost')
    }
  })

  it('returns success + emits supplier_invoice.paid on the happy path (full payment)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const invoice = makeSupplierInvoice({
      status: 'paid',
      paid_amount: 1000,
      remaining_amount: 0,
      total: 1000,
      currency: 'SEK',
    })

    // 1. RPC returns the happy path
    enqueue({
      data: {
        ok: true,
        payment_id: 'sip-1',
        invoice_status: 'paid',
        paid_amount: 1000,
        remaining_amount: 0,
        payment_amount: 1000,
        journal_entry_id: 'je-1',
        currency: 'SEK',
      },
      error: null,
    })
    // 2. Lightweight invoice re-fetch for the event payload
    enqueue({ data: invoice, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)

    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: invoice.id,
      journalEntryId: 'je-1',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.invoiceStatus).toBe('paid')
      expect(result.result.paidAmount).toBe(1000)
      expect(result.result.remainingAmount).toBe(0)
      expect(result.result.paymentAmount).toBe(1000)
      expect(result.result.journalEntryId).toBe('je-1')
      expect(result.result.paymentId).toBe('sip-1')
    }

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'supplier_invoice.paid',
        payload: expect.objectContaining({ paymentAmount: 1000, userId: 'user-1' }),
      }),
    )
  })

  it('still returns success even if the post-link invoice re-fetch is empty (event is best-effort)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ok: true,
        payment_id: 'sip-2',
        invoice_status: 'partially_paid',
        paid_amount: 400,
        remaining_amount: 600,
        payment_amount: 400,
        journal_entry_id: 'je-1',
        currency: 'SEK',
      },
      error: null,
    })
    enqueue({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)

    const result = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-2',
      journalEntryId: 'je-1',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.invoiceStatus).toBe('partially_paid')
      expect(result.result.remainingAmount).toBe(600)
    }
    // Event NOT emitted when re-fetch found nothing
    expect(emitSpy).not.toHaveBeenCalled()
  })
})
