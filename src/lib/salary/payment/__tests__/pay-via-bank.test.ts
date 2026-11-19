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

import { prepareSalaryBankPayment, salaryPaymentReference } from '../pay-via-bank'

const COMPANY = 'company-1'
const RUN = 'run-1'
// A Friday; payday is Monday 2026-10-26.
const TODAY = '2026-10-16'

const ACCOUNT = {
  id: 'acct-1',
  iban: 'SE3550000000054910000003',
  currency: 'SEK',
  name: 'Företagskonto',
  enabled: true,
  bank_connection: { bank_name: 'SEB', affiliated_aspsp_id: null, psu_type: 'business' },
}

const RUN_ROW = {
  id: RUN,
  status: 'approved',
  period_year: 2026,
  period_month: 10,
  payment_date: '2026-10-26',
  payment_file_generated_at: null,
}

const ANNA = {
  employee_id: 'emp-anna',
  net_salary: 28291,
  tax_withheld: 6709,
  tax_withheld_override: null,
  employee: { first_name: 'Anna', last_name: 'Andersson', clearing_number: '8327-9', bank_account_number: '123 456 789-0' },
}
const BERTIL = {
  employee_id: 'emp-bertil',
  net_salary: 27866,
  tax_withheld: 7134,
  tax_withheld_override: 7000,
  employee: { first_name: 'Bertil', last_name: 'Berg', clearing_number: '6000', bank_account_number: '123456789' },
}
const CECILIA = {
  employee_id: 'emp-cecilia',
  net_salary: 0,
  tax_withheld: 0,
  tax_withheld_override: null,
  employee: { first_name: 'Cecilia', last_name: 'Ceder', clearing_number: null, bank_account_number: null },
}

const provider = { id: 'open_payments', isAvailableFor: () => true } as unknown as PaymentInitiationProvider

type Chain = Array<{ method: string; args: unknown[] }>

/**
 * payment_orders answers by what the chain asks: the run's own orders
 * ('id, employee_id, status') or the accounts already paid by an executed
 * salary payment ('employee_id, payee_clearing, payee_account').
 */
function paymentOrders(runOrders: Array<{ id: string; employee_id: string; status: string }>, paid: Array<Record<string, string>> = []) {
  return (calls: Chain) => {
    const select = calls.find((c) => c.method === 'select')?.args[0]
    if (select === 'id, employee_id, status') return { data: runOrders }
    return { data: paid }
  }
}

const CREATED = [
  { id: 'order-anna', purpose: 'salary', status: 'draft', amount: 28291, employee_id: 'emp-anna' },
  { id: 'order-bertil', purpose: 'salary', status: 'draft', amount: 28000, employee_id: 'emp-bertil' },
]

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  resetPaymentInitiationProviders()
  registerPaymentInitiationProvider(provider)
  db = createTableMockSupabase({
    cash_accounts: { data: ACCOUNT },
    salary_runs: { data: RUN_ROW },
    salary_run_employees: { data: [ANNA, BERTIL, CECILIA] },
    payment_orders: paymentOrders([]),
    'rpc:create_salary_payment_orders': { data: { ok: true, orders: CREATED, replaced_draft_ids: [] } },
  })
  mock.supabase = db.supabase
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: 'user-1', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never }
})

function rpcArgs(): Record<string, unknown> {
  const [args] = db.findCall('rpc:create_salary_payment_orders', 'rpc') as [Record<string, unknown>]
  return args
}

describe('salaryPaymentReference', () => {
  it('names the run\'s month', () => {
    expect(salaryPaymentReference(2026, 3)).toBe('Lön 2026-03')
  })
})

describe('prepareSalaryBankPayment', () => {
  it('creates the drafts through the database function, the banking day before payday, with the month as message', async () => {
    const result = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })

    expect(result).toEqual({
      ok: true,
      data: { orders: CREATED, replaced_draft_ids: [], warnings: [], total: 56291 },
    })
    expect(rpcArgs()).toMatchObject({
      p_company_id: COMPANY,
      p_salary_run_id: RUN,
      p_cash_account_id: 'acct-1',
      p_debtor_snapshot: { iban: 'SE3550000000054910000003', bic: 'ESSESESS', bank_name: 'SEB', currency: 'SEK' },
      // Friday before Monday's payday.
      p_requested_execution_date: '2026-10-23',
      p_reference: 'Lön 2026-10',
      p_confirmed_unpaid: false,
      p_user_id: 'user-1',
    })
    expect(typeof rpcArgs().p_idempotency_key).toBe('string')
    // Amounts and accounts are the database's to read: the caller sends none.
    expect(rpcArgs()).not.toHaveProperty('p_orders')
    expect(rpcArgs()).not.toHaveProperty('p_amount')
  })

  it('previews every payout by name with the account masked, leaving out a zero payout, and writes nothing', async () => {
    db.setTable('payment_orders', paymentOrders([], [{ employee_id: 'emp-anna', payee_clearing: '83279', payee_account: '1234567890' }]))

    const result = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY, dryRun: true })

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        salary_run_id: RUN,
        period: '2026-10',
        payment_date: '2026-10-26',
        requested_execution_date: '2026-10-23',
        reference: 'Lön 2026-10',
        payees: [
          { employee_id: 'emp-anna', name: 'Anna Andersson', masked_account: '83279-****7890', amount: 28291, known_account: true },
          // The tax override moved 134 kr back to Bertil.
          { employee_id: 'emp-bertil', name: 'Bertil Berg', masked_account: '6000-****6789', amount: 28000, known_account: false },
        ],
        total: 56291,
        zero_payouts: 1,
        in_payment: 0,
        replaces_drafts: 0,
        confirmation_required: null,
        warnings: [],
      },
    })
    expect(db.findCall('rpc:create_salary_payment_orders', 'rpc')).toBeUndefined()
  })

  it('leaves out an employee whose payment is approved or further, and counts the drafts it replaces', async () => {
    db.setTable(
      'payment_orders',
      paymentOrders([
        { id: 'o-anna', employee_id: 'emp-anna', status: 'awaiting_signature' },
        { id: 'o-bertil', employee_id: 'emp-bertil', status: 'draft' },
      ]),
    )
    const result = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY, dryRun: true })
    expect(result).toMatchObject({ ok: true, preview: { payees: [{ employee_id: 'emp-bertil' }], in_payment: 1, replaces_drafts: 1, total: 28000 } })
  })

  it('refuses when everyone with a payout is already in payment', async () => {
    db.setTable(
      'payment_orders',
      paymentOrders([
        { id: 'o-anna', employee_id: 'emp-anna', status: 'executed' },
        { id: 'o-bertil', employee_id: 'emp-bertil', status: 'approved' },
      ]),
    )
    expect(await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY',
      details: { in_payment: 2 },
    })
    expect(db.findCall('rpc:create_salary_payment_orders', 'rpc')).toBeUndefined()
  })

  it('names every employee without an account, and every account the bank cannot pay to', async () => {
    db.setTable('salary_run_employees', {
      data: [{ ...ANNA, employee: { ...ANNA.employee, bank_account_number: null } }, BERTIL, CECILIA],
    })
    expect(await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING',
      details: { employees: [{ employee_id: 'emp-anna', name: 'Anna Andersson' }] },
    })

    db.setTable('salary_run_employees', {
      data: [ANNA, { ...BERTIL, employee: { ...BERTIL.employee, clearing_number: '12' } }, CECILIA],
    })
    const invalid = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })
    expect(invalid).toMatchObject({
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_INVALID',
      details: { employees: [{ employee_id: 'emp-bertil', name: 'Bertil Berg' }] },
    })
    if (invalid.ok) throw new Error('expected a refusal')
    expect(invalid.messageSv).toContain('Bertil Berg')
    expect(db.findCall('rpc:create_salary_payment_orders', 'rpc')).toBeUndefined()
  })

  it('refuses a run that is not approved, paid or booked', async () => {
    db.setTable('salary_runs', { data: { ...RUN_ROW, status: 'review' } })
    expect(await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })).toMatchObject({
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_NOT_READY',
      details: { current_status: 'review' },
    })
    db.setTable('salary_runs', { data: null })
    expect(await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'SALARY_RUN_NOT_FOUND',
    })
  })

  it('asks for the person\'s confirmation once a payment file was made, and shows the question in the preview', async () => {
    db.setTable('salary_runs', { data: { ...RUN_ROW, payment_file_generated_at: '2026-10-15T08:00:00Z' } })

    expect(await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })).toEqual({
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_CONFIRMATION_REQUIRED',
      details: { status: 'approved', payment_file_generated_at: '2026-10-15T08:00:00Z' },
    })
    expect(
      await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY, dryRun: true }),
    ).toMatchObject({ ok: true, preview: { confirmation_required: { status: 'approved', payment_file_generated_at: '2026-10-15T08:00:00Z' } } })

    const confirmed = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY, confirmedUnpaid: true })
    expect(confirmed.ok).toBe(true)
    expect(rpcArgs().p_confirmed_unpaid).toBe(true)
  })

  it('asks for the confirmation on a run already marked paid or booked', async () => {
    for (const status of ['paid', 'booked']) {
      db.setTable('salary_runs', { data: { ...RUN_ROW, status } })
      expect(await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })).toMatchObject({
        ok: false,
        code: 'SALARY_RUN_BANK_PAYMENT_CONFIRMATION_REQUIRED',
        details: { status },
      })
    }
  })

  it('pays on the earliest banking day when payday has passed, and says the money arrives after payday', async () => {
    const result = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: '2026-10-26', dryRun: true })
    expect(result).toMatchObject({
      ok: true,
      preview: { requested_execution_date: '2026-10-27', warnings: [{ code: 'after_payday', payday: '2026-10-26' }] },
    })
  })

  it('moves a day the bank does not pay on to the next banking day, and refuses a day in the past', async () => {
    const moved = await prepareSalaryBankPayment(ctx, {
      salaryRunId: RUN,
      cashAccountId: 'acct-1',
      executionDate: '2026-10-24',
      today: TODAY,
      dryRun: true,
    })
    expect(moved).toMatchObject({
      ok: true,
      preview: {
        requested_execution_date: '2026-10-26',
        date_moved_from: '2026-10-24',
        warnings: [{ code: 'date_moved', from: '2026-10-24', to: '2026-10-26' }, { code: 'after_payday', payday: '2026-10-26' }],
      },
    })

    expect(
      await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', executionDate: '2026-10-01', today: TODAY }),
    ).toEqual({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'execution_date', reason: 'in_the_past' } })
  })

  it('is unavailable without a payments provider, and in the sandbox', async () => {
    resetPaymentInitiationProviders()
    expect(await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })).toMatchObject({
      ok: false,
      code: 'PAYMENTS_UNAVAILABLE',
    })

    registerPaymentInitiationProvider(provider)
    db.setTable('company_settings', { data: { is_sandbox: true } })
    expect(await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })).toMatchObject({
      ok: false,
      code: 'PAYMENTS_UNAVAILABLE',
      details: { reason: 'sandbox' },
    })
  })

  it('translates the database function\'s refusals', async () => {
    db.setTable('rpc:create_salary_payment_orders', { data: { ok: false, code: 'already_in_payment', details: {} } })
    expect(await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })).toMatchObject({
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_ALREADY_IN_PAYMENT',
      details: { rpc_code: 'already_in_payment' },
    })
  })
})

describe('prepareSalaryBankPayment on a correction run', () => {
  const ORIGINAL = 'run-0'
  const FIRST_CORRECTION = 'run-c1'

  /** Rosters per run: the correction's own (eq salary_run_id) and the chain's (in salary_run_id). */
  function rosters(byRun: Record<string, Array<Record<string, unknown>>>) {
    return (calls: Chain) => {
      const own = calls.find((c) => c.method === 'eq' && c.args[0] === 'salary_run_id')?.args[1] as string | undefined
      if (own) return { data: byRun[own] ?? [] }
      const chain = (calls.find((c) => c.method === 'in' && c.args[0] === 'salary_run_id')?.args[1] ?? []) as string[]
      return { data: chain.flatMap((id) => (byRun[id] ?? []).map((row, i) => ({ id: `${id}-${i}`, ...row }))) }
    }
  }

  /** salary_runs answers by id: the correction itself and every run of its chain. */
  function runs(byId: Record<string, Record<string, unknown>>) {
    return (calls: Chain) => {
      const id = calls.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1] as string
      return { data: byId[id] ?? null }
    }
  }

  beforeEach(() => {
    db.setTable(
      'salary_runs',
      runs({
        [RUN]: { ...RUN_ROW, corrects_run_id: ORIGINAL },
        [ORIGINAL]: { id: ORIGINAL, corrects_run_id: null },
      }),
    )
  })

  it('pays each employee only the difference against the corrected run, a new employee in full, and names no one when nobody was overpaid', async () => {
    const DAVID = {
      employee_id: 'emp-david',
      net_salary: 15000,
      tax_withheld: 3000,
      tax_withheld_override: null,
      employee: { first_name: 'David', last_name: 'Dahl', clearing_number: '6000', bank_account_number: '987654321' },
    }
    db.setTable(
      'salary_run_employees',
      rosters({
        // The original paid Anna 28 291 and Bertil 28 000 (his override).
        [ORIGINAL]: [ANNA, BERTIL, CECILIA],
        // The correction raises Anna by 1 200, leaves Bertil as he was and adds David.
        [RUN]: [{ ...ANNA, net_salary: 29491 }, BERTIL, CECILIA, DAVID],
      }),
    )

    const preview = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY, dryRun: true })
    expect(preview).toMatchObject({
      ok: true,
      preview: {
        payees: [
          { employee_id: 'emp-anna', amount: 1200 },
          { employee_id: 'emp-david', amount: 15000 },
        ],
        total: 16200,
        // Bertil (no difference) and Cecilia (0 kr).
        zero_payouts: 2,
        // A fresh correction is approved and has no file: nothing to confirm.
        confirmation_required: null,
        correction: { corrects_run_id: ORIGINAL, overpaid: [] },
      },
    })

    // The live call leaves the amounts to the database function, which reads the same rule.
    const live = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })
    expect(live.ok).toBe(true)
    expect(rpcArgs()).not.toHaveProperty('p_amount')
  })

  it('leaves out an overpaid employee and one removed from the correction, and names both with the amount', async () => {
    db.setTable(
      'salary_run_employees',
      rosters({
        [ORIGINAL]: [ANNA, BERTIL, CECILIA],
        // Anna's net drops by 500,25; Bertil is no longer on the run; Cecilia now gets 1 000.
        [RUN]: [{ ...ANNA, net_salary: 27790.75 }, { ...CECILIA, net_salary: 1000, employee: { ...CECILIA.employee, clearing_number: '6000', bank_account_number: '111222333' } }],
      }),
    )
    const preview = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY, dryRun: true })
    expect(preview).toMatchObject({
      ok: true,
      preview: {
        payees: [{ employee_id: 'emp-cecilia', amount: 1000 }],
        total: 1000,
        zero_payouts: 0,
        correction: {
          corrects_run_id: ORIGINAL,
          overpaid: [
            { employee_id: 'emp-anna', name: 'Anna Andersson', amount: 500.25 },
            { employee_id: 'emp-bertil', name: 'Bertil Berg', amount: 28000 },
          ],
        },
      },
    })
  })

  it('over a chain of two corrections pays only what neither earlier run paid', async () => {
    db.setTable(
      'salary_runs',
      runs({
        [RUN]: { ...RUN_ROW, corrects_run_id: FIRST_CORRECTION },
        [FIRST_CORRECTION]: { id: FIRST_CORRECTION, corrects_run_id: ORIGINAL },
        [ORIGINAL]: { id: ORIGINAL, corrects_run_id: null },
      }),
    )
    db.setTable(
      'salary_run_employees',
      rosters({
        [ORIGINAL]: [ANNA, BERTIL],
        // The first correction raised Anna to 29 000 (paid 709) and lowered Bertil to 27 000 (nothing paid back).
        [FIRST_CORRECTION]: [{ ...ANNA, net_salary: 29000 }, { ...BERTIL, net_salary: 26866 }],
        // The second raises Anna to 29 500 and Bertil back to 28 100.
        [RUN]: [{ ...ANNA, net_salary: 29500 }, { ...BERTIL, net_salary: 27966 }],
      }),
    )
    const preview = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY, dryRun: true })
    expect(preview).toMatchObject({
      ok: true,
      preview: {
        payees: [
          { employee_id: 'emp-anna', amount: 500 },
          // Bertil still holds the original 28 000: only 100 is new.
          { employee_id: 'emp-bertil', amount: 100 },
        ],
        total: 600,
        correction: { corrects_run_id: FIRST_CORRECTION, overpaid: [] },
      },
    })
    expect(db.findCall('salary_run_employees', 'in')).toEqual(['salary_run_id', [FIRST_CORRECTION, ORIGINAL]])
  })

  it('says there is nothing to pay when the correction raises nobody, naming the overpaid', async () => {
    db.setTable(
      'salary_run_employees',
      rosters({ [ORIGINAL]: [ANNA, BERTIL], [RUN]: [{ ...ANNA, net_salary: 28000 }, BERTIL] }),
    )
    const result = await prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY })
    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY',
      details: {
        in_payment: 0,
        correction: { corrects_run_id: ORIGINAL, overpaid: [{ employee_id: 'emp-anna', name: 'Anna Andersson', amount: 291 }] },
      },
      messageSv: 'Rättelsen ger ingen skillnad att betala ut jämfört med den tidigare körningen.',
    })
    expect(db.findCall('rpc:create_salary_payment_orders', 'rpc')).toBeUndefined()
  })

  it('refuses rather than pays the full net when the corrected run cannot be read', async () => {
    db.setTable('salary_runs', runs({ [RUN]: { ...RUN_ROW, corrects_run_id: ORIGINAL } }))
    await expect(
      prepareSalaryBankPayment(ctx, { salaryRunId: RUN, cashAccountId: 'acct-1', today: TODAY, dryRun: true }),
    ).rejects.toThrow(/corrected run run-0 not found/)
    expect(db.findCall('rpc:create_salary_payment_orders', 'rpc')).toBeUndefined()
  })
})
