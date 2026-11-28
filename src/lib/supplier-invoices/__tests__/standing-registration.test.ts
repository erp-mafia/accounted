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

  // A storno of a corrected registration released the invoice from the
  // correction; deleting that storno posts the correction again while the
  // invoice names none. Bokför must hand the invoice back to it, not book a
  // second registration.
  it('returns the posted correction of a reversed registration when no registration is posted', async () => {
    enqueue({ data: [], error: null }) // no posted registration
    enqueue({ data: [{ id: 'je-1' }], error: null }) // the reversed registration
    enqueue({ data: { id: 'je-1', status: 'reversed' }, error: null }) // liveEntryOf: the registration
    enqueue({ data: [{ id: 'corr-1' }], error: null }) // its correction
    enqueue({ data: { id: 'corr-1', status: 'posted' }, error: null }) // standing again

    await expect(findStandingRegistration(supabase as never, 'company-1', 'si-1')).resolves.toEqual({ id: 'corr-1' })
    expect(findCalls('journal_entries', 'eq').slice(4, 8)).toEqual([
      ['company_id', 'company-1'],
      ['source_type', 'supplier_invoice_registered'],
      ['source_id', 'si-1'],
      ['status', 'reversed'],
    ])
  })

  it('returns null when the reversed registration has no posted correction (its correction is reversed too)', async () => {
    enqueue({ data: [], error: null })
    enqueue({ data: [{ id: 'je-1' }], error: null })
    enqueue({ data: { id: 'je-1', status: 'reversed' }, error: null })
    enqueue({ data: [{ id: 'corr-1' }], error: null })
    enqueue({ data: { id: 'corr-1', status: 'reversed' }, error: null }) // the correction's storno stands
    enqueue({ data: [], error: null }) // and nothing corrects the correction

    await expect(findStandingRegistration(supabase as never, 'company-1', 'si-1')).resolves.toBeNull()
  })

  it('returns null for a registration reversed with no correction (a failed registration undone)', async () => {
    enqueue({ data: [], error: null })
    enqueue({ data: [{ id: 'je-1' }], error: null })
    enqueue({ data: { id: 'je-1', status: 'reversed' }, error: null })
    enqueue({ data: [], error: null })

    await expect(findStandingRegistration(supabase as never, 'company-1', 'si-1')).resolves.toBeNull()
  })

  it('throws when the reversed registrations cannot be read', async () => {
    enqueue({ data: [], error: null })
    enqueue({ data: null, error: { message: 'gone away' } })

    await expect(findStandingRegistration(supabase as never, 'company-1', 'si-1')).rejects.toThrow('gone away')
  })
})
