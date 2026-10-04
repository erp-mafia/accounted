import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
} from '@/lib/payments/initiation/provider'
import type { OperationContext } from '@/lib/operations/types'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))

import { preparePaymentOrders } from '../prepare'
import { approvePaymentOrders } from '../lifecycle'

const COMPANY = 'company-1'
const ACCOUNT = { id: 'acct-1', iban: 'SE3550000000054910000003', currency: 'SEK', name: 'Företagskonto', enabled: true, bank_connection: { bank_name: 'SEB' } }

function invoice(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    supplier_id: 'sup-1',
    status: 'approved',
    approved_at: '2026-09-29T08:00:00Z',
    due_date: '2026-10-20',
    remaining_amount: 737.5,
    currency: 'SEK',
    is_credit_note: false,
    payment_reference: '4400112233',
    supplier_invoice_number: `F-${id}`,
    payee_bankgiro: null,
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    ...overrides,
  }
}

const SUPPLIER = { id: 'sup-1', name: 'Derome Bygg AB', bankgiro: '5050-1055', plusgiro: null, bank_account: null, clearing_number: null, account_number: null }

const provider = { id: 'open_payments', isAvailableFor: () => true } as unknown as PaymentInitiationProvider

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  resetPaymentInitiationProviders()
  registerPaymentInitiationProvider(provider)
  db = createTableMockSupabase({
    cash_accounts: { data: ACCOUNT },
    suppliers: { data: [SUPPLIER] },
    supplier_payment_batch_items: { data: [] },
    payment_orders: { data: [] },
    payment_order_events: { data: null },
  })
  mock.supabase = db.supabase
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never }
})

describe('preparePaymentOrders', () => {
  it('builds one draft per payable invoice with the payment-file rules and skips the rest', async () => {
    db.setTable('supplier_invoices', {
      data: [invoice('a'), invoice('b', { is_credit_note: true, status: 'credited' }), invoice('c', { currency: 'EUR' })],
    })
    db.setTable('rpc:create_payment_orders', { data: { ok: true, orders: [{ id: 'order-a', supplier_invoice_id: 'a' }] } })

    const result = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a', 'b', 'c', 'missing'], cashAccountId: 'acct-1', today: '2026-09-30' })

    expect(result.ok).toBe(true)
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.skipped).toEqual([
      { supplier_invoice_id: 'b', reason: 'credit_note' },
      { supplier_invoice_id: 'c', reason: 'foreign_currency' },
      { supplier_invoice_id: 'missing', reason: 'not_found' },
    ])
    const [args] = db.findCall('rpc:create_payment_orders', 'rpc') as [{ p_orders: Array<Record<string, unknown>>; p_user_id: string }]
    expect(args.p_user_id).toBe('user-1')
    expect(args.p_orders).toHaveLength(1)
    expect(args.p_orders[0]).toMatchObject({
      supplier_invoice_id: 'a',
      amount: 737.5,
      requested_execution_date: '2026-10-20',
      debtor_snapshot: { iban: 'SE3550000000054910000003', bic: 'ESSESESS' },
      payee_type: 'bankgiro',
      payee_bankgiro: '50501055',
      payee_source: 'supplier',
      payee_check: 'known',
      reference_type: 'ocr',
      reference: '4400112233',
    })
  })

  it('flags an invoice that states another account, and pays the card unless told otherwise', async () => {
    db.setTable('supplier_invoices', { data: [invoice('a', { payee_bankgiro: '5402-0102' })] })
    db.setTable('rpc:create_payment_orders', { data: { ok: true, orders: [] } })

    const result = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-09-30' })

    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.warnings).toContainEqual({ supplier_invoice_id: 'a', code: 'payee_changed', alternative_payee: 'BG 5402-0102' })
    const [args] = db.findCall('rpc:create_payment_orders', 'rpc') as [{ p_orders: Array<Record<string, unknown>> }]
    expect(args.p_orders[0]).toMatchObject({ payee_bankgiro: '50501055', payee_source: 'supplier', payee_check: 'changed' })
  })

  it('skips invoices in an open payment file or an open order before calling the database', async () => {
    db.setTable('supplier_invoices', { data: [invoice('a'), invoice('b')] })
    db.setTable('supplier_payment_batch_items', { data: [{ supplier_invoice_id: 'a', batch: { status: 'created' } }] })
    db.setTable('payment_orders', { data: [{ supplier_invoice_id: 'b', status: 'executed', supplier_invoice_payment_id: null }] })

    const result = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a', 'b'], cashAccountId: 'acct-1', today: '2026-09-30' })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_INELIGIBLE' })
    expect(db.findCall('rpc:create_payment_orders', 'rpc')).toBeUndefined()
  })

  it('refuses an account that cannot pay and a company without a provider', async () => {
    db.setTable('cash_accounts', { data: { ...ACCOUNT, currency: 'EUR' } })
    expect(await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-09-30' })).toMatchObject({
      ok: false,
      code: 'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE',
      details: { reason: 'not_sek' },
    })
    resetPaymentInitiationProviders()
    expect(await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-09-30' })).toMatchObject({
      ok: false,
      code: 'PAYMENTS_UNAVAILABLE',
    })
  })

  it('maps a database refusal to its payment code', async () => {
    db.setTable('supplier_invoices', { data: [invoice('a')] })
    db.setTable('rpc:create_payment_orders', { data: { ok: false, code: 'already_in_payment', details: [{ id: 'a' }] } })
    expect(await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-09-30' })).toMatchObject({
      ok: false,
      code: 'PAYMENT_ORDERS_ALREADY_IN_PAYMENT',
    })
  })

  it('never prepares a bank payment from the sandbox', async () => {
    db.setTable('company_settings', { data: { is_sandbox: true } })
    db.setTable('supplier_invoices', { data: [invoice('a')] })
    expect(await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-09-30' })).toMatchObject({
      ok: false,
      code: 'PAYMENTS_UNAVAILABLE',
      details: { reason: 'sandbox' },
    })
    expect(db.findCall('rpc:create_payment_orders', 'rpc')).toBeUndefined()
  })

  it('refuses an execution date in the past', async () => {
    expect(
      await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', executionDate: '2026-09-01', today: '2026-09-30' }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })
})

describe('approvePaymentOrders', () => {
  it('requires a confirmation before approving a payment to a changed account', async () => {
    db.setTable('payment_orders', { data: [{ id: 'o1', status: 'draft', payee_check: 'changed' }] })
    expect(await approvePaymentOrders(ctx, { orderIds: ['o1'] })).toMatchObject({
      ok: false,
      code: 'PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED',
    })
    expect(db.findCalls('payment_orders', 'update')).toHaveLength(0)
  })

  it('approves drafts with a compare-and-set and records who confirmed a changed account', async () => {
    db.setTable('payment_orders', [{ data: [{ id: 'o1', status: 'draft', payee_check: 'changed' }] }, { data: [{ id: 'o1' }] }])
    const result = await approvePaymentOrders(ctx, { orderIds: ['o1'], confirmChangedPayee: true })
    expect(result).toMatchObject({ ok: true, data: { approved: ['o1'] } })
    const [patch] = db.findCall('payment_orders', 'update') as [Record<string, unknown>]
    expect(patch).toMatchObject({ status: 'approved', approved_by: 'user-1' })
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['status', 'draft'])
    const [events] = db.findCall('payment_order_events', 'insert') as [Array<Record<string, unknown>>]
    expect(events[0]).toMatchObject({ event_type: 'approved', detail: { confirmed_changed_payee: true } })
  })

  it('refuses orders that are no longer drafts', async () => {
    db.setTable('payment_orders', { data: [{ id: 'o1', status: 'submitted', payee_check: 'known' }] })
    expect(await approvePaymentOrders(ctx, { orderIds: ['o1'] })).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' })
  })
})
