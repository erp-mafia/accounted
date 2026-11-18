import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  validateClaimableSendingDomain,
  mapResendSendingStatus,
  isSendingOnlyProfile,
  classifyDomainCreateError,
  claimSendingDomain,
  checkSendingDomainVerification,
  updateSendingDomainSettings,
  removeSendingDomain,
  applySendingDomainStatusFromWebhook,
  SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT,
  SENDING_DOMAIN_CLAIM_PROVIDER_ERROR,
  SENDING_DOMAIN_VERIFY_PROVIDER_ERROR,
  SENDING_DOMAIN_VERIFY_PROVIDER_DOMAIN_MISSING,
  SENDING_DOMAIN_REMOVE_PROVIDER_ERROR,
} from '@/extensions/general/email/lib/sending-domains'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

const { domainsMock, logMock } = vi.hoisted(() => ({
  domainsMock: {
    create: vi.fn(),
    get: vi.fn(),
    verify: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
  },
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('resend', () => ({
  Resend: class {
    domains = domainsMock
  },
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...logMock, child: () => logMock }),
}))

// Resend's 403 when the account has used every domain its plan includes. The
// wording is not documented; only the shape (403 validation_error) is relied on.
const PLAN_LIMIT_ERROR = {
  name: 'validation_error',
  statusCode: 403,
  message: 'You have reached the maximum number of domains included in your plan.',
}

// Documented: resend.com/docs/knowledge-base/domain-already-registered
const REGISTERED_ALREADY_ERROR = {
  name: 'validation_error',
  statusCode: 403,
  message: 'The hansbolag.example domain has been registered already',
}

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

/** The registry's Swedish sentence and status for a code, as a refusal. */
function registryRefusal(code: string) {
  const entry = getErrorEntry(code)
  if (!entry) throw new Error(`${code} is not in the structured-errors registry`)
  return { ok: false, status: entry.httpStatus, code, error: entry.message_sv }
}

// What Resend answers on an outage-shaped failure; its text must never reach
// the customer.
const PROVIDER_OUTAGE = { name: 'application_error', statusCode: 500, message: 'Internal server error at provider' }

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

describe('classifyDomainCreateError', () => {
  it('reads a 403 validation_error as the plan cap, whatever its wording (crm#1288)', () => {
    expect(classifyDomainCreateError(PLAN_LIMIT_ERROR)).toBe('plan_limit')
    expect(classifyDomainCreateError({ ...PLAN_LIMIT_ERROR, message: 'Domain limit reached for the Pro plan (10).' })).toBe(
      'plan_limit',
    )
  })

  it("reads Resend's documented 'has been registered already' and the older 'already exists' as a conflict", () => {
    expect(classifyDomainCreateError(REGISTERED_ALREADY_ERROR)).toBe('already_registered')
    expect(classifyDomainCreateError({ message: 'Domain already exists' })).toBe('already_registered')
  })

  it('leaves every other refusal unclassified', () => {
    expect(classifyDomainCreateError({ name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' })).toBe(
      'other',
    )
    expect(classifyDomainCreateError({ name: 'invalid_api_key', statusCode: 403, message: 'API key is invalid' })).toBe(
      'other',
    )
    expect(classifyDomainCreateError({ name: 'validation_error', statusCode: 422, message: 'Invalid domain name' })).toBe(
      'other',
    )
    expect(classifyDomainCreateError({ name: 'application_error', statusCode: null, message: 'Unable to fetch data.' })).toBe(
      'other',
    )
    expect(classifyDomainCreateError(null)).toBe('other')
  })
})

describe('claimSendingDomain', () => {
  it('rejects an invalid domain without touching the DB or Resend', async () => {
    const { client, calls } = sb()
    const result = await claimSendingDomain(client, client, 'company-1', 'nodots')
    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/Ogiltig/) })
    expect(calls).toHaveLength(0)
    expect(domainsMock.create).not.toHaveBeenCalled()
  })

  it('rejects a reserved domain', async () => {
    const { client } = sb()
    const result = await claimSendingDomain(client, client, 'company-1', 'platform.example')
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

    const result = await claimSendingDomain(client, client, 'company-1', 'HansBolag.example')
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

  it('writes the verification state through the service-role writer, not the tenant client', async () => {
    const tenant = sb()
    const writer = sb()
    tenant.enqueue({ data: { ...ROW, resend_domain_id: null, dns_records: null } }) // insert (RLS client)
    writer.enqueue({ data: ROW }) // update (service role)
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', status: 'not_started', records: [DKIM_RECORD], capabilities: SENDING_ONLY },
      error: null,
    })

    const result = await claimSendingDomain(tenant.client, writer.client, 'company-1', 'hansbolag.example')
    expect(result.ok).toBe(true)
    expect(tenant.findCall('company_sending_domains', 'update')).toBeUndefined()
    expect(writer.findCall('company_sending_domains', 'update')?.[0]).toMatchObject({ resend_domain_id: 'rd_1' })
    // Still scoped to the company on the service-role path, and bound only to
    // the row that still carries the registered domain and no Resend id (a
    // concurrent tenant delete + re-insert under the same id matches nothing).
    expect(writer.findCalls('company_sending_domains', 'eq')).toEqual(
      expect.arrayContaining([
        ['id', 'row-1'],
        ['company_id', 'company-1'],
        ['domain', 'hansbolag.example'],
      ]),
    )
    expect(writer.findCall('company_sending_domains', 'is')).toEqual(['resend_domain_id', null])
  })

  it('maps a unique-violation on company_id to a 409 about the existing domain', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key idx_company_sending_domains_company' } })
    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/redan en avsändardomän/) })
  })

  it('never adopts an existing Resend domain: "already exists" rolls back and returns 409', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: null, error: { message: 'Domain already exists' } })

    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/finns redan/) })
    expect(domainsMock.list).not.toHaveBeenCalled()
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(1)
  })

  it("answers Resend's documented 'registered already' 403 with the same 409, not as a quota problem", async () => {
    const { client, enqueue } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: null, error: REGISTERED_ALREADY_ERROR })

    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')
    expect(result).toEqual({ ok: false, status: 409, error: expect.stringMatching(/finns redan/) })
    expect(logMock.error).not.toHaveBeenCalled()
  })

  it('at the plan cap: rolls back, tells the customer in Swedish without the provider text, and alerts (crm#1288)', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: null, error: PLAN_LIMIT_ERROR })

    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')

    const entry = getErrorEntry(SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT)
    expect(entry).toBeDefined()
    expect(result).toEqual({
      ok: false,
      status: 503,
      code: SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT,
      error: entry?.message_sv,
    })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toMatch(/från vår adress/)
    expect(result.error).not.toContain(PLAN_LIMIT_ERROR.message)
    // The row the claim inserted is gone again; nothing was created in Resend.
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(1)
    expect(domainsMock.get).not.toHaveBeenCalled()
    expect(domainsMock.remove).not.toHaveBeenCalled()
    // The operators hear about it: one alert-flagged error with a stable code
    // and Resend's own text for them to read.
    expect(logMock.error).toHaveBeenCalledTimes(1)
    expect(logMock.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        alert: true,
        code: SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT,
        companyId: 'company-1',
        providerError: 'validation_error',
        providerStatus: 403,
        providerMessage: PLAN_LIMIT_ERROR.message,
      }),
    )
    // The settings toast maps the same sentence through the app's error
    // mapping unchanged (it is already Swedish).
    expect(getErrorMessage(new Error(result.error))).toBe(entry?.message_sv)
  })

  it('any other provider refusal: a 502 in Swedish without the provider text, logged without the alert flag', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' },
    })

    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')
    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_CLAIM_PROVIDER_ERROR))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.status).toBe(502)
    expect(result.error).toMatch(/e-postleverantören/)
    expect(result.error).not.toContain('Too many requests')
    expect(logMock.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ providerStatus: 429, providerMessage: 'Too many requests' }),
    )
    expect(logMock.error.mock.calls[0][1]).not.toHaveProperty('alert')
  })

  it('removes the Resend domain it just created when persisting the DNS records fails', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null, error: { message: 'db down' } }) // update fails
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({ data: { id: 'rd_1', status: 'pending', records: [], capabilities: SENDING_ONLY }, error: null })
    domainsMock.remove.mockResolvedValue({ data: null, error: null })

    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')
    expect(result).toEqual({ ok: false, status: 500, error: expect.stringMatching(/Kunde inte spara domänen/) })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).not.toContain('db down')
    expect(domainsMock.remove).toHaveBeenCalledWith('rd_1')
    // A clean cleanup is not an alert.
    expect(logMock.error.mock.calls.some(([, ctx]) => (ctx as { alert?: boolean })?.alert)).toBe(false)
  })

  it('DNS-record fetch failure after a successful create: removes the Resend domain and the row, answers in Swedish without the provider text', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({ data: null, error: PROVIDER_OUTAGE })
    domainsMock.remove.mockResolvedValue({ data: { id: 'rd_1', deleted: true }, error: null })

    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')

    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_CLAIM_PROVIDER_ERROR))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).not.toContain(PROVIDER_OUTAGE.message)
    expect(domainsMock.remove).toHaveBeenCalledWith('rd_1')
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(1)
    expect(logMock.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ companyId: 'company-1', providerStatus: 500, providerMessage: PROVIDER_OUTAGE.message }),
    )
  })

  it('a throw after a successful create removes the Resend domain too, not only the row (orphan regression)', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockRejectedValue(new Error('fetch failed: ECONNRESET'))
    domainsMock.remove.mockResolvedValue({ data: { id: 'rd_1', deleted: true }, error: null })

    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')

    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_CLAIM_PROVIDER_ERROR))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).not.toContain('ECONNRESET')
    expect(domainsMock.remove).toHaveBeenCalledWith('rd_1')
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(1)
  })

  it('a refused cleanup ({ error }, not a throw) is alert-logged with the orphaned domain id', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({ data: null, error: PROVIDER_OUTAGE })
    domainsMock.remove.mockResolvedValue({ data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' } })

    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')

    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_CLAIM_PROVIDER_ERROR))
    // The row still goes: the customer can claim again; the orphan is ours.
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(1)
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/could not remove the Resend domain/),
      expect.objectContaining({
        alert: true,
        companyId: 'company-1',
        domain: 'hansbolag.example',
        resendDomainId: 'rd_1',
        providerStatus: 429,
        providerMessage: 'Too many requests',
      }),
    )
  })

  it('a cleanup that throws is alert-logged too', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null, error: { message: 'db down' } }) // update fails
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({ data: { id: 'rd_1', status: 'pending', records: [], capabilities: SENDING_ONLY }, error: null })
    domainsMock.remove.mockRejectedValue(new Error('socket hang up'))

    const result = await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')

    expect(result.ok).toBe(false)
    expect(logMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/could not remove the Resend domain/),
      expect.objectContaining({ alert: true, resendDomainId: 'rd_1', providerMessage: 'socket hang up' }),
    )
  })

  it('a cleanup answered with 404 (already gone) is not an alert', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: { ...ROW, resend_domain_id: null } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({ data: null, error: PROVIDER_OUTAGE })
    domainsMock.remove.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 404, message: 'Domain not found' } })

    await claimSendingDomain(client, client, 'company-1', 'hansbolag.example')

    expect(domainsMock.remove).toHaveBeenCalledWith('rd_1')
    expect(logMock.error.mock.calls.some(([, ctx]) => (ctx as { alert?: boolean })?.alert)).toBe(false)
  })
})

describe('checkSendingDomainVerification', () => {
  it('404s without a row', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: null })
    const result = await checkSendingDomainVerification(client, client, 'company-1')
    expect(result).toMatchObject({ ok: false, status: 404 })
  })

  it('persists verified + verified_at when Resend has verified the domain, without restarting the check', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: ROW })
    enqueue({ data: { ...ROW, status: 'verified' } })
    domainsMock.get.mockResolvedValue({
      data: {
        id: 'rd_1',
        name: 'hansbolag.example',
        status: 'verified',
        records: [{ ...DKIM_RECORD, status: 'verified' }],
        capabilities: SENDING_ONLY,
      },
      error: null,
    })

    const result = await checkSendingDomainVerification(client, client, 'company-1')
    expect(result.ok).toBe(true)
    expect(domainsMock.verify).not.toHaveBeenCalled()
    const updateArgs = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
    expect(updateArgs.status).toBe('verified')
    expect(typeof updateArgs.verified_at).toBe('string')
  })

  it('leaves a running Resend check alone: pending is stored with the per-record state (crm#1044)', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: ROW })
    enqueue({ data: ROW })
    const records = [{ ...DKIM_RECORD, status: 'pending' }]
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', name: 'hansbolag.example', status: 'pending', records, capabilities: SENDING_ONLY },
      error: null,
    })

    const result = await checkSendingDomainVerification(client, client, 'company-1')
    expect(result.ok).toBe(true)
    expect(domainsMock.verify).not.toHaveBeenCalled()
    expect(domainsMock.get).toHaveBeenCalledTimes(1)
    const updateArgs = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
    expect(updateArgs.status).toBe('pending')
    expect(updateArgs.dns_records).toEqual(records)
  })

  it.each(['not_started', 'failed', 'partially_failed'])(
    'starts a Resend check when the status is %s, then stores what Resend reports',
    async status => {
      const { client, enqueue, findCall } = sb()
      enqueue({ data: ROW })
      enqueue({ data: ROW })
      domainsMock.get
        .mockResolvedValueOnce({
          data: { id: 'rd_1', name: 'hansbolag.example', status, records: [DKIM_RECORD], capabilities: SENDING_ONLY },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { id: 'rd_1', name: 'hansbolag.example', status: 'pending', records: [DKIM_RECORD], capabilities: SENDING_ONLY },
          error: null,
        })
      domainsMock.verify.mockResolvedValue({ data: {}, error: null })

      const result = await checkSendingDomainVerification(client, client, 'company-1')
      expect(result.ok).toBe(true)
      expect(domainsMock.verify).toHaveBeenCalledTimes(1)
      expect(domainsMock.verify).toHaveBeenCalledWith('rd_1')
      expect(domainsMock.get).toHaveBeenCalledTimes(2)
      const updateArgs = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
      expect(updateArgs.status).toBe('pending')
    },
  )

  it('refuses to flip when Resend reports a different domain name than the row (swapped row)', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: { ...ROW, domain: 'platform.example' } })
    domainsMock.verify.mockResolvedValue({ data: {}, error: null })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', name: 'hansbolag.example', status: 'verified', records: [], capabilities: SENDING_ONLY },
      error: null,
    })
    const result = await checkSendingDomainVerification(client, client, 'company-1')
    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(findCall('company_sending_domains', 'update')).toBeUndefined()
  })

  it('a Resend failure answers in Swedish under its code, never with the provider text', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: ROW })
    domainsMock.get.mockResolvedValue({ data: null, error: PROVIDER_OUTAGE })

    const result = await checkSendingDomainVerification(client, client, 'company-1')

    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_VERIFY_PROVIDER_ERROR))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).not.toContain(PROVIDER_OUTAGE.message)
    expect(findCall('company_sending_domains', 'update')).toBeUndefined()
    expect(logMock.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        operation: 'sending-domain.verify',
        companyId: 'company-1',
        providerStatus: 500,
        providerMessage: PROVIDER_OUTAGE.message,
      }),
    )
  })

  it('a domain Resend no longer has (404) says so and points at removing and adding it again', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: ROW })
    domainsMock.get.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 404, message: 'Domain not found' } })

    const result = await checkSendingDomainVerification(client, client, 'company-1')

    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_VERIFY_PROVIDER_DOMAIN_MISSING))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.status).toBe(409)
    expect(result.error).not.toContain('Domain not found')
  })

  it('a throw during the check answers in Swedish without the thrown text', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: ROW })
    domainsMock.get.mockRejectedValue(new Error('fetch failed: ETIMEDOUT'))

    const result = await checkSendingDomainVerification(client, client, 'company-1')

    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_VERIFY_PROVIDER_ERROR))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).not.toContain('ETIMEDOUT')
  })

  it('refuses to flip a domain without the sending capability', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: ROW })
    domainsMock.verify.mockResolvedValue({ data: {}, error: null })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', status: 'verified', records: [], capabilities: { sending: 'disabled', receiving: 'enabled' } },
      error: null,
    })
    const result = await checkSendingDomainVerification(client, client, 'company-1')
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

  it('a failed Resend lookup keeps the row and answers in Swedish without the provider text', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: ROW })
    domainsMock.get.mockResolvedValue({ data: null, error: PROVIDER_OUTAGE })

    const result = await removeSendingDomain(client, 'company-1')

    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_REMOVE_PROVIDER_ERROR))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).not.toContain(PROVIDER_OUTAGE.message)
    expect(domainsMock.remove).not.toHaveBeenCalled()
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(0)
  })

  it('a removal Resend refuses keeps the row (no orphaned domain) and logs the provider text for us', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: ROW })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', name: 'hansbolag.example', capabilities: SENDING_ONLY },
      error: null,
    })
    domainsMock.remove.mockResolvedValue({ data: null, error: PROVIDER_OUTAGE })

    const result = await removeSendingDomain(client, 'company-1')

    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_REMOVE_PROVIDER_ERROR))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).not.toContain(PROVIDER_OUTAGE.message)
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(0)
    expect(logMock.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ operation: 'sending-domain.remove', providerMessage: PROVIDER_OUTAGE.message }),
    )
  })

  it('a throw during removal keeps the row and answers in Swedish without the thrown text', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: ROW })
    domainsMock.get.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'))

    const result = await removeSendingDomain(client, 'company-1')

    expect(result).toEqual(registryRefusal(SENDING_DOMAIN_REMOVE_PROVIDER_ERROR))
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).not.toContain('ECONNREFUSED')
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(0)
  })

  it('drops the row when Resend already lost the domain (404)', async () => {
    const { client, enqueue, findCalls } = sb()
    enqueue({ data: ROW })
    enqueue({ data: null }) // delete
    domainsMock.get.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 404, message: 'Domain not found' } })

    const result = await removeSendingDomain(client, 'company-1')

    expect(result).toEqual({ ok: true, data: { removed: true } })
    expect(domainsMock.remove).not.toHaveBeenCalled()
    expect(findCalls('company_sending_domains', 'delete')).toHaveLength(1)
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
  it('returns no_match for an unknown Resend domain id', async () => {
    const { client, enqueue } = sb()
    enqueue({ data: null })
    await expect(applySendingDomainStatusFromWebhook(client, { id: 'rd_other', status: 'verified' })).resolves.toBe(
      'no_match',
    )
    expect(domainsMock.get).not.toHaveBeenCalled()
  })

  it('returns error (so the webhook is retried) when the lookup or the update fails', async () => {
    const lookupFail = sb()
    lookupFail.enqueue({ data: null, error: { message: 'db down' } })
    await expect(
      applySendingDomainStatusFromWebhook(lookupFail.client, { id: 'rd_1', status: 'failed' }),
    ).resolves.toBe('error')

    const updateFail = sb()
    updateFail.enqueue({ data: { id: 'row-1', verified_at: null } })
    updateFail.enqueue({ data: null, error: { message: 'db down' } })
    await expect(
      applySendingDomainStatusFromWebhook(updateFail.client, { id: 'rd_1', status: 'failed' }),
    ).resolves.toBe('error')
  })

  it('keeps the stored status when Resend names a different domain than the row (swapped row)', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: { id: 'row-1', domain: 'platform.example', verified_at: null } })
    enqueue({ data: null }) // update (records/last_checked only)
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', name: 'hansbolag.example', capabilities: SENDING_ONLY },
      error: null,
    })
    const ok = await applySendingDomainStatusFromWebhook(client, { id: 'rd_1', status: 'verified' })
    expect(ok).toBe('applied')
    const update = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
    expect(update.status).toBeUndefined()
  })

  it('flips to verified only after confirming the sending capability with Resend', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: { id: 'row-1', domain: 'hansbolag.example', verified_at: null } })
    enqueue({ data: null }) // update
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', name: 'hansbolag.example', capabilities: SENDING_ONLY },
      error: null,
    })
    const ok = await applySendingDomainStatusFromWebhook(client, { id: 'rd_1', status: 'verified', records: [DKIM_RECORD] })
    expect(ok).toBe('applied')
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
    expect(ok).toBe('applied')
    const update = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
    expect(update.status).toBeUndefined()
  })

  it('records a failed status without calling Resend', async () => {
    const { client, enqueue, findCall } = sb()
    enqueue({ data: { id: 'row-1', verified_at: '2026-08-01T00:00:00Z' } })
    enqueue({ data: null })
    const ok = await applySendingDomainStatusFromWebhook(client, { id: 'rd_1', status: 'failed' })
    expect(ok).toBe('applied')
    expect(domainsMock.get).not.toHaveBeenCalled()
    const update = findCall('company_sending_domains', 'update')?.[0] as Record<string, unknown>
    expect(update.status).toBe('failed')
    expect(update.verified_at).toBe('2026-08-01T00:00:00Z')
  })
})

describe('sending-domain provider codes in the structured-errors registry', () => {
  it.each([
    SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT,
    SENDING_DOMAIN_CLAIM_PROVIDER_ERROR,
    SENDING_DOMAIN_VERIFY_PROVIDER_ERROR,
    SENDING_DOMAIN_VERIFY_PROVIDER_DOMAIN_MISSING,
    SENDING_DOMAIN_REMOVE_PROVIDER_ERROR,
  ])('%s has a Swedish sentence the settings toast shows unchanged', (code) => {
    const entry = getErrorEntry(code)
    expect(entry).toBeDefined()
    expect(entry?.message_en).toBeTruthy()
    // The page throws new Error(json.error) and maps it for the toast.
    expect(getErrorMessage(new Error(entry?.message_sv))).toBe(entry?.message_sv)
  })
})
