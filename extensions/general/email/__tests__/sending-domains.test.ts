import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  validateClaimableSendingDomain,
  mapResendSendingStatus,
  isSendingOnlyProfile,
  claimSendingDomain,
  checkSendingDomainVerification,
  updateSendingDomainSettings,
  removeSendingDomain,
  applySendingDomainStatusFromWebhook,
} from '@/extensions/general/email/lib/sending-domains'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

const { domainsMock } = vi.hoisted(() => ({
  domainsMock: {
    create: vi.fn(),
    get: vi.fn(),
    verify: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
  },
}))

vi.mock('resend', () => ({
  Resend: class {
    domains = domainsMock
  },
}))

const DKIM_RECORD = {
  record: 'DKIM',
  name: 'resend._domainkey.hansbolag.example',
  value: 'p=MIGf...',
  type: 'TXT',
  ttl: 'Auto',
  status: 'not_started',
}

const SENDING_ONLY = { sending: 'enabled', receiving: 'disabled' }

const ROW = {
  id: 'row-1',
  company_id: 'company-1',
  domain: 'hansbolag.example',
  status: 'pending',
  sender_local_part: 'faktura',
  sender_name: null,
  enabled: true,
  resend_domain_id: 'rd_1',
  dns_records: [DKIM_RECORD],
  verified_at: null,
  last_checked_at: null,
  created_at: '2026-08-22T00:00:00Z',
  updated_at: '2026-08-22T00:00:00Z',
}

function sb(): ReturnType<typeof createQueuedMockSupabase> & { client: SupabaseClient } {
  const m = createQueuedMockSupabase()
  return Object.assign(m, { client: m.supabase as unknown as SupabaseClient })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.RESEND_API_KEY = 'test-key'
  process.env.RESEND_FROM_EMAIL = 'noreply@platform.example'
  process.env.RESEND_INBOUND_DOMAIN = 'inbox.platform.example'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.platform.example'
})
afterEach(() => {
  delete process.env.RESEND_INBOUND_DOMAIN
})

describe('validateClaimableSendingDomain', () => {
  it('blocks public mailbox providers', () => {
    expect(validateClaimableSendingDomain('gmail.com')).toMatch(/Publika/)
  })

  it("blocks the platform's own sender domain, the inbound domain and the app host (and subdomains)", () => {
    expect(validateClaimableSendingDomain('platform.example')).toMatch(/reserverad/)
    expect(validateClaimableSendingDomain('mail.platform.example')).toMatch(/reserverad/)
    expect(validateClaimableSendingDomain('inbox.platform.example')).toMatch(/reserverad/)
    expect(validateClaimableSendingDomain('app.platform.example')).toMatch(/reserverad/)
  })

  it('allows an ordinary company domain', () => {
    expect(validateClaimableSendingDomain('hansbolag.example')).toBeNull()
  })
})

describe('mapResendSendingStatus', () => {
  it('maps verified and temporary_failure to verified, failures to failed, the rest to pending', () => {
    expect(mapResendSendingStatus('verified')).toBe('verified')
    expect(mapResendSendingStatus('temporary_failure')).toBe('verified')
    expect(mapResendSendingStatus('failed')).toBe('failed')
    expect(mapResendSendingStatus('partially_failed')).toBe('failed')
    expect(mapResendSendingStatus('pending')).toBe('pending')
    expect(mapResendSendingStatus('not_started')).toBe('pending')
    expect(mapResendSendingStatus('partially_verified')).toBe('pending')
  })
})

describe('isSendingOnlyProfile', () => {
  it('accepts sending-only and rejects receiving or unknown', () => {
    expect(isSendingOnlyProfile(SENDING_ONLY)).toBe(true)
    expect(isSendingOnlyProfile({ sending: 'enabled', receiving: 'enabled' })).toBe(false)
    expect(isSendingOnlyProfile({ sending: 'disabled', receiving: 'enabled' })).toBe(false)
    expect(isSendingOnlyProfile(null)).toBe(false)
  })
})

describe('claimSendingDomain', () => {
  it('rejects an invalid domain without touching the DB or Resend', async () => {
    const { client, calls } = sb()
    const result = await claimSendingDomain(client, 'company-1', 'nodots')
    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/Ogiltig/) })
    expect(calls).toHaveLength(0)
    expect(domainsMock.create).not.toHaveBeenCalled()
  })

  it('rejects a reserved domain', async () => {
    const { client } = sb()
    const result = await claimSendingDomain(client, 'company-1', 'platform.example')
    expect(result.ok).toBe(false)
    expect(domainsMock.create).not.toHaveBeenCalled()
  })

  it('inserts the row, registers a sending-only domain in Resend, and stores the DNS records', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null, dns_records: null } }) // insert
    enqueue({ data: ROW }) // update
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', status: 'not_started', records: [DKIM_RECORD], capabilities: SENDING_ONLY },
      error: null,
    })

    const result = await claimSendingDomain(client, 'company-1', 'HansBolag.example')
    expect(result.ok).toBe(true)
    expect(domainsMock.create).toHaveBeenCalledWith({
      name: 'hansbolag.example',
      region: 'eu-west-1',
      capabilities: { sending: 'enabled', receiving: 'disabled' },
    })
    const insertArgs = findCall('company_sending_domains', 'insert')
    expect(insertArgs?.[0]).toEqual({ company_id: 'company-1', domain: 'hansbolag.example', status: 'pending' })
    const updateArgs = findCall('company_sending_domains', 'update')
    expect(updateArgs?.[0]).toMatchObject({ resend_domain_id: 'rd_1', dns_records: [DKIM_RECORD], status: 'pending' })
  })

  it('maps a unique-violation on company_id to a 409 about the existing domain', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key idx_company_sending_domains_company' } })
    const result = await claimSendingDomain(client, 'company-1', 'hansbolag.example')
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/redan en avsändardomän/) })
  })

  it('never adopts an existing Resend domain: "already exists" rolls back and returns 409', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: null, error: { message: 'Domain already exists' } })

    const result = await claimSendingDomain(client, 'company-1', 'hansbolag.example')
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/finns redan/) })
    expect(domainsMock.list).not.toHaveBeenCalled()
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(1)
  })

  it('removes the Resend domain it just created when persisting the DNS records fails', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null, error: { message: 'db down' } }) // update fails
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({ data: { id: 'rd_1', status: 'pending', records: [], capabilities: SENDING_ONLY }, error: null })
    domainsMock.remove.mockResolvedValue({ data: null, error: null })

    const result = await claimSendingDomain(client, 'company-1', 'hansbolag.example')
    expect(result.ok).toBe(false)
    expect(domainsMock.remove).toHaveBeenCalledWith('rd_1')
  })
})

describe('checkSendingDomainVerification', () => {
  it('404s without a row', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: null })
    const result = await checkSendingDomainVerification(client, 'company-1')
    expect(result).toMatchObject({ ok: false, status: 404 })
  })

  it('verifies, then persists verified + verified_at', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: ROW })
    enqueue({ data: { ...ROW, status: 'verified' } })
    domainsMock.verify.mockResolvedValue({ data: {}, error: null })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', status: 'verified', records: [{ ...DKIM_RECORD, status: 'verified' }], capabilities: SENDING_ONLY },
      error: null,
    })

    const result = await checkSendingDomainVerification(client, 'company-1')
    expect(result.ok).toBe(true)
    expect(domainsMock.verify).toHaveBeenCalledWith('rd_1')
    const updateArgs = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
    expect(updateArgs.status).toBe('verified')
    expect(typeof updateArgs.verified_at).toBe('string')
  })

  it('refuses to flip a domain without the sending capability', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: ROW })
    domainsMock.verify.mockResolvedValue({ data: {}, error: null })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', status: 'verified', records: [], capabilities: { sending: 'disabled', receiving: 'enabled' } },
      error: null,
    })
    const result = await checkSendingDomainVerification(client, 'company-1')
    expect(result).toMatchObject({ ok: false, status: 409 })
  })
})

describe('updateSendingDomainSettings', () => {
  it('normalizes the local part, strips header characters from the name, and toggles enabled', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: ROW })
    enqueue({ data: { ...ROW, sender_local_part: 'ekonomi', sender_name: 'Hans Bolag', enabled: false } })
    const result = await updateSendingDomainSettings(client, 'company-1', {
      sender_local_part: 'Ekonomi',
      sender_name: 'Hans <Bolag>\r\n',
      enabled: false,
    })
    expect(result.ok).toBe(true)
    expect(findCall('company_sending_domains', 'update')?.[0]).toEqual({
      sender_local_part: 'ekonomi',
      sender_name: 'Hans Bolag',
      enabled: false,
    })
  })

  it('rejects an invalid local part with 400', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: ROW })
    const result = await updateSendingDomainSettings(client, 'company-1', { sender_local_part: 'no spaces' })
    expect(result).toMatchObject({ ok: false, status: 400 })
  })

  it('clears the sender name with null', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: { ...ROW, sender_name: 'Old' } })
    enqueue({ data: ROW })
    const result = await updateSendingDomainSettings(client, 'company-1', { sender_name: null })
    expect(result.ok).toBe(true)
    expect(findCall('company_sending_domains', 'update')?.[0]).toEqual({ sender_name: null })
  })
})

describe('removeSendingDomain', () => {
  it('deletes a sending-only Resend domain, then the row', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: ROW })
    enqueue({ data: null }) // delete
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', name: 'hansbolag.example', capabilities: SENDING_ONLY },
      error: null,
    })
    domainsMock.remove.mockResolvedValue({ data: null, error: null })

    const result = await removeSendingDomain(client, 'company-1')
    expect(result).toEqual({ ok: true, data: { removed: true } })
    expect(domainsMock.remove).toHaveBeenCalledWith('rd_1')
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(1)
  })

  it("never deletes the platform's own sender domain from Resend, even when a row points at it", async () => {
    const { client, enqueue } = sb()
    enqueue({ data: { ...ROW, domain: 'platform.example', resend_domain_id: 'rd_platform' } })
    enqueue({ data: null }) // delete row
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_platform', name: 'platform.example', capabilities: SENDING_ONLY },
      error: null,
    })
    const result = await removeSendingDomain(client, 'company-1')
    expect(result.ok).toBe(true)
    expect(domainsMock.remove).not.toHaveBeenCalled()
  })

  it('leaves a receiving-capable Resend domain alone', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: ROW })
    enqueue({ data: null })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', name: 'hansbolag.example', capabilities: { sending: 'enabled', receiving: 'enabled' } },
      error: null,
    })
    const result = await removeSendingDomain(client, 'company-1')
    expect(result.ok).toBe(true)
    expect(domainsMock.remove).not.toHaveBeenCalled()
  })
})

describe('applySendingDomainStatusFromWebhook', () => {
  it('returns false for an unknown Resend domain id', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: null })
    await expect(applySendingDomainStatusFromWebhook(client, { id: 'rd_other', status: 'verified' })).resolves.toBe(false)
    expect(domainsMock.get).not.toHaveBeenCalled()
  })

  it('flips to verified only after confirming the sending capability with Resend', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: { id: 'row-1', verified_at: null } })
    enqueue({ data: null }) // update
    domainsMock.get.mockResolvedValue({ data: { id: 'rd_1', capabilities: SENDING_ONLY }, error: null })
    const ok = await applySendingDomainStatusFromWebhook(client, { id: 'rd_1', status: 'verified', records: [DKIM_RECORD] })
    expect(ok).toBe(true)
    const update = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
    expect(update.status).toBe('verified')
    expect(update.dns_records).toEqual([DKIM_RECORD])
    expect(typeof update.verified_at).toBe('string')
  })

  it('keeps the stored status when Resend cannot confirm sending', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: { id: 'row-1', verified_at: null } })
    enqueue({ data: null })
    domainsMock.get.mockResolvedValue({ data: null, error: { message: 'nope' } })
    const ok = await applySendingDomainStatusFromWebhook(client, { id: 'rd_1', status: 'verified' })
    expect(ok).toBe(true)
    const update = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
    expect(update.status).toBeUndefined()
  })

  it('records a failed status without calling Resend', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: { id: 'row-1', verified_at: '2026-08-01T00:00:00Z' } })
    enqueue({ data: null })
    const ok = await applySendingDomainStatusFromWebhook(client, { id: 'rd_1', status: 'failed' })
    expect(ok).toBe(true)
    expect(domainsMock.get).not.toHaveBeenCalled()
    const update = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
    expect(update.status).toBe('failed')
    expect(update.verified_at).toBe('2026-08-01T00:00:00Z')
  })
})
