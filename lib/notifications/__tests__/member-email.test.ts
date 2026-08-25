/**
 * Recipient resolution for notification emails.
 *
 * The regression this guards: the four notification senders used the
 * PostgREST embed company_members → profiles!inner(email), but no FK links
 * those tables, so the embed 400'd and every recipient resolved to null.
 * The helper resolves membership and email as two separate queries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { warnRecorder } = vi.hoisted(() => ({ warnRecorder: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnRecorder,
    error: vi.fn(),
    child() {
      return this
    },
  }),
}))

import { resolveMemberEmail, resolveMemberEmails } from '../member-email'

interface QueryRecord {
  table: string
  columns?: string
  filters: Record<string, unknown>
}

function makeSupabase(opts: {
  memberRows?: Array<{ user_id: string | null }> | null
  membersError?: { message: string } | null
  profileRows?: Array<{ id: string; email: string | null }> | null
  profilesError?: { message: string } | null
}) {
  const queries: QueryRecord[] = []
  const from = (table: string) => {
    const record: QueryRecord = { table, filters: {} }
    queries.push(record)
    const result = () => {
      if (table === 'company_members') {
        return {
          data: opts.membersError ? null : opts.memberRows ?? [],
          error: opts.membersError ?? null,
        }
      }
      if (table === 'profiles') {
        return {
          data: opts.profilesError ? null : opts.profileRows ?? [],
          error: opts.profilesError ?? null,
        }
      }
      return { data: null, error: null }
    }
    const builder: Record<string, unknown> = {}
    Object.assign(builder, {
      select: (columns: string) => {
        record.columns = columns
        return builder
      },
      eq: (key: string, value: unknown) => {
        record.filters[key] = value
        return builder
      },
      in: (key: string, value: unknown) => {
        record.filters[key] = value
        return builder
      },
      maybeSingle: async () => {
        const r = result()
        const rows = r.data as Array<Record<string, unknown>> | null
        return { data: rows?.[0] ?? null, error: r.error }
      },
      then: (resolve: (v: unknown) => void) => resolve(result()),
    })
    return builder
  }
  return { supabase: { from } as unknown as SupabaseClient, queries }
}

function warnedWith(fragment: string): boolean {
  return warnRecorder.mock.calls.some(
    (call) => typeof call[0] === 'string' && call[0].includes(fragment),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveMemberEmail', () => {
  it('resolves an active member to their profile email via two queries (no embed)', async () => {
    const { supabase, queries } = makeSupabase({
      memberRows: [{ user_id: 'user-1' }],
      profileRows: [{ id: 'user-1', email: 'user@example.com' }],
    })

    const email = await resolveMemberEmail(supabase, 'company-1', 'user-1')

    expect(email).toBe('user@example.com')
    const memberQuery = queries.find((q) => q.table === 'company_members')
    // The embed column list is exactly what broke: assert it is gone.
    expect(memberQuery?.columns).toBe('user_id')
    expect(memberQuery?.filters).toMatchObject({ company_id: 'company-1', user_id: 'user-1' })
    const profileQuery = queries.find((q) => q.table === 'profiles')
    expect(profileQuery?.columns).toBe('email')
    expect(profileQuery?.filters).toMatchObject({ id: 'user-1' })
  })

  it('returns null for a user who is no longer a member (no profile query at all)', async () => {
    const { supabase, queries } = makeSupabase({
      memberRows: [],
      profileRows: [{ id: 'user-1', email: 'user@example.com' }],
    })

    expect(await resolveMemberEmail(supabase, 'company-1', 'user-1')).toBeNull()
    expect(queries.some((q) => q.table === 'profiles')).toBe(false)
  })

  it('returns null when the profile has no email', async () => {
    const { supabase } = makeSupabase({
      memberRows: [{ user_id: 'user-1' }],
      profileRows: [{ id: 'user-1', email: null }],
    })
    expect(await resolveMemberEmail(supabase, 'company-1', 'user-1')).toBeNull()
  })

  it('logs and returns null (never throws) on a member query error', async () => {
    const { supabase } = makeSupabase({
      membersError: { message: 'permission denied for table company_members' },
    })
    expect(await resolveMemberEmail(supabase, 'company-1', 'user-1')).toBeNull()
    expect(warnedWith('could not read company members')).toBe(true)
  })

  it('logs and returns null (never throws) on a profile query error', async () => {
    const { supabase } = makeSupabase({
      memberRows: [{ user_id: 'user-1' }],
      profilesError: { message: 'timeout' },
    })
    expect(await resolveMemberEmail(supabase, 'company-1', 'user-1')).toBeNull()
    expect(warnedWith('could not read profile email')).toBe(true)
  })
})

describe('resolveMemberEmails', () => {
  it('maps every member with a profile email, keyed by user id', async () => {
    const { supabase, queries } = makeSupabase({
      memberRows: [{ user_id: 'user-1' }, { user_id: 'user-2' }, { user_id: 'user-3' }],
      profileRows: [
        { id: 'user-1', email: 'owner@example.com' },
        { id: 'user-2', email: 'revisor@byra.se' },
        { id: 'user-3', email: null },
      ],
    })

    const emails = await resolveMemberEmails(supabase, 'company-1')

    expect(emails.get('user-1')).toBe('owner@example.com')
    expect(emails.get('user-2')).toBe('revisor@byra.se')
    expect(emails.has('user-3')).toBe(false)
    const memberQuery = queries.find((q) => q.table === 'company_members')
    expect(memberQuery?.columns).toBe('user_id')
    const profileQuery = queries.find((q) => q.table === 'profiles')
    expect(profileQuery?.columns).toBe('id, email')
    expect(profileQuery?.filters).toMatchObject({ id: ['user-1', 'user-2', 'user-3'] })
  })

  it('returns an empty map for a company with no members (no profile query)', async () => {
    const { supabase, queries } = makeSupabase({ memberRows: [] })
    const emails = await resolveMemberEmails(supabase, 'company-1')
    expect(emails.size).toBe(0)
    expect(queries.some((q) => q.table === 'profiles')).toBe(false)
  })

  it('logs and returns an empty map on a member query error', async () => {
    const { supabase } = makeSupabase({
      membersError: { message: 'permission denied for table company_members' },
    })
    const emails = await resolveMemberEmails(supabase, 'company-1')
    expect(emails.size).toBe(0)
    expect(warnedWith('could not read company members')).toBe(true)
  })

  it('logs and returns an empty map on a profiles query error', async () => {
    const { supabase } = makeSupabase({
      memberRows: [{ user_id: 'user-1' }],
      profilesError: { message: 'timeout' },
    })
    const emails = await resolveMemberEmails(supabase, 'company-1')
    expect(emails.size).toBe(0)
    expect(warnedWith('could not read member emails')).toBe(true)
  })
})
