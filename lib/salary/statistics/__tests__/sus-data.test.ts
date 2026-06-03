import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { collectSusCases } from '../sus-data'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const db = supabase as unknown as SupabaseClient

describe('collectSusCases', () => {
  beforeEach(() => reset())

  it('returns no cases (and no error) when there are no sick days', async () => {
    enqueue({ data: [] }) // salary_absence_days

    const result = await collectSusCases(db, 'company-1', 2026, 1)

    expect(result.error).toBeUndefined()
    expect(result.cases).toEqual([])
  })

  it('surfaces an error from the absence query', async () => {
    enqueue({ error: { message: 'absence query failed' } }) // salary_absence_days

    const result = await collectSusCases(db, 'company-1', 2026, 1)

    expect(result.error).toBe('absence query failed')
    expect(result.cases).toEqual([])
  })

  it('surfaces an error from the employee lookup', async () => {
    enqueue({ data: [{ employee_id: 'emp-1', absence_date: '2026-01-10' }] }) // salary_absence_days
    enqueue({ error: { message: 'employee query failed' } }) // employees

    const result = await collectSusCases(db, 'company-1', 2026, 1)

    expect(result.error).toBe('employee query failed')
  })

  it('groups consecutive sick days into one case with the decrypted personnummer', async () => {
    enqueue({
      data: [
        { employee_id: 'emp-1', absence_date: '2026-01-10' },
        { employee_id: 'emp-1', absence_date: '2026-01-11' },
      ],
    }) // salary_absence_days
    enqueue({
      data: [{ id: 'emp-1', personnummer: encryptPersonnummer('199001011234') }],
    }) // employees

    const result = await collectSusCases(db, 'company-1', 2026, 1)

    expect(result.error).toBeUndefined()
    expect(result.cases).toHaveLength(1)
    expect(result.cases[0]).toMatchObject({
      personnummer: '199001011234',
      sjukFrom: '2026-01-10',
      sjukTom: '2026-01-11',
      ersDays: 2,
    })
  })

  it('skips employees whose personnummer cannot be decrypted', async () => {
    enqueue({ data: [{ employee_id: 'emp-1', absence_date: '2026-01-10' }] }) // salary_absence_days
    enqueue({ data: [{ id: 'emp-1', personnummer: 'not-a-valid-ciphertext' }] }) // employees

    const result = await collectSusCases(db, 'company-1', 2026, 1)

    expect(result.error).toBeUndefined()
    expect(result.cases).toEqual([])
  })
})
