/**
 * The "nytt att bokföra" digest: opt-in sweep, empty-skip, the atomic
 * claim-then-send dedup, and the counts-only email body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mockIsConfigured = vi.fn()
const mockSendEmail = vi.fn()
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: mockIsConfigured, sendEmail: mockSendEmail }),
}))

vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandForCompany: vi.fn(async () => null),
}))
vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appUrl: 'https://app.testbrand.example' }),
}))

import { runBookkeepingDigest, buildDigestEmail } from '../bookkeeping-digest'

interface TableFixture {
  optedIn?: Array<{ user_id: string }>
  members?: Array<{ user_id: string; company_id: string }>
  txCount?: number
  inboxCount?: number
  claimError?: { code?: string; message: string } | null
}

interface RecordedInsert {
  table: string
  payload: Record<string, unknown>
}

/**
 * Hand-rolled mock: the assertions need recorded insert payloads (the claim)
 * and per-table counts, which createQueuedMockSupabase cannot key by table.
 */
function makeSupabase(fx: TableFixture) {
  const inserts: RecordedInsert[] = []
  const deletes: string[] = []
  const from = (table: string) => {
    const builder: Record<string, unknown> = {}
    const finish = () => {
      if (table === 'notification_settings') {
        return { data: fx.optedIn ?? [], error: null, count: null }
      }
      if (table === 'company_members') {
        return { data: fx.members ?? [], error: null, count: null }
      }
      if (table === 'profiles') {
        const ids = new Set((fx.members ?? []).map((m) => m.user_id))
        return {
          data: [...ids].map((id) => ({ id, email: `${id}@testbrand.example` })),
          error: null,
          count: null,
        }
      }
      return { data: [], error: null, count: null }
    }
    Object.assign(builder, {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (table === 'transactions' && opts?.head) {
          return countBuilder(fx.txCount ?? 0)
        }
        if (table === 'invoice_inbox_items' && opts?.head) {
          return countBuilder(fx.inboxCount ?? 0)
        }
        return builder
      },
      insert: (payload: Record<string, unknown>) => {
        inserts.push({ table, payload })
        return Promise.resolve({ data: null, error: fx.claimError ?? null })
      },
      delete: () => {
        deletes.push(table)
        return builder
      },
      eq: () => builder,
      in: () => builder,
      gte: () => builder,
      not: () => builder,
      is: () => builder,
      order: () => builder,
      range: () => builder,
      maybeSingle: async () => {
        if (table === 'companies') return { data: { name: 'Testbolaget AB' }, error: null }
        return { data: null, error: null }
      },
      then: (resolve: (v: unknown) => void) => resolve(finish()),
    })
    return builder
  }
  const countBuilder = (count: number) => {
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      eq: () => b,
      gte: () => b,
      not: () => b,
      is: () => b,
      in: () => b,
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null, count }),
    })
    return b
  }
  return { supabase: { from } as unknown as SupabaseClient, inserts, deletes }
}

const NOW = new Date('2026-08-31T05:45:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  mockIsConfigured.mockReturnValue(true)
  mockSendEmail.mockResolvedValue({ success: true })
})

describe('runBookkeepingDigest', () => {
  it('does nothing when email is not configured', async () => {
    mockIsConfigured.mockReturnValue(false)
    const { supabase } = makeSupabase({ optedIn: [{ user_id: 'u1' }] })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.sent).toBe(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('does nothing when nobody opted in', async () => {
    const { supabase, inserts } = makeSupabase({ optedIn: [] })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary).toMatchObject({ optedInUsers: 0, sent: 0 })
    expect(inserts).toHaveLength(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('skips companies with nothing new instead of sending empty mail', async () => {
    const { supabase } = makeSupabase({
      optedIn: [{ user_id: 'u1' }],
      members: [{ user_id: 'u1', company_id: 'c1' }],
      txCount: 0,
      inboxCount: 0,
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.skippedEmpty).toBe(1)
    expect(summary.sent).toBe(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('claims the notification_log row BEFORE sending, with counts in the mail', async () => {
    const { supabase, inserts } = makeSupabase({
      optedIn: [{ user_id: 'u1' }],
      members: [{ user_id: 'u1', company_id: 'c1' }],
      txCount: 3,
      inboxCount: 1,
    })
    let claimsAtSendTime = -1
    mockSendEmail.mockImplementation(async () => {
      claimsAtSendTime = inserts.length
      return { success: true }
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.sent).toBe(1)
    expect(claimsAtSendTime).toBe(1)
    expect(inserts[0].table).toBe('notification_log')
    expect(inserts[0].payload).toMatchObject({
      user_id: 'u1',
      company_id: 'c1',
      notification_type: 'bookkeeping_digest',
      delivery_status: 'sent',
    })
    const mail = mockSendEmail.mock.calls[0][0]
    expect(mail.to).toBe('u1@testbrand.example')
    expect(mail.subject).toContain('Nytt att bokföra')
    expect(mail.text).toContain('3 nya banktransaktioner')
    expect(mail.text).toContain('1 nytt underlag')
    // Data minimization: counts only, never amounts.
    expect(mail.text).not.toMatch(/\d+[.,]\d{2}\s*(kr|SEK)/i)
  })

  it('a 23505 on the claim means another run already sent today: no email', async () => {
    const { supabase } = makeSupabase({
      optedIn: [{ user_id: 'u1' }],
      members: [{ user_id: 'u1', company_id: 'c1' }],
      txCount: 2,
      claimError: { code: '23505', message: 'duplicate key' },
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.skippedDuplicate).toBe(1)
    expect(summary.sent).toBe(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('releases the claim when the send fails so a retried run can resend', async () => {
    mockSendEmail.mockResolvedValue({ success: false, error: 'smtp down' })
    const { supabase, deletes } = makeSupabase({
      optedIn: [{ user_id: 'u1' }],
      members: [{ user_id: 'u1', company_id: 'c1' }],
      txCount: 2,
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.failed).toBe(1)
    expect(summary.sent).toBe(0)
    expect(deletes).toContain('notification_log')
  })

  it('sends to every opted-in member of the same company', async () => {
    const { supabase } = makeSupabase({
      optedIn: [{ user_id: 'u1' }, { user_id: 'u2' }],
      members: [
        { user_id: 'u1', company_id: 'c1' },
        { user_id: 'u2', company_id: 'c1' },
      ],
      txCount: 5,
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.sent).toBe(2)
    const recipients = mockSendEmail.mock.calls.map((c) => c[0].to).sort()
    expect(recipients).toEqual(['u1@testbrand.example', 'u2@testbrand.example'])
  })
})

describe('buildDigestEmail', () => {
  it('renders singular and plural Swedish correctly', () => {
    const one = buildDigestEmail({
      companyName: 'Testbolaget AB',
      counts: { newTransactions: 1, newInboxItems: 1 },
      baseUrl: 'https://app.testbrand.example',
      appName: 'Accounted',
    })
    expect(one.text).toContain('1 ny banktransaktion att bokföra')
    expect(one.text).toContain('1 nytt underlag i inkorgen')
    expect(one.subject).toBe('Nytt att bokföra i Testbolaget AB')

    const many = buildDigestEmail({
      companyName: null,
      counts: { newTransactions: 4, newInboxItems: 2 },
      baseUrl: 'https://app.testbrand.example',
      appName: 'Accounted',
    })
    expect(many.subject).toBe('Nytt att bokföra')
    expect(many.text).toContain('4 nya banktransaktioner att bokföra')
    expect(many.text).toContain('2 nya underlag i inkorgen')
  })

  it('omits the zero category', () => {
    const mail = buildDigestEmail({
      companyName: null,
      counts: { newTransactions: 2, newInboxItems: 0 },
      baseUrl: 'https://app.testbrand.example',
      appName: 'Accounted',
    })
    expect(mail.text).not.toContain('underlag i inkorgen')
  })

  it('escapes html in the company name', () => {
    const mail = buildDigestEmail({
      companyName: '<b>Evil & Co</b>',
      counts: { newTransactions: 1, newInboxItems: 0 },
      baseUrl: 'https://app.testbrand.example',
      appName: 'Accounted',
    })
    expect(mail.html).not.toContain('<b>Evil')
    expect(mail.html).toContain('&lt;b&gt;Evil &amp; Co&lt;/b&gt;')
  })
})
