import { describe, it, expect, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { findStandingRegistration } from '../standing-registration'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

describe('findStandingRegistration', () => {
  beforeEach(() => {
    reset()
  })

  it('returns the posted registration verifikat booked from the invoice', async () => {
    enqueue({ data: [{ id: 'je-1' }], error: null })

    await expect(findStandingRegistration(supabase as never, 'company-1', 'si-1')).resolves.toEqual({ id: 'je-1' })
    expect(findCalls('journal_entries', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['source_type', 'supplier_invoice_registered'],
      ['source_id', 'si-1'],
      ['status', 'posted'],
    ])
  })

  it('returns null when no registration stands', async () => {
    enqueue({ data: [], error: null })

    await expect(findStandingRegistration(supabase as never, 'company-1', 'si-1')).resolves.toBeNull()
  })

  it('throws when the read fails, so the caller does not book on a guess', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    await expect(findStandingRegistration(supabase as never, 'company-1', 'si-1')).rejects.toThrow('boom')
  })
})
