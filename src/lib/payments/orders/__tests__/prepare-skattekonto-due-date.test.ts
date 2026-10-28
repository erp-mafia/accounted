/**
 * A bank payment in to the skattekonto of everything declared due on one day
 * (prepareSkattekontoPaymentOrder with source due_date), and the warning a
 * declaration paid on its own gives when another one is due the same day:
 * the database holds one open skattekonto payment per company, so moms and
 * AGI due on the 12th are paid together (crm#1260).
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

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
const vat = vi.hoisted(() => ({ computeVatDeclaration: vi.fn(), vatPeriodDeadline: vi.fn() }))
vi.mock('@/lib/reports/vat-declaration', () => ({ computeVatDeclaration: vat.computeVatDeclaration }))
vi.mock('@/lib/vat/filing-record-store', () => ({ vatPeriodDeadline: vat.vatPeriodDeadline }))

import { prepareSkattekontoPaymentOrder } from '../prepare-skattekonto'

const COMPANY = 'company-1'
// A Friday; Q3 2026 moms and the October AGI are both due Thursday 2026-11-12.
const TODAY = '2026-10-16'
const DUE = '2026-11-12'
const DAY = { kind: 'due_date', dueDate: DUE } as const
const VAT_Q3 = { kind: 'vat_declaration', periodType: 'quarterly', year: 2026, period: 3 } as const
const AGI_OCT = { kind: 'agi', year: 2026, month: 10 } as const

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
type Executed = { id: string; amount: number; executed_at: string; created_at: string }

/** payment_orders by what the chain asks: the open order of the day, or executed payments since a day. */
function paymentOrders(open: Array<{ id: string; status: string; amount?: number }>, executed: Executed[] = []) {
  return (calls: Chain) => {
    if (calls.some((c) => c.method === 'update')) throw new Error('no payment order is updated by the service')
    const select = calls.find((c) => c.method === 'select')?.args[0]
    if (select === 'id, status, amount, batch_id') return { data: open }
    if (select === 'id, amount, executed_at') {
      const since = String(calls.find((c) => c.method === 'gte')?.args[1] ?? '')
      return { data: executed.filter((row) => row.created_at >= since) }
    }
    return { data: [] }
  }
}

/** company_settings answers the sandbox check, the moms cadence and the AGI's VAT size. */
function companySettings(calls: Chain) {
  const select = String(calls.find((c) => c.method === 'select')?.args[0] ?? '')
  if (select.includes('moms_period')) return { data: { vat_registered: true, moms_period: 'quarterly' } }
  if (select.includes('vat_taxable_base_over_40m')) return { data: { vat_registered: true, vat_taxable_base_over_40m: false } }
  return { data: { is_sandbox: false } }
}

const AGI_ROW = { status: 'submitted', total_tax: 18000, total_avgifter: 12568, tax_paid_at: null }

/** agi_declarations by the month asked for. */
const agiByMonth = (rows: Record<number, Record<string, unknown>>) => (calls: Chain) => {
  const month = calls.find((c) => c.method === 'eq' && c.args[0] === 'period_month')?.args[1] as number
  return { data: rows[month] ?? null }
}

/** The quarter's moms: 96 755 - 19 351 = 77 404 as filed, or a refund. */
const Q3_TO_PAY = { declaration: { rutor: { ruta10: 96755.6, ruta48: 19351.3 }, period: { start: '2026-07-01', end: '2026-09-30' } } }
const Q3_REFUND = { declaration: { rutor: { ruta10: 1000, ruta48: 4000 }, period: { start: '2026-07-01', end: '2026-09-30' } } }

const CREATED = { id: 'order-1', purpose: 'skattekonto', status: 'draft', amount: 107972 }

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  vi.clearAllMocks()
  resetPaymentInitiationProviders()
  registerPaymentInitiationProvider(provider)
  db = createTableMockSupabase({
    cash_accounts: { data: ACCOUNT },
    companies: { data: { org_number: '554466-8808', entity_type: 'aktiebolag' } },
    company_settings: companySettings,
    extension_data: { data: { value: { saldo: { saldoSkatteverket: 5000 }, fetchedAt: Date.parse('2026-10-15T06:00:00Z') } } },
    agi_declarations: agiByMonth({ 10: AGI_ROW, 9: AGI_ROW }),
    deadlines: { data: [] },
    payment_orders: paymentOrders([]),
    payment_order_events: { data: null },
    'rpc:create_skattekonto_payment_order': { data: { ok: true, order: CREATED } },
  })
  mock.supabase = db.supabase
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never }
  vat.computeVatDeclaration.mockResolvedValue(Q3_TO_PAY)
  // Only the third quarter's deadline is the 12 November.
  vat.vatPeriodDeadline.mockImplementation((_s: unknown, _c: string, input: { periodType: string; year: number; period: number }) =>
    Promise.resolve({
      tax_period: `${input.year}-Q${input.period}`,
      due_date: input.periodType === 'quarterly' && input.year === 2026 && input.period === 3 ? DUE : '2026-08-17',
      filed: true,
    }),
  )
})

/** The RPC arguments of the last created order, without the per-call idempotency key. */
function lastRpcArgs(): Record<string, unknown> {
  const calls = db.findCalls('rpc:create_skattekonto_payment_order', 'rpc')
  const [args] = calls[calls.length - 1] as [Record<string, unknown>]
  const { p_idempotency_key: _key, ...rest } = args
  return rest
}

describe('prepareSkattekontoPaymentOrder with source due_date', () => {
  it('pays the quarter\'s moms and the October AGI as one payment, the banking day before the 12th, and lists the parts', async () => {
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: DAY, today: TODAY })

    // 77 404 + 30 568; the saldo of 5 000 is shown, never netted.
    expect(lastRpcArgs()).toMatchObject({ p_amount: 107972, p_requested_execution_date: '2026-11-11' })
    expect(result).toMatchObject({
      ok: true,
      data: {
        warnings: [],
        source: null,
        combined: {
          due_date: DUE,
          total: 107972,
          components: [
            { source: 'vat_declaration', period: '2026-Q3', amount: 77404 },
            { source: 'agi', period: '2026-10', amount: 30568 },
          ],
          excluded: [],
        },
        balance: { saldo: 5000 },
      },
    })
  })

  it('answers the same on a dry run and writes nothing', async () => {
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: DAY, today: TODAY, dryRun: true })

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { amount: 107972, requested_execution_date: '2026-11-11', due: null, combined: { total: 107972 } },
    })
    expect(db.findCall('rpc:create_skattekonto_payment_order', 'rpc')).toBeUndefined()
    expect(db.calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))).toEqual([])
  })

  it('with one declaration due that day pays exactly what that declaration named on its own pays', async () => {
    db.setTable('agi_declarations', { data: null })

    const single = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, today: TODAY })
    const singleArgs = lastRpcArgs()
    const day = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: DAY, today: TODAY })

    expect(lastRpcArgs()).toEqual(singleArgs)
    if (!single.ok || single.dryRun || !day.ok || day.dryRun) throw new Error('expected two payments')
    const { combined, ...rest } = day.data
    expect(rest).toEqual(single.data)
    expect(combined).toEqual({ due_date: DUE, total: 77404, components: [{ source: 'vat_declaration', period: '2026-Q3', amount: 77404 }], excluded: [] })

    // And refuses the same way when that one declaration asks for nothing.
    vat.computeVatDeclaration.mockResolvedValue(Q3_REFUND)
    const refusedSingle = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, today: TODAY })
    const refusedDay = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: DAY, today: TODAY })
    expect(refusedDay).toEqual(refusedSingle)
    expect(refusedDay).toMatchObject({ ok: false, code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE', details: { reason: 'refund' } })
  })

  it('leaves a refund in ruta 49 out and reports it: the AGI is paid in full, never netted', async () => {
    vat.computeVatDeclaration.mockResolvedValue(Q3_REFUND)

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: DAY, today: TODAY })

    expect(lastRpcArgs()).toMatchObject({ p_amount: 30568 })
    expect(result).toMatchObject({
      ok: true,
      data: {
        source: { kind: 'agi', tax_period: '2026-10', payable: 30568 },
        combined: {
          total: 30568,
          components: [{ source: 'agi', period: '2026-10', amount: 30568 }],
          excluded: [{ source: 'vat_declaration', period: '2026-Q3', declared: -3000, reason: 'refund' }],
        },
      },
    })
  })

  it('names the declaration in a not_filed or possible_duplicate warning when the payment pays several', async () => {
    db.setTable('agi_declarations', agiByMonth({ 10: { ...AGI_ROW, status: 'generated' } }))
    db.setTable('payment_orders', paymentOrders([], [{ id: 'paid-agi', amount: 30568, executed_at: '2026-10-25T09:00:00Z', created_at: '2026-10-24' }]))

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: DAY, today: TODAY })

    expect(result).toMatchObject({
      ok: true,
      data: {
        warnings: [
          { code: 'not_filed', source: 'agi', period: '2026-10' },
          { code: 'possible_duplicate', payment_order_id: 'paid-agi', source: 'agi', period: '2026-10' },
        ],
      },
    })
  })

  it('refuses a day with nothing declared unless the person enters an amount, paid the banking day before it', async () => {
    db.setTable('company_settings', (calls: Chain) =>
      String(calls.find((c) => c.method === 'select')?.args[0]).includes('moms_period')
        ? { data: { vat_registered: false, moms_period: null } }
        : { data: { is_sandbox: false } },
    )
    db.setTable('agi_declarations', { data: null })

    expect(await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: DAY, today: TODAY })).toEqual({
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_NOTHING_DUE',
      details: { reason: 'no_declaration', due_date: DUE, excluded: [] },
    })

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: DAY, amount: 2500, today: TODAY })
    expect(result.ok).toBe(true)
    expect(lastRpcArgs()).toMatchObject({ p_amount: 2500, p_requested_execution_date: '2026-11-11' })
  })
})

describe('a declaration paid on its own with another due the same day', () => {
  it('warns same_due_date_parts naming the AGI, the sum of both and the combined source', async () => {
    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: VAT_Q3, today: TODAY })

    // Still the moms alone: the warning informs, it changes nothing paid.
    expect(lastRpcArgs()).toMatchObject({ p_amount: 77404 })
    expect(result).toMatchObject({
      ok: true,
      data: {
        warnings: [
          {
            code: 'same_due_date_parts',
            due: DUE,
            parts: [{ source: 'agi', period: '2026-10', amount: 30568 }],
            total: 107972,
            replaces_draft: false,
            suggested_source: { source: 'due_date', due_date: DUE },
          },
        ],
      },
    })
    // The moms the caller resolved is not computed a second time.
    expect(vat.computeVatDeclaration).toHaveBeenCalledTimes(1)
  })

  it('adds to an unapproved draft of the same day instead of replacing it (crm#1485)', async () => {
    db.setTable('payment_orders', paymentOrders([{ id: 'draft-moms', status: 'draft', amount: 77404 }]))

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: AGI_OCT, today: TODAY, dryRun: true })

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        replaces_drafts: 0,
        merges_into: { payment_order_id: 'draft-moms', status: 'draft', amount: 77404, total: 107972 },
        warnings: [
          {
            code: 'same_due_date_parts',
            parts: [{ source: 'vat_declaration', period: '2026-Q3', amount: 77404 }],
            total: 107972,
            replaces_draft: false,
          },
        ],
      },
    })
  })

  it('does not warn when the other declaration due that day asks for nothing, or none is due', async () => {
    vat.computeVatDeclaration.mockResolvedValue(Q3_REFUND)
    let result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: AGI_OCT, today: TODAY })
    expect(result).toMatchObject({ ok: true, data: { warnings: [] } })

    vat.computeVatDeclaration.mockResolvedValue(Q3_TO_PAY)
    // September's AGI is due 2026-10-12: nothing else is due that day.
    db.setTable('agi_declarations', agiByMonth({ 9: AGI_ROW }))
    result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: { kind: 'agi', year: 2026, month: 9 }, today: TODAY })
    expect(result).toMatchObject({ ok: true, data: { warnings: [{ code: 'late', due: '2026-10-12' }] } })
  })

  it('leaves the warning out, never the payment, when the other declarations cannot be read', async () => {
    vat.computeVatDeclaration.mockRejectedValue(new Error('no fiscal period'))

    const result = await prepareSkattekontoPaymentOrder(ctx, { cashAccountId: 'acct-1', source: AGI_OCT, today: TODAY })

    expect(result).toMatchObject({ ok: true, data: { warnings: [], source: { kind: 'agi', payable: 30568 } } })
    expect(lastRpcArgs()).toMatchObject({ p_amount: 30568 })
  })
})
