import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { tools } from '../server'

const tool = () => tools.find((candidate) => candidate.name === 'gnubok_list_customers')!

// Synthetic personnummer, never a real one.
const PERSONAL_NUMBER = '19900101-1234'
const MASKED = '********-1234'

describe('gnubok_list_customers: individual identifiers', () => {
  it('never lists a personnummer raw: ciphertext is masked, a legacy org_number personnummer is masked and nulled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'c-1', name: 'Acme AB', customer_type: 'swedish_business', org_number: '556677-8899', personal_number: null },
        { id: 'c-2', name: 'Anna', customer_type: 'individual', org_number: null, personal_number: encryptPersonnummer(PERSONAL_NUMBER) },
        // Written before the write paths moved an individual's personnummer
        // out of org_number (the 2026-08-21 fix); the repair script moves it.
        { id: 'c-3', name: 'Bertil', customer_type: 'individual', org_number: PERSONAL_NUMBER, personal_number: null },
        { id: 'c-4', name: 'Cecilia', customer_type: 'individual', org_number: null, personal_number: null },
      ],
    })

    const result = (await tool().execute({}, 'company-1', 'user-1', supabase as never)) as {
      customers: Array<Record<string, unknown>>
      count: number
    }

    expect(result.count).toBe(4)
    const byName = Object.fromEntries(result.customers.map((c) => [c.name as string, c]))
    expect(byName['Acme AB']).toMatchObject({ org_number: '556677-8899' })
    expect(byName['Acme AB']).not.toHaveProperty('personal_number')
    expect(byName['Acme AB']).not.toHaveProperty('personal_number_masked')
    expect(byName['Anna']).toMatchObject({ org_number: null, personal_number_masked: MASKED })
    expect(byName['Bertil']).toMatchObject({ org_number: null, personal_number_masked: MASKED })
    expect(byName['Cecilia']).toMatchObject({ org_number: null, personal_number_masked: null })
    // Neither the plaintext nor the ciphertext leaves the tool.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(PERSONAL_NUMBER)
    expect(serialized).not.toMatch(/"personal_number"/)
  })
})
