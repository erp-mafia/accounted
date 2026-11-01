import { vi } from 'vitest'
import type { PaymentInitiationProvider } from '@/lib/payments/initiation/provider'
import { makeTransaction, type createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
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
    salary_run_id: null,
    employee_id: null,
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
 * A createTableMockSupabase answer backed by rows the test holds: every chain
 * reads (or, with update, writes) the rows its eq/is/in/not-is filters match,
 * so a test asserts where the rows end rather than the order of the calls.
 * Updates compare and set: the filters run on the rows as they were, and an
 * undefined key is left out, as the client leaves it out of the request.
 */
export function rowsTable<T extends object>(rows: T[]): TableMockResolver {
  const field = (row: T, key: unknown) => (row as Record<string, unknown>)[key as string]
  return (chain) => {
    const matches = rows.filter((row) =>
      chain.every(({ method, args: [key, value, more] }) => {
        if (method === 'eq' || method === 'is') return field(row, key) === value
        if (method === 'in') return (value as unknown[]).includes(field(row, key))
        if (method === 'not' && value === 'is') return field(row, key) !== more
        return true
      }),
    )
    const update = chain.find((c) => c.method === 'update')
    const patch = update && Object.fromEntries(Object.entries(update.args[0] as object).filter(([, v]) => v !== undefined))
    if (patch) for (const row of matches) Object.assign(row, patch)
    // Copies, as a database answers: what the code holds goes stale, the held rows do not.
    const answer = matches.map((row) => ({ ...row }))
    return { data: chain.some((c) => c.method === 'maybeSingle') ? (answer[0] ?? null) : answer }
  }
}

type MockDb = ReturnType<typeof createTableMockSupabase>

/**
 * A signing and its orders held as rows: the batch and order tables answer
 * from them (rowsTable), and release_payment_order moves an order by its
 * rules: one still in that signing with that payment goes back to approved,
 * out of the signing and without a payment id; anything else has moved.
 */
export function holdSigning(db: MockDb, signing: PaymentOrderBatchRow, orders: PaymentOrderRow[]): void {
  db.setTable('payment_order_batches', rowsTable([signing]))
  db.setTable('payment_orders', rowsTable(orders))
  db.setTable('rpc:release_payment_order', () => {
    const [args] = db.findCalls('rpc:release_payment_order', 'rpc').at(-1) as [{ p_order_id: string; p_batch_id: string | null; p_provider_payment_id: string | null }]
    const row = orders.find((o) => o.id === args.p_order_id)
    if (!row || row.batch_id !== args.p_batch_id || !['submitted', 'awaiting_signature'].includes(row.status) || row.provider_payment_id !== args.p_provider_payment_id) {
      return { data: { ok: false, code: 'moved' } }
    }
    Object.assign(row, { status: 'approved', batch_id: null, provider_payment_id: null, provider_payment_product: null })
    return { data: { ok: true, status: 'approved' } }
  })
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
    payee_bankgiro: '55778815',
    payee_plusgiro: null,
    payee_iban: null,
    payee_name: 'Exempel Systems AB',
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
    description: 'EXEMPEL SYSTEMS BG 0000055778815',
    original_description: 'EXEMPEL SYSTEMS BG 0000055778815',
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
    supplier_id: 'sup-exempel',
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
    supplier: { id: 'sup-exempel', name: 'Exempel Systems AB', supplier_type: 'swedish_business', bankgiro: '5577-8815' },
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

/**
 * The shape of the case that made orders without an invoice settle by their
 * debit (2026-10): a skattekonto payment BankID-signed in a signing the bank
 * finalised, while its status API keeps answering RCVD, so the order stays
 * awaiting_signature next to a 'signed' batch. The debit arrives through
 * Enable Banking, already booked to the skattekonto, with Skatteverket's
 * bankgiro hyphenated in the text and no end-to-end id. Ids and the amount
 * are placeholders.
 */
export const RCVD_TAX = {
  companyId: 'c0ffee00-0000-4000-8000-0000000000c1',
  userId: 'c0ffee00-0000-4000-8000-0000000000a1',
  cashAccountId: 'c0ffee00-0000-4000-8000-0000000000ca',
  orderId: 'c0ffee00-0000-4000-8000-000000000001',
  batchId: 'c0ffee00-0000-4000-8000-0000000000b1',
  transactionId: 'c0ffee00-0000-4000-8000-0000000000d1',
} as const

/** The skattekonto order: signed in RCVD_TAX.batchId, the bank still at RCVD. */
export function rcvdTaxOrder(overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return order(RCVD_TAX.orderId, {
    company_id: RCVD_TAX.companyId,
    user_id: RCVD_TAX.userId,
    purpose: 'skattekonto',
    supplier_invoice_id: null,
    batch_id: RCVD_TAX.batchId,
    status: 'awaiting_signature',
    amount: 12345,
    requested_execution_date: '2026-10-27',
    cash_account_id: RCVD_TAX.cashAccountId,
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_name: 'Skatteverket',
    payee_source: 'skatteverket',
    reference_type: 'ocr',
    reference: '1655446688087',
    provider: 'open_payments',
    provider_payment_id: 'pay-tax-1',
    provider_payment_product: 'swedish-giro',
    provider_status: 'RCVD',
    submitted_by: RCVD_TAX.userId,
    submitted_at: '2026-10-26T17:05:00Z',
    signed_at: null,
    executed_at: null,
    ...overrides,
  })
}

/** The signing the order is in: BankID finalised. */
export function rcvdTaxBatch(overrides: Partial<PaymentOrderBatchRow> = {}): PaymentOrderBatchRow {
  return batch({
    id: RCVD_TAX.batchId,
    company_id: RCVD_TAX.companyId,
    user_id: RCVD_TAX.userId,
    status: 'signed',
    provider_authorisation_id: 'auth-tax-1',
    signing_started_at: '2026-10-26T17:06:00Z',
    signed_at: '2026-10-26T17:09:00Z',
    order_count: 1,
    total_amount: 12345,
    ...overrides,
  })
}

/** Its debit, as Enable Banking delivered it and the bank rule booked it. */
export function rcvdTaxDebit(overrides: Partial<Transaction> = {}): Transaction {
  return makeTransaction({
    id: RCVD_TAX.transactionId,
    company_id: RCVD_TAX.companyId,
    user_id: RCVD_TAX.userId,
    date: '2026-10-27',
    value_date: null,
    amount: -12345,
    currency: 'SEK',
    description: '5050-1055 Betalning',
    original_description: '5050-1055 Betalning',
    reference: null,
    counterparty_iban: null,
    counterparty_account: null,
    end_to_end_id: null,
    cash_account_id: RCVD_TAX.cashAccountId,
    import_source: 'enable_banking',
    potential_supplier_invoice_id: null,
    supplier_invoice_id: null,
    journal_entry_id: 'je-skattekonto',
    is_ignored: false,
    merchant_name: null,
    ...overrides,
  })
}

/** One employee's net pay on a salary run, paid to the account on the employee card. */
export function salaryOrder(id: string, overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return order(id, {
    company_id: RCVD_TAX.companyId,
    user_id: RCVD_TAX.userId,
    purpose: 'salary',
    supplier_invoice_id: null,
    salary_run_id: 'run-1',
    employee_id: `emp-${id}`,
    batch_id: 'batch-salary',
    status: 'accepted',
    amount: 23456.5,
    requested_execution_date: '2026-10-28',
    cash_account_id: RCVD_TAX.cashAccountId,
    payee_type: 'bank_account',
    payee_bankgiro: null,
    payee_clearing: '8327',
    payee_account: '9012345',
    payee_name: 'Anna Exempel',
    payee_source: 'employee',
    reference_type: 'message',
    reference: 'Lön 2026-10',
    provider: 'open_payments',
    provider_payment_id: `pay-${id}`,
    provider_status: 'ACSP',
    signed_at: '2026-10-27T09:00:00Z',
    ...overrides,
  })
}

/** A salary payment's debit: the run's message in the text, nothing about the employee. */
export function salaryDebit(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return makeTransaction({
    id,
    company_id: RCVD_TAX.companyId,
    user_id: RCVD_TAX.userId,
    date: '2026-10-28',
    value_date: '2026-10-28',
    amount: -23456.5,
    currency: 'SEK',
    description: 'LÖN 2026-10',
    original_description: 'LÖN 2026-10',
    reference: null,
    counterparty_iban: null,
    counterparty_account: null,
    end_to_end_id: null,
    cash_account_id: RCVD_TAX.cashAccountId,
    import_source: 'open_payments',
    supplier_invoice_id: null,
    journal_entry_id: null,
    is_ignored: false,
    ...overrides,
  })
}
