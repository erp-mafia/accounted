/**
 * A salary run's net pay as draft bank payments, staged by an agent
 * (../salary-run-bank-payment.ts). The preparation itself is the run page's
 * service (lib/salary/payment/pay-via-bank.ts, tested there); here: the
 * scope and the staging, and that whether the pay already left is answered
 * by the person approving in the app, never by the agent's input and never
 * by another door.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/salary/payment/pay-via-bank', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payment/pay-via-bank')>()),
  prepareSalaryBankPayment: vi.fn(),
}))

import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { createLogger } from '@/lib/logger'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { fixableRefusalFor } from '@/lib/pending-operations/fixable-refusals'
import { prepareSalaryBankPayment } from '@/lib/salary/payment/pay-via-bank'
import type { PendingOperation } from '@/types'
import { ALL_OPERATIONS } from '../registry'
import { SALARY_UNPAID_CONFIRMATION, salaryRunsPrepareBankPayment } from '../salary-run-bank-payment'

const prepare = vi.mocked(prepareSalaryBankPayment)
const RUN_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const INPUT = { salary_run_id: RUN_ID, cash_account_id: ACCOUNT_ID }

const ctx = (extra: Record<string, unknown> = {}) => ({
  supabase: createQueuedMockSupabase().supabase as never,
  companyId: 'company-1',
  userId: 'user-1',
  log: createLogger('test'),
  ...extra,
})

const ORDER = {
  id: '33333333-3333-4333-8333-333333333333',
  company_id: 'company-1',
  supplier_invoice_id: null,
  batch_id: null,
  status: 'draft',
  amount: 21500.5,
  currency: 'SEK',
  requested_execution_date: '2026-11-24',
  cash_account_id: ACCOUNT_ID,
  payee_type: 'bank_account',
  payee_source: 'employee',
  payee_check: 'known',
  payee_name: 'Anna Andersson',
  payee_clearing: '8327',
  payee_account: '9876543210',
  reference_type: 'message',
  reference: 'Lön 2026-11',
  end_to_end_id: 'e2e-1',
  created_at: '2026-11-20T10:00:00Z',
  updated_at: '2026-11-20T10:00:00Z',
}

function stagedOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'prepare_salary_payment_orders',
    status: 'pending',
    title: 'Förbered bankbetalning av lönerna för 2026-11',
    params: INPUT,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-11-20T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-11-20T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('salary-runs.prepare-bank-payment', () => {
  it('is a staged MCP write under payroll:write whose input has no say on whether the pay already left', () => {
    expect(ALL_OPERATIONS).toContain(salaryRunsPrepareBankPayment)
    expect(salaryRunsPrepareBankPayment.scope).toBe('payroll:write')
    expect(TOOL_SCOPE_MAP.gnubok_prepare_salary_payments).toBe('payroll:write')
    expect(salaryRunsPrepareBankPayment.mcp?.stage?.pendingType).toBe('prepare_salary_payment_orders')
    expect(salaryRunsPrepareBankPayment.http).toBeUndefined()
    const shape = (salaryRunsPrepareBankPayment.input as unknown as { shape: Record<string, unknown> }).shape
    expect(Object.keys(shape).sort()).toEqual(['cash_account_id', 'execution_date', 'salary_run_id'])
    // An answer an agent sends anyway is dropped by the contract (and the MCP door's closed schema refuses it).
    expect((salaryRunsPrepareBankPayment.input.parse({ ...INPUT, confirmed_unpaid: true }) as Record<string, unknown>).confirmed_unpaid).toBeUndefined()
  })

  it('stages with the preview, never confirming on the agent\'s behalf', async () => {
    prepare.mockResolvedValueOnce({ ok: true, dryRun: true, preview: { period: '2026-11', confirmation_required: { status: 'booked', payment_file_generated_at: null } } })
    const outcome = await salaryRunsPrepareBankPayment.run(ctx(), INPUT, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { period: '2026-11' } })
    expect(prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ salaryRunId: RUN_ID, cashAccountId: ACCOUNT_ID, confirmedUnpaid: false, dryRun: true }))
    const stage = salaryRunsPrepareBankPayment.mcp!.stage!
    expect(stage.title(INPUT, { period: '2026-11' })).toBe('Förbered bankbetalning av lönerna för 2026-11')
    expect(stage.extras!(INPUT, { confirmation_required: { status: 'booked' } }).complianceNote).toMatch(/person approving in Accounted confirms/)
    expect(stage.extras!(INPUT, { confirmation_required: null }).complianceNote).toBeUndefined()
  })

  it('confirms only when a person answered at the approval of the staged proposal', async () => {
    prepare.mockResolvedValue({ ok: false, code: 'SALARY_RUN_BANK_PAYMENT_NOT_READY' })
    await salaryRunsPrepareBankPayment.run(ctx({ acknowledgedWarnings: [SALARY_UNPAID_CONFIRMATION] }), INPUT, { dryRun: false })
    await salaryRunsPrepareBankPayment.run(ctx({ pendingOperationId: 'op-1' }), INPUT, { dryRun: false })
    await salaryRunsPrepareBankPayment.run(
      ctx({ pendingOperationId: 'op-1', acknowledgedWarnings: [SALARY_UNPAID_CONFIRMATION] }),
      INPUT,
      { dryRun: false },
    )
    expect(prepare.mock.calls.map((call) => (call[1] as { confirmedUnpaid: boolean }).confirmedUnpaid)).toEqual([false, false, true])
  })

  it('says who confirms when the run needs it, and hands the drafts back with the Betalningar link', async () => {
    prepare.mockResolvedValueOnce({ ok: false, code: SALARY_UNPAID_CONFIRMATION, details: { status: 'booked', payment_file_generated_at: null } })
    const refused = await salaryRunsPrepareBankPayment.run(ctx({ pendingOperationId: 'op-1' }), INPUT, { dryRun: false })
    expect(refused).toMatchObject({ ok: false, code: SALARY_UNPAID_CONFIRMATION, details: { status: 'booked' } })
    expect((refused as { messageSv: string }).messageSv).toMatch(/personen som godkänner förslaget i Accounted bekräftar/)

    prepare.mockResolvedValueOnce({
      ok: true,
      data: { orders: [ORDER as never], replaced_draft_ids: [], warnings: [{ code: 'after_payday', payday: '2026-11-25' }], total: 21500.5 },
    })
    const created = await salaryRunsPrepareBankPayment.run(ctx({ pendingOperationId: 'op-1' }), INPUT, { dryRun: false })
    expect(created).toMatchObject({
      ok: true,
      data: {
        salary_run_id: RUN_ID,
        total: 21500.5,
        warnings: [{ code: 'after_payday', payday: '2026-11-25' }],
        payment_orders: [{ payment_order_id: ORDER.id, status: 'draft', amount: 21500.5, payee: { name: 'Anna Andersson', label: '8327-****3210' } }],
      },
    })
    expect((created as { data: { next: { sign_in_app: string } } }).data.next.sign_in_app).toContain(`orders=${ORDER.id}`)
  })
})

describe('approving a staged salary bank payment', () => {
  it("keeps the proposal for the app's single approval when the pay may already have left, and the same approval goes through with the person's answer", async () => {
    expect(fixableRefusalFor('prepare_salary_payment_orders', SALARY_UNPAID_CONFIRMATION)).toBeTruthy()
    prepare.mockImplementation(async (_ctx, input) =>
      input.confirmedUnpaid
        ? { ok: true, data: { orders: [ORDER as never], replaced_draft_ids: [], warnings: [], total: 21500.5 } }
        : { ok: false, code: SALARY_UNPAID_CONFIRMATION, details: { status: 'booked', payment_file_generated_at: null } },
    )

    const first = createQueuedMockSupabase()
    first.enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    first.enqueue({ data: null, error: null }) // back to pending
    const kept = await commitPendingOperation(first.supabase as never, 'user-1', 'company-1', stagedOp(), {
      commitMethod: 'user_accept',
      keepFixableRefusals: true,
    })
    expect(kept).toMatchObject({ status: 'failed', code: SALARY_UNPAID_CONFIRMATION, operation_status: 'pending' })

    const second = createQueuedMockSupabase()
    second.enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    const approved = await commitPendingOperation(second.supabase as never, 'user-1', 'company-1', stagedOp(), {
      commitMethod: 'user_accept',
      keepFixableRefusals: true,
      acknowledgedWarnings: [SALARY_UNPAID_CONFIRMATION],
    })
    expect(approved.status).toBe('committed')
    expect(prepare.mock.calls.map((call) => (call[1] as { confirmedUnpaid: boolean }).confirmedUnpaid)).toEqual([false, true])
  })

  it('refuses it at every other door, which cannot carry the answer', async () => {
    prepare.mockResolvedValue({ ok: false, code: SALARY_UNPAID_CONFIRMATION, details: { status: 'booked', payment_file_generated_at: null } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', stagedOp(), { commitMethod: 'api_key' })
    expect(result).toMatchObject({ status: 'rejected', code: SALARY_UNPAID_CONFIRMATION })
    expect(prepare.mock.calls[0]![1]).toMatchObject({ confirmedUnpaid: false })
  })
})
