import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  configured: vi.fn(),
  recipients: vi.fn(),
  sender: vi.fn(),
  entitled: vi.fn(),
  standings: vi.fn(),
  skvEnabled: vi.fn(),
  systemActive: vi.fn(),
  logo: vi.fn(),
}))
vi.mock('@/lib/email/service', () => ({
  getEmailService: async () => ({ sendEmail: (...a: unknown[]) => mocks.sendEmail(...a), isConfigured: () => mocks.configured() }),
}))
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultForCompany: (...a: unknown[]) => mocks.sender(...a),
}))
vi.mock('@/lib/email/brand-sender', () => ({
  getSenderForBrand: (brand: { appName: string; supportEmail: string } | null) =>
    brand
      ? { fromName: brand.appName, fromAddress: null, replyTo: brand.supportEmail, brand }
      : { fromName: null, fromAddress: null, replyTo: null, brand: null },
  getBaseUrlForBrand: (brand: { domain: string } | null) => (brand ? `https://${brand.domain}` : 'https://app.accounted.se'),
}))
vi.mock('@/lib/notifications/member-email', () => ({
  resolveCompanyAdminRecipients: (...a: unknown[]) => mocks.recipients(...a),
}))
vi.mock('@/lib/entitlements/has-capability', () => ({
  getCompanyIdsWithCapability: (...a: unknown[]) => mocks.entitled(...a),
}))
vi.mock('@/lib/skatteverket/enabled', () => ({ isSkatteverketEnabled: () => mocks.skvEnabled() }))
vi.mock('../lib/resolve-auth', () => ({
  currentSkvEnvironment: () => 'production',
  isSystemReadActive: () => mocks.systemActive(),
}))
vi.mock('../lib/connection-store', () => ({
  getOmbudClaimStandings: (...a: unknown[]) => mocks.standings(...a),
}))
vi.mock('@/lib/signing/logo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/signing/logo')>()),
  resolveSigningLogo: (...a: unknown[]) => mocks.logo(...a),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import {
  OMBUD_ANNOUNCEMENT,
  ombudAnnouncementMailsEnabled,
  ombudAnnouncementSkip,
  runOmbudAnnouncementCron,
  type OmbudAnnouncementFacts,
} from '../lib/ombud-announcement'

const NOW = new Date('2026-11-10T07:15:00Z')
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ANNA = '11111111-1111-4111-8111-111111111111'
const BO = '22222222-2222-4222-8222-222222222222'

const BRAND = {
  id: 'brand-1',
  teamId: 'team-1',
  domain: 'app.byran.se',
  appName: 'Byråappen',
  logoUrl: null,
  faviconUrl: null,
  brandColor: '#000000',
  chromeColor: null,
  fontKey: 'default',
  supportEmail: 'hjalp@byran.se',
  authEmailFrom: null,
  senderDomain: null,
  senderDomainStatus: 'unverified' as const,
  resendDomainId: null,
  signupMode: 'open' as const,
}
/** What resolveBrandResultForCompany answers for a platform company and a white-label one. */
const PLATFORM_SENDER = { brand: null, lookupFailed: false }
const BRAND_SENDER = { brand: BRAND, lookupFailed: false }

const facts = (overrides: Partial<OmbudAnnouncementFacts> = {}): OmbudAnnouncementFacts => ({
  entitled: true,
  connection: null,
  orgNumber: '165560000001',
  claim: 'clear',
  ...overrides,
})

const conn = (status: string, lasombud = 'unknown', moms = 'unknown') => ({
  status,
  lasombud_status: lasombud,
  moms_ombud_status: moms,
  last_probe_detail: null,
})

/** The audit log names these companies; settings give each a valid org number. */
function stub(options: {
  used?: string[]
  connections?: Array<Record<string, unknown>>
  told?: Array<{ company_id: string; user_id: string }>
  settings?: Array<Record<string, unknown>>
} = {}) {
  const used = options.used ?? [A]
  const mock = createTableMockSupabase({
    skatteverket_api_audit_log: { data: used.flatMap((id) => [{ company_id: id }, { company_id: id }]) },
    skatteverket_company_connections: { data: options.connections ?? [] },
    company_settings: {
      data:
        options.settings ??
        used.map((id, i) => ({ company_id: id, org_number: `556000000${i}`, entity_type: 'aktiebolag', company_name: `Bolag ${i + 1} AB` })),
    },
    company_announcement_mails: ((chain: Array<{ method: string; args: unknown[] }>) => {
      if (chain.some((c) => c.method === 'upsert')) {
        const rows = chain.find((c) => c.method === 'upsert')!.args[0] as Array<{ company_id: string }>
        return { data: rows.map((r) => ({ company_id: r.company_id })) }
      }
      if (chain.some((c) => c.method === 'delete')) return { data: null }
      return { data: options.told ?? [] }
    }) as unknown as TableMockResult,
  })
  return { ...mock, service: mock.supabase as unknown as SupabaseClient }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS', 'true')
  mocks.skvEnabled.mockReturnValue(true)
  mocks.systemActive.mockReturnValue(true)
  mocks.configured.mockReturnValue(true)
  mocks.sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
  mocks.recipients.mockResolvedValue([{ userId: ANNA, email: 'anna@example.se' }])
  mocks.sender.mockResolvedValue(PLATFORM_SENDER)
  mocks.entitled.mockImplementation(async (_s: unknown, ids: string[]) => new Set(ids))
  mocks.standings.mockImplementation(async (claims: Array<{ companyId: string }>) => new Map(claims.map((c) => [c.companyId, 'clear'])))
  mocks.logo.mockResolvedValue(null)
})
afterEach(() => vi.unstubAllEnvs())

describe('ombudAnnouncementMailsEnabled', () => {
  it('is on only for exactly "true"', () => {
    expect(ombudAnnouncementMailsEnabled({ SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    for (const value of [undefined, '', 'TRUE', '1', 'yes', 'false']) {
      expect(ombudAnnouncementMailsEnabled({ SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS: value } as unknown as NodeJS.ProcessEnv)).toBe(false)
    }
  })
})

describe('ombudAnnouncementSkip', () => {
  it('offers the button to an entitled company with a clear org number and no appointment', () => {
    expect(ombudAnnouncementSkip(facts())).toBeNull()
  })

  it('still offers it while the company waits on Skatteverket (pending row) or after a withdrawal', () => {
    expect(ombudAnnouncementSkip(facts({ connection: conn('pending', 'denied', 'denied') }))).toBeNull()
    expect(ombudAnnouncementSkip(facts({ connection: conn('error', 'error', 'error') }))).toBeNull()
  })

  it('names each reason a company is left out', () => {
    expect(ombudAnnouncementSkip(facts({ entitled: false }))).toBe('not_entitled')
    expect(ombudAnnouncementSkip(facts({ connection: conn('verified', 'granted', 'granted') }))).toBe('already_appointed')
    expect(ombudAnnouncementSkip(facts({ connection: conn('partial', 'granted', 'denied') }))).toBe('already_appointed')
    expect(ombudAnnouncementSkip(facts({ connection: conn('revoked', 'granted', 'granted') }))).toBe('disconnected')
    expect(ombudAnnouncementSkip(facts({ orgNumber: null }))).toBe('no_org_number')
    expect(ombudAnnouncementSkip(facts({ claim: 'unproven' }))).toBe('org_number_contested')
    expect(ombudAnnouncementSkip(facts({ claim: 'proven_twice' }))).toBe('org_number_contested')
  })
})

describe('runOmbudAnnouncementCron', () => {
  it('reads nothing and sends nothing while the button does not work here', async () => {
    mocks.systemActive.mockReturnValue(false)
    const { service, tables } = stub()
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(result.ombud_enabled).toBe(false)
    expect(tables()).toEqual([])
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('with the flag off answers the counts and sends and logs nothing', async () => {
    vi.stubEnv('SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS', 'false')
    mocks.recipients.mockImplementation(async (_s: unknown, companyId: string) =>
      companyId === A
        ? [{ userId: ANNA, email: 'anna@example.se' }, { userId: BO, email: 'bo@example.se' }]
        : [{ userId: ANNA, email: 'anna@example.se' }],
    )
    const { service, payloads } = stub({ used: [A, B] })
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(result).toMatchObject({ ombud_enabled: true, mails: false, used_recently: 2, eligible_companies: 2, recipients: 2, mails_due: 2, sent: 0 })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(payloads('company_announcement_mails', 'upsert')).toEqual([])
  })

  it('counts every skip reason', async () => {
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const G = '99999999-9999-4999-8999-999999999999'
    const H = '88888888-8888-4888-8888-888888888888'
    mocks.entitled.mockResolvedValue(new Set([B, C, D, E, F, G, H]))
    mocks.standings.mockImplementation(async (claims: Array<{ companyId: string }>) =>
      new Map(claims.map((c) => [c.companyId, c.companyId === E ? 'unproven' : 'clear'])),
    )
    mocks.recipients.mockImplementation(async (_s: unknown, companyId: string) => (companyId === F ? [] : [{ userId: ANNA, email: 'anna@example.se' }]))
    const { service } = stub({
      used: [A, B, C, D, E, F, G, H],
      connections: [
        { company_id: B, ...conn('verified', 'granted', 'granted') },
        { company_id: C, ...conn('revoked', 'granted', 'granted') },
      ],
      settings: [A, B, C, E, F, G, H].map((id) => ({ company_id: id, org_number: '5560000001', entity_type: 'aktiebolag', company_name: 'Bolaget AB' })),
      told: [{ company_id: G, user_id: ANNA }],
    })
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(result.skipped).toEqual({
      not_entitled: 1,
      already_appointed: 1,
      disconnected: 1,
      no_org_number: 1,
      org_number_contested: 1,
      no_recipient: 1,
      already_sent: 1,
      brand_unreadable: 0,
    })
    expect(result.eligible_companies).toBe(1)
    expect(result.sent).toBe(1)
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('looks only at the last 30 days of Skatteverket use', async () => {
    const { service, findCall } = stub()
    await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(findCall('skatteverket_api_audit_log', 'gte')).toEqual(['created_at', '2026-10-11T07:15:00.000Z'])
  })

  it('sends a person one mail naming every company of theirs, and logs each pair before it goes', async () => {
    mocks.recipients.mockImplementation(async (_s: unknown, companyId: string) =>
      companyId === A
        ? [{ userId: ANNA, email: 'anna@example.se' }, { userId: BO, email: 'bo@example.se' }]
        : [{ userId: ANNA, email: 'anna@example.se' }],
    )
    const { service, payloads } = stub({ used: [A, B] })
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(result).toMatchObject({ eligible_companies: 2, recipients: 2, mails_due: 2, sent: 2, failed: 0 })
    const toAnna = mocks.sendEmail.mock.calls.map((c) => c[0]).find((m) => m.to === 'anna@example.se')
    expect(toAnna.subject).toBe('Nu slipper du logga in med BankID för skattekontot')
    expect(toAnna.text).toContain('Det gäller Bolag 1 AB och Bolag 2 AB.')
    expect(payloads('company_announcement_mails', 'upsert')).toEqual([
      [
        { announcement: OMBUD_ANNOUNCEMENT, company_id: A, user_id: ANNA },
        { announcement: OMBUD_ANNOUNCEMENT, company_id: B, user_id: ANNA },
      ],
      [{ announcement: OMBUD_ANNOUNCEMENT, company_id: A, user_id: BO }],
    ])
  })

  it('never tells a person twice about the same company', async () => {
    const { service, payloads } = stub({ told: [{ company_id: A, user_id: ANNA }] })
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(result.skipped.already_sent).toBe(1)
    expect(result.mails_due).toBe(0)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(payloads('company_announcement_mails', 'upsert')).toEqual([])
  })

  it('leaves a pair another run logged first to that run', async () => {
    const { service, setTable } = stub()
    setTable('company_announcement_mails', ((chain: Array<{ method: string }>) =>
      chain.some((c) => c.method === 'upsert') ? { data: [] } : { data: [] }) as unknown as TableMockResult)
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(result.sent).toBe(0)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('mails in the company brand: its sender, name, domain and sign-off', async () => {
    mocks.sender.mockResolvedValue(BRAND_SENDER)
    const { service } = stub()
    await runOmbudAnnouncementCron(service, log, { now: NOW })
    const mail = mocks.sendEmail.mock.calls[0][0]
    expect(mail.fromName).toBe('Byråappen')
    expect(mail.replyTo).toBe('hjalp@byran.se')
    expect(mail.html).toContain('https://app.byran.se/settings/skatteverket')
    expect(mail.text).toContain('Nu kan du utse Byråappen som ombud')
    expect(mail.text).toContain('Med vänliga hälsningar,\nByråappen')
    expect(mail.text).not.toContain('Accounted')
    expect(mail.text).not.toContain('//Emil')
  })

  it('signs the platform mail as the founder and replies to support', async () => {
    const { service } = stub()
    await runOmbudAnnouncementCron(service, log, { now: NOW })
    const mail = mocks.sendEmail.mock.calls[0][0]
    expect(mail.text).toContain('//Emil')
    expect(mail.text).toContain('https://app.accounted.se/settings/skatteverket')
    expect(mail.replyTo).toBeTruthy()
    expect(mail.fromName).toBeUndefined()
  })

  it('waits, rather than send the platform mail, when the brand cannot be read', async () => {
    mocks.sender.mockResolvedValue({ brand: null, lookupFailed: true })
    const { service, payloads } = stub()
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(result).toMatchObject({ eligible_companies: 0, mails_due: 0, sent: 0 })
    expect(result.skipped.brand_unreadable).toBe(1)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(payloads('company_announcement_mails', 'upsert')).toEqual([])
  })

  it('a person in two brands gets one mail per brand', async () => {
    mocks.sender.mockImplementation(async (companyId: string) => (companyId === A ? BRAND_SENDER : PLATFORM_SENDER))
    const { service } = stub({ used: [A, B] })
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(result).toMatchObject({ recipients: 1, mails_due: 2, sent: 2 })
  })

  it('releases the log when the provider refused the mail, and keeps it when the outcome is unknown', async () => {
    mocks.sendEmail.mockResolvedValueOnce({ success: false, error: 'invalid address', outcomeUnknown: false })
    const refused = stub()
    let result = await runOmbudAnnouncementCron(refused.service, log, { now: NOW })
    expect(result.failed).toBe(1)
    expect(refused.findCalls('company_announcement_mails', 'delete')).toHaveLength(1)

    mocks.sendEmail.mockResolvedValueOnce({ success: false, error: 'timeout', outcomeUnknown: true })
    const unknown = stub()
    result = await runOmbudAnnouncementCron(unknown.service, log, { now: NOW })
    expect(result.failed).toBe(1)
    expect(unknown.findCalls('company_announcement_mails', 'delete')).toHaveLength(0)
  })

  it('leaves what it has no time for to the next run', async () => {
    const { service, payloads } = stub()
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW, deadline: Date.now() - 1 })
    expect(result).toMatchObject({ mails_due: 1, deferred: 1, sent: 0 })
    expect(payloads('company_announcement_mails', 'upsert')).toEqual([])
  })

  it('sends nothing without an email provider', async () => {
    mocks.configured.mockReturnValue(false)
    const { service } = stub()
    const result = await runOmbudAnnouncementCron(service, log, { now: NOW })
    expect(result).toMatchObject({ not_configured: true, sent: 0, mails_due: 1 })
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('throws rather than announce when the connection rows cannot be read', async () => {
    const { service, setTable } = stub()
    setTable('skatteverket_company_connections', { data: null, error: { message: 'boom' } })
    await expect(runOmbudAnnouncementCron(service, log, { now: NOW })).rejects.toThrow(/connections unreadable/)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })
})

describe('the roles the mail says are pre-selected', () => {
  it('are the two the deep link asks for: skol and momsdeklaration_ombud', async () => {
    const { OMBUD_ROLE_KEYS, OMBUD_ROLES } = await import('../lib/ombud-client')
    expect(OMBUD_ROLE_KEYS).toEqual(['lasombud', 'moms_ombud'])
    expect(OMBUD_ROLES.lasombud.code).toBe('skol')
    expect(OMBUD_ROLES.moms_ombud.code).toBe('momsdeklaration_ombud')
  })
})

describe('before the log table is migrated', () => {
  it('still counts, and sends nothing because no mail can be logged first', async () => {
    const { service, setTable } = stub()
    setTable('company_announcement_mails', { data: null, error: { message: 'relation does not exist', code: '42P01' } } as TableMockResult)
    vi.stubEnv('SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS', 'false')
    expect(await runOmbudAnnouncementCron(service, log, { now: NOW })).toMatchObject({ eligible_companies: 1, mails_due: 1, sent: 0 })

    vi.stubEnv('SKATTEVERKET_OMBUD_ANNOUNCEMENT_MAILS', 'true')
    await expect(runOmbudAnnouncementCron(service, log, { now: NOW })).rejects.toThrow(/announcement log not written/)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })
})
