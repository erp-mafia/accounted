/**
 * Executor tests for the payroll gap-closure pending operations:
 * update_payslip_line + register_absence (1.7).
 *
 * Executors are private to commit.ts and reached through
 * commitPendingOperation (same pattern as dimension-value-executor.test.ts).
 * Staging-side coverage lives in
 * extensions/general/mcp-server/__tests__/payroll-staged-tools.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const mockCloseYear = vi.fn()
vi.mock('@/lib/salary/semesterberedning', () => ({
  previewVacationYearClose: vi.fn(),
  commitVacationYearClose: (...a: unknown[]) => mockCloseYear(...a),
}))

const mockAdvanceAndBook = vi.fn()
vi.mock('@/lib/salary/book-run', () => ({
  advanceAndBookSalaryRun: (...a: unknown[]) => mockAdvanceAndBook(...a),
  bookPaidSalaryRun: vi.fn(),
}))

import { commitPendingOperation } from '../commit'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'update_payslip_line',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-07-13T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-13T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: update_payslip_line', () => {
  const LINE_ROW = {
    id: 'line-1',
    salary_run_employee_id: 'sre-1',
    company_id: 'company-1',
    item_type: 'bonus',
    description: 'Kvartalsbonus',
    quantity: null,
    unit_price: null,
    amount: 5000,
    is_taxable: true,
    is_avgift_basis: true,
    is_vacation_basis: true,
    is_gross_deduction: false,
    is_net_deduction: false,
    account_number: '7210',
    sort_order: 0,
    created_at: '',
    updated_at: '',
    salary_run_employee: { salary_run_id: 'run-1' },
  }

  it('applies the patch through the shared service (happy path)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'run-1', status: 'draft' } }) // service draft gate
    enqueue({ data: LINE_ROW }) // service loadLineInRun
    enqueue({ data: { ...LINE_ROW, amount: 5500, salary_run_employee: undefined } }) // update
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      params: { salary_run_id: 'run-1', salary_line_item_id: 'line-1', patch: { amount: 5500 } },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      salary_line_item_id: 'line-1',
      salary_run_id: 'run-1',
      amount: 5500,
    })
  })

  it('fails cleanly when the run advanced between staging and approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'run-1', status: 'approved' } }) // draft gate trips
    enqueue({ data: null, error: null }) // finalize (failed)

    const op = makePendingOp({
      params: { salary_run_id: 'run-1', salary_line_item_id: 'line-1', patch: { amount: 5500 } },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/utkast/)
  })

  it('rejects an empty patch with 400', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // finalize (failed)

    const op = makePendingOp({
      params: { salary_run_id: 'run-1', salary_line_item_id: 'line-1', patch: {} },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })
})

describe('commitPendingOperation: register_absence', () => {
  it('upserts the expanded range through the shared service (happy path)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'emp-1' } }) // service assertEmployee
    enqueue({
      data: [
        { id: 'a1', absence_date: '2026-03-02', absence_type: 'sick', hours: 8, notes: null, salary_run_employee_id: null, created_at: '', updated_at: '' },
        { id: 'a2', absence_date: '2026-03-03', absence_type: 'sick', hours: 8, notes: null, salary_run_employee_id: null, created_at: '', updated_at: '' },
      ],
    }) // bulk upsert
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      operation_type: 'register_absence',
      params: {
        employee_id: 'emp-1',
        from: '2026-03-02',
        to: '2026-03-03',
        absence_type: 'sick',
        hours_per_day: 8,
        notes: null,
        include_weekends: false,
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      employee_id: 'emp-1',
      absence_type: 'sick',
      day_count: 2,
    })
  })

  it('maps the 24h-cap trigger to a clean 409 failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'emp-1' } }) // assertEmployee
    enqueue({ data: null, error: { code: '23514', message: 'Total tid över 24h' } }) // upsert trips trigger
    enqueue({ data: null, error: null }) // finalize (failed)

    const op = makePendingOp({
      operation_type: 'register_absence',
      params: { employee_id: 'emp-1', from: '2026-03-02', to: '2026-03-02', absence_type: 'sick' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // 409 is a client-state conflict: the dispatcher rejects the op (fix the
    // day's hours and re-stage) rather than marking it transiently failed.
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('logs the PG details and persists a sanitized error_code when the upsert fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
      enqueue({ data: { id: 'emp-1' } }) // assertEmployee
      enqueue({
        data: null,
        error: {
          code: '42501',
          message:
            'new row violates row-level security policy for table "salary_absence_franvaro_audit"',
        },
      }) // upsert denied (the franvaro audit-trigger bug)
      enqueue({ data: null, error: null }) // finalize (failed)

      const op = makePendingOp({
        operation_type: 'register_absence',
        params: { employee_id: 'emp-1', from: '2026-03-02', to: '2026-03-02', absence_type: 'parental' },
      })
      const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

      expect(result.status).toBe('failed')
      expect(result.http_status).toBe(500)
      expect(result.code).toBe('DB_PERMISSION_DENIED')
      // The op row keeps the structured code so the failure mode is
      // diagnosable later, but never the raw PG text.
      const updates = findCalls('pending_operations', 'update')
      const finalize = updates[updates.length - 1]![0] as { result_data?: Record<string, unknown> }
      expect(finalize.result_data).toMatchObject({
        error_code: 'DB_PERMISSION_DENIED',
        http_status: 500,
      })
      expect(JSON.stringify(finalize.result_data)).not.toContain('row-level security')
      // The raw PG message goes to the log: it is persisted nowhere else.
      const logged = consoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logged).toContain('register_absence commit failed')
      expect(logged).toContain('row-level security')
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('commitPendingOperation: book_salary_run', () => {
  it('books through the shared advance-walk service (happy path)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // finalize

    mockAdvanceAndBook.mockResolvedValue({
      ok: true,
      data: {
        run: { period_year: 2026, period_month: 6, status: 'booked' },
        entryIds: ['je-1', 'je-2'],
        nollkorning: false,
        warnings: ['Anna Svensson: E-post saknas, lönebesked kan inte skickas'],
      },
    })

    const op = makePendingOp({
      operation_type: 'book_salary_run',
      risk_level: 'high',
      params: { salary_run_id: 'run-1' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      salary_run_id: 'run-1',
      status: 'booked',
      period: '2026-06',
      journal_entry_ids: ['je-1', 'je-2'],
    })
    expect(mockAdvanceAndBook).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1', salaryRunId: 'run-1' }),
    )
  })

  it('rejects cleanly when the run was already booked between staging and approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // finalize (failed)

    mockAdvanceAndBook.mockResolvedValue({ ok: false, code: 'SALARY_RUN_ALREADY_BOOKED' })

    const op = makePendingOp({
      operation_type: 'book_salary_run',
      risk_level: 'high',
      params: { salary_run_id: 'run-1' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/redan bokförd/)
  })
})

describe('commitPendingOperation: delete_absence', () => {
  it('deletes the range through the shared service (happy path)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'emp-1' } }) // service assertEmployee
    enqueue({ data: null, count: 3 }) // delete with count
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      operation_type: 'delete_absence',
      params: { employee_id: 'emp-1', from: '2026-03-02', to: '2026-03-06', absence_type: 'sick' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      employee_id: 'emp-1',
      absence_type: 'sick',
      deleted_count: 3,
    })
  })

  it('fails cleanly for an unknown employee', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null }) // assertEmployee misses
    enqueue({ data: null, error: null }) // finalize (failed)

    const op = makePendingOp({
      operation_type: 'delete_absence',
      params: { employee_id: 'emp-x', from: '2026-03-02', to: '2026-03-06' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).not.toBe('committed')
    expect(result.error).toBeDefined()
  })

  it('logs the PG details and persists a sanitized error_code when the delete fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
      enqueue({ data: { id: 'emp-1' } }) // assertEmployee
      enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) // delete fails
      enqueue({ data: null, error: null }) // finalize (failed)

      const op = makePendingOp({
        operation_type: 'delete_absence',
        params: { employee_id: 'emp-1', from: '2026-03-02', to: '2026-03-06' },
      })
      const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

      expect(result.status).toBe('failed')
      expect(result.code).toBe('INTERNAL_ERROR')
      const updates = findCalls('pending_operations', 'update')
      const finalize = updates[updates.length - 1]![0] as { result_data?: Record<string, unknown> }
      expect(finalize.result_data).toMatchObject({ error_code: 'INTERNAL_ERROR' })
      const logged = consoleError.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logged).toContain('delete_absence commit failed')
      expect(logged).toContain('statement timeout')
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('commitPendingOperation: create_employee', () => {
  it('inserts via the shared service with the pre-encrypted personnummer', async () => {
    const { encryptPersonnummer } = await import('@/lib/salary/personnummer')
    const encrypted = encryptPersonnummer('190001010000')

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { entity_type: 'ab' } }) // getCompanyEntityType (company_settings)
    enqueue({
      data: {
        id: 'emp-new',
        first_name: 'Anna',
        last_name: 'Andersson',
        personnummer: encrypted,
        is_active: true,
      },
    }) // insert
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      operation_type: 'create_employee',
      params: {
        first_name: 'Anna',
        last_name: 'Andersson',
        personnummer_encrypted: encrypted,
        personnummer_last4: '0000',
        employment_type: 'employee',
        employment_start: '2026-01-15',
        salary_type: 'monthly',
        monthly_salary: 35000,
        tax_table_number: 33,
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      employee_id: 'emp-new',
      personnummer_masked: '19000101-XXXX',
    })
    // Result data never carries the plaintext or ciphertext.
    expect(JSON.stringify(result.data)).not.toContain('190001010000')
    expect(JSON.stringify(result.data)).not.toContain(encrypted)
  })

  it('maps duplicate personnummer to a clean rejection', async () => {
    const { encryptPersonnummer } = await import('@/lib/salary/personnummer')
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { entity_type: 'ab' } }) // entity type
    enqueue({
      data: null,
      error: { code: '23505', message: 'duplicate', constraint: 'employees_company_id_personnummer_key' },
    }) // insert conflict
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      operation_type: 'create_employee',
      params: {
        first_name: 'Anna',
        last_name: 'Andersson',
        personnummer_encrypted: encryptPersonnummer('190001010000'),
        personnummer_last4: '0000',
        employment_start: '2026-01-15',
        salary_type: 'monthly',
        monthly_salary: 35000,
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })
})

describe('commitPendingOperation: update_employee', () => {
  it('applies the patch through merged-state validation (happy path)', async () => {
    const { encryptPersonnummer } = await import('@/lib/salary/personnummer')
    const encrypted = encryptPersonnummer('190001010000')

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'emp-1',
        first_name: 'Anna',
        last_name: 'Andersson',
        personnummer: encrypted,
        salary_type: 'monthly',
        monthly_salary: 35000,
        tax_table_number: 33,
        is_sidoinkomst: false,
        f_skatt_status: 'a_skatt',
        vaxa_stod_eligible: false,
        jamkning_percentage: null,
        is_active: true,
      },
    }) // fetch existing
    enqueue({
      data: {
        id: 'emp-1',
        first_name: 'Anna',
        last_name: 'Andersson',
        personnummer: encrypted,
        is_active: true,
      },
    }) // update
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      operation_type: 'update_employee',
      params: { employee_id: 'emp-1', patch: { monthly_salary: 38000 } },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ employee_id: 'emp-1' })
  })

  it('upserts opening balances atomically (set_employee_opening_balances)', async () => {
    const CURRENT_YEAR = new Date().getFullYear()
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', employment_start: '2024-01-15', is_active: true }] }) // employees
    enqueue({ data: [] }) // locks
    enqueue({ data: [] }) // existing created_by lookup
    enqueue({
      data: [
        {
          id: 'ob-1',
          employee_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          cutover_date: `${CURRENT_YEAR}-07-01`,
          ytd_gross: 210000,
          ytd_tax: 48000,
          ytd_net: 162000,
          vacation_paid_days_remaining: 12.5,
          vacation_saved_days_by_year: {},
          opening_semester_liability: 42000,
          opening_semester_liability_avgifter: 13196.4,
          karens_periods_adjustment: 1,
          created_at: '',
          updated_at: '',
        },
      ],
    }) // upsert
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      operation_type: 'set_employee_opening_balances',
      params: {
        items: [
          {
            employee_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            cutover_date: `${CURRENT_YEAR}-07-01`,
            ytd_gross: 210000,
            ytd_tax: 48000,
            ytd_net: 162000,
            vacation_paid_days_remaining: 12.5,
            opening_semester_liability: 42000,
            opening_semester_liability_avgifter: 13196.4,
            karens_periods_adjustment: 1,
          },
        ],
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      employee_count: 1,
      employee_opening_balances_ids: ['ob-1'],
    })
  })

  it('closes the vacation year through the shared service (vacation_year_close)', async () => {
    mockCloseYear.mockResolvedValue({
      ok: true,
      data: {
        closure_id: 'closure-1',
        adjustment_entry_id: 'je-1',
        report: { rows: [{ employee_id: 'emp-1' }], sek: { drift_2920: 8690.84 } },
      },
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      operation_type: 'vacation_year_close',
      params: { vacation_year_start: '2025-01-01', book_adjustment: true },
      risk_level: 'high',
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      vacation_year_closure_id: 'closure-1',
      adjustment_entry_id: 'je-1',
      employee_count: 1,
    })
    expect(mockCloseYear).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      '2025-01-01',
      { bookAdjustment: true },
    )
  })

  it('rejects a vacation_year_close replay cleanly', async () => {
    mockCloseYear.mockResolvedValue({ ok: false, code: 'VACATION_YEAR_ALREADY_CLOSED' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      operation_type: 'vacation_year_close',
      params: { vacation_year_start: '2025-01-01' },
      risk_level: 'high',
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('fails merged validation when clearing salary below zero-state', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: {
        id: 'emp-1',
        first_name: 'Anna',
        last_name: 'Andersson',
        salary_type: 'monthly',
        monthly_salary: 35000,
        tax_table_number: 33,
        is_sidoinkomst: false,
        f_skatt_status: 'a_skatt',
        vaxa_stod_eligible: false,
        jamkning_percentage: null,
      },
    }) // fetch existing
    enqueue({ data: null, error: null }) // finalize

    const op = makePendingOp({
      operation_type: 'update_employee',
      params: { employee_id: 'emp-1', patch: { monthly_salary: 0 } },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).not.toBe('committed')
    expect(result.error).toMatch(/Månadslön/)
  })
})
