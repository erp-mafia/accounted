import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isReminderExcluded, loadReminderExclusions } from '../reminder-guard'
import { createMemorySupabase, type MemorySupabase } from './memory-supabase'

const memory = vi.hoisted(() => ({ current: null as MemorySupabase | null }))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => memory.current!.client),
}))
vi.mock('@/lib/email/service', () => ({ getEmailService: () => ({ sendEmail: vi.fn() }) }))

import { processOverdueReminders } from '@/lib/invoices/reminder-processor'

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

describe('processOverdueReminders and the collections provider', () => {
  const overdue = (id: string, companyId: string) => ({
    id,
    company_id: companyId,
    status: 'sent',
    document_type: 'invoice',
    credited_invoice_id: null,
    invoice_number: id,
    due_date: '2026-01-01',
    customer: { email: 'kund@example.se', name: 'Kund' },
    credit_notes: [],
  })

  beforeEach(() => {
    memory.current = seed()
    memory.current.seed('invoices', [overdue('inv-active', ACTIVE), overdue('inv-case', CASE_ONLY), overdue('inv-free', FREE)])
  })

  it('never reminds beside the provider: only the free invoice reaches the reminder steps', async () => {
    const result = await processOverdueReminders()
    // The free invoice's company has no settings row here, so it is reported as a failure; the others never get that far.
    expect(result.results.map((r) => r.invoiceId)).toEqual(['inv-free'])
  })

  it('sends nothing at all when the guard cannot read the cases', async () => {
    memory.current!.failures.set('collection_cases:select', { message: 'timeout' })
    expect(await processOverdueReminders()).toEqual({ processed: 0, sent: 0, failed: 0, results: [] })
  })
})
