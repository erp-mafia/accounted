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

import { prepareSkattekontoPaymentOrder } from '../prepare-skattekonto'

const COMPANY = 'company-1'
// A Friday; Skatteverket draws the next charge on Thursday 2026-11-12.
const TODAY = '2026-10-16'
const DUE = '2026-11-12'
const OCR = '1655954700217'

const ACCOUNT = {
  id: 'acct-1',
  iban: 'SE3550000000054910000003',
  currency: 'SEK',
  name: 'Företagskonto',
  enabled: true,
  bank_connection: { bank_name: 'SEB', affiliated_aspsp_id: null, psu_type: 'business' },
}

const provider = { id: 'open_payments', isAvailableFor: () => true } as unknown as PaymentInitiationProvider

type Chain = Array<{ method: string; args: unknown[] }>
type OrderRow = { id: string; status: string; amount?: number; executed_at?: string | null }

/**
 * payment_orders answers by what the chain asks: the open-order check
 * ('id, status'), the worklist's payments underway (amount, status,
 * executed_at), or the cancel of a stale draft (an update).
 */
function paymentOrders(open: OrderRow[], underway: OrderRow[] = [], cancelled: Array<{ id: string }> = []) {
  return (calls: Chain) => {
    if (calls.some((c) => c.method === 'update')) return { data: cancelled }
    const select = calls.find((c) => c.method === 'select')?.args[0]
    if (select === 'id, status') return { data: open }
    return { data: underway }
  }
}

const UPCOMING = [
  { transaktionsdatum: DUE, forfallodatum: DUE, belopp_skatteverket: -12000 },
  { transaktionsdatum: DUE, forfallodatum: DUE, belopp_skatteverket: -3000 },
]

const snapshot = (saldoSkatteverket: number, ocrNummer?: string) => ({
  data: { value: { saldo: { saldoSkatteverket, ...(ocrNummer ? { ocrNummer } : {}) }, fetchedAt: Date.parse('2026-10-15T06:00:00Z') } },
})

const CREATED = { id: 'order-1', purpose: 'skattekonto', status: 'draft', amount: 11000 }

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  resetPaymentInitiationProviders()
  registerPaymentInitiationProvider(provider)
  db = createTableMockSupabase({
    cash_accounts: { data: ACCOUNT },
    companies: { data: { org_number: '559547-0021', entity_type: 'aktiebolag' } },
    skattekonto_transactions: { data: UPCOMING },
    extension_data: snapshot(4000),
    payment_orders: paymentOrders([]),
    payment_order_events: { data: null },
    'rpc:create_skattekonto_payment_order': { data: { ok: true, order: CREATED } },
  })
  mock.supabase = db.supabase
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never }
})

function rpcArgs(): Record<string, unknown> {
  const [args] = db.findCall('rpc:create_skattekonto_payment_order', 'rpc') as [Record<string, unknown>]
  return args
}

describe('prepareSkattekontoPaymentOrder', () => {
  it('pays in what the next charge lacks, the banking day before Skatteverket draws it, with the company OCR', async () => {
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })

    expect(result).toEqual({ ok: true, data: { order: CREATED, warnings: [], replaced_draft_ids: [] } })
    expect(rpcArgs()).toMatchObject({
      p_company_id: COMPANY,
      p_cash_account_id: 'acct-1',
      p_debtor_snapshot: { iban: 'SE3550000000054910000003', bic: 'ESSESESS', bank_name: 'SEB', currency: 'SEK' },
      p_amount: 11000,
      p_requested_execution_date: '2026-11-11',
      p_reference: OCR,
      p_user_id: 'user-1',
    })
    expect(typeof rpcArgs().p_idempotency_key).toBe('string')
    // The payee is the database's to set: the caller sends none.
    expect(rpcArgs()).not.toHaveProperty('p_payee_bankgiro')
  })

  it('takes the amount the person enters, rounded to öre, and refuses zero or less', async () => {
    await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', amount: 1234.567, today: TODAY })
    expect(rpcArgs().p_amount).toBe(1234.57)

    for (const amount of [0, -5, 0.004]) {
      const refused = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', amount, today: TODAY })
      expect(refused).toEqual({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'amount', reason: 'not_positive' } })
    }
  })

  it('refuses when nothing is due and no amount is entered, and pays an entered amount on the earliest day', async () => {
    db.setTable('extension_data', snapshot(20000))

    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE',
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()

    db.setTable('skattekonto_transactions', { data: [] })
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', amount: 500, today: TODAY })
    expect(result.ok).toBe(true)
    // Monday 2026-10-19: the first banking day after today.
    expect(rpcArgs()).toMatchObject({ p_amount: 500, p_requested_execution_date: '2026-10-19' })
  })

  it('subtracts a payment executed since the saldo was fetched from the default amount', async () => {
    db.setTable('payment_orders', paymentOrders([], [{ id: 'paid-1', status: 'executed', amount: 6000, executed_at: '2026-10-15T09:00:00Z' }]))
    await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })
    expect(rpcArgs().p_amount).toBe(5000)
  })

  it('refuses without an OCR number, and uses the one Skatteverket reported when the company has no org number', async () => {
    db.setTable('companies', { data: { org_number: null, entity_type: 'aktiebolag' } })
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_OCR_MISSING',
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()

    db.setTable('extension_data', snapshot(4000, '1655954700217'))
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })
    expect(result.ok).toBe(true)
    expect(rpcArgs().p_reference).toBe('1655954700217')
  })

  it('warns that a payment on or after the due date is late, and moves a day the bank does not take', async () => {
    const onDue = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', executionDate: DUE, today: TODAY })
    expect(onDue).toMatchObject({ ok: true, data: { warnings: [{ code: 'late', due: DUE }] } })

    // Saturday 2026-11-14 becomes Monday 2026-11-16, after the charge is drawn.
    const weekend = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', executionDate: '2026-11-14', today: TODAY })
    expect(weekend).toMatchObject({
      ok: true,
      data: {
        warnings: [
          { code: 'date_moved', from: '2026-11-14', to: '2026-11-16' },
          { code: 'late', due: DUE },
        ],
      },
    })

    const past = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', executionDate: '2026-10-15', today: TODAY })
    expect(past).toEqual({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'execution_date', reason: 'in_the_past' } })
  })

  it('calls the default late when the charge is drawn on the first day the bank takes', async () => {
    // Drawn Monday 2026-10-19: the banking day before it is today, which the bank no longer takes.
    db.setTable('skattekonto_transactions', { data: [{ transaktionsdatum: '2026-10-19', forfallodatum: '2026-10-19', belopp_skatteverket: -1000 }] })
    db.setTable('extension_data', snapshot(0))
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })
    expect(result).toMatchObject({ ok: true, data: { warnings: [{ code: 'late', due: '2026-10-19' }] } })
    expect(rpcArgs().p_requested_execution_date).toBe('2026-10-19')
  })

  it('answers the payment it would make on a dry run and writes nothing', async () => {
    db.setTable('payment_orders', paymentOrders([{ id: 'old-draft', status: 'draft' }]))

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY, dryRun: true })

    expect(result).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        cash_account_id: 'acct-1',
        debtor: { bank_name: 'SEB', bic: 'ESSESESS' },
        amount: 11000,
        currency: 'SEK',
        requested_execution_date: '2026-11-11',
        date_moved_from: null,
        due: { date: DUE, charge: 15000, balance: 4000, amount: 11000 },
        payee: { type: 'bankgiro', label: 'BG 5050-1055', name: 'Skatteverket' },
        reference: { type: 'ocr', value: OCR },
        warnings: [],
        replaces_drafts: 1,
      },
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()
    expect(db.findCalls('payment_orders', 'update')).toEqual([])
    expect(db.findCalls('payment_order_events', 'insert')).toEqual([])
  })

  it('replaces a skattekonto draft nobody approved, so the latest choice wins', async () => {
    db.setTable('payment_orders', paymentOrders([{ id: 'old-draft', status: 'draft' }], [], [{ id: 'old-draft' }]))

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })

    expect(result).toMatchObject({ ok: true, data: { replaced_draft_ids: ['old-draft'] } })
    const [patch] = db.findCall('payment_orders', 'update') as [Record<string, unknown>]
    expect(patch).toMatchObject({ status: 'cancelled', cancelled_by: 'user-1' })
    expect(db.findCalls('payment_orders', 'eq')).toEqual(expect.arrayContaining([['status', 'draft'], ['purpose', 'skattekonto']]))
    const [events] = db.findCall('payment_order_events', 'insert') as [Array<Record<string, unknown>>]
    expect(events).toEqual([expect.objectContaining({ payment_order_id: 'old-draft', event_type: 'cancelled', detail: { replaced_by_new_draft: true } })])
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeDefined()
  })

  it('refuses while a skattekonto payment is already on its way, and maps the database refusal the same way', async () => {
    db.setTable('payment_orders', paymentOrders([{ id: 'signed-1', status: 'awaiting_signature' }]))
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT',
      details: { payment_order_id: 'signed-1', status: 'awaiting_signature' },
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()

    db.setTable('payment_orders', paymentOrders([]))
    db.setTable('rpc:create_skattekonto_payment_order', { data: { ok: false, code: 'already_in_payment', details: {} } })
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })).toMatchObject({
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT',
    })
  })

  it('is closed without a payments provider, and in a sandbox company', async () => {
    resetPaymentInitiationProviders()
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'PAYMENTS_UNAVAILABLE',
      details: { reason: 'no_provider' },
    })

    registerPaymentInitiationProvider(provider)
    db.setTable('company_settings', { data: { is_sandbox: true } })
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'PAYMENTS_UNAVAILABLE',
      details: { reason: 'sandbox' },
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()
  })

  it('refuses an account that cannot pay through the bank', async () => {
    db.setTable('cash_accounts', { data: { ...ACCOUNT, currency: 'EUR' } })
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE',
      details: { reason: 'not_sek' },
    })
  })
})
