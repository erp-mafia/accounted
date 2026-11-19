import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createPagedMockSupabase, manyRows } from '@/tests/helpers'
import { getLockingRuns } from '../opening-balances'

describe('getLockingRuns', () => {
  it('locks an employee whose booked payslip sits past the first 1,000 rows', async () => {
    const { supabase, findCalls } = createPagedMockSupabase({
      salary_run_employees: [
        ...manyRows(1000, () => ({ employee_id: 'emp-1', salary_run: { id: 'run-1', status: 'booked' } })),
        { employee_id: 'emp-2', salary_run: { id: 'run-2', status: 'booked' } },
      ],
    })

    const result = await getLockingRuns(supabase as unknown as SupabaseClient, 'company-1', ['emp-1', 'emp-2'])

    expect(result.ok && result.data.get('emp-2')).toBe('run-2')
    expect(findCalls('salary_run_employees', 'order')[0][0]).toBe('id')
  })
})
