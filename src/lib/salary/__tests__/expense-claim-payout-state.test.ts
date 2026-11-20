/**
 * Which expense claims wait for a payout of their own (crm#1942):
 * lib/salary/expense-claim-payout-state.ts. A claim on a payslip line stays
 * 'registered' until the salary run is booked, and must not read as owed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  listExpenseClaimsAwaitingPayout,
  readPayslipLinesForClaims,
  withExpenseClaimPayoutState,
} from '../expense-claim-payout-state'

const COMPANY = 'company-1'
const RUN = 'run-1'

const { supabase, enqueue, enqueueMany, reset, findCall, findCalls } = createQueuedMockSupabase()
const sb = supabase as never

beforeEach(() => {
  reset()
})

/** A payslip line that repays `claimId`, as PostgREST embeds its run. */
function payslipLine(claimId: string, run: Record<string, unknown> = {}) {
  return {
    id: `line-${claimId}`,
    source_expense_claim_id: claimId,
    salary_run_employee: {
      salary_run: {
        id: RUN,
        status: 'draft',
        period_year: 2026,
        period_month: 6,
        payment_date: '2026-06-25',
        ...run,
      },
    },
  }
}

const claim = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  employee_id: 'emp-1',
  claimant_name: 'Anna Berg',
  description: 'Kabel',
  expense_date: '2026-06-01',
  amount_sek: 100,
  liability_account: '2820',
  ...overrides,
})

describe('readPayslipLinesForClaims', () => {
  it('answers the salary run of each claim on a payslip and nothing for the others', async () => {
    enqueue({ data: [payslipLine('c-a')] })

    const lines = await readPayslipLinesForClaims(sb, COMPANY, ['c-a', 'c-b'])

    expect([...lines.keys()]).toEqual(['c-a'])
    expect(lines.get('c-a')).toEqual({
      line_id: 'line-c-a',
      salary_run: { salary_run_id: RUN, status: 'draft', period_year: 2026, period_month: 6, payment_date: '2026-06-25' },
    })
    expect(findCall('salary_line_items', 'eq')).toEqual(['company_id', COMPANY])
    expect(findCall('salary_line_items', 'in')).toEqual(['source_expense_claim_id', ['c-a', 'c-b']])
  })

  it('reads an embed that arrives as a one-row array', async () => {
    const line = payslipLine('c-a')
    enqueue({
      data: [{ ...line, salary_run_employee: [{ salary_run: [line.salary_run_employee.salary_run] }] }],
    })
    const lines = await readPayslipLinesForClaims(sb, COMPANY, ['c-a'])
    expect(lines.get('c-a')?.salary_run?.salary_run_id).toBe(RUN)
  })

  it('counts a line as scheduled even when its run row could not be read', async () => {
    enqueue({ data: [{ id: 'line-1', source_expense_claim_id: 'c-a', salary_run_employee: null }] })
    const lines = await readPayslipLinesForClaims(sb, COMPANY, ['c-a'])
    expect(lines.get('c-a')).toEqual({ line_id: 'line-1', salary_run: null })
  })

  it('asks once per 100 distinct ids, so a long list never overruns the URL', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c-${i}`)
    await readPayslipLinesForClaims(sb, COMPANY, [...ids, 'c-0', 'c-1'])
    expect(findCalls('salary_line_items', 'in').map((args) => (args[1] as string[]).length)).toEqual([100, 100, 50])
  })

  it('reads nothing for no ids', async () => {
    expect((await readPayslipLinesForClaims(sb, COMPANY, [])).size).toBe(0)
    expect(findCalls('salary_line_items', 'select')).toEqual([])
  })

  it('throws when the read fails: a missing answer must never read as "on no payslip"', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(readPayslipLinesForClaims(sb, COMPANY, ['c-a'])).rejects.toThrow('boom')
  })
})

describe('withExpenseClaimPayoutState', () => {
  it('a registered claim on no payslip waits for a payout; one on a draft run does not and names the run', async () => {
    enqueue({ data: [payslipLine('c-run')] })

    const claims = await withExpenseClaimPayoutState(sb, COMPANY, [
      { id: 'c-open', status: 'registered' },
      { id: 'c-run', status: 'registered' },
      { id: 'c-paid', status: 'paid' },
    ])

    expect(claims).toEqual([
      { id: 'c-open', status: 'registered', awaits_payout: true, salary_run: null },
      {
        id: 'c-run',
        status: 'registered',
        awaits_payout: false,
        salary_run: { salary_run_id: RUN, status: 'draft', period_year: 2026, period_month: 6, payment_date: '2026-06-25' },
      },
      { id: 'c-paid', status: 'paid', awaits_payout: false, salary_run: null },
    ])
    // Only registered claims are looked up: a paid one waits for nothing.
    expect(findCall('salary_line_items', 'in')).toEqual(['source_expense_claim_id', ['c-open', 'c-run']])
  })

  it.each(['review', 'approved', 'paid', 'booked'])(
    'a registered claim on a %s run is still not offered for a payout',
    async (status) => {
      enqueue({ data: [payslipLine('c-run', { status })] })
      const [state] = await withExpenseClaimPayoutState(sb, COMPANY, [{ id: 'c-run', status: 'registered' }])
      expect(state.awaits_payout).toBe(false)
      expect(state.salary_run?.status).toBe(status)
    },
  )

  it('reads no payslip lines when no claim is registered', async () => {
    const claims = await withExpenseClaimPayoutState(sb, COMPANY, [{ id: 'c-paid', status: 'paid' }])
    expect(claims).toEqual([{ id: 'c-paid', status: 'paid', awaits_payout: false, salary_run: null }])
    expect(findCalls('salary_line_items', 'select')).toEqual([])
  })
})

describe('listExpenseClaimsAwaitingPayout', () => {
  it('lists the registered claims of the company, less the ones on a payslip', async () => {
    enqueueMany([
      { data: [claim('c-a'), claim('c-b', { expense_date: '2026-06-03' }), claim('c-owner', { employee_id: null, liability_account: '2893' })] },
      { data: [payslipLine('c-a')] }, // c-a sits on a draft salary run
    ])

    const open = await listExpenseClaimsAwaitingPayout(sb, COMPANY)

    expect(open.map((c) => c.id)).toEqual(['c-b', 'c-owner'])
    expect(findCalls('expense_claims', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['status', 'registered'],
    ])
    expect(findCalls('expense_claims', 'order').map((args) => args[0])).toEqual(['expense_date', 'id'])
  })

  it('narrows to one employee when asked', async () => {
    enqueueMany([{ data: [claim('c-a')] }, { data: [] }])
    await listExpenseClaimsAwaitingPayout(sb, COMPANY, { employeeId: 'emp-1' })
    expect(findCalls('expense_claims', 'eq')).toContainEqual(['employee_id', 'emp-1'])
  })

  it('reads no payslip lines when nothing is registered', async () => {
    enqueue({ data: [] })
    expect(await listExpenseClaimsAwaitingPayout(sb, COMPANY)).toEqual([])
    expect(findCalls('salary_line_items', 'select')).toEqual([])
  })

  it('throws when the claims cannot be read', async () => {
    enqueue({ error: { message: 'boom' } })
    await expect(listExpenseClaimsAwaitingPayout(sb, COMPANY)).rejects.toThrow('boom')
  })
})
