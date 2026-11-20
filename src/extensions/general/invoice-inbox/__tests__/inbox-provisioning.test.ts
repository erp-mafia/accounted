import { describe, it, expect } from 'vitest'
import {
  composeInboxAddress,
  getActiveInbox,
  inboxReceivesMail,
  InboxRenameRefused,
  listPreviousInboxes,
  renameCompanyInbox,
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

describe('inboxReceivesMail', () => {
  it('files mail for the active address and the previous ones a rename kept (crm#1334)', () => {
    expect(inboxReceivesMail('active')).toBe(true)
    expect(inboxReceivesMail('previous')).toBe(true)
  })

  it('refuses retired, blocked and unknown addresses', () => {
    expect(inboxReceivesMail('deprecated')).toBe(false)
    expect(inboxReceivesMail('blocked')).toBe(false)
    expect(inboxReceivesMail(null)).toBe(false)
  })
})

describe('listPreviousInboxes', () => {
  it('lists the local parts of the previous addresses', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ local_part: 'old-ab-x7f2' }, { local_part: 'older-ab-m4tz' }] })

    expect(await listPreviousInboxes(supabase as never, 'company-1')).toEqual(['old-ab-x7f2', 'older-ab-m4tz'])
    expect(findCalls('company_inboxes', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['status', 'previous'],
    ])
  })

  it('throws on database error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'db blew up' } })
    await expect(listPreviousInboxes(supabase as never, 'company-1')).rejects.toThrow(/db blew up/)
  })
})

describe('renameCompanyInbox', () => {
  it('delegates to the rename_company_inbox RPC and returns the new row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'inbox-4', company_id: 'company-1', local_part: 'new-name-ab-m4tz', status: 'active' }] })

    const result = await renameCompanyInbox(supabase as never, 'company-1')
    expect(result.local_part).toBe('new-name-ab-m4tz')
    expect(supabase.rpc).toHaveBeenCalledWith('rename_company_inbox', { p_company_id: 'company-1' })
  })

  it('names the refusals the route answers differently', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: 'PT409', message: 'already carries the name' } })
    enqueue({ data: null, error: { code: 'P0002', message: 'no active inbox' } })

    await expect(renameCompanyInbox(supabase as never, 'company-1')).rejects.toMatchObject({
      name: 'InboxRenameRefused',
      reason: 'unchanged',
    })
    const second = await renameCompanyInbox(supabase as never, 'company-1').catch((err: unknown) => err)
    expect(second).toBeInstanceOf(InboxRenameRefused)
    expect((second as InboxRenameRefused).reason).toBe('no_active_inbox')
  })

  it('surfaces any other RPC error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '42501', message: 'Not authorized to rename inbox for this company' } })
    await expect(renameCompanyInbox(supabase as never, 'company-1')).rejects.toThrow(/Not authorized/)
  })
})
