import { describe, expect, it } from 'vitest'
import { isReminderExcluded, loadReminderExclusions } from '../reminder-guard'
import { createMemorySupabase, type MemorySupabase } from './memory-supabase'

const ACTIVE = 'company-active'
const CASE_ONLY = 'company-case-only'
const FREE = 'company-free'

function seed(): MemorySupabase {
  const db = createMemorySupabase()
  db.seed('collection_connections', [
    { id: 'conn-1', company_id: ACTIVE, state: 'active' },
    { id: 'conn-2', company_id: CASE_ONLY, state: 'needs_setup' },
    { id: 'conn-3', company_id: FREE, state: 'disconnected' },
  ])
  db.seed('collection_cases', [
    { id: 'case-1', company_id: CASE_ONLY, invoice_id: 'inv-case', is_open: true },
    { id: 'case-2', company_id: FREE, invoice_id: 'inv-free', is_open: false },
  ])
  return db
}

describe('loadReminderExclusions', () => {
  it('excludes every invoice of a company with an active connection, and each invoice with an open case', async () => {
    const db = seed()
    const exclusions = await loadReminderExclusions(db.client, [
      { id: 'inv-active', company_id: ACTIVE },
      { id: 'inv-case', company_id: CASE_ONLY },
      { id: 'inv-other', company_id: CASE_ONLY },
      { id: 'inv-free', company_id: FREE },
    ])
    expect(isReminderExcluded(exclusions, { id: 'inv-active', company_id: ACTIVE })).toBe(true)
    expect(isReminderExcluded(exclusions, { id: 'inv-case', company_id: CASE_ONLY })).toBe(true)
    expect(isReminderExcluded(exclusions, { id: 'inv-other', company_id: CASE_ONLY })).toBe(false)
    expect(isReminderExcluded(exclusions, { id: 'inv-free', company_id: FREE })).toBe(false)
  })

  it('reads nothing for no candidates and throws when it cannot tell', async () => {
    const db = seed()
    expect(await loadReminderExclusions(db.client, [])).toEqual({ companies: new Set(), invoices: new Set() })
    db.failures.set('collection_cases:select', { message: 'relation does not exist' })
    await expect(loadReminderExclusions(db.client, [{ id: 'x', company_id: FREE }])).rejects.toThrow()
  })
})
