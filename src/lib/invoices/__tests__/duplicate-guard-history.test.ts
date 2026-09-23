/**
 * The behandlingshistorik record written when the supplier-invoice
 * duplicate-payment guard is bypassed with force (issue #2366).
 *
 * What matters legally (BFNAR 2013:2 p. 9.16) is that the row exists, names
 * the voucher the override produced and names what the guard would have
 * flagged: the detector is therefore re-run on the bypass path, an empty
 * result is still recorded, and nothing here may throw into a payment that is
 * already posted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDetector, mockInsert, mockFrom, mockCreateServiceClient } = vi.hoisted(() => {
  const mockInsert = vi.fn()
  const mockFrom = vi.fn(() => ({ insert: mockInsert }))
  return {
    mockDetector: vi.fn(),
    mockInsert,
    mockFrom,
    mockCreateServiceClient: vi.fn(() => ({ from: mockFrom })),
  }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: mockCreateServiceClient,
}))

vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForSupplierInvoice: mockDetector,
}))

import {
  GUARD_BYPASSED_ACTION,
  SUPPLIER_INVOICE_DUPLICATE_PAYMENT_GUARD,
  recordSupplierInvoiceDuplicateGuardBypass,
} from '@/lib/invoices/duplicate-guard-history'

const readClient = { from: vi.fn() } as unknown as Parameters<
  typeof recordSupplierInvoiceDuplicateGuardBypass
>[0]

function input(over: Record<string, unknown> = {}) {
  return {
    companyId: 'company-1',
    invoice: {
      id: 'si-1',
      supplier_invoice_number: 'LF-7',
      payment_reference: '123456789',
      supplier_name: 'Hi3G Access AB',
      currency: 'SEK',
      total: 1000,
      total_sek: 1000,
      exchange_rate: null,
    },
    paymentAmount: 1000,
    paymentDate: '2026-05-12',
    paymentAccount: '1930',
    journalEntryId: 'je-1',
    actor: { user_id: 'user-1', actor_type: 'user' as const },
    ...over,
  }
}

function insertedRow(): Record<string, unknown> {
  return mockInsert.mock.calls[0][0] as Record<string, unknown>
}

describe('recordSupplierInvoiceDuplicateGuardBypass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInsert.mockResolvedValue({ error: null })
    mockDetector.mockResolvedValue([])
  })

  it('names the bank row the guard would have flagged, and the voucher it already carries', async () => {
    mockDetector.mockResolvedValue([
      {
        id: 'tx-1',
        date: '2026-05-11',
        amount: -1000,
        description: 'HI3G',
        merchant_name: null,
        reference: null,
        journal_entry_id: 'je-bank',
        match_reason: 'already_booked',
        match_confidence: 0.85,
      },
    ])

    await recordSupplierInvoiceDuplicateGuardBypass(readClient, input())

    expect(mockFrom).toHaveBeenCalledWith('audit_log')
    const row = insertedRow()
    expect(row.action).toBe(GUARD_BYPASSED_ACTION)
    expect(row.table_name).toBe('supplier_invoices')
    expect(row.record_id).toBe('si-1')
    expect(row.company_id).toBe('company-1')
    expect(row.user_id).toBe('user-1')
    expect(row.actor_type).toBe('user')
    expect(row.new_state).toEqual({
      guard: SUPPLIER_INVOICE_DUPLICATE_PAYMENT_GUARD,
      reason: 'force',
      supplier_invoice_id: 'si-1',
      supplier_invoice_number: 'LF-7',
      payment_amount: 1000,
      payment_currency: 'SEK',
      payment_date: '2026-05-12',
      payment_account: '1930',
      journal_entry_id: 'je-1',
      detector_failed: false,
      candidate_count: 1,
      candidates: [
        {
          transaction_id: 'tx-1',
          date: '2026-05-11',
          amount: -1000,
          match_reason: 'already_booked',
          match_confidence: 0.85,
          journal_entry_id: 'je-bank',
        },
      ],
    })
  })

  it('re-runs the detector with the invoice currency the payment was banded in', async () => {
    await recordSupplierInvoiceDuplicateGuardBypass(
      readClient,
      input({
        invoice: {
          id: 'si-2',
          supplier_invoice_number: 'LF-8',
          payment_reference: null,
          supplier_name: 'Leverantör AB',
          currency: 'EUR',
          total: 1000,
          total_sek: 11500,
          exchange_rate: 11.5,
        },
      }),
    )

    expect(mockDetector).toHaveBeenCalledWith(readClient, {
      companyId: 'company-1',
      invoice: {
        supplier_invoice_number: 'LF-8',
        payment_reference: null,
        supplier_name: 'Leverantör AB',
        currency: 'EUR',
        total: 1000,
        total_sek: 11500,
        exchange_rate: 11.5,
      },
      paymentAmount: 1000,
      paymentDate: '2026-05-12',
    })
  })

  it('records the override even when the guard found nothing at that moment', async () => {
    await recordSupplierInvoiceDuplicateGuardBypass(readClient, input())

    const state = insertedRow().new_state as Record<string, unknown>
    expect(state.candidate_count).toBe(0)
    expect(state.candidates).toEqual([])
    expect(state.detector_failed).toBe(false)
    expect(insertedRow().description).toContain('0 candidate transaction(s)')
  })

  it('records the override, flagged as unevaluated, when the detector fails', async () => {
    mockDetector.mockRejectedValue(new Error('sweep exploded'))

    await recordSupplierInvoiceDuplicateGuardBypass(readClient, input())

    const state = insertedRow().new_state as Record<string, unknown>
    expect(state.detector_failed).toBe(true)
    expect(state.candidate_count).toBe(0)
  })

  it('records the API-key actor the v1 surface passes', async () => {
    await recordSupplierInvoiceDuplicateGuardBypass(
      readClient,
      input({
        actor: {
          user_id: 'user-9',
          actor_id: 'ak_1',
          actor_type: 'api_key' as const,
          actor_label: 'CI key',
        },
      }),
    )

    const row = insertedRow()
    expect(row.user_id).toBe('user-9')
    expect(row.actor_id).toBe('ak_1')
    expect(row.actor_type).toBe('api_key')
    expect(row.actor_label).toBe('CI key')
  })

  it('rounds the payment to öre and tolerates a missing payment account', async () => {
    await recordSupplierInvoiceDuplicateGuardBypass(
      readClient,
      input({ paymentAmount: 1000.005, paymentAccount: undefined }),
    )

    const state = insertedRow().new_state as Record<string, unknown>
    expect(state.payment_amount).toBe(1000.01)
    expect(state.payment_account).toBeNull()
  })

  it('never throws: the payment is already posted and immutable', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'rls', code: '42501' } })
    await expect(
      recordSupplierInvoiceDuplicateGuardBypass(readClient, input()),
    ).resolves.toBeUndefined()

    mockInsert.mockRejectedValue(new Error('network down'))
    await expect(
      recordSupplierInvoiceDuplicateGuardBypass(readClient, input()),
    ).resolves.toBeUndefined()
  })
})
