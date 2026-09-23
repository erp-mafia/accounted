import { describe, it, expect } from 'vitest'
import {
  composeInboxAddress,
  getActiveInbox,
  rotateCompanyInbox,
} from '@/extensions/general/invoice-inbox/lib/inbox-provisioning'
import { createQueuedMockSupabase } from '@/tests/helpers'

describe('composeInboxAddress', () => {
  it('joins local_part and domain with @', () => {
    expect(composeInboxAddress('acme-ab-x7f2', 'arcim.io')).toBe('acme-ab-x7f2@arcim.io')
  })
})

describe('getActiveInbox', () => {
  it('returns the active inbox row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const row = {
      id: 'inbox-1',
      company_id: 'company-1',
      local_part: 'acme-x7f2',
      status: 'active',
      slug_seed: 'acme',
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
      deprecated_at: null,
    }
    enqueue({ data: row })

    const result = await getActiveInbox(supabase as never, 'company-1')
    expect(result).toEqual(row)
  })

  it('returns null when no active inbox exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const result = await getActiveInbox(supabase as never, 'company-1')
    expect(result).toBeNull()
  })

  it('throws on database error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'db blew up' } })

    await expect(getActiveInbox(supabase as never, 'company-1')).rejects.toThrow(/db blew up/)
  })
})

describe('rotateCompanyInbox', () => {
  it('delegates to the rotate_company_inbox RPC and returns the new row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()

    const newRow = {
      id: 'inbox-2',
      company_id: 'company-1',
      local_part: 'acme-new2',
      status: 'active',
      slug_seed: 'acme',
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
      deprecated_at: null,
    }
    enqueue({ data: newRow })

    const result = await rotateCompanyInbox(supabase as never, 'company-1')

    expect(result.local_part).toBe('acme-new2')
    expect(result.status).toBe('active')
  })

  it('accepts the SETOF shape where the RPC wraps the row in an array', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()

    const newRow = {
      id: 'inbox-3',
      company_id: 'company-1',
      local_part: 'new-co-abcd',
      status: 'active',
      slug_seed: 'new-co',
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
      deprecated_at: null,
    }
    enqueue({ data: [newRow] })

    const result = await rotateCompanyInbox(supabase as never, 'company-1')
    expect(result.local_part).toBe('new-co-abcd')
  })

  it('surfaces RPC errors', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'Not authorized to rotate inbox for this company' } })

    await expect(rotateCompanyInbox(supabase as never, 'nope'))
      .rejects.toThrow(/Not authorized/)
  })
})
