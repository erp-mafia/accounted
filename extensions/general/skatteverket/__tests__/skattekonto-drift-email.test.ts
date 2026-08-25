/**
 * Recipient resolution for the skattekonto drift alert.
 *
 * The alert must reach the address the company actually configured
 * (company_settings.tax_contact_email, the "Kontaktperson för skatteärenden"
 * field in Inställningar > Skatt), and every path that silently downgrades to
 * the syncing user has to leave a log line: an alert delivered to the wrong
 * inbox is indistinguishable from no alert at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EventPayload } from '@/lib/events/types'

const { warnRecorder } = vi.hoisted(() => ({ warnRecorder: vi.fn() }))

// log.warn is suppressed under NODE_ENV=test, so the failure-path tests
// observe it through this mock instead of a console spy.
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

const mockIsConfigured = vi.fn()
const mockSendEmail = vi.fn()
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: mockIsConfigured, sendEmail: mockSendEmail }),
}))

// The handler builds its own SERVICE-ROLE client: the only emitter is the
// nightly cron, where the registry-built ctx is an anonymous (or absent)
// client that RLS would turn into "no members, no recipient".
const { serviceClientHolder } = vi.hoisted(() => ({
  serviceClientHolder: { current: null as unknown },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(() => serviceClientHolder.current),
}))

import { handleSkattekontoDriftDetected } from '../lib/skattekonto-drift-email'

interface QueryRecord {
  table: string
  columns?: string
  filters: Record<string, unknown>
}

type MemberRow = { user_id: string; email: string }

const OWNER: MemberRow = { user_id: 'user-1', email: 'owner@example.com' }
const ACCOUNTANT: MemberRow = { user_id: 'user-2', email: 'revisor@byra.se' }

/**
 * Hand-rolled mock (instead of createQueuedMockSupabase) because the
 * assertions need the selected COLUMN list per table: the bug this covers was
 * a select of a column that does not exist on company_settings.
 *
 * Recipient resolution is the two-step lookup from
 * lib/notifications/member-email: company_members yields user ids, profiles
 * yields their emails via an .in() read.
 */
function makeSupabase(
  opts: {
    members?: MemberRow[] | null
    membersError?: { message: string } | null
    profilesError?: { message: string } | null
    settings?: Record<string, unknown> | null
    settingsError?: { message: string } | null
  } = {},
) {
  const members = opts.members === undefined ? [OWNER] : opts.members ?? []
  const queries: QueryRecord[] = []
  const from = (table: string) => {
    const record: QueryRecord = { table, filters: {} }
    queries.push(record)
    const result = () => {
      if (table === 'company_members') {
        return {
          data: opts.membersError ? null : members.map((m) => ({ user_id: m.user_id })),
          error: opts.membersError ?? null,
        }
      }
      if (table === 'company_settings') {
        if (opts.settingsError) return { data: null, error: opts.settingsError }
        const row = opts.settings
        if (!row) return { data: null, error: null }
        // Project to the selected columns, like PostgREST does: reading a
        // column the handler did not ask for must not appear to work.
        const projected: Record<string, unknown> = {}
        for (const col of (record.columns ?? '').split(',').map((c) => c.trim())) {
          if (col in row) projected[col] = row[col]
        }
        return { data: projected, error: null }
      }
      if (table === 'profiles') {
        return {
          data: opts.profilesError
            ? null
            : members.map((m) => ({ id: m.user_id, email: m.email })),
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
      order: () => builder,
      range: () => builder,
      maybeSingle: async () => {
        const r = result()
        const rows = r.data as Array<Record<string, unknown>> | null
        return { data: Array.isArray(rows) ? rows[0] ?? null : rows, error: r.error }
      },
      then: (resolve: (v: unknown) => void) => resolve(result()),
    })
    return builder
  }
  return { supabase: { from } as unknown as SupabaseClient, queries }
}

/** Point the mocked createServiceClient at this test's supabase stub. */
function useServiceClient(supabase: SupabaseClient): void {
  serviceClientHolder.current = supabase
}

const payload: EventPayload<'skattekonto.drift_detected'> = {
  drift: -1250.5,
  saldoSkatteverket: 10000,
  glSum1630: 11250.5,
  fetchedAt: Date.UTC(2026, 5, 30),
  unbookedCount: 2,
  userId: 'user-1',
  companyId: 'company-1',
}

function sentTo(): string | undefined {
  return mockSendEmail.mock.calls[0]?.[0]?.to as string | undefined
}

function warnedWith(fragment: string): boolean {
  return warnRecorder.mock.calls.some(
    (call) => typeof call[0] === 'string' && call[0].includes(fragment),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsConfigured.mockReturnValue(true)
  mockSendEmail.mockResolvedValue({ success: true })
})

describe('handleSkattekontoDriftDetected recipient resolution', () => {
  it('sends to the configured tax contact when it belongs to an active member', async () => {
    const { supabase } = makeSupabase({
      members: [OWNER, ACCOUNTANT],
      settings: { tax_contact_email: ACCOUNTANT.email },
    })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(sentTo()).toBe(ACCOUNTANT.email)
  })

  it('reads tax_contact_email: the column the settings UI actually writes', async () => {
    const { supabase, queries } = makeSupabase({
      members: [OWNER, ACCOUNTANT],
      settings: { tax_contact_email: ACCOUNTANT.email },
    })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    const settingsQuery = queries.find((q) => q.table === 'company_settings')
    // Exact match, not `toContain`: 'tax_contact_email' contains the phantom
    // 'contact_email' as a substring, so a loose assertion would pass on the bug.
    expect(settingsQuery?.columns).toBe('tax_contact_email')
    expect(settingsQuery?.filters).toMatchObject({ company_id: 'company-1' })
  })

  it('matches the configured contact against members case-insensitively', async () => {
    const { supabase } = makeSupabase({
      members: [OWNER, ACCOUNTANT],
      settings: { tax_contact_email: 'Revisor@Byra.se' },
    })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    expect(sentTo()).toBe('Revisor@Byra.se')
  })

  it('falls back to the syncing user when no tax contact is configured', async () => {
    const { supabase } = makeSupabase({ members: [OWNER], settings: null })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    expect(sentTo()).toBe(OWNER.email)
  })

  it('refuses a tax contact that is not an active member, and says so', async () => {
    const { supabase } = makeSupabase({
      members: [OWNER],
      settings: { tax_contact_email: 'ex-admin@example.com' },
    })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    expect(sentTo()).toBe(OWNER.email)
    expect(warnedWith('not an active member')).toBe(true)
  })

  it('does not silently swallow a company_settings read error', async () => {
    const { supabase } = makeSupabase({
      members: [OWNER],
      settings: null,
      settingsError: { message: 'column company_settings.tax_contact_email does not exist' },
    })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    expect(warnedWith('could not read tax contact email')).toBe(true)
    // Still delivers to the documented fallback rather than dropping the alert.
    expect(sentTo()).toBe(OWNER.email)
  })

  it('does not silently swallow a member lookup error', async () => {
    const { supabase } = makeSupabase({
      members: null,
      membersError: { message: 'permission denied for table company_members' },
    })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    expect(warnedWith('could not read company members')).toBe(true)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does not silently swallow a member-email lookup error', async () => {
    const { supabase } = makeSupabase({
      members: [OWNER],
      settings: null,
      profilesError: { message: 'timeout' },
    })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    expect(warnedWith('could not read member emails')).toBe(true)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('sends nothing when the company has no members at all', async () => {
    const { supabase } = makeSupabase({ members: [] })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(warnedWith('no authorised recipient')).toBe(true)
  })

  it('skips quietly when no email service is configured', async () => {
    mockIsConfigured.mockReturnValue(false)
    const { supabase, queries } = makeSupabase({ members: [OWNER, ACCOUNTANT] })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(queries).toHaveLength(0)
  })

  it('keeps the drift figures out of the email body', async () => {
    const { supabase } = makeSupabase({
      members: [OWNER, ACCOUNTANT],
      settings: { tax_contact_email: ACCOUNTANT.email },
    })

    useServiceClient(supabase)
    await handleSkattekontoDriftDetected(payload)

    const body = `${mockSendEmail.mock.calls[0][0].text}${mockSendEmail.mock.calls[0][0].html}`
    expect(body).not.toContain('1250')
    expect(body).not.toContain('10000')
  })
})
