/**
 * A bank payment in to the skattekonto named from a filed declaration
 * (prepareSkattekontoPaymentOrder with a source): the momsdeklaration's ruta 49
 * or the AGI's skatt + avgifter, the banking day before its due date, the
 * company OCR from the skattekonto module, the synced saldo shown and never
 * netted, and the same doors closed as for any bank payment.
 */
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
import { generateSkattekontoOcr } from '@/lib/skatteverket/skattekonto-ocr'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
const vat = vi.hoisted(() => ({ computeVatDeclaration: vi.fn(), vatPeriodDeadline: vi.fn() }))
vi.mock('@/lib/reports/vat-declaration', () => ({ computeVatDeclaration: vat.computeVatDeclaration }))
vi.mock('@/lib/vat/filing-record-store', () => ({ vatPeriodDeadline: vat.vatPeriodDeadline }))

import { prepareSkattekontoPaymentOrder } from '../prepare-skattekonto'

const COMPANY = 'company-1'
// A Friday; Q3 2026 moms and the October AGI are due Thursday 2026-11-12.
const TODAY = '2026-10-16'
const DUE = '2026-11-12'
const ORG_NUMBER = '554466-8808'

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

/** payment_orders by what the chain asks: the open order of the day, or executed payments of the same declaration. */
function paymentOrders(open: Array<{ id: string; status: string }>, executed: Array<Record<string, unknown>> = []) {
  return (calls: Chain) => {
    const select = calls.find((c) => c.method === 'select')?.args[0]
    if (select === 'id, status, amount, batch_id') return { data: open }
    if (select === 'id, amount, executed_at') return { data: executed }
    return { data: [] }
  }
}

/** company_settings answers the sandbox check and the AGI's VAT size. */
function companySettings(calls: Chain) {
  const select = String(calls.find((c) => c.method === 'select')?.args[0] ?? '')
  if (select.includes('vat_taxable_base_over_40m')) return { data: { vat_registered: true, vat_taxable_base_over_40m: false } }
  return { data: { is_sandbox: false } }
}

const snapshot = (saldoSkatteverket: number) => ({
  data: { value: { saldo: { saldoSkatteverket }, fetchedAt: Date.parse('2026-10-15T06:00:00Z') } },
})

const CREATED = { id: 'order-1', purpose: 'skattekonto', status: 'draft', amount: 77404 }
const VAT_Q3 = { kind: 'vat_declaration', periodType: 'quarterly', year: 2026, period: 3 } as const

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  vi.clearAllMocks()
  resetPaymentInitiationProviders()
  registerPaymentInitiationProvider(provider)
  db = createTableMockSupabase({
    cash_accounts: { data: ACCOUNT },
    companies: { data: { org_number: ORG_NUMBER, entity_type: 'aktiebolag' } },
    company_settings: companySettings,
    // A charge the synced skattekonto knows of: a declaration source never reads it.
    skattekonto_transactions: { data: [{ transaktionsdatum: DUE, forfallodatum: DUE, belopp_skatteverket: -90000 }] },
    extension_data: snapshot(5000),
    agi_declarations: { data: { status: 'submitted', total_tax: 18000, total_avgifter: 12568, tax_paid_at: null } },
    deadlines: { data: [] },
    payment_orders: paymentOrders([]),
    payment_order_events: { data: null },
    'rpc:create_skattekonto_payment_order': { data: { ok: true, order: CREATED } },
  })
  mock.supabase = db.supabase
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never }
  vat.computeVatDeclaration.mockResolvedValue({
    declaration: { rutor: { ruta10: 96755.6, ruta48: 19351.3 }, period: { start: '2026-07-01', end: '2026-09-30' } },
  })
  vat.vatPeriodDeadline.mockResolvedValue({ tax_period: '2026-Q3', due_date: DUE, filed: true })
})

function rpcArgs(): Record<string, unknown> {
  const [args] = db.findCall('rpc:create_skattekonto_payment_order', 'rpc') as [Record<string, unknown>]
  return args
}

describe('prepareSkattekontoPaymentOrder from a momsdeklaration', () => {
  // No AGI due the same day here: moms and AGI together are prepare-skattekonto-due-date.test.ts.
  beforeEach(() => db.setTable('agi_declarations', { data: null }))

  it('pays ruta 49 as filed, the banking day before the deadline, with the OCR from the skattekonto module', async () => {
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, today: TODAY })

    // 96 755 - 19 351 = 77 404: whole kronor per ruta, the saldo of 5 000 not netted.
    expect(rpcArgs()).toMatchObject({
      p_amount: 77404,
      p_requested_execution_date: '2026-11-11',
      p_reference: generateSkattekontoOcr(ORG_NUMBER, 'aktiebolag'),
    })
    expect(result).toMatchObject({
      ok: true,
      data: {
        order: CREATED,
        warnings: [],
        source: { kind: 'vat_declaration', tax_period: '2026-Q3', declared: 77404, due_date: DUE, filed: true, payable: 77404 },
        balance: { saldo: 5000, fetched_at: '2026-10-15T06:00:00.000Z' },
      },
    })
    // The next charge on the synced skattekonto is not what a declaration pays.
    expect(db.findCall('skattekonto_transactions', 'select')).toBeUndefined()
  })

  it('answers the payment on a dry run with the declaration and the saldo, and writes nothing', async () => {
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, today: TODAY, dryRun: true })

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        amount: 77404,
        requested_execution_date: '2026-11-11',
        due: null,
        source: { kind: 'vat_declaration', declared: 77404, due_date: DUE },
        balance: { saldo: 5000 },
        payee: { type: 'bankgiro', label: 'BG 5050-1055', name: 'Skatteverket' },
      },
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()
    expect(db.calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))).toEqual([])
  })

  it('refuses a declaration that asks for nothing, says why, and pays an amount the person enters', async () => {
    vat.computeVatDeclaration.mockResolvedValue({
      declaration: { rutor: { ruta10: 1000, ruta48: 4000 }, period: { start: '2026-07-01', end: '2026-09-30' } },
    })
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, today: TODAY })).toEqual({
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE',
      details: { reason: 'refund', declared: -3000, tax_period: '2026-Q3' },
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, amount: 2500, today: TODAY })
    expect(result.ok).toBe(true)
    expect(rpcArgs()).toMatchObject({ p_amount: 2500, p_requested_execution_date: '2026-11-11' })
  })

  it('refuses an amount of zero or less, whatever the declaration says', async () => {
    for (const amount of [0, -77404]) {
      expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, amount, today: TODAY })).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'amount', reason: 'not_positive' },
      })
    }
    expect(vat.computeVatDeclaration).not.toHaveBeenCalled()
  })

  it('warns when the declaration is not on record as filed, and when a payment of the same amount was executed since the period', async () => {
    vat.vatPeriodDeadline.mockResolvedValue({ tax_period: '2026-Q3', due_date: DUE, filed: false })
    db.setTable('payment_orders', paymentOrders([], [
      { id: 'paid-other', amount: 1200, executed_at: '2026-10-05T09:00:00Z' },
      { id: 'paid-same', amount: '77404.00', executed_at: '2026-10-06T09:00:00Z' },
    ]))

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, today: TODAY })

    expect(result).toMatchObject({
      ok: true,
      data: {
        warnings: [
          { code: 'not_filed' },
          { code: 'possible_duplicate', payment_order_id: 'paid-same', executed_at: '2026-10-06T09:00:00Z' },
        ],
      },
    })
    expect(db.findCalls('payment_orders', 'gte')).toContainEqual(['created_at', '2026-09-30'])
  })

  it('is closed without a payment-capable bank connection, before the declaration is read', async () => {
    resetPaymentInitiationProviders()
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, today: TODAY })).toEqual({
      ok: false,
      code: 'PAYMENTS_UNAVAILABLE',
      details: { reason: 'no_provider' },
    })

    registerPaymentInitiationProvider(provider)
    db.setTable('cash_accounts', { data: { ...ACCOUNT, currency: 'EUR' } })
    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, today: TODAY })).toEqual({
      ok: false,
      code: 'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE',
      details: { reason: 'not_sek' },
    })
    expect(vat.computeVatDeclaration).not.toHaveBeenCalled()
  })
})

describe('prepareSkattekontoPaymentOrder from an AGI', () => {
  it('pays avdragen skatt + arbetsgivaravgifter the banking day before the 12th', async () => {
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: { kind: 'agi', year: 2026, month: 10 }, today: TODAY })

    expect(rpcArgs()).toMatchObject({ p_amount: 30568, p_requested_execution_date: '2026-11-11' })
    expect(result).toMatchObject({ ok: true, data: { source: { kind: 'agi', tax_period: '2026-10', declared: 30568, filed: true } } })
  })

  it('warns late for a month whose due date has passed, and answers 404 for a month without an AGI', async () => {
    // September's AGI was due Monday 2026-10-12: the earliest day the bank takes is Monday 2026-10-19.
    const late = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: { kind: 'agi', year: 2026, month: 9 }, today: TODAY })
    expect(late).toMatchObject({ ok: true, data: { warnings: [{ code: 'late', due: '2026-10-12' }] } })
    expect(rpcArgs().p_requested_execution_date).toBe('2026-10-19')

    db.setTable('agi_declarations', { data: null })
    expect(
      await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: { kind: 'agi', year: 2026, month: 11 }, today: TODAY }),
    ).toEqual({ ok: false, code: 'SKATTEKONTO_PAYMENT_AGI_NOT_FOUND', details: { tax_period: '2026-11' } })
  })

  it('refuses a month already marked paid unless the person enters an amount', async () => {
    db.setTable('agi_declarations', { data: { status: 'accepted', total_tax: 18000, total_avgifter: 12568, tax_paid_at: '2026-11-12T00:00:00Z' } })
    expect(
      await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: { kind: 'agi', year: 2026, month: 10 }, today: TODAY }),
    ).toMatchObject({ ok: false, code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE', details: { reason: 'already_paid' } })
  })
})
