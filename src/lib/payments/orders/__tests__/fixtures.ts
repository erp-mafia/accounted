import { vi } from 'vitest'
import type { PaymentInitiationProvider } from '@/lib/payments/initiation/provider'
import { makeTransaction } from '@/tests/helpers'
import type { Transaction } from '@/types'
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

/**
 * Production example, 2026-10-13: the first Open Payments payment (Arcim).
 * Swedbank reports the debit WITHOUT the order's end-to-end id and writes the
 * payee's bankgiro zero-padded into the description, with the channel phrase
 * as the reference. Ids are the real row ids; the company and user ids are
 * placeholders.
 */
export const ARCIM = {
  companyId: 'a7c1a000-0000-4000-8000-000000000a7c',
  userId: 'a7c1a000-0000-4000-8000-00000000a5e7',
  cashAccountId: 'ed501e6a-ec81-4d6d-a00d-c8f5e3ca335f',
  orderId: '4e42c482-40f8-4336-9150-f6ae656ab9a7',
  transactionId: '7af13560-1ed2-4b17-8a1a-242438870caf',
  invoiceId: '8976eb66-2742-4572-a140-57d6919b9990',
  endToEndId: 'ACCd60621c108e442119d8ae9e24d5543c5',
} as const

/** Payment order 4e42c482 as the status sync left it: executed (ACSC), not yet matched. */
export function arcimOrder(overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return order(ARCIM.orderId, {
    company_id: ARCIM.companyId,
    user_id: ARCIM.userId,
    supplier_invoice_id: ARCIM.invoiceId,
    status: 'executed',
    provider: 'open_payments',
    provider_payment_id: 'pay-arcim-1',
    provider_payment_product: 'swedish-giro',
    provider_status: 'ACSC',
    provider_status_at: '2026-10-13T00:45:00Z',
    amount: 10,
    currency: 'SEK',
    requested_execution_date: '2026-10-13',
    cash_account_id: ARCIM.cashAccountId,
    end_to_end_id: ARCIM.endToEndId,
    payee_type: 'bankgiro',
    payee_bankgiro: '52386828',
    payee_plusgiro: null,
    payee_iban: null,
    payee_name: 'Mattsson Systems AB',
    reference_type: 'message',
    reference: '001',
    approved_by: ARCIM.userId,
    approved_at: '2026-10-12T14:58:00Z',
    submitted_by: ARCIM.userId,
    submitted_at: '2026-10-12T15:00:00Z',
    signed_at: '2026-10-12T15:05:00Z',
    executed_at: '2026-10-13T00:45:00Z',
    matched_transaction_id: null,
    supplier_invoice_payment_id: null,
    matched_at: null,
    created_at: '2026-10-12T14:55:00Z',
    updated_at: '2026-10-13T00:45:00Z',
    ...overrides,
  })
}

/** Transaction row 7af13560: the Swedbank debit of that order, as ingest stored it (suggestion only). */
export function arcimDebit(overrides: Partial<Transaction> = {}): Transaction {
  return makeTransaction({
    id: ARCIM.transactionId,
    company_id: ARCIM.companyId,
    user_id: ARCIM.userId,
    date: '2026-10-13',
    value_date: '2026-10-13',
    amount: -10,
    currency: 'SEK',
    description: 'MATTSSON SYSTEMS BG 0000052386828',
    original_description: 'MATTSSON SYSTEMS BG 0000052386828',
    reference: 'Bg-bet. via internet',
    counterparty_iban: null,
    counterparty_account: null,
    end_to_end_id: null,
    cash_account_id: ARCIM.cashAccountId,
    import_source: 'open_payments',
    potential_supplier_invoice_id: ARCIM.invoiceId,
    supplier_invoice_id: null,
    journal_entry_id: null,
    merchant_name: null,
    ...overrides,
  })
}

/** Supplier invoice 8976eb66 as the booking reads it: open, booked to 2440 at receipt, 10,00 SEK remaining. */
export function arcimInvoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ARCIM.invoiceId,
    company_id: ARCIM.companyId,
    user_id: ARCIM.userId,
    supplier_id: 'sup-mattsson',
    supplier_invoice_number: 'MS-001',
    arrival_number: 1,
    status: 'approved',
    currency: 'SEK',
    exchange_rate: null,
    subtotal: 8,
    vat_amount: 2,
    total: 10,
    paid_amount: 0,
    remaining_amount: 10,
    registration_journal_entry_id: 'je-registration',
    reverse_charge: false,
    vat_treatment: 'standard_25',
    default_dimensions: {},
    is_credit_note: false,
    document_id: null,
    supplier: { id: 'sup-mattsson', name: 'Mattsson Systems AB', supplier_type: 'swedish_business', bankgiro: '5238-6828' },
    items: [
      {
        id: 'item-1', description: 'Konsulttjänst', quantity: 1, unit: 'st', unit_price: 8,
        line_total: 8, account_number: '6540', vat_code: null, vat_rate: 0.25, vat_amount: 2,
        reverse_charge_rate: null,
      },
    ],
    ...overrides,
  }
}
