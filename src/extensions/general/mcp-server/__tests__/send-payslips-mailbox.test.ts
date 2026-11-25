/**
 * gnubok_send_payslips with channel kivra (operation salary-runs.send-payslips):
 * staged like the email send, named for the mailbox, with the channel carried
 * to the approval. The staging dry run applies the run page's mailbox gates,
 * so a company without Kivra sending switched on is refused before anything
 * is staged. The dry run never reads a personnummer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  payslipMailboxBlock: vi.fn(),
}))

vi.mock('@/lib/sandbox/guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sandbox/guard')>()),
  isSandboxCompany: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/company/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/context')>()),
  getCompanyDisplayName: vi.fn().mockResolvedValue('Test AB'),
}))
vi.mock('@/lib/salary/payslips/send-digital-mailbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payslips/send-digital-mailbox')>()),
  payslipMailboxBlock: mocks.payslipMailboxBlock,
}))

import { tools } from '../server'

const sendPayslips = tools.find((t) => t.name === 'gnubok_send_payslips')!

const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EMP_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function setup() {
  return createTableMockSupabase({
    salary_runs: { data: { id: RUN_ID, status: 'approved', period_year: 2026, period_month: 11, payment_date: '2026-11-25' } },
    companies: { data: { name: 'Test AB', org_number: '5560000000' } },
    salary_run_employees: { data: [{ employee_id: EMP_ID, employee: { first_name: 'Anna', last_name: 'Andersson', email: null } }] },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    pending_operations: { data: { id: 'op-1' } },
  })
}

const call = (args: Record<string, unknown>, supabase: unknown) =>
  sendPayslips.execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.payslipMailboxBlock.mockResolvedValue(null)
})

describe('gnubok_send_payslips: channel kivra', () => {
  it('stages the send named for Kivra with the channel in its params', async () => {
    const { supabase, findCall, calls } = setup()
    const result = (await call({ salary_run_id: RUN_ID, channel: 'kivra' }, supabase)) as {
      staged: boolean
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(true)
    const staged = findCall('pending_operations', 'insert')![0] as { operation_type: string; title: string; params: Record<string, unknown> }
    expect(staged.operation_type).toBe('send_payslips')
    expect(staged.title).toBe('Skicka lönebesked till Kivra')
    expect(staged.params).toMatchObject({ salary_run_id: RUN_ID, channel: 'kivra' })
    expect(result.preview).toMatchObject({ channel: 'kivra' })
    expect(mocks.payslipMailboxBlock).toHaveBeenCalledWith(supabase, 'company-1', 'kivra')
    // The staging dry run never reads a personnummer.
    const selects = calls.filter((c) => c.table === 'salary_run_employees' && c.method === 'select').map((c) => String(c.args[0]))
    expect(selects.join(' ')).not.toMatch(/personnummer/)
  })

  it('refuses while the company has not switched on Kivra sending, and stages nothing', async () => {
    mocks.payslipMailboxBlock.mockResolvedValue('DIGITAL_MAILBOX_SENDING_NOT_ACTIVE')
    const { supabase, findCall } = setup()

    await expect(call({ salary_run_id: RUN_ID, channel: 'kivra' }, supabase)).rejects.toMatchObject({
      code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE',
    })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('keeps the plain email send named as before', async () => {
    const { supabase, findCall } = setup()
    await call({ salary_run_id: RUN_ID }, supabase)
    const staged = findCall('pending_operations', 'insert')![0] as { title: string; params: Record<string, unknown> }
    expect(staged.title).toBe('Skicka lönebesked')
    expect(staged.params.channel).toBeUndefined()
    expect(mocks.payslipMailboxBlock).not.toHaveBeenCalled()
  })
})
