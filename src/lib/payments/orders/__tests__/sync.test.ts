import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  PaymentProviderError,
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
} from '@/lib/payments/initiation/provider'
import type { Logger } from '@/lib/logger'
import type { CreateJournalEntryInput } from '@/types'

// The debit sweep books for real down to the engine; the side-effect helpers
// pinned elsewhere are mocked so they consume no table answers.
const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  findFiscalPeriod: vi.fn().mockResolvedValue('fp-2026'),
  reverseEntry: vi.fn(),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({ anchorSupplierInvoiceDocument: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({ clearSettledInvoiceSuggestions: vi.fn() }))
const mockStoredBatchSigner = vi.fn()
vi.mock('@/lib/auth/resource-psu', () => ({ storedBatchSigner: (...args: unknown[]) => mockStoredBatchSigner(...args) }))
const NO_SIGNER = { psuId: null, ipAddress: null }

import { isDueForStatusRead, SIGNING_PASS_RESERVE_MS, syncPaymentOrderStatuses, UNANSWERED_READS_PER_BANK, UNANSWERED_SIGNING_MINUTES } from '../sync'
import { SCHEDULED_PAYMENT_READ_EVERY_MS } from '../status'
import { runBudget } from '@/lib/api/run-budget'
import { skattekontoPaymentsCovering } from '../skattekonto-underway'
import type { PaymentOrderBatchRow, PaymentOrderRow } from '../types'
import { ARCIM, arcimDebit, arcimInvoice, arcimOrder, fakeProvider, holdSigning, RCVD_TAX, rcvdTaxBatch, rcvdTaxDebit, rcvdTaxOrder } from './fixtures'

const COMPANY = 'company-1'

function order(id: string, overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id,
    company_id: COMPANY,
    purpose: 'supplier_invoice',
    supplier_invoice_id: `inv-${id}`,
    amount: 737.5,
    batch_id: 'batch-1',
    status: 'awaiting_signature',
    debtor_snapshot: { iban: 'SE3550000000054910000003', bban: null, bic: 'ESSESESS', name: 'Konto', currency: 'SEK', bank_name: null },
    provider_payment_id: `pay-${id}`,
    provider_payment_product: 'swedish-giro',
    ...overrides,
  } as PaymentOrderRow
}

const SIGNING = {
  id: 'batch-1',
  company_id: COMPANY,
  status: 'awaiting_signature',
  signing_target: 'basket',
  signing_started_at: '2026-09-30T08:00:00Z',
  provider_authorisation_id: 'auth-1',
} as PaymentOrderBatchRow

function provider(
  getPaymentState: PaymentInitiationProvider['getPaymentState'],
  cancelPayment: PaymentInitiationProvider['cancelPayment'] = vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' }),
): PaymentInitiationProvider {
  return { id: 'open_payments', isAvailableFor: () => true, getPaymentState, cancelPayment } as unknown as PaymentInitiationProvider
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
let db: ReturnType<typeof createTableMockSupabase>

function patches(table: string): Array<Record<string, unknown>> {
  return db.findCalls(table, 'update').map(([p]) => p as Record<string, unknown>)
}

function events(): Array<Record<string, unknown>> {
  return db.findCalls('payment_order_events', 'insert').flatMap(([rows]) => rows as Array<Record<string, unknown>>)
}

async function run() {
  return syncPaymentOrderStatuses(db.supabase as unknown as SupabaseClient, log)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetPaymentInitiationProviders()
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-payment' })
  mockStoredBatchSigner.mockResolvedValue(NO_SIGNER)
  db = createTableMockSupabase({
    company_settings: { data: { org_number: '556677-8899', accounting_method: 'accrual' } },
    cash_accounts: { data: { ledger_account: '1930' } },
    payment_order_batches: { data: [] },
    payment_order_events: { data: [] },
    payment_orders: { data: [] },
    supplier_invoices: { data: [] },
    transactions: { data: [] },
    'rpc:sweep_stale_payment_order_claims': { data: { marked_unknown: 0, released: 0 } },
    'rpc:release_payment_order': { data: { ok: true, status: 'cancelled' } },
  })
})

const UNPAID = { company_id: COMPANY, status: 'approved', is_credit_note: false, remaining_amount: 737.5 }
const PAID = { company_id: COMPANY, status: 'paid', is_credit_note: false, remaining_amount: 0 }

describe('syncPaymentOrderStatuses', () => {
  it('reads a status with the sparbank and the account context the paying account was connected with', async () => {
    const getPaymentState = vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] })
    registerPaymentInitiationProvider(provider(getPaymentState))
    const sparbank = { ...order('o1').debtor_snapshot, bic: 'SWEDSESS', affiliated_aspsp_id: '08999', psu_type: 'personal' }
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'submitted', debtor_snapshot: sparbank })] }, { data: [{ id: 'o1' }] }])

    await run()

    expect(getPaymentState).toHaveBeenCalledWith(
      expect.objectContaining({ debtorBic: 'SWEDSESS', affiliatedAspspId: '08999', accountContext: 'private', signerPersonalNumber: null }),
      'pay-o1',
      'swedish-giro',
    )
  })

  it('sends the PSU-ID and the IP address the payments were created with on every status read and cancel, read once per signing, with no user agent', async () => {
    mockStoredBatchSigner.mockImplementation(async (batchId: string) =>
      batchId === 'batch-1' ? { psuId: '198001019879', ipAddress: '203.0.113.10' } : NO_SIGNER,
    )
    const getPaymentState = vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] })
    const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' })
    registerPaymentInitiationProvider(provider(getPaymentState, cancelPayment))
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }, { id: 'inv-o2', ...UNPAID }, { id: 'inv-o3', ...UNPAID }] })
    db.setTable('payment_orders', [
      { data: [order('o1', { status: 'submitted' }), order('o2', { status: 'submitted' }), order('o3', { status: 'submitted', batch_id: 'batch-old' })] },
      { data: [{ id: 'o1' }] },
      { data: { id: 'o1' } },
      { data: [{ id: 'o2' }] },
      { data: [{ id: 'o3' }] },
    ])

    await run()

    const kept = expect.objectContaining({ signerPersonalNumber: '198001019879', psuIpAddress: '203.0.113.10', psuUserAgent: null })
    expect(getPaymentState).toHaveBeenCalledWith(kept, 'pay-o1', 'swedish-giro')
    expect(getPaymentState).toHaveBeenCalledWith(kept, 'pay-o2', 'swedish-giro')
    expect(cancelPayment).toHaveBeenCalledWith(kept, 'pay-o1', 'swedish-giro')
    // A signing without a kept number or address reads as before: no PSU-ID, no IP, never a guessed one.
    expect(getPaymentState).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: null, psuIpAddress: null }), 'pay-o3', 'swedish-giro')
    expect(mockStoredBatchSigner.mock.calls.map(([id]) => id).sort()).toEqual(['batch-1', 'batch-old'])
  })

  it('reads an abandoned signing\'s payments with the PSU-ID and the IP address they were created with', async () => {
    mockStoredBatchSigner.mockResolvedValue({ psuId: '198001019879', ipAddress: '2001:db8::1' })
    const getPaymentState = vi.fn().mockResolvedValue({ providerStatus: 'ACSP', status: 'accepted', messages: [] })
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('payment_order_batches', [{ data: [SIGNING] }, { data: [{ id: 'batch-1' }] }])
    db.setTable('payment_orders', [{ data: [order('o1')] }, { data: [{ id: 'o1' }] }, { data: [] }])

    await run()

    expect(mockStoredBatchSigner).toHaveBeenCalledWith('batch-1')
    expect(getPaymentState).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: '198001019879', psuIpAddress: '2001:db8::1' }), 'pay-o1', 'swedish-giro')
  })

  it('sweeps claims nobody finished in one database call, before anything else and even with no provider registered', async () => {
    db.setTable('rpc:sweep_stale_payment_order_claims', { data: { marked_unknown: 1, released: 2 } })

    const result = await run()
    const after = Date.now()

    expect(result).toMatchObject({ markedUnknown: 1, released: 2, noProvider: true })
    const [[args]] = db.findCalls('rpc:sweep_stale_payment_order_claims', 'rpc') as [[{ p_before: string }]]
    // Well past the signing routes' maxDuration, so a create still running is never swept.
    // Measured against a clock read after the call: the window is computed inside it.
    expect(after - Date.parse(args.p_before)).toBeGreaterThanOrEqual(15 * 60_000)
    expect(db.findCalls('payment_orders', 'update')).toEqual([])
  })

  it('asks the bank before calling a signing abandoned, and records one finished after the dialog closed', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'ACSP', status: 'accepted', messages: [] })))
    db.setTable('payment_order_batches', [{ data: [SIGNING] }, { data: [{ id: 'batch-1' }] }])
    db.setTable('payment_orders', [
      { data: [order('o1'), order('o2')] }, // the batch's orders
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o2' }] },
      { data: [] }, // in-flight poll
    ])

    const result = await run()

    expect(result).toMatchObject({ signedLate: 1, abandoned: 0, moved: 2 })
    expect(patches('payment_orders').map((p) => p.status)).toEqual(['accepted', 'accepted'])
    expect(patches('payment_order_batches')).toEqual([expect.objectContaining({ status: 'signed' })])
    expect(events()).toContainEqual(expect.objectContaining({ batch_id: 'batch-1', event_type: 'status_changed', to_status: 'signed' }))
    expect(events().some((e) => (e.detail as { code?: string }).code === 'SIGNING_ABANDONED')).toBe(false)
  })

  describe('a signing whose payments still read unsigned 15 minutes on (crm#1470)', () => {
    // The customer's case: BankID on the same device backed out of and the
    // dialog closed, so no poll saw it end; the sync finds it 15 minutes on.
    const bankId = (state: 'failed' | 'finalised' | 'pending', failureCode: string | null = null) =>
      vi.fn().mockResolvedValue({ state, challenge: null, failureCode, step: null })

    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

    function held(orders: PaymentOrderRow[], signingStartedAt = SIGNING.signing_started_at) {
      const signing = { ...SIGNING, provider_batch_id: 'basket-at-bank', signing_method: 'same_device', signing_started_at: signingStartedAt } as PaymentOrderBatchRow
      holdSigning(db, signing, orders)
      // Their invoices still need paying: no cancel for a closed invoice.
      db.setTable('supplier_invoices', { data: orders.map((o) => ({ id: o.supplier_invoice_id, ...UNPAID })) })
      return signing
    }

    it('asks the BankID, and when it failed cancels the payments at the bank with the PSU-ID and IP address they were created with and sends the orders back to approved', async () => {
      mockStoredBatchSigner.mockResolvedValue({ psuId: '198001019879', ipAddress: '203.0.113.10' })
      const provider = fakeProvider({ pollSigning: bankId('failed', 'SIGNING_SESSION_EXPIRED') })
      registerPaymentInitiationProvider(provider)
      const orders = [order('o1'), order('o2')]
      const signing = held(orders)

      const result = await run()

      expect(result).toMatchObject({ abandoned: 1, signedLate: 0, moved: 0 })
      const kept = expect.objectContaining({ signerPersonalNumber: '198001019879', psuIpAddress: '203.0.113.10' })
      expect(provider.pollSigning).toHaveBeenCalledWith(kept, { kind: 'basket', providerBasketId: 'basket-at-bank' }, 'auth-1', 'same_device')
      expect(provider.cancelPayment).toHaveBeenCalledWith(kept, 'pay-o1', 'swedish-giro')
      expect(provider.cancelPayment).toHaveBeenCalledWith(kept, 'pay-o2', 'swedish-giro')
      // Att betala again, no payment at the bank: nothing reads as in payment or counts as sent.
      expect(orders.map((o) => [o.status, o.batch_id, o.provider_payment_id])).toEqual([
        ['approved', null, null],
        ['approved', null, null],
      ])
      expect(signing.status).toBe('failed')
      // Only the attempt that was read: a restart since then has another id.
      expect(db.findCalls('payment_order_batches', 'eq')).toContainEqual(['provider_authorisation_id', 'auth-1'])
      expect(db.findCalls('rpc:release_payment_order', 'rpc').map(([a]) => (a as { p_reason: string }).p_reason)).toEqual(['SIGNING_ABANDONED', 'SIGNING_ABANDONED'])
      expect(events()).toContainEqual(
        expect.objectContaining({ batch_id: 'batch-1', event_type: 'error', detail: { code: 'SIGNING_ABANDONED', provider_code: 'SIGNING_SESSION_EXPIRED' } }),
      )
    })

    it('keeps an order whose cancel the bank does not confirm submitted with its payment, for a person', async () => {
      const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'too_late', providerStatus: 'RCVD', unsigned: true })
      registerPaymentInitiationProvider(fakeProvider({ pollSigning: bankId('failed', 'USER_CANCEL'), cancelPayment }))
      const orders = [order('o1')]
      const signing = held(orders)

      const result = await run()

      expect(result).toMatchObject({ abandoned: 1 })
      expect(orders[0]).toMatchObject({ status: 'submitted', batch_id: 'batch-1', provider_payment_id: 'pay-o1' })
      expect(signing.status).toBe('failed')
      expect(events()).toContainEqual(expect.objectContaining({ payment_order_id: 'o1', event_type: 'error', detail: expect.objectContaining({ code: 'BANK_CANCEL_NOT_CONFIRMED' }) }))
    })

    it('never cancels a signing whose BankID finalised while the bank still answers RCVD: it is signed, and the bank is confirming it', async () => {
      const provider = fakeProvider({ pollSigning: bankId('finalised') })
      registerPaymentInitiationProvider(provider)
      const orders = [order('o1'), order('o2')]
      const signing = held(orders)

      const result = await run()

      expect(result).toMatchObject({ signedLate: 1, abandoned: 0 })
      expect(provider.cancelPayment).not.toHaveBeenCalled()
      expect(signing.status).toBe('signed')
      expect(orders.map((o) => o.status)).toEqual(['awaiting_signature', 'awaiting_signature'])
    })

    it.each([
      ['still open by the bank\'s word', () => bankId('pending'), 0],
      ['unreadable', () => vi.fn().mockRejectedValue(new PaymentProviderError('down', 'SERVICE_UNAVAILABLE', true, 503)), 1],
    ])('cancels nothing on a guess when the BankID is %s: the signing is left for the next run', async (_, pollSigning, errors) => {
      const provider = fakeProvider({ pollSigning: pollSigning() })
      registerPaymentInitiationProvider(provider)
      const orders = [order('o1'), order('o2')]
      const signing = held(orders, minutesAgo(UNANSWERED_SIGNING_MINUTES - 5))

      const result = await run()

      expect(result).toMatchObject({ abandoned: 0, signedLate: 0, errors })
      expect(provider.cancelPayment).not.toHaveBeenCalled()
      expect(signing.status).toBe('awaiting_signature')
      expect(orders.map((o) => [o.status, o.provider_payment_id])).toEqual([
        ['awaiting_signature', 'pay-o1'],
        ['awaiting_signature', 'pay-o2'],
      ])
      expect(events()).toEqual([])
    })

    it.each([
      ['still open by the bank\'s word', () => bankId('pending'), 'pending'],
      ['unreadable', () => vi.fn().mockRejectedValue(new PaymentProviderError('down', 'SERVICE_UNAVAILABLE', true, 503)), 'unreadable'],
    ])('stops asking about a BankID %s past the cutoff: the orders go back to submitted with their payments, nothing cancelled', async (_, pollSigning, bankIdState) => {
      const provider = fakeProvider({ pollSigning: pollSigning() })
      registerPaymentInitiationProvider(provider)
      const orders = [order('o1'), order('o2')]
      const signing = held(orders, minutesAgo(UNANSWERED_SIGNING_MINUTES + 5))

      const result = await run()

      expect(result).toMatchObject({ abandoned: 1, signedLate: 0 })
      expect(provider.cancelPayment).not.toHaveBeenCalled()
      expect(db.findCalls('rpc:release_payment_order', 'rpc')).toEqual([])
      // Signera igen on the row, as every unfinished signing was before crm#1470.
      expect(signing.status).toBe('created')
      expect(orders.map((o) => [o.status, o.batch_id, o.provider_payment_id])).toEqual([
        ['submitted', 'batch-1', 'pay-o1'],
        ['submitted', 'batch-1', 'pay-o2'],
      ])
      expect(db.findCalls('payment_order_batches', 'eq')).toContainEqual(['provider_authorisation_id', 'auth-1'])
      expect(events()).toContainEqual(
        expect.objectContaining({ batch_id: 'batch-1', event_type: 'error', detail: { code: 'SIGNING_ABANDONED', bank_id: bankIdState } }),
      )
    })

    describe('whose payment status the bank refuses to give', () => {
      // Production, 2026-10-30 to 2026-11-06: a SEB signing started before the
      // signer's IP address was kept. Every 15 minutes the read was refused
      // ("FORMAT_ERROR: PSU-IP-Address is mandatory for payment"), the sweep
      // left the signing for the next run, and it never ended.
      const refusedRead = () => new PaymentProviderError('Open Payments GET 400 FORMAT_ERROR', 'FORMAT_ERROR', false, 422)

      it('asks the BankID instead of waiting for ever, and past the cutoff sends the orders back to submitted with their payments, nothing cancelled', async () => {
        const provider = fakeProvider({ getPaymentState: vi.fn().mockRejectedValue(refusedRead()), pollSigning: vi.fn().mockRejectedValue(refusedRead()) })
        registerPaymentInitiationProvider(provider)
        const orders = [order('o1', { purpose: 'skattekonto', supplier_invoice_id: null })]
        const signing = held(orders, minutesAgo(8 * 24 * 60))

        const result = await run()

        expect(result).toMatchObject({ abandoned: 1, signedLate: 0, moved: 0 })
        expect(provider.pollSigning).toHaveBeenCalledTimes(1)
        expect(provider.cancelPayment).not.toHaveBeenCalled()
        expect(db.findCalls('rpc:release_payment_order', 'rpc')).toEqual([])
        // Signera igen and Avbryt on the row: both ask the bank with the person present.
        expect(signing.status).toBe('created')
        expect(orders.map((o) => [o.status, o.batch_id, o.provider_payment_id])).toEqual([['submitted', 'batch-1', 'pay-o1']])
        expect(events()).toContainEqual(
          expect.objectContaining({
            batch_id: 'batch-1',
            event_type: 'error',
            detail: { code: 'SIGNING_ABANDONED', bank_id: 'unreadable', payment_status: 'refused' },
          }),
        )
      })

      it('records the signing finished when the BankID says it finalised', async () => {
        const provider = fakeProvider({ getPaymentState: vi.fn().mockRejectedValue(refusedRead()), pollSigning: bankId('finalised') })
        registerPaymentInitiationProvider(provider)
        const orders = [order('o1')]
        const signing = held(orders, minutesAgo(UNANSWERED_SIGNING_MINUTES + 5))

        const result = await run()

        expect(result).toMatchObject({ signedLate: 1, abandoned: 0 })
        expect(signing.status).toBe('signed')
        expect(orders[0]!.status).toBe('awaiting_signature')
        expect(provider.cancelPayment).not.toHaveBeenCalled()
      })

      it('ends a signing whose BankID failed as any other: only a cancel the bank confirms lets an order go', async () => {
        const cancelPayment = vi.fn().mockRejectedValue(refusedRead())
        const provider = fakeProvider({ getPaymentState: vi.fn().mockRejectedValue(refusedRead()), pollSigning: bankId('failed', 'SIGNING_SESSION_EXPIRED'), cancelPayment })
        registerPaymentInitiationProvider(provider)
        const orders = [order('o1')]
        const signing = held(orders, minutesAgo(UNANSWERED_SIGNING_MINUTES + 5))

        const result = await run()

        expect(result).toMatchObject({ abandoned: 1 })
        expect(cancelPayment).toHaveBeenCalledTimes(1)
        expect(db.findCalls('rpc:release_payment_order', 'rpc')).toEqual([])
        expect(orders[0]).toMatchObject({ status: 'submitted', batch_id: 'batch-1', provider_payment_id: 'pay-o1' })
        expect(signing.status).toBe('failed')
      })

      it('leaves a signing whose BankID is still open before the cutoff, and never takes a refused read for a closed payment', async () => {
        // o2 reads cancelled; o1 is refused: the batch is not "closed by the bank".
        const getPaymentState = vi.fn(async (_party: unknown, paymentId: string) => {
          if (paymentId === 'pay-o2') return { providerStatus: 'CANC', status: 'cancelled' as const, messages: [] }
          throw refusedRead()
        })
        const provider = fakeProvider({ getPaymentState, pollSigning: bankId('pending') })
        registerPaymentInitiationProvider(provider)
        const orders = [order('o1'), order('o2')]
        const signing = held(orders, minutesAgo(UNANSWERED_SIGNING_MINUTES - 5))

        const result = await run()

        expect(result).toMatchObject({ abandoned: 0, signedLate: 0 })
        expect(provider.pollSigning).toHaveBeenCalledTimes(1)
        expect(signing.status).toBe('awaiting_signature')
        expect(orders.map((o) => o.status)).toEqual(['awaiting_signature', 'cancelled'])
        expect(provider.cancelPayment).not.toHaveBeenCalled()
      })

      it.each([
        ['the service is unreachable', () => new PaymentProviderError('down', 'CONNECTOR_UNREACHABLE', true, null)],
        ['the bank throttles', () => new PaymentProviderError('busy', 'CONNECTOR_BANK_THROTTLED', true, 429)],
        ['the answer was lost', () => new PaymentProviderError('lost', 'CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN', false, 502, true)],
        ['an operator must act', () => new PaymentProviderError('config', 'CONNECTOR_PAYMENTS_PROVIDER_UNAVAILABLE', false, 503)],
      ])('still waits when %s: the next run asks again, nothing is reset', async (_, failure) => {
        const provider = fakeProvider({ getPaymentState: vi.fn().mockRejectedValue(failure()), pollSigning: bankId('pending') })
        registerPaymentInitiationProvider(provider)
        const orders = [order('o1')]
        const signing = held(orders, minutesAgo(UNANSWERED_SIGNING_MINUTES + 5))

        const result = await run()

        expect(result).toMatchObject({ abandoned: 0, signedLate: 0 })
        expect(provider.pollSigning).not.toHaveBeenCalled()
        expect(signing.status).toBe('awaiting_signature')
        expect(orders[0]!.status).toBe('awaiting_signature')
      })

      it('never moves the signing start on a failed read, so a skattekonto payment left waiting stops counting as cover at the cutoff all the same (crm#1721)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
          vi.setSystemTime(new Date('2026-11-10T08:00:00Z'))
          const getPaymentState = vi.fn().mockRejectedValue(new PaymentProviderError('down', 'CONNECTOR_UNREACHABLE', true, null))
          registerPaymentInitiationProvider(fakeProvider({ getPaymentState, pollSigning: bankId('pending') }))
          const orders = [order('o1', { purpose: 'skattekonto', supplier_invoice_id: null, amount: 5000 })]
          const startedAt = '2026-11-10T07:30:00Z'
          const signing = held(orders, startedAt)
          // What Hem and the Skattekonto page read: the order with its signing.
          const cover = () =>
            skattekontoPaymentsCovering(
              orders.map((o) => ({ ...o, signing: { status: signing.status, signing_started_at: signing.signing_started_at } })),
              null,
            )

          await run()
          expect(cover()).toBe(5000)

          // 75 minutes after the start, the reads still failing.
          vi.setSystemTime(new Date('2026-11-10T08:45:00Z'))
          await run()

          expect(getPaymentState).toHaveBeenCalled()
          expect(signing).toMatchObject({ status: 'awaiting_signature', signing_started_at: startedAt })
          expect(orders[0]!.status).toBe('awaiting_signature')
          expect(patches('payment_order_batches')).toEqual([])
          expect(cover()).toBe(0)
        } finally {
          vi.useRealTimers()
        }
      })
    })
  })

  it('leaves the signing alone when nobody can ask the bank (no provider, or no organisation number)', async () => {
    const getPaymentState = vi.fn()
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('company_settings', { data: null })
    db.setTable('companies', { data: null })
    db.setTable('payment_order_batches', { data: [SIGNING] })
    db.setTable('payment_orders', [{ data: [order('o1'), order('o2')] }, { data: [] }])

    const result = await run()

    expect(result).toMatchObject({ abandoned: 0, signedLate: 0 })
    expect(patches('payment_order_batches')).toEqual([])
    expect(getPaymentState).not.toHaveBeenCalled()
  })

  it('leaves the signing alone while the bank cannot be asked', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockRejectedValue(new PaymentProviderError('down', 'SERVICE_UNAVAILABLE', true, 503))))
    db.setTable('payment_order_batches', { data: [SIGNING] })
    db.setTable('payment_orders', [{ data: [order('o1'), order('o2')] }, { data: [] }])

    const result = await run()

    expect(result).toMatchObject({ abandoned: 0, signedLate: 0, errors: 2 })
    expect(patches('payment_order_batches')).toEqual([])
  })

  it('moves payments the bank holds forward, executed included', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'ACSC', status: 'executed', messages: [] })))
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'accepted' })] }, { data: [{ id: 'o1' }] }])

    const result = await run()

    expect(result).toMatchObject({ checked: 1, moved: 1 })
    expect(patches('payment_orders').at(-1)).toMatchObject({ status: 'executed', provider_status: 'ACSC' })
    expect(patches('payment_orders').at(-1)?.executed_at).toEqual(expect.any(String))
  })

  it('skips companies the registered provider does not serve', async () => {
    const getPaymentState = vi.fn()
    registerPaymentInitiationProvider({ ...provider(getPaymentState), isAvailableFor: () => false } as PaymentInitiationProvider)
    db.setTable('payment_orders', { data: [order('o1', { status: 'accepted' })] })

    const result = await run()

    expect(result).toMatchObject({ checked: 0, moved: 0, errors: 0 })
    expect(result.noProvider).toBeUndefined()
    expect(getPaymentState).not.toHaveBeenCalled()
  })

  it('stops after the stale-claim sweep (and the IP sweep, which needs no bank) when the installation has no payments provider', async () => {
    const result = await run()

    expect(result).toEqual({
      checked: 0,
      moved: 0,
      markedUnknown: 0,
      released: 0,
      abandoned: 0,
      signedLate: 0,
      cancelledForClosedInvoice: 0,
      heldForPerson: 0,
      settledByDebit: 0,
      linkedByDebit: 0,
      forgottenIps: 0,
      deferred: 0,
      banksNotAnswering: 0,
      errors: 0,
      noProvider: true,
    })
    expect(db.findCalls('payment_orders', 'select')).toHaveLength(0)
    expect(db.findCalls('payment_order_batches', 'select')).toHaveLength(0)
  })

  it('cancels at the bank an unsigned payment whose invoice was paid another way, cancelling its order', async () => {
    const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' })
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }), cancelPayment))
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }, { id: 'inv-o2', ...UNPAID }] })
    db.setTable('payment_orders', [
      { data: [order('o1', { status: 'submitted' }), order('o2', { status: 'submitted' })] },
      { data: [{ id: 'o1' }] }, // o1 status refreshed
      { data: { id: 'o1' } }, // o1 still waits with its payment
      { data: [{ id: 'o2' }] },
    ])

    const result = await run()

    expect(result).toMatchObject({ cancelledForClosedInvoice: 1, heldForPerson: 0 })
    expect(cancelPayment).toHaveBeenCalledTimes(1)
    expect(cancelPayment).toHaveBeenCalledWith(
      expect.objectContaining({ signerPersonalNumber: null, accountContext: 'corporate', affiliatedAspspId: null }),
      'pay-o1',
      'swedish-giro',
    )
    expect(db.findCalls('rpc:release_payment_order', 'rpc')).toEqual([
      [expect.objectContaining({ p_order_id: 'o1', p_provider_payment_id: 'pay-o1', p_provider_status: 'CANC', p_reason: 'INVOICE_CLOSED', p_user_id: null })],
    ])
  })

  it('leaves an unsigned skattekonto payment waiting beside a supplier payment whose invoice was paid another way', async () => {
    const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' })
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }), cancelPayment))
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }] })
    db.setTable('payment_orders', [
      { data: [order('o1', { status: 'submitted' }), order('t1', { status: 'submitted', purpose: 'skattekonto', supplier_invoice_id: null })] },
      { data: [{ id: 'o1' }] }, // o1 status refreshed
      { data: { id: 'o1' } }, // o1 still waits with its payment
      { data: [{ id: 't1' }] }, // t1 status refreshed
    ])

    const result = await run()

    expect(result).toMatchObject({ cancelledForClosedInvoice: 1 })
    expect(cancelPayment).toHaveBeenCalledTimes(1)
    expect(cancelPayment).toHaveBeenCalledWith(expect.anything(), 'pay-o1', 'swedish-giro')
    expect(db.findCalls('rpc:release_payment_order', 'rpc')).toEqual([[expect.objectContaining({ p_order_id: 'o1' })]])
  })

  it('holds for a person a payment whose cancel the bank does not confirm, and does not ask again', async () => {
    const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'not_cancelled', providerStatus: 'RCVD' })
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }), cancelPayment))
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }] })
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'submitted' })] }, { data: [{ id: 'o1' }] }, { data: { id: 'o1' } }])

    const first = await run()

    expect(first).toMatchObject({ cancelledForClosedInvoice: 0, heldForPerson: 1 })
    expect(db.findCalls('rpc:release_payment_order', 'rpc')).toEqual([])
    expect(events()).toContainEqual(
      expect.objectContaining({
        payment_order_id: 'o1',
        event_type: 'cancel_requested',
        detail: expect.objectContaining({ source: 'invoice_closed', provider_payment_id: 'pay-o1', answer: 'not_cancelled' }),
      }),
    )

    // The next run finds the attempt on record and leaves the order to a person.
    db.reset()
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }] })
    db.setTable('payment_order_events', { data: [{ payment_order_id: 'o1', detail: { source: 'invoice_closed', provider_payment_id: 'pay-o1' } }] })
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'submitted' })] }, { data: [{ id: 'o1' }] }])
    cancelPayment.mockClear()

    const second = await run()

    expect(second).toMatchObject({ cancelledForClosedInvoice: 0, heldForPerson: 0 })
    expect(cancelPayment).not.toHaveBeenCalled()
  })

  it('tries a cancel that never reached the bank again on the next run', async () => {
    const cancelPayment = vi.fn().mockRejectedValue(new PaymentProviderError('busy', 'RATE_LIMITED', true, 429))
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }), cancelPayment))
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }] })
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'submitted' })] }, { data: [{ id: 'o1' }] }, { data: { id: 'o1' } }])

    const result = await run()

    expect(result).toMatchObject({ cancelledForClosedInvoice: 0, heldForPerson: 0 })
    expect(cancelPayment).toHaveBeenCalledTimes(1)
    expect(events().some((e) => e.event_type === 'cancel_requested')).toBe(false)
  })
})

describe('syncPaymentOrderStatuses: the debit sweep', () => {
  type Line = { account_number: string; debit_amount: number; credit_amount: number }
  const shape = (input: CreateJournalEntryInput | undefined) =>
    (input?.lines ?? []).map((l: Line) => [l.account_number, l.debit_amount, l.credit_amount])

  /** The bank is reachable but holds nothing in flight: only the sweep has work. */
  function seedArcim(options: { debits?: unknown[] } = {}) {
    registerPaymentInitiationProvider(provider(vi.fn()))
    db.setTable('payment_orders', [
      { data: [] }, // in flight: nothing
      { data: [arcimOrder()] }, // executed, unsettled
      { data: arcimOrder() }, // read again before booking
      { data: { id: ARCIM.orderId, status: 'executed', supplier_invoice_payment_id: 'sip-1' } }, // the trigger linked it
    ])
    db.setTable('open_bank_rows', { data: options.debits ?? [arcimDebit()] }) // unbooked debits of the order's shape
    db.setTable('transactions', [
      { data: arcimDebit() }, // read again before booking
      { data: [{ id: ARCIM.transactionId }] }, // the row claim (compare-and-set)
    ])
    db.setTable('supplier_invoices', [{ data: arcimInvoice() }, { data: [{ id: ARCIM.invoiceId }] }])
    db.setTable('supplier_invoice_payments', { data: { id: 'sip-1' } })
    db.setTable('payment_match_log', { data: null })
  }

  it("settles Arcim's executed order 4e42c482 with the Swedbank debit 7af13560 already in the feed, on the first run", async () => {
    seedArcim()

    const result = await run()

    expect(result).toMatchObject({ settledByDebit: 1, errors: 0, checked: 0 })
    // Executed, unsettled orders of the last 14 days, each against the
    // unbooked debits of its amount from its account in the bank feeds.
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['status', 'executed'])
    expect(db.findCalls('payment_orders', 'is')).toContainEqual(['supplier_invoice_payment_id', null])
    expect(db.findCalls('open_bank_rows', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', ARCIM.companyId],
        ['cash_account_id', ARCIM.cashAccountId],
        ['currency', 'SEK'],
        ['amount', -10],
      ]),
    )
    expect(db.findCalls('open_bank_rows', 'is')).toEqual([['supplier_invoice_id', null]])
    expect(db.findCalls('open_bank_rows', 'in')).toContainEqual(['import_source', ['open_payments', 'enable_banking']])
    // Booked as the user who approved the order: Dr 2440 / Cr 1930, 10,00 on 2026-10-13.
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    const [, companyId, userId, input] = mockCreateJournalEntry.mock.calls[0] as [unknown, string, string, CreateJournalEntryInput]
    expect([companyId, userId]).toEqual([ARCIM.companyId, ARCIM.userId])
    expect(shape(input)).toEqual([['2440', 10, 0], ['1930', 0, 10]])
    expect(db.findCall('supplier_invoice_payments', 'insert')?.[0]).toMatchObject({
      supplier_invoice_id: ARCIM.invoiceId, transaction_id: ARCIM.transactionId, amount: 10, user_id: ARCIM.userId,
    })
    expect(db.findCall('transactions', 'update')?.[0]).toMatchObject({
      supplier_invoice_id: ARCIM.invoiceId, potential_supplier_invoice_id: null, journal_entry_id: 'je-payment',
    })
    expect(db.findCall('payment_match_log', 'insert')?.[0]).toMatchObject({
      action: 'auto_matched',
      match_method: 'payment_order',
      match_confidence: 0.98,
      new_state: expect.objectContaining({ payment_order_id: ARCIM.orderId, matched_by: 'payee' }),
    })
    expect(log.info).toHaveBeenCalledWith(
      'executed payment order settled with its debit',
      expect.objectContaining({ orderId: ARCIM.orderId, transactionId: ARCIM.transactionId, basis: 'payee', orderLinked: true }),
    )
  })

  it('leaves an executed order alone when no unbooked debit of its shape is in the feed', async () => {
    seedArcim({ debits: [] })

    const result = await run()

    expect(result).toMatchObject({ settledByDebit: 0, errors: 0 })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('leaves an executed order alone when two unbooked debits could be it', async () => {
    seedArcim({ debits: [arcimDebit(), arcimDebit({ id: 'tx-twin' })] })

    const result = await run()

    expect(result).toMatchObject({ settledByDebit: 0, errors: 0 })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('leaves an executed order alone when its debit was booked meanwhile', async () => {
    seedArcim()
    db.setTable('transactions', [{ data: arcimDebit({ journal_entry_id: 'je-by-hand' }) }])

    const result = await run()

    expect(result).toMatchObject({ settledByDebit: 0, errors: 0 })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith('executed payment order left unsettled', expect.objectContaining({ reason: 'transaction_not_open' }))
  })

  it('runs after the statuses are applied, and a failing read counts as an error without undoing them', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'ACSC', status: 'executed', messages: [] })))
    db.setTable('payment_orders', [
      { data: [order('o1', { status: 'accepted' })] },
      { data: [{ id: 'o1' }] },
      { data: null, error: { message: 'connection reset' } }, // the sweep's read
      { data: [] }, // the link sweep's read: nothing without an invoice
    ])

    const result = await run()

    expect(result).toMatchObject({ checked: 1, moved: 1, settledByDebit: 0, errors: 1 })
    expect(patches('payment_orders').at(-1)).toMatchObject({ status: 'executed' })
  })
})

describe('syncPaymentOrderStatuses: the link sweep for orders without an invoice', () => {
  /** The bank answers RCVD for the signed skattekonto order, whose debit is in the feed and booked already. */
  function seedRcvd(options: { batch?: Record<string, unknown> } = {}) {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] })))
    db.setTable('payment_order_batches', [
      { data: [] }, // no abandoned signing
      { data: [rcvdTaxBatch(options.batch)] }, // the order's signing, read for the sweep and again before the link
    ])
    db.setTable('payment_orders', [
      { data: [rcvdTaxOrder()] }, // in flight: the bank is asked, answers RCVD
      { data: [{ id: RCVD_TAX.orderId }] }, // provider columns refreshed, status unchanged
      { data: [] }, // executed supplier orders: none
      { data: [rcvdTaxOrder()] }, // orders without an invoice, unlinked
      { data: rcvdTaxOrder() }, // read again before the link
      { data: [] }, // no other order is linked to the debit
      { data: [{ id: RCVD_TAX.orderId }] }, // the compare-and-set
    ])
    db.setTable('transactions', [{ data: [rcvdTaxDebit()] }, { data: rcvdTaxDebit() }])
  }

  it('links the RCVD skattekonto order of a finished signing to its booked debit and executes it, booking nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-30T08:00:00Z'))
    try {
      seedRcvd()

      const result = await run()

      expect(result).toMatchObject({ checked: 1, moved: 0, linkedByDebit: 1, settledByDebit: 0, errors: 0 })
      // Orders without an invoice from 14 days back to tomorrow, unlinked, at the bank.
      expect(db.findCalls('payment_orders', 'gte')).toContainEqual(['requested_execution_date', '2026-10-16'])
      expect(db.findCalls('payment_orders', 'lte')).toContainEqual(['requested_execution_date', '2026-10-31'])
      expect(db.findCalls('payment_orders', 'is')).toEqual(
        expect.arrayContaining([['supplier_invoice_id', null], ['matched_transaction_id', null]]),
      )
      // The debit may be booked already: no journal_entry_id filter on the read.
      expect(db.findCalls('transactions', 'is')).toEqual([['supplier_invoice_id', null]])
      expect(patches('payment_orders').at(-1)).toMatchObject({
        status: 'executed',
        executed_at: '2026-10-27T00:00:00.000Z',
        matched_transaction_id: RCVD_TAX.transactionId,
      })
      expect(events()).toContainEqual(
        expect.objectContaining({ event_type: 'matched', from_status: 'awaiting_signature', to_status: 'executed', provider_status: 'RCVD' }),
      )
      expect(mockCreateJournalEntry).not.toHaveBeenCalled()
      expect(db.findCalls('transactions', 'update')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an order whose signing never finished, however well the debit fits', async () => {
    seedRcvd({ batch: { status: 'created', signed_at: null } })

    const result = await run()

    expect(result).toMatchObject({ linkedByDebit: 0, errors: 0 })
    expect(patches('payment_orders').some((p) => p.status === 'executed')).toBe(false)
    expect(events().some((e) => e.event_type === 'matched')).toBe(false)
  })
})

describe('the signer\'s IP address once the signing is closed', () => {
  const kept = (...ids: string[]) => ({ data: ids.map((batch_id) => ({ batch_id })) })

  it('is cleared for every signing none of whose orders is at the bank, and kept while one still is', async () => {
    db.setTable('payment_batch_psus', [kept('batch-done', 'batch-open', 'batch-moved'), { data: [{ batch_id: 'batch-done' }, { batch_id: 'batch-moved' }] }])
    // After the main read and the debit sweeps (none here): the open orders of the kept signings.
    db.setTable('payment_orders', (calls) => {
      const statuses = calls.find((c) => c.method === 'in' && c.args[0] === 'status')?.args[1] as string[] | undefined
      const batches = calls.find((c) => c.method === 'in' && c.args[0] === 'batch_id')
      return batches && statuses ? { data: [{ batch_id: 'batch-open' }] } : { data: [] }
    })

    const result = await run()

    expect(result.forgottenIps).toBe(2)
    const [read] = db.findCalls('payment_batch_psus', 'not')
    expect(read).toEqual(['psu_ip_address', 'is', null])
    const openRead = db.findCalls('payment_orders', 'in').find(([column]) => column === 'batch_id')
    expect(openRead).toEqual(['batch_id', ['batch-done', 'batch-open', 'batch-moved']])
    const statusRead = db.findCalls('payment_orders', 'in').filter(([column]) => column === 'status').at(-1)
    expect(statusRead).toEqual(['status', ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted']])
    expect(db.payloads('payment_batch_psus', 'update')).toEqual([{ psu_ip_address: null }])
    expect(db.findCalls('payment_batch_psus', 'in')).toEqual([['batch_id', ['batch-done', 'batch-moved']]])
  })

  it('runs with no payments provider too: the address is the signer\'s, not the bank\'s', async () => {
    db.setTable('payment_batch_psus', [kept('batch-done'), { data: [{ batch_id: 'batch-done' }] }])

    const result = await run()

    expect(result).toMatchObject({ noProvider: true, forgottenIps: 1, errors: 0 })
    expect(db.payloads('payment_batch_psus', 'update')).toEqual([{ psu_ip_address: null }])
  })

  it('writes nothing when no address is kept, or every kept signing still has an order at the bank', async () => {
    let result = await run()
    expect(result.forgottenIps).toBe(0)
    expect(db.findCalls('payment_batch_psus', 'update')).toEqual([])

    db.setTable('payment_batch_psus', kept('batch-open'))
    db.setTable('payment_orders', { data: [{ batch_id: 'batch-open' }] })
    result = await run()
    expect(result.forgottenIps).toBe(0)
    expect(db.findCalls('payment_batch_psus', 'update')).toEqual([])
  })

  it('does nothing before the column exists, and a failure is one error that never undoes the run', async () => {
    db.setTable('payment_batch_psus', { data: null, error: { code: '42703', message: 'column payment_batch_psus.psu_ip_address does not exist' } })
    let result = await run()
    expect(result).toMatchObject({ forgottenIps: 0, errors: 0 })

    db.setTable('payment_batch_psus', [kept('batch-done'), { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }])
    result = await run()
    expect(result).toMatchObject({ forgottenIps: 0, errors: 1 })
    expect(log.error).toHaveBeenCalledWith('signer IP addresses of closed signings could not be cleared', expect.anything())
  })
})

describe('syncPaymentOrderStatuses: what bounds a run', () => {
  const RCVD = { providerStatus: 'RCVD', status: 'submitted' as const, messages: [] }
  const atBank = (bic: string) => ({ ...order('x').debtor_snapshot, bic })
  const unsigned = (id: string, bic = 'ESSESESS') => order(id, { status: 'submitted', debtor_snapshot: atBank(bic) })
  const down = () => new PaymentProviderError('the bank did not answer', 'CONNECTOR_PAYMENTS_PROVIDER_FAILED', true, 502)
  const refusal = () => new PaymentProviderError('refused', 'FORMAT_ERROR', false, 400)
  const reads = (getPaymentState: ReturnType<typeof vi.fn>) => getPaymentState.mock.calls.map(([, paymentId]) => String(paymentId).replace('pay-', ''))
  /** A bank that leaves the named payments unanswered and answers RCVD about every other. */
  const unansweredFor = (...ids: string[]) =>
    vi.fn().mockImplementation(async (_party: unknown, paymentId: string) => {
      if (ids.includes(paymentId.replace('pay-', ''))) throw down()
      return RCVD
    })
  const withBudget = (budget: { deadline: number; allows: (ms?: number) => boolean }, sweeps?: { deadline: number; allows: (ms?: number) => boolean }) =>
    syncPaymentOrderStatuses(db.supabase as unknown as SupabaseClient, log, budget, sweeps)

  it('asks its budget before each bank read and leaves the rest, counted, for the next run', async () => {
    // Production, 2026-11-10 04:30: twelve unanswered reads took the whole 300 s and the platform killed the run.
    const getPaymentState = vi.fn().mockResolvedValue(RCVD)
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('payment_orders', [{ data: [unsigned('o1'), unsigned('o2'), unsigned('o3')] }, { data: [{ id: 'o1' }] }])
    const allows = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)

    const result = await withBudget({ deadline: 0, allows })

    expect(reads(getPaymentState)).toEqual(['o1'])
    expect(result).toMatchObject({ checked: 1, deferred: 2, banksNotAnswering: 0, errors: 0 })
    expect(log.warn).toHaveBeenCalledWith('payment status sync left payments for the next run', { deferred: 2, banksNotAnswering: 0 })
  })

  it('reads at most 200 payments in a run, oldest answer first with the id as tie-break, and counts the rest as left', async () => {
    const getPaymentState = vi.fn().mockResolvedValue(RCVD)
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('payment_orders', [{ data: Array.from({ length: 201 }, (_, i) => unsigned(`o${i}`)) }, { data: [{ id: 'o0' }] }])

    const result = await run()

    expect(getPaymentState).toHaveBeenCalledTimes(200)
    expect(result).toMatchObject({ checked: 200, deferred: 1 })
    expect(db.findCalls('payment_orders', 'order').slice(0, 2)).toEqual([
      ['provider_status_at', { ascending: true, nullsFirst: true }],
      ['id', { ascending: true }],
    ])
  })

  describe('an abandoned signing', () => {
    const bankId = (state: 'failed' | 'pending') => vi.fn().mockResolvedValue({ state, challenge: null, failureCode: state === 'failed' ? 'SIGNING_SESSION_EXPIRED' : null, step: null })
    function held(orders: PaymentOrderRow[]) {
      const signing = { ...SIGNING, provider_batch_id: 'basket-at-bank', signing_method: 'same_device' } as PaymentOrderBatchRow
      holdSigning(db, signing, orders)
      db.setTable('supplier_invoices', { data: orders.map((o) => ({ id: o.supplier_invoice_id, ...UNPAID })) })
      return signing
    }

    it('waits for the next run, as one that could not be read, when the budget is spent before it', async () => {
      const getPaymentState = vi.fn()
      const pollSigning = vi.fn()
      registerPaymentInitiationProvider({ ...provider(getPaymentState), pollSigning } as unknown as PaymentInitiationProvider)
      db.setTable('payment_order_batches', { data: [SIGNING, { ...SIGNING, id: 'batch-2' }] })
      db.setTable('payment_orders', { data: [] })

      const result = await withBudget({ deadline: 0, allows: () => false })

      expect(result).toMatchObject({ checked: 0, abandoned: 0, deferred: 2 })
      expect(getPaymentState).not.toHaveBeenCalled()
      expect(pollSigning).not.toHaveBeenCalled()
      expect(patches('payment_order_batches')).toEqual([])
    })

    it('is never called abandoned on half its payments: out of time between two reads, nothing is asked of the BankID and nothing cancelled', async () => {
      const fake = fakeProvider({ pollSigning: bankId('failed') })
      registerPaymentInitiationProvider(fake)
      const orders = [order('o1'), order('o2')]
      const signing = held(orders)
      // Time for the signing and its first read, none for the second.
      const allows = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)

      const result = await withBudget({ deadline: 0, allows })

      expect(fake.getPaymentState).toHaveBeenCalledTimes(1)
      expect(fake.pollSigning).not.toHaveBeenCalled()
      expect(fake.cancelPayment).not.toHaveBeenCalled()
      expect(signing.status).toBe('awaiting_signature')
      expect(orders.map((o) => o.status)).toEqual(['awaiting_signature', 'awaiting_signature'])
      expect(result).toMatchObject({ abandoned: 0, checked: 1 })
      expect(result.deferred).toBeGreaterThanOrEqual(1)
    })

    it('is not ended once the budget is spent: its cancels wait for the next run, where it ends as before', async () => {
      const fake = fakeProvider({ pollSigning: bankId('failed') })
      registerPaymentInitiationProvider(fake)
      const orders = [order('o1')]
      const signing = held(orders)
      // Time for the signing, its read and the BankID read; none left to start the cancels.
      const allows = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)

      const result = await withBudget({ deadline: 0, allows })

      expect(fake.pollSigning).toHaveBeenCalledTimes(1)
      expect(fake.cancelPayment).not.toHaveBeenCalled()
      expect(signing.status).toBe('awaiting_signature')
      expect(result).toMatchObject({ abandoned: 0 })
      // A signing is started only in the first half of the read budget.
      expect(allows.mock.calls[0]).toEqual([SIGNING_PASS_RESERVE_MS])

      expect(await run()).toMatchObject({ abandoned: 1 })
      expect(fake.cancelPayment).toHaveBeenCalledTimes(1)
      expect(signing.status).toBe('failed')
    })

    it('is not asked about its BankID once the budget is spent', async () => {
      const fake = fakeProvider({ pollSigning: bankId('failed') })
      registerPaymentInitiationProvider(fake)
      const signing = held([order('o1')])
      const allows = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)

      const result = await withBudget({ deadline: 0, allows })

      expect(fake.getPaymentState).toHaveBeenCalledTimes(1)
      expect(fake.pollSigning).not.toHaveBeenCalled()
      expect(signing.status).toBe('awaiting_signature')
      expect(result.deferred).toBeGreaterThanOrEqual(1)
    })

    describe('at a bank that is not answering', () => {
      const signingAt = (id: string) => ({ ...SIGNING, id }) as PaymentOrderBatchRow
      const awaiting = (id: string, bic: string, batchId: string) => order(id, { batch_id: batchId, debtor_snapshot: atBank(bic) })
      /** Each signing's orders, then the main read, answered by the batch the query names. */
      function seed(byBatch: Record<string, PaymentOrderRow[]>, atTheBank: PaymentOrderRow[]) {
        db.setTable('payment_order_batches', { data: Object.keys(byBatch).map(signingAt) })
        db.setTable('payment_orders', (chain) => {
          if (chain.some(({ method }) => method === 'update')) return { data: [{ id: 'moved' }] }
          const batch = chain.find(({ method, args }) => method === 'eq' && args[0] === 'batch_id')
          if (batch) return { data: byBatch[batch.args[1] as string] ?? [] }
          return chain.some(({ method }) => method === 'range') ? { data: atTheBank } : { data: [] }
        })
      }

      it('goes last: the signings of every other bank are worked first, and the bank goes last for the payments read after', async () => {
        const getPaymentState = unansweredFor('a1', 'c1')
        registerPaymentInitiationProvider({ ...provider(getPaymentState), pollSigning: vi.fn().mockResolvedValue({ state: 'pending', challenge: null, failureCode: null, step: null }) } as unknown as PaymentInitiationProvider)
        seed(
          { 'batch-a': [awaiting('a1', 'HANDSESS', 'batch-a')], 'batch-c': [awaiting('c1', 'HANDSESS', 'batch-c')], 'batch-b': [awaiting('b1', 'ESSESESS', 'batch-b')] },
          [unsigned('h1', 'HANDSESS'), unsigned('s1')],
        )

        const result = await run()

        // a1 goes unanswered: the next Handelsbanken signing waits until SEB's is worked, then is asked; SEB's payment is read before Handelsbanken's.
        expect(reads(getPaymentState)).toEqual(['a1', 'b1', 'c1', 's1', 'h1'])
        expect(result).toMatchObject({ banksNotAnswering: 1, abandoned: 0 })
      })

      it('gives the bank its turn back as soon as it answers', async () => {
        const getPaymentState = unansweredFor('a1')
        registerPaymentInitiationProvider({ ...provider(getPaymentState), pollSigning: vi.fn().mockResolvedValue({ state: 'pending', challenge: null, failureCode: null, step: null }) } as unknown as PaymentInitiationProvider)
        seed({ 'batch-a': [awaiting('a1', 'HANDSESS', 'batch-a')], 'batch-c': [awaiting('c1', 'HANDSESS', 'batch-c')] }, [unsigned('h1', 'HANDSESS'), unsigned('s1')])

        await run()

        // c1 is answered, so Handelsbanken is answering again when the payments are read: h1 keeps its place ahead of s1.
        expect(reads(getPaymentState)).toEqual(['a1', 'c1', 'h1', 's1'])
      })
    })
  })

  it('lets the banks take turns, each with its oldest answer first', async () => {
    const getPaymentState = vi.fn().mockResolvedValue(RCVD)
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('payment_orders', [{ data: [unsigned('h1', 'HANDSESS'), unsigned('h2', 'HANDSESS'), unsigned('h3', 'HANDSESS'), unsigned('s1'), unsigned('s2')] }, { data: [{ id: 'h1' }] }])

    await run()

    expect(reads(getPaymentState)).toEqual(['h1', 's1', 'h2', 's2', 'h3'])
  })

  it('still reads the other payments of a bank where two always go unanswered, after every other bank', async () => {
    // Two payments whose read fails on every run keep the oldest answer and are first in every run.
    const getPaymentState = unansweredFor('h1', 'h2')
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('payment_orders', [{ data: [unsigned('h1', 'HANDSESS'), unsigned('h2', 'HANDSESS'), unsigned('h3', 'HANDSESS'), unsigned('s1'), unsigned('s2')] }, { data: [{ id: 's1' }] }])

    const result = await run()

    expect(UNANSWERED_READS_PER_BANK).toBe(1)
    expect(reads(getPaymentState)).toEqual(['h1', 's1', 's2', 'h2', 'h3'])
    expect(result).toMatchObject({ checked: 5, errors: 2, banksNotAnswering: 1, deferred: 0 })
  })

  it('reads every answering bank before going back to one that is down', async () => {
    const getPaymentState = unansweredFor('h1', 'h2', 'h3', 'h4')
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('payment_orders', [
      { data: [unsigned('h1', 'HANDSESS'), unsigned('h2', 'HANDSESS'), unsigned('h3', 'HANDSESS'), unsigned('h4', 'HANDSESS'), unsigned('s1'), unsigned('s2'), unsigned('s3')] },
      { data: [{ id: 's1' }] },
    ])

    const result = await run()

    expect(reads(getPaymentState)).toEqual(['h1', 's1', 's2', 's3', 'h2', 'h3', 'h4'])
    expect(result).toMatchObject({ checked: 7, errors: 4, banksNotAnswering: 1 })
  })

  it('reads a fourth bank in full when three are down at once, on the clock: each unanswered read is a 30 s timeout', async () => {
    // Swedbank and two sparbanker behind its BIC down together: each is its own connection at the provider.
    const sparbank = (id: string, aspsp: string | null) => order(id, { status: 'submitted', debtor_snapshot: { ...atBank('SWEDSESS'), affiliated_aspsp_id: aspsp } })
    let clock = 0
    const getPaymentState = vi.fn().mockImplementation(async (party: { debtorBic: string }) => {
      if (party.debtorBic === 'SWEDSESS') {
        clock += 30_000
        throw down()
      }
      clock += 500
      return RCVD
    })
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('payment_orders', [
      {
        data: [
          sparbank('a1', null), sparbank('a2', null), sparbank('a3', null),
          sparbank('b1', '08999'), sparbank('b2', '08999'), sparbank('b3', '08999'),
          sparbank('c1', '08327'), sparbank('c2', '08327'), sparbank('c3', '08327'),
          unsigned('d1', 'NDEASESS'), unsigned('d2', 'NDEASESS'), unsigned('d3', 'NDEASESS'),
        ],
      },
      { data: [{ id: 'd1' }] },
    ])

    // The route's budget: reads start until 180 s into the run.
    const result = await withBudget(runBudget(0, 180_000, () => clock))

    // One timeout per bank that is down (90 s), then Nordea in full, then the rest of the time on the banks that are down.
    expect(reads(getPaymentState)).toEqual(['a1', 'b1', 'c1', 'd1', 'd2', 'd3', 'a2', 'b2', 'c2'])
    expect(result).toMatchObject({ banksNotAnswering: 3, deferred: 3 })
  })

  it('takes a refusal for an answer: the bank is there, and keeps its turn', async () => {
    // Production since 2026-10-30: three payments whose read SEB and Länsförsäkringar refuse (FORMAT_ERROR) on every run.
    const getPaymentState = vi.fn().mockImplementation(async (_party: unknown, paymentId: string) => {
      if (paymentId === 'pay-o1') throw refusal()
      return RCVD
    })
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('payment_orders', [{ data: [unsigned('o1'), unsigned('o2'), unsigned('h1', 'HANDSESS'), unsigned('h2', 'HANDSESS')] }, { data: [{ id: 'o2' }] }])

    const result = await run()

    expect(reads(getPaymentState)).toEqual(['o1', 'h1', 'o2', 'h2'])
    expect(result).toMatchObject({ checked: 4, errors: 1, banksNotAnswering: 0 })
  })

  describe('a payment planned for a later day', () => {
    const now = Date.now()
    const farAhead = new Date(now + 40 * 86_400_000).toISOString().slice(0, 10)
    const planned = (id: string, hoursAgo: number) =>
      order(id, { status: 'accepted', requested_execution_date: farAhead, provider_status_at: new Date(now - hoursAgo * 3_600_000).toISOString() })
    const ACSP = { providerStatus: 'ACSP', status: 'accepted' as const, messages: [] }

    it('is read when its last answer is six hours old, and skipped before that', async () => {
      const getPaymentState = vi.fn().mockResolvedValue(ACSP)
      registerPaymentInitiationProvider(provider(getPaymentState))
      db.setTable('payment_orders', [{ data: [planned('old', 7), planned('fresh', 1)] }, { data: [{ id: 'old' }] }])

      const result = await run()

      expect(reads(getPaymentState)).toEqual(['old'])
      expect(result).toMatchObject({ checked: 1, deferred: 0 })
    })

    it('is read on every run once someone has asked the bank to cancel it: they are waiting to see the cancel here', async () => {
      const getPaymentState = vi.fn().mockResolvedValue(ACSP)
      registerPaymentInitiationProvider(provider(getPaymentState))
      db.setTable('payment_orders', [{ data: [planned('asked', 1), planned('fresh', 1)] }, { data: [{ id: 'asked' }] }])
      db.setTable('payment_order_events', { data: [{ payment_order_id: 'asked' }, { payment_order_id: 'another-company-order' }] })

      await run()

      expect(reads(getPaymentState)).toEqual(['asked'])
      expect(db.findCalls('payment_order_events', 'eq')).toContainEqual(['event_type', 'cancel_requested'])
      const [column, since] = db.findCall('payment_order_events', 'gte') as [string, string]
      expect(column).toBe('occurred_at')
      expect(Date.now() - Date.parse(since)).toBeGreaterThanOrEqual(7 * 86_400_000 - 5_000)
    })

    it('is left to its six hours, and every other payment still read, when the cancel requests cannot be read', async () => {
      const getPaymentState = vi.fn().mockResolvedValue(ACSP)
      registerPaymentInitiationProvider(provider(getPaymentState))
      // o1 is signed and due today: read on every run, and no cancel for a closed invoice is weighed for it.
      const dueToday = order('o1', { status: 'accepted', requested_execution_date: new Date().toISOString().slice(0, 10) })
      db.setTable('payment_orders', [{ data: [planned('fresh', 1), dueToday] }, { data: [{ id: 'o1' }] }])
      db.setTable('payment_order_events', { data: null, error: { message: 'canceling statement due to statement timeout' } })

      const result = await run()

      expect(reads(getPaymentState)).toEqual(['o1'])
      expect(result).toMatchObject({ checked: 1 })
      expect(log.error).toHaveBeenCalledWith('cancel requests of planned payments could not be read', expect.objectContaining({ message: 'canceling statement due to statement timeout' }))
    })
  })

  describe('the debit sweeps', () => {
    function seedExecutedOrder() {
      registerPaymentInitiationProvider(provider(vi.fn()))
      db.setTable('payment_orders', [{ data: [] }, { data: [arcimOrder()] }])
      db.setTable('open_bank_rows', { data: [] })
    }

    it('run on a budget of their own: they call no bank, so a run whose reads took all their time still looks for the debits', async () => {
      seedExecutedOrder()

      const result = await withBudget({ deadline: 0, allows: () => false }, { deadline: 0, allows: () => true })

      expect(db.findCalls('open_bank_rows', 'select')).toHaveLength(1)
      expect(result).toMatchObject({ deferred: 0, errors: 0 })
    })

    it('leave their rows, counted, for the next run when their own budget is spent', async () => {
      seedExecutedOrder()

      const result = await withBudget({ deadline: 0, allows: () => false }, { deadline: 0, allows: () => false })

      expect(db.findCalls('open_bank_rows', 'select')).toHaveLength(0)
      expect(result.deferred).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('isDueForStatusRead', () => {
  // 09:00 in Stockholm on 12 November 2026.
  const NOW = new Date('2026-11-12T08:00:00Z')
  const answered = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
  const row = (status: PaymentOrderRow['status'], requested_execution_date: string, provider_status_at: string | null) => ({ status, requested_execution_date, provider_status_at })

  it('reads a payment planned for a later day every six hours, not every run', () => {
    expect(isDueForStatusRead(row('accepted', '2027-04-01', answered(15 * 60_000)), NOW)).toBe(false)
    expect(isDueForStatusRead(row('accepted', '2026-11-14', answered(SCHEDULED_PAYMENT_READ_EVERY_MS - 1)), NOW)).toBe(false)
    expect(isDueForStatusRead(row('accepted', '2026-11-14', answered(SCHEDULED_PAYMENT_READ_EVERY_MS)), NOW)).toBe(true)
    expect(isDueForStatusRead(row('accepted', '2027-04-01', null), NOW)).toBe(true)
    expect(isDueForStatusRead(row('accepted', '2027-04-01', 'not a date'), NOW)).toBe(true)
  })

  it('reads a payment the bank pays today or tomorrow, or should have paid, on every run', () => {
    for (const date of ['2026-11-13', '2026-11-12', '2026-11-01']) {
      expect(isDueForStatusRead(row('accepted', date, answered(60_000)), NOW)).toBe(true)
    }
  })

  it('reads every payment nobody has signed yet on every run, whatever its date', () => {
    for (const status of ['submitted', 'awaiting_signature', 'awaiting_second_signer'] as const) {
      expect(isDueForStatusRead(row(status, '2027-04-01', answered(60_000)), NOW)).toBe(true)
    }
  })

  it('reads a planned payment on every run while a cancel of it is asked for', () => {
    expect(isDueForStatusRead(row('accepted', '2027-04-01', answered(15 * 60_000)), NOW, true)).toBe(true)
    expect(isDueForStatusRead(row('accepted', '2027-04-01', answered(15 * 60_000)), NOW, false)).toBe(false)
  })

  it('counts the day on the Swedish calendar', () => {
    // 23:30 UTC on the 12th is 00:30 on the 13th in Stockholm: the 14th is tomorrow there.
    const late = new Date('2026-11-12T23:30:00Z')
    expect(isDueForStatusRead(row('accepted', '2026-11-14', new Date(late.getTime() - 60_000).toISOString()), late)).toBe(true)
    expect(isDueForStatusRead(row('accepted', '2026-11-15', new Date(late.getTime() - 60_000).toISOString()), late)).toBe(false)
  })
})
