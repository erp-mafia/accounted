import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { createTableMockSupabase } from '@/tests/helpers'

const findCompanyTokenUser = vi.fn()
const hasOmbudReadAccess = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/resolve-auth', () => ({
  findCompanyTokenUser: (...a: unknown[]) => findCompanyTokenUser(...a),
  hasOmbudReadAccess: (...a: unknown[]) => hasOmbudReadAccess(...a),
}))

import {
  getSkvConnectionHealth,
  getSkvFilingReadiness,
  SKV_NEEDS_RECONSENT_MESSAGE,
} from '../skv-connection-health'

describe('SKV_NEEDS_RECONSENT_MESSAGE', () => {
  it('sends the user to the real settings path: Skatteverket lives under Kopplingar', () => {
    // Agents relay this to the user verbatim. "Inställningar → Skatteverket"
    // named a rail entry that no longer exists (the connection moved under
    // Kopplingar, lib/navigation/settings-sections.ts SETTINGS_SECTION_PARENT).
    const nav = sv.nav as Record<string, string>
    const settingsNav = sv.settings_nav as Record<string, string>
    expect(SKV_NEEDS_RECONSENT_MESSAGE).toContain(
      `${nav.settings} → ${settingsNav.connections} → ${settingsNav.skatteverket}`,
    )
  })

  it('states the real session length: about ten hours per BankID login, not one hour (crm#1442)', () => {
    // Prod data: the hourly cron keeps a consent alive until Skatteverket
    // refuses refreshes ~10 h after the BankID login (median 10.5 h). The old
    // "ca 1 timme" made a user who reconnects every morning think something
    // was broken on his side. The settings panel says the same thing.
    const connect = sv.settings_skatteverket_connect as Record<string, string>
    const connectEn = en.settings_skatteverket_connect as Record<string, string>
    for (const text of [SKV_NEEDS_RECONSENT_MESSAGE, connect.session_lifetime_note]) {
      expect(text).toContain('tio timmar')
      expect(text).not.toMatch(/1 timme|en timme/)
    }
    expect(connectEn.session_lifetime_note).toContain('ten hours')
    expect(connectEn.session_lifetime_note).not.toMatch(/one hour|1 hour/)
  })
})

// Filing readiness (crm#1263): the company's Skatteverket connection serves
// reads through any member's session, but momsdeklaration and AGI are filed
// on the CALLER's own BankID session. The agent briefing reported the company
// connection as active (another member had just connected) while validate and
// submit refused on the caller's own session, expired weeks before. `filing`
// answers the caller's question from the same token rows.

const COMPANY = 'company-1'
const CALLER = 'user-1'
const MEMBER = 'user-2'
const NOW = Date.parse('2026-10-16T10:06:00Z')
const MINUTE = 60_000

function tokenRow(
  userId: string,
  opts: { status?: string; expiresInMin: number; refreshCount?: number; refreshToken?: string | null; now?: number },
) {
  const now = opts.now ?? NOW
  return {
    user_id: userId,
    status: opts.status ?? 'active',
    created_at: new Date(now + (opts.expiresInMin - 60) * MINUTE).toISOString(),
    expires_at: new Date(now + opts.expiresInMin * MINUTE).toISOString(),
    refresh_count: opts.refreshCount ?? 0,
    refresh_token: opts.refreshToken === undefined ? 'ciphertext' : opts.refreshToken,
  }
}

function client(rows: unknown[], memberName: string | null = 'Anna Admin') {
  return createTableMockSupabase({
    skatteverket_tokens: { data: rows },
    profiles: { data: memberName === null ? null : { full_name: memberName } },
  })
}

describe('getSkvFilingReadiness', () => {
  it("ready when the caller's own access token is still valid", async () => {
    const { supabase } = client([tokenRow(CALLER, { expiresInMin: 30 })])
    expect(await getSkvFilingReadiness(supabase as never, COMPANY, CALLER, NOW)).toEqual({
      ready: true,
      own_session: 'active',
    })
  })

  it('ready inside the five-minute refresh window after expiry (the 65-minute rule)', async () => {
    const { supabase } = client([tokenRow(CALLER, { expiresInMin: -3 })])
    expect((await getSkvFilingReadiness(supabase as never, COMPANY, CALLER, NOW))?.ready).toBe(true)
  })

  it('expired past the refresh window, even while the row is still flagged active', async () => {
    const { supabase } = client([tokenRow(CALLER, { expiresInMin: -10 })])
    const filing = await getSkvFilingReadiness(supabase as never, COMPANY, CALLER, NOW)
    expect(filing).toMatchObject({ ready: false, own_session: 'expired' })
    expect(filing?.message).toContain('has expired')
    expect(filing?.message).toContain('gnubok_connect_skatteverket')
  })

  it("crm#1263: another member's live session is named, never counted as the caller's", async () => {
    const { supabase, findCall } = client([
      tokenRow(MEMBER, { expiresInMin: 57 }),
      tokenRow(CALLER, { status: 'needs_reconsent', expiresInMin: -26 * 24 * 60 }),
    ])
    const filing = await getSkvFilingReadiness(supabase as never, COMPANY, CALLER, NOW)
    expect(filing).toMatchObject({ ready: false, own_session: 'expired' })
    expect(filing?.message).toContain('belongs to Anna Admin, another member of the company')
    expect(filing?.message).toContain('never used to validate or file for you')
    expect(filing?.message).toContain('ask Anna Admin to file from their own Accounted login')
    // The name is the member's, looked up by their id.
    expect(findCall('profiles', 'eq')).toEqual(['id', MEMBER])
  })

  it('a caller who never connected is told so; an unnamed member stays generic', async () => {
    const { supabase } = client([tokenRow(MEMBER, { expiresInMin: 40 })], null)
    const filing = await getSkvFilingReadiness(supabase as never, COMPANY, CALLER, NOW)
    expect(filing).toMatchObject({ ready: false, own_session: 'none' })
    expect(filing?.message).toContain('You have not connected your own')
    expect(filing?.message).toContain('belongs to another member of the company')
    expect(filing?.message).toContain('ask that member to file')
  })

  it('a member row flagged needs_reconsent is not offered as the live connection', async () => {
    const { supabase, findCall } = client([
      tokenRow(MEMBER, { status: 'needs_reconsent', expiresInMin: -120 }),
      tokenRow(CALLER, { status: 'needs_reconsent', expiresInMin: -120 }),
    ])
    const filing = await getSkvFilingReadiness(supabase as never, COMPANY, CALLER, NOW)
    expect(filing).toMatchObject({ ready: false, own_session: 'expired' })
    expect(filing?.message).not.toContain('belongs to')
    expect(findCall('profiles', 'select')).toBeUndefined()
  })

  it('answers null when the token rows cannot be read', async () => {
    const { supabase } = createTableMockSupabase({
      skatteverket_tokens: { data: null, error: { message: 'boom' } },
    })
    expect(await getSkvFilingReadiness(supabase as never, COMPANY, CALLER, NOW)).toBeNull()
  })
})

describe('getSkvConnectionHealth with the caller', () => {
  const originalEnabled = process.env.SKATTEVERKET_ENABLED
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SKATTEVERKET_ENABLED = 'true'
    hasOmbudReadAccess.mockResolvedValue(false)
  })
  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.SKATTEVERKET_ENABLED
    else process.env.SKATTEVERKET_ENABLED = originalEnabled
  })

  it('crm#1263: status stays the company truth (active), filing says this caller cannot file', async () => {
    // Real clock: getSkvConnectionHealth reads Date.now().
    const memberRow = tokenRow(MEMBER, { expiresInMin: 57, now: Date.now() })
    findCompanyTokenUser.mockResolvedValue({ userId: MEMBER, needsReconsent: false, createdAt: memberRow.created_at })
    const { supabase } = client([
      memberRow,
      tokenRow(CALLER, { status: 'needs_reconsent', expiresInMin: -26 * 24 * 60, now: Date.now() }),
    ])
    const health = await getSkvConnectionHealth(supabase as never, COMPANY, CALLER)
    expect(health).toMatchObject({
      status: 'active',
      source: 'user',
      connected_at: memberRow.created_at,
      filing: { ready: false, own_session: 'expired' },
    })
    expect(health?.filing?.message).toContain('Anna Admin')
  })

  it('reads on the ombud grant still report what filing needs: a personal session', async () => {
    hasOmbudReadAccess.mockResolvedValue(true)
    const { supabase } = client([])
    const health = await getSkvConnectionHealth(supabase as never, COMPANY, CALLER)
    expect(health).toMatchObject({ status: 'active', source: 'system', filing: { ready: false, own_session: 'none' } })
  })

  it('without a caller, no filing block (the shape every other consumer had)', async () => {
    findCompanyTokenUser.mockResolvedValue({ userId: MEMBER, needsReconsent: false, createdAt: null })
    const { supabase } = client([tokenRow(MEMBER, { expiresInMin: 57 })])
    const health = await getSkvConnectionHealth(supabase as never, COMPANY)
    expect(health).toEqual({ status: 'active', source: 'user', connected_at: null })
  })
})
