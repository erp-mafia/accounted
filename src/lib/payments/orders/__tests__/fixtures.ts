import { vi } from 'vitest'
import type { PaymentInitiationProvider } from '@/lib/payments/initiation/provider'
import type { PaymentOrderBatchRow, PaymentOrderRow } from '../types'

export const COMPANY = 'company-1'
export const USER = 'user-1'
export const SIGNER = { personalNumber: '19900101-1239', ipAddress: '203.0.113.10', userAgent: 'UA' }

export function order(id: string, overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id,
    company_id: COMPANY,
    user_id: USER,
    purpose: 'supplier_invoice',
    supplier_invoice_id: `inv-${id}`,
    batch_id: null,
    status: 'approved',
    amount: 737.5,
    currency: 'SEK',
    requested_execution_date: '2031-10-21',
    cash_account_id: 'acct-1',
    debtor_snapshot: { iban: 'SE3550000000054910000003', bban: null, bic: 'ESSESESS', name: 'Konto', currency: 'SEK', bank_name: null },
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_iban: null,
    payee_bic: null,
    payee_name: 'Derome Bygg AB',
    payee_source: 'supplier',
    payee_check: 'known',
    reference_type: 'ocr',
    reference: '4400112233',
    end_to_end_id: `ACC${id.padEnd(32, '0')}`,
    idempotency_key: `k-${id}`,
    provider: null,
    provider_payment_id: null,
    provider_payment_product: null,
    provider_status: null,
    provider_status_at: null,
    provider_error_code: null,
    provider_error_message: null,
    create_started_at: null,
    outcome_unknown_at: null,
    approved_by: USER,
    approved_at: '2026-09-30T08:00:00Z',
    submitted_by: null,
    submitted_at: null,
    signed_at: null,
    executed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    matched_transaction_id: null,
    supplier_invoice_payment_id: null,
    matched_at: null,
    created_at: '2026-09-30T07:00:00Z',
    updated_at: '2026-09-30T07:00:00Z',
    ...overrides,
  }
}

/** An order as the claim returns it: submitted in batch-1. */
export const claimedOrder = (id: string, overrides: Partial<PaymentOrderRow> = {}) =>
  order(id, { status: 'submitted', batch_id: 'batch-1', provider: 'open_payments', submitted_at: '2026-09-30T08:00:00Z', ...overrides })

/** An order whose payment the bank holds, waiting in batch-1. */
export const waitingOrder = (id: string, n: number, overrides: Partial<PaymentOrderRow> = {}) =>
  claimedOrder(id, { provider_payment_id: `pay-${n}`, provider_payment_product: 'swedish-giro', provider_status: 'RCVD', ...overrides })

export function batch(overrides: Partial<PaymentOrderBatchRow> = {}): PaymentOrderBatchRow {
  return {
    id: 'batch-1',
    company_id: COMPANY,
    user_id: USER,
    provider: 'open_payments',
    signing_target: 'basket',
    provider_batch_id: null,
    status: 'created',
    provider_status: null,
    provider_status_at: null,
    provider_authorisation_id: null,
    signing_method: null,
    signer_user_id: null,
    signing_started_at: null,
    signed_at: null,
    order_count: 2,
    total_amount: 1475,
    currency: 'SEK',
    created_at: '2026-09-30T08:00:00Z',
    updated_at: '2026-09-30T08:00:00Z',
    ...overrides,
  }
}

/** The invoice row unpayableOrders reads for an order. */
export function invoiceFor(orderId: string, overrides: Record<string, unknown> = {}) {
  return { id: `inv-${orderId}`, company_id: COMPANY, status: 'approved', is_credit_note: false, remaining_amount: 737.5, ...overrides }
}

export const CAPABLE = { decoupled: true, redirect: true, basket: { supported: true, maxPayments: 100 } }

export function fakeProvider(overrides: Partial<PaymentInitiationProvider> = {}): PaymentInitiationProvider {
  let n = 0
  return {
    id: 'open_payments',
    isAvailableFor: () => true,
    getBankCapabilities: vi.fn().mockResolvedValue(CAPABLE),
    getCompanyVerification: vi.fn().mockResolvedValue({ status: 'valid', validUntil: '2027-03-29' }),
    startCompanyVerification: vi.fn(),
    createPayment: vi.fn().mockImplementation(async () => {
      n += 1
      return { providerPaymentId: `pay-${n}`, product: 'swedish-giro', providerStatus: 'RCVD', status: 'submitted', messages: [] }
    }),
    createSigningBasket: vi.fn().mockResolvedValue({ providerBasketId: 'basket-at-bank' }),
    startSigning: vi.fn().mockResolvedValue({
      providerAuthorisationId: 'auth-1',
      method: 'qr',
      state: 'pending',
      challenge: { approach: 'decoupled', autostartToken: null, qrData: 'bankid.qr.1', qrImage: null, redirectUrl: null },
      failureCode: null,
    }),
    pollSigning: vi.fn(),
    getPaymentState: vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }),
    cancelPayment: vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' }),
    ...overrides,
  }
}
