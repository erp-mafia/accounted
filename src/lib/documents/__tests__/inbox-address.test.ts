import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolveInboxAddress, tagInboxAddress } from '../inbox-address'

describe('resolveInboxAddress', () => {
  beforeEach(() => {
    process.env.RESEND_INBOUND_DOMAIN = 'in.example.test'
  })
  afterEach(() => {
    delete process.env.RESEND_INBOUND_DOMAIN
  })

  it('composes the active inbox local part with the inbound domain', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { local_part: 'acme-7f3k' } })

    expect(await resolveInboxAddress(supabase as never, 'company-1')).toBe('acme-7f3k@in.example.test')
    // Scoped to the company and to its live address, never a retired one.
    expect(findCalls('company_inboxes', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['status', 'active'],
    ])
  })

  it('is null without reading when the install has no inbound mail domain', async () => {
    delete process.env.RESEND_INBOUND_DOMAIN
    const supabase = { from: vi.fn() }

    expect(await resolveInboxAddress(supabase as never, 'company-1')).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is null when the company has no active inbox', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    expect(await resolveInboxAddress(supabase as never, 'company-1')).toBeNull()
  })

  it('is null when the read fails, so the read it rides along with never fails on it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    expect(await resolveInboxAddress(supabase as never, 'company-1')).toBeNull()

    const throwing = { from: vi.fn(() => { throw new Error('network') }) }
    expect(await resolveInboxAddress(throwing as never, 'company-1')).toBeNull()
  })
})

describe('tagInboxAddress', () => {
  it('puts the tag between the local part and the domain', () => {
    expect(tagInboxAddress('acme-7f3k@in.example.test', 'lev')).toBe('acme-7f3k+lev@in.example.test')
    expect(tagInboxAddress('acme-7f3k@in.example.test', 'ver')).toBe('acme-7f3k+ver@in.example.test')
  })

  it('returns an address without a local part unchanged', () => {
    expect(tagInboxAddress('not-an-address', 'lev')).toBe('not-an-address')
    expect(tagInboxAddress('@in.example.test', 'lev')).toBe('@in.example.test')
  })
})
