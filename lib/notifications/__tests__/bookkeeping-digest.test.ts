/**
 * The "nytt att bokföra" digest: opt-in sweep, empty-skip, the recoverable
 * claim lifecycle (pending -> send -> sent, stale takeover), and the
 * counts-only email body.
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
  companyName?: string
  claimError?: { code?: string; message: string } | null
  /** Row returned when acquireClaim inspects an existing claim after 23505. */
  existingClaim?: { id: string; delivery_status: string; sent_at: string | null } | null
  /** Whether the stale-takeover lease UPDATE wins (returns the row). */
  leaseWon?: boolean
}

interface RecordedWrite {
  table: string
  op: 'insert' | 'update' | 'delete'
  payload?: Record<string, unknown>
}

/**
 * Hand-rolled mock: the assertions need recorded write payloads and order
 * (claim insert before send, sent-update after), which
 * createQueuedMockSupabase cannot key by table.
 */
function makeSupabase(fx: TableFixture) {
  const writes: RecordedWrite[] = []
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
  const from = (table: string) => {
    const builder: Record<string, unknown> = {}
    const finish = () => {
      if (table === 'notification_settings') return { data: fx.optedIn ?? [], error: null }
      if (table === 'company_members') return { data: fx.members ?? [], error: null }
      if (table === 'profiles') {
        const ids = new Set((fx.members ?? []).map((m) => m.user_id))
        return {
          data: [...ids].map((id) => ({ id, email: `${id}@testbrand.example` })),
          error: null,
        }
      }
      return { data: [], error: null }
    }
    Object.assign(builder, {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (table === 'transactions' && opts?.head) return countBuilder(fx.txCount ?? 0)
        if (table === 'invoice_inbox_items' && opts?.head) return countBuilder(fx.inboxCount ?? 0)
        return builder
      },
      insert: (payload: Record<string, unknown>) => {
        writes.push({ table, op: 'insert', payload })
        return Promise.resolve({ data: null, error: fx.claimError ?? null })
      },
      update: (payload: Record<string, unknown>) => {
        writes.push({ table, op: 'update', payload })
        const ub: Record<string, unknown> = {}
        Object.assign(ub, {
          eq: () => ub,
          lte: () => ub,
          // The lease-renewal UPDATE ends in .select('id'): winning returns
          // the row, losing returns [].
          select: () =>
            Promise.resolve({ data: fx.leaseWon ? [{ id: 'claim-1' }] : [], error: null }),
          then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
        })
        return ub
      },
      delete: () => {
        writes.push({ table, op: 'delete' })
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
        if (table === 'companies') {
          return { data: { name: fx.companyName ?? 'Testbolaget AB' }, error: null }
        }
        if (table === 'notification_log') {
          return { data: fx.existingClaim ?? null, error: null }
        }
        return { data: null, error: null }
      },
      then: (resolve: (v: unknown) => void) => resolve(finish()),
    })
    return builder
  }
  return { supabase: { from } as unknown as SupabaseClient, writes }
}

const NOW = new Date('2026-08-31T05:45:00Z')

const oneUserOneCompany = {
  optedIn: [{ user_id: 'u1' }],
  members: [{ user_id: 'u1', company_id: 'c1' }],
}

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
    const { supabase, writes } = makeSupabase({ optedIn: [] })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary).toMatchObject({ optedInUsers: 0, sent: 0 })
    expect(writes).toHaveLength(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('skips companies with nothing new instead of sending empty mail', async () => {
    const { supabase } = makeSupabase({ ...oneUserOneCompany, txCount: 0, inboxCount: 0 })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.skippedEmpty).toBe(1)
    expect(summary.sent).toBe(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('claims as pending BEFORE sending, marks sent only after the provider accepted', async () => {
    const { supabase, writes } = makeSupabase({ ...oneUserOneCompany, txCount: 3, inboxCount: 1 })
    let claimsAtSendTime = -1
    mockSendEmail.mockImplementation(async () => {
      claimsAtSendTime = writes.filter((w) => w.op === 'insert').length
      return { success: true }
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.sent).toBe(1)
    expect(claimsAtSendTime).toBe(1)
    const insert = writes.find((w) => w.op === 'insert')
    expect(insert?.table).toBe('notification_log')
    expect(insert?.payload).toMatchObject({
      user_id: 'u1',
      company_id: 'c1',
      notification_type: 'bookkeeping_digest',
      delivery_status: 'pending',
    })
    // Flipped to 'sent' only after sendEmail resolved successfully.
    const sentUpdate = writes.find(
      (w) => w.op === 'update' && w.payload?.delivery_status === 'sent',
    )
    expect(sentUpdate).toBeDefined()
    const mail = mockSendEmail.mock.calls[0][0]
    expect(mail.to).toBe('u1@testbrand.example')
    expect(mail.subject).toContain('Nytt att bokföra')
    expect(mail.text).toContain('3 nya banktransaktioner')
    expect(mail.text).toContain('1 nytt underlag')
    // Data minimization: counts only, never amounts.
    expect(mail.text).not.toMatch(/\d+[.,]\d{2}\s*(kr|SEK)/i)
  })

  it('a 23505 with an already-sent claim means another run delivered today: no email', async () => {
    const { supabase } = makeSupabase({
      ...oneUserOneCompany,
      txCount: 2,
      claimError: { code: '23505', message: 'duplicate key' },
      existingClaim: { id: 'claim-1', delivery_status: 'sent', sent_at: NOW.toISOString() },
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.skippedDuplicate).toBe(1)
    expect(summary.sent).toBe(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('a fresh pending claim belongs to a run in flight: no takeover, no email', async () => {
    const { supabase } = makeSupabase({
      ...oneUserOneCompany,
      txCount: 2,
      claimError: { code: '23505', message: 'duplicate key' },
      existingClaim: {
        id: 'claim-1',
        delivery_status: 'pending',
        sent_at: new Date(Date.now() - 60_000).toISOString(),
      },
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.skippedDuplicate).toBe(1)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('takes over a STALE pending claim (a run that died before sending) and sends', async () => {
    const { supabase, writes } = makeSupabase({
      ...oneUserOneCompany,
      txCount: 2,
      claimError: { code: '23505', message: 'duplicate key' },
      existingClaim: {
        id: 'claim-1',
        delivery_status: 'pending',
        sent_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
      leaseWon: true,
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.sent).toBe(1)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    // Lease renewal update happened before the send-completion update.
    expect(writes.filter((w) => w.op === 'update').length).toBeGreaterThanOrEqual(2)
  })

  it('loses the stale-takeover race cleanly: no email', async () => {
    const { supabase } = makeSupabase({
      ...oneUserOneCompany,
      txCount: 2,
      claimError: { code: '23505', message: 'duplicate key' },
      existingClaim: {
        id: 'claim-1',
        delivery_status: 'pending',
        sent_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
      leaseWon: false,
    })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.skippedDuplicate).toBe(1)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('keeps the claim pending when the send fails, so a later run can retry', async () => {
    mockSendEmail.mockResolvedValue({ success: false, error: 'smtp down' })
    const { supabase, writes } = makeSupabase({ ...oneUserOneCompany, txCount: 2 })

    const summary = await runBookkeepingDigest(supabase, NOW)

    expect(summary.failed).toBe(1)
    expect(summary.sent).toBe(0)
    // The claim is neither deleted nor marked sent: it stays 'pending' and
    // becomes takeover-eligible once stale.
    expect(writes.some((w) => w.op === 'delete')).toBe(false)
    expect(
      writes.some((w) => w.op === 'update' && w.payload?.delivery_status === 'sent'),
    ).toBe(false)
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

  it('strips CRLF from the company name so it cannot inject mail headers', async () => {
    const { supabase } = makeSupabase({
      ...oneUserOneCompany,
      txCount: 1,
      companyName: 'Evil AB\r\nBcc: attacker@testbrand.example',
    })

    await runBookkeepingDigest(supabase, NOW)

    const mail = mockSendEmail.mock.calls[0][0]
    expect(mail.subject).not.toMatch(/[\r\n]/)
    expect(mail.subject).toBe('Nytt att bokföra i Evil AB Bcc: attacker@testbrand.example')
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
