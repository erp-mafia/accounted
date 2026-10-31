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

import { resolveMemberEmail } from '../member-email'

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
      maybeSingle: async () => {
        const r = result()
        const rows = r.data as Array<Record<string, unknown>> | null
        return { data: rows?.[0] ?? null, error: r.error }
      },
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
  function batchSupabase(memberIds: string[], profiles: Array<{ id: string; email: string | null; deleted_at: string | null }>) {
    const asked: Record<string, unknown[]> = {}
    const chain = (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: (_column: string, ids: unknown[]) => {
          asked[table] = ids
          return builder
        },
        then: (resolve: (v: unknown) => void) =>
          resolve(
            table === 'company_members'
              ? { data: memberIds.map((user_id) => ({ user_id })), error: null }
              : { data: profiles.filter((p) => (asked.profiles ?? []).includes(p.id)), error: null },
          ),
      }
      return builder
    }
    return { supabase: { from: chain } as unknown as SupabaseClient, asked }
  }

  it('keys each active member to their address, leaving out non-members, deleted accounts and empty addresses', async () => {
    const { resolveMemberEmails } = await import('../member-email')
    const { supabase, asked } = batchSupabase(
      ['u-member', 'u-deleted', 'u-blank'],
      [
        { id: 'u-member', email: ' anna@example.se ', deleted_at: null },
        { id: 'u-deleted', email: 'gone@example.se', deleted_at: '2026-10-01T00:00:00Z' },
        { id: 'u-blank', email: '  ', deleted_at: null },
        { id: 'u-former', email: 'former@example.se', deleted_at: null },
      ],
    )

    const emails = await resolveMemberEmails(supabase, 'company-1', ['u-member', 'u-deleted', 'u-blank', 'u-former'])

    expect([...emails]).toEqual([['u-member', 'anna@example.se']])
    // Only members' profiles are read.
    expect(asked.profiles).toEqual(['u-member', 'u-deleted', 'u-blank'])
  })

  it('reads nothing for nobody', async () => {
    const { resolveMemberEmails } = await import('../member-email')
    const from = vi.fn()
    expect((await resolveMemberEmails({ from } as unknown as SupabaseClient, 'company-1', [])).size).toBe(0)
    expect(from).not.toHaveBeenCalled()
  })
})
