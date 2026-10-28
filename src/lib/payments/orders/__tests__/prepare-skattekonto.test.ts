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
const OCR = '1655446688087'

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
type OrderRow = {
  id: string
  status: string
  amount?: number
  executed_at?: string | null
  requested_execution_date?: string
  batch_id?: string | null
}

/**
 * payment_orders answers by what the chain asks: the open order of the
 * execution day ('id, status, amount, batch_id', filtered by the day asked
 * for; a row without a day is on every day), or the worklist's payments
 * underway (amount, status, executed_at).
 */
function paymentOrders(open: OrderRow[], underway: OrderRow[] = []) {
  return (calls: Chain) => {
    if (calls.some((c) => c.method === 'update')) throw new Error('no payment order is updated by the service')
    const select = calls.find((c) => c.method === 'select')?.args[0]
    if (select === 'id, status, amount, batch_id') {
      const day = calls.find((c) => c.method === 'eq' && c.args[0] === 'requested_execution_date')?.args[1]
      return { data: open.filter((o) => !o.requested_execution_date || o.requested_execution_date === day) }
    }
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
    companies: { data: { org_number: '554466-8808', entity_type: 'aktiebolag' } },
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

    expect(result).toEqual({ ok: true, data: { order: CREATED, warnings: [], replaced_draft_ids: [], source: null, balance: null } })
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

  it('stays the next charge by default: no declaration is read and no combined parts are answered (crm#1260)', async () => {
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY, dryRun: true })

    expect(result).toMatchObject({ ok: true, dryRun: true, preview: { amount: 11000, source: null } })
    if (!result.ok || !result.dryRun) throw new Error('expected a preview')
    expect(result.preview).not.toHaveProperty('combined')
    expect(db.tables()).not.toContain('agi_declarations')
    expect(db.tables()).not.toContain('deadlines')
    expect(db.findCalls('company_settings', 'select').map(([columns]) => columns)).not.toContain('vat_registered, moms_period')
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

    db.setTable('extension_data', snapshot(4000, '1655446688087'))
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })
    expect(result.ok).toBe(true)
    expect(rpcArgs().p_reference).toBe('1655446688087')
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
    db.setTable('payment_orders', paymentOrders([{ id: 'old-draft', status: 'draft', amount: 3433 }]))

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
        replaces_drafts: 0,
        merges_into: { payment_order_id: 'old-draft', status: 'draft', amount: 3433, total: 14433 },
        source: null,
        balance: null,
      },
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()
    expect(db.findCalls('payment_orders', 'update')).toEqual([])
    expect(db.findCalls('payment_order_events', 'insert')).toEqual([])
  })

  it('adds to the same day\'s order nobody signed yet instead of replacing it, and answers what it was added to (crm#1485)', async () => {
    db.setTable('payment_orders', paymentOrders([{ id: 'agi-order', status: 'approved', amount: 30232, requested_execution_date: '2026-11-11' }]))
    db.setTable('rpc:create_skattekonto_payment_order', {
      data: {
        ok: true,
        order: { id: 'agi-order', purpose: 'skattekonto', status: 'draft', amount: 33665 },
        merged: { previous_amount: '30232.00', added_amount: '3433.00' },
      },
    })

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', amount: 3433, today: TODAY })

    expect(result).toMatchObject({
      ok: true,
      data: {
        order: { id: 'agi-order', status: 'draft', amount: 33665 },
        replaced_draft_ids: [],
        merged_into: { payment_order_id: 'agi-order', status: 'draft', amount: 30232, total: 33665 },
      },
    })
    expect(rpcArgs()).toMatchObject({ p_amount: 3433, p_requested_execution_date: '2026-11-11' })
    // Nothing is cancelled any more: the database adds to the day's order.
    expect(db.findCalls('payment_orders', 'update')).toEqual([])
  })

  it('lets another day have its own payment while one is signed (crm#1485)', async () => {
    db.setTable('payment_orders', paymentOrders([{ id: 'signed-1', status: 'accepted', amount: 30232, requested_execution_date: '2026-11-11' }]))

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', amount: 3433, executionDate: '2026-11-10', today: TODAY })

    expect(result).toMatchObject({ ok: true, data: { order: CREATED } })
    expect(rpcArgs()).toMatchObject({ p_amount: 3433, p_requested_execution_date: '2026-11-10' })
  })

  it('refuses while the same day\'s payment is signed or at the bank, and maps the database refusal the same way', async () => {
    db.setTable('payment_orders', paymentOrders([{ id: 'signed-1', status: 'awaiting_signature', amount: 30232 }]))
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT',
      details: { payment_order_id: 'signed-1', status: 'awaiting_signature', requested_execution_date: '2026-11-11' },
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()

    // Approved but already claimed for signing is in payment too.
    db.setTable('payment_orders', paymentOrders([{ id: 'claimed-1', status: 'approved', amount: 30232, batch_id: 'batch-1' }]))
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', today: TODAY })).toMatchObject({
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT',
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
