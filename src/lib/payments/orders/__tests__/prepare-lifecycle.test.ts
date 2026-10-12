import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))
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
      reference_type: 'ocr',
      reference: '4400112233',
    })
    // The database derives the check; the caller never sends one.
    expect(args.p_orders[0]).not.toHaveProperty('payee_check')
  })

  it('warns from what the database decided: a changed account names the other one, a new one asks for a check', async () => {
    db.setTable('supplier_invoices', { data: [invoice('a', { payee_bankgiro: '5402-0102' }), invoice('b')] })
    db.setTable('rpc:create_payment_orders', {
      data: {
        ok: true,
        orders: [
          { id: 'order-a', supplier_invoice_id: 'a', payee_check: 'changed' },
          { id: 'order-b', supplier_invoice_id: 'b', payee_check: 'new' },
        ],
      },
    })

    const result = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a', 'b'], cashAccountId: 'acct-1', today: '2026-09-30' })

    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.warnings).toContainEqual({ supplier_invoice_id: 'a', code: 'payee_changed', alternative_payee: 'BG 5402-0102' })
    expect(result.data.warnings).toContainEqual({ supplier_invoice_id: 'b', code: 'payee_new' })
    const [args] = db.findCall('rpc:create_payment_orders', 'rpc') as [{ p_orders: Array<Record<string, unknown>> }]
    // The card is paid unless a person chose the invoice's account.
    expect(args.p_orders[0]).toMatchObject({ payee_bankgiro: '50501055', payee_source: 'supplier' })
  })

  it('skips invoices in an open payment file or an open order before calling the database', async () => {
    db.setTable('supplier_invoices', { data: [invoice('a'), invoice('b')] })
    db.setTable('supplier_payment_batch_items', { data: [{ supplier_invoice_id: 'a', batch: { status: 'created' } }] })
    db.setTable('payment_orders', { data: [{ supplier_invoice_id: 'b', status: 'executed', supplier_invoice_payment_id: null }] })

    const result = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a', 'b'], cashAccountId: 'acct-1', today: '2026-09-30' })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_INELIGIBLE' })
    expect(db.findCall('rpc:create_payment_orders', 'rpc')).toBeUndefined()
  })

  it('replaces a draft nobody approved instead of refusing the invoice', async () => {
    db.setTable('supplier_invoices', { data: [invoice('a')] })
    db.setTable('payment_orders', { data: [{ id: 'old-draft', supplier_invoice_id: 'a', status: 'draft', supplier_invoice_payment_id: null }] })
    db.setTable('rpc:create_payment_orders', { data: { ok: true, orders: [{ id: 'order-a', supplier_invoice_id: 'a', payee_check: 'ok' }] } })

    const preview = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-09-30', dryRun: true })
    if (!preview.ok || !preview.dryRun) throw new Error('unexpected')
    expect(preview.preview).toMatchObject({ replaces_drafts: 1 })
    expect(db.findCall('payment_orders', 'update')).toBeUndefined()

    const result = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-09-30' })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.replaced_draft_ids).toEqual(['old-draft'])
    expect(result.data.orders.map((o) => o.id)).toEqual(['order-a'])
    const [patch] = db.findCall('payment_orders', 'update') as [Record<string, unknown>]
    expect(patch).toMatchObject({ status: 'cancelled', cancelled_by: ctx.userId })
    expect(db.findCall('payment_order_events', 'insert')).toBeDefined()
    expect(db.findCall('rpc:create_payment_orders', 'rpc')).toBeDefined()
  })

  it('still skips an invoice whose order a person approved or the bank may hold', async () => {
    db.setTable('supplier_invoices', { data: [invoice('a')] })
    db.setTable('payment_orders', { data: [{ id: 'live', supplier_invoice_id: 'a', status: 'approved', supplier_invoice_payment_id: null }] })
    expect(await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-09-30' })).toMatchObject({
      ok: false,
      code: 'PAYMENT_ORDERS_INELIGIBLE',
      details: { skipped: [{ supplier_invoice_id: 'a', reason: 'already_in_payment' }] },
    })
    expect(db.findCall('payment_orders', 'update')).toBeUndefined()
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

  it.each([
    ['already_in_payment', 'PAYMENT_ORDERS_ALREADY_IN_PAYMENT'],
    ['payee_mismatch', 'PAYMENT_ORDERS_PAYEE_MISMATCH'],
    ['idempotency_mismatch', 'PAYMENT_ORDERS_IDEMPOTENCY_MISMATCH'],
    ['invalid_payload', 'VALIDATION_ERROR'],
    ['sandbox', 'PAYMENTS_UNAVAILABLE'],
  ])('maps the database refusal %s to %s', async (rpcCode, code) => {
    db.setTable('supplier_invoices', { data: [invoice('a')] })
    db.setTable('rpc:create_payment_orders', { data: { ok: false, code: rpcCode, details: [{ id: 'a' }] } })
    expect(await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-09-30' })).toMatchObject({
      ok: false,
      code,
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

  it('moves a weekend or holiday date to the next banking day and says so', async () => {
    db.setTable('supplier_invoices', { data: [invoice('a', { due_date: '2026-10-10' })] }) // a Saturday, already passed on the 11th
    db.setTable('rpc:create_payment_orders', { data: { ok: true, orders: [{ id: 'order-a', supplier_invoice_id: 'a', payee_check: 'known' }] } })
    const result = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-10-11' })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    const [args] = db.findCall('rpc:create_payment_orders', 'rpc') as [{ p_orders: Array<Record<string, unknown>> }]
    expect(args.p_orders[0]).toMatchObject({ requested_execution_date: '2026-10-12' })
    expect(result.data.warnings).toContainEqual({ supplier_invoice_id: 'a', code: 'date_moved', from: '2026-10-11', to: '2026-10-12' })

    const preview = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', executionDate: '2027-01-01', today: '2026-10-11', dryRun: true })
    if (!preview.ok || !preview.dryRun) throw new Error('unexpected')
    expect((preview.preview as { lines: Array<Record<string, unknown>> }).lines[0]).toMatchObject({ requested_execution_date: '2027-01-04', date_moved_from: '2027-01-01' })
  })

  it('never dates a payment today: an invoice due today goes to the next banking day', async () => {
    db.setTable('supplier_invoices', { data: [invoice('a', { due_date: '2026-10-12' })] }) // a Monday, due today
    db.setTable('rpc:create_payment_orders', { data: { ok: true, orders: [{ id: 'order-a', supplier_invoice_id: 'a', payee_check: 'known' }] } })
    const result = await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', today: '2026-10-12' })
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    const [args] = db.findCall('rpc:create_payment_orders', 'rpc') as [{ p_orders: Array<Record<string, unknown>> }]
    expect(args.p_orders[0]).toMatchObject({ requested_execution_date: '2026-10-13' })
    expect(result.data.warnings).toContainEqual({ supplier_invoice_id: 'a', code: 'date_moved', from: '2026-10-12', to: '2026-10-13' })
  })

  it('refuses an execution date in the past', async () => {
    expect(
      await preparePaymentOrders(ctx, { supplierInvoiceIds: ['a'], cashAccountId: 'acct-1', executionDate: '2026-09-01', today: '2026-09-30' }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })
})

describe('approvePaymentOrders', () => {
  it('requires each invoice with a changed or new account to be confirmed, one by one', async () => {
    db.setTable('payment_orders', {
      data: [
        { id: 'o1', status: 'draft', payee_check: 'changed', supplier_invoice_id: 'a' },
        { id: 'o2', status: 'draft', payee_check: 'new', supplier_invoice_id: 'b' },
        { id: 'o3', status: 'draft', payee_check: 'known', supplier_invoice_id: 'c' },
      ],
    })
    // Confirming one invoice does not confirm the other.
    expect(await approvePaymentOrders(ctx, { orderIds: ['o1', 'o2', 'o3'], confirmedPayeeInvoiceIds: ['a'] })).toMatchObject({
      ok: false,
      code: 'PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED',
      details: { orders: [{ id: 'o2', supplier_invoice_id: 'b', payee_check: 'new' }] },
    })
    expect(db.findCalls('payment_orders', 'update')).toHaveLength(0)
  })

  it('approves drafts with a compare-and-set and records which account was confirmed', async () => {
    db.setTable('payment_orders', [{ data: [{ id: 'o1', status: 'draft', payee_check: 'changed', supplier_invoice_id: 'a' }] }, { data: [{ id: 'o1' }] }])
    const result = await approvePaymentOrders(ctx, { orderIds: ['o1'], confirmedPayeeInvoiceIds: ['a'] })
    expect(result).toMatchObject({ ok: true, data: { approved: ['o1'] } })
    const [patch] = db.findCall('payment_orders', 'update') as [Record<string, unknown>]
    expect(patch).toMatchObject({ status: 'approved', approved_by: 'user-1' })
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['status', 'draft'])
    const [events] = db.findCall('payment_order_events', 'insert') as [Array<Record<string, unknown>>]
    expect(events[0]).toMatchObject({ event_type: 'approved', detail: { confirmed_payee: 'changed' } })
  })

  it('moves a draft dated on a weekend to the next banking day as it approves, and says so', async () => {
    db.setTable('payment_orders', [
      { data: [{ id: 'o1', status: 'draft', payee_check: 'known', supplier_invoice_id: 'a', requested_execution_date: '2026-10-10' }] },
      { data: [{ id: 'o1' }] }, // the date
      { data: [{ id: 'o1' }] }, // the approval
    ])
    const result = await approvePaymentOrders(ctx, { orderIds: ['o1'], today: '2026-10-11' })
    expect(result).toMatchObject({ ok: true, data: { approved: ['o1'] } })
    const patches = db.findCalls('payment_orders', 'update').map(([p]) => p as Record<string, unknown>)
    expect(patches[0]).toEqual({ requested_execution_date: '2026-10-12' })
    expect(patches[1]).toMatchObject({ status: 'approved' })
    const [events] = db.findCall('payment_order_events', 'insert') as [Array<Record<string, unknown>>]
    expect(events[0]).toMatchObject({ event_type: 'approved', detail: { date_moved_from: '2026-10-10', date_moved_to: '2026-10-12' } })
  })

  it('moves a draft dated today to the next banking day as it approves: the bank never takes today', async () => {
    db.setTable('payment_orders', [
      { data: [{ id: 'o1', status: 'draft', payee_check: 'known', supplier_invoice_id: 'a', requested_execution_date: '2026-10-12' }] },
      { data: [{ id: 'o1' }] }, // the date
      { data: [{ id: 'o1' }] }, // the approval
    ])
    const result = await approvePaymentOrders(ctx, { orderIds: ['o1'], today: '2026-10-12' })
    expect(result).toMatchObject({ ok: true, data: { approved: ['o1'] } })
    const patches = db.findCalls('payment_orders', 'update').map(([p]) => p as Record<string, unknown>)
    expect(patches[0]).toEqual({ requested_execution_date: '2026-10-13' })
    const [events] = db.findCall('payment_order_events', 'insert') as [Array<Record<string, unknown>>]
    expect(events[0]).toMatchObject({ event_type: 'approved', detail: { date_moved_from: '2026-10-12', date_moved_to: '2026-10-13' } })
  })

  it('refuses orders that are no longer drafts', async () => {
    db.setTable('payment_orders', { data: [{ id: 'o1', status: 'submitted', payee_check: 'known' }] })
    expect(await approvePaymentOrders(ctx, { orderIds: ['o1'] })).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' })
  })
})
