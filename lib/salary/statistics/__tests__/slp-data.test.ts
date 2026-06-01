import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { collectSlpEmployees } from '../slp-data'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const db = supabase as unknown as SupabaseClient

function activeEmployee(over: Record<string, unknown> = {}) {
  return {
    id: 'emp-1',
    personnummer: encryptPersonnummer('199001011234'),
    worker_category: 'tjansteman',
    salary_type: 'monthly',
    monthly_salary: 42000,
    hourly_rate: null,
    ssyk_code: '2611',
    cfar_number: '12345678',
    arbetstidsart: '1',
    anstallningsform: '1',
    vacation_days_per_year: 25,
    ...over,
  }
}

describe('collectSlpEmployees', () => {
  beforeEach(() => reset())

  it('surfaces an error from the employee query', async () => {
    enqueue({ error: { message: 'employees failed' } }) // employees

    const result = await collectSlpEmployees(db, 'company-1', 2026)

    expect(result.error).toBe('employees failed')
    expect(result.rows).toEqual([])
  })

  it('snapshots active employees with zeroed hours when there is no September run', async () => {
    enqueue({ data: [activeEmployee()] }) // employees
    enqueue({ data: [] }) // salary_runs (none in September)

    const result = await collectSlpEmployees(db, 'company-1', 2026)

    expect(result.error).toBeUndefined()
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      personnummer: '199001011234',
      workerCategory: 'tjansteman',
      salaryType: 'monthly',
      ssykCode: '2611',
      cfarNumber: '12345678',
      agreedWage: 42000,
      workedHours: 0,
      overtimeSupplement: 0,
      vacationDays: 25,
    })
  })

  it('uses the hourly rate as the agreed wage for hourly employees', async () => {
    enqueue({ data: [activeEmployee({ salary_type: 'hourly', monthly_salary: null, hourly_rate: 250 })] }) // employees
    enqueue({ data: [] }) // salary_runs

    const result = await collectSlpEmployees(db, 'company-1', 2026)

    expect(result.rows[0].agreedWage).toBe(250)
  })

  it('layers September worked hours and overtime supplement onto the snapshot', async () => {
    enqueue({ data: [activeEmployee()] }) // employees
    enqueue({ data: [{ id: 'run-1' }] }) // salary_runs (September)
    enqueue({ data: [{ id: 'sre-1', employee_id: 'emp-1', hours_worked: 160 }] }) // salary_run_employees
    enqueue({ data: [{ salary_run_employee_id: 'sre-1', amount: 5000, item_type: 'overtime_50' }] }) // salary_line_items

    const result = await collectSlpEmployees(db, 'company-1', 2026)

    expect(result.rows[0].workedHours).toBe(160)
    expect(result.rows[0].overtimeSupplement).toBe(5000)
  })

  it('emits an empty personnummer when decryption fails', async () => {
    enqueue({ data: [activeEmployee({ personnummer: 'not-a-valid-ciphertext' })] }) // employees
    enqueue({ data: [] }) // salary_runs

    const result = await collectSlpEmployees(db, 'company-1', 2026)

    expect(result.rows[0].personnummer).toBe('')
  })
})
