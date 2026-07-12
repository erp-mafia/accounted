import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  normalizeInboundDomain,
  validateClaimableDomain,
  mapResendDomainStatus,
  resolveClaimedDomainStatus,
  claimCustomDomain,
  checkCustomDomainVerification,
  removeCustomDomain,
  findCompanyForRecipientDomains,
  applyDomainStatusFromWebhook,
} from '@/extensions/general/invoice-inbox/lib/custom-domains'
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

const RECEIVING_RECORD = {
  record: 'Receiving',
  name: 'hansbolag.example',
  value: 'inbound.resend.example',
  type: 'MX',
  ttl: 'Auto',
  status: 'not_started',
  priority: 10,
}

describe('normalizeInboundDomain', () => {
  it('lowercases and strips trailing dots', () => {
    expect(normalizeInboundDomain('Faktura.HansBolag.SE.')).toBe('faktura.hansbolag.se')
  })

  it('accepts a pasted URL', () => {
    expect(normalizeInboundDomain('https://hansbolag.se/kontakt?x=1')).toBe('hansbolag.se')
  })

  it('accepts a pasted email address', () => {
    expect(normalizeInboundDomain('faktura@hansbolag.se')).toBe('hansbolag.se')
  })

  it('punycodes Swedish IDN domains', () => {
    const result = normalizeInboundDomain('blåbär.se')
    expect(result).not.toBeNull()
    expect(result!.startsWith('xn--')).toBe(true)
    expect(result!.endsWith('.se')).toBe(true)
  })

  it('rejects hostnames without a dot', () => {
    expect(normalizeInboundDomain('nodots')).toBeNull()
  })

  it('rejects empty input', () => {
    expect(normalizeInboundDomain('')).toBeNull()
    expect(normalizeInboundDomain('   ')).toBeNull()
  })

  it('rejects IP addresses', () => {
    expect(normalizeInboundDomain('192.168.0.1')).toBeNull()
  })
})

describe('validateClaimableDomain', () => {
  beforeEach(() => {
    process.env.RESEND_INBOUND_DOMAIN = 'arcim.example'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.gnubok.example'
  })

  it('blocks public mailbox providers', () => {
    expect(validateClaimableDomain('gmail.com')).not.toBeNull()
    expect(validateClaimableDomain('outlook.com')).not.toBeNull()
  })

  it('blocks the shared inbound domain and its subdomains', () => {
    expect(validateClaimableDomain('arcim.example')).not.toBeNull()
    expect(validateClaimableDomain('foo.arcim.example')).not.toBeNull()
  })

  it('blocks the app domain', () => {
    expect(validateClaimableDomain('app.gnubok.example')).not.toBeNull()
  })

  it('allows a normal customer domain', () => {
    expect(validateClaimableDomain('hansbolag.se')).toBeNull()
  })
})

describe('mapResendDomainStatus', () => {
  it('maps Resend statuses to our three buckets', () => {
    expect(mapResendDomainStatus('verified')).toBe('verified')
    // temporary_failure = previously verified, Resend still routing: keep routing.
    expect(mapResendDomainStatus('temporary_failure')).toBe('verified')
    expect(mapResendDomainStatus('failed')).toBe('failed')
    expect(mapResendDomainStatus('pending')).toBe('pending')
    expect(mapResendDomainStatus('not_started')).toBe('pending')
  })
})

describe('resolveClaimedDomainStatus', () => {
  it('forces an adopted orphan to pending even when Resend reports verified', () => {
    // The security-critical case: adopting a domain freed by a deleted company
    // must NOT inherit a stale 'verified': DNS control has to be re-proven.
    expect(resolveClaimedDomainStatus(true, 'verified')).toBe('pending')
    expect(resolveClaimedDomainStatus(true, 'temporary_failure')).toBe('pending')
  })

  it('maps Resend status normally for a freshly created (non-adopted) domain', () => {
    expect(resolveClaimedDomainStatus(false, 'pending')).toBe('pending')
    expect(resolveClaimedDomainStatus(false, 'not_started')).toBe('pending')
    expect(resolveClaimedDomainStatus(false, 'verified')).toBe('verified')
  })
})

describe('claimCustomDomain', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 'test-key'
    process.env.RESEND_INBOUND_DOMAIN = 'arcim.example'
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.gnubok.example'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('rejects an unparseable domain without touching the database', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await claimCustomDomain(supabase as unknown as SupabaseClient, 'company-1', 'not a domain!')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
    expect(domainsMock.create).not.toHaveBeenCalled()
  })

  it('rejects blocked domains', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await claimCustomDomain(supabase as unknown as SupabaseClient, 'company-1', 'gmail.com')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it('registers the domain in Resend with receiving-only capabilities and stores the records', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', company_id: 'company-1', domain: 'hansbolag.example' } }) // insert
    enqueue({
      data: {
        id: 'row-1',
        company_id: 'company-1',
        domain: 'hansbolag.example',
        status: 'pending',
        resend_domain_id: 'rd_1',
        dns_records: [RECEIVING_RECORD],
      },
    }) // update
    domainsMock.create.mockResolvedValue({ data: { id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_1', status: 'pending', records: [RECEIVING_RECORD] },
      error: null,
    })

    const result = await claimCustomDomain(supabase as unknown as SupabaseClient, 'company-1', 'HansBolag.example')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.resend_domain_id).toBe('rd_1')
      expect(result.data.status).toBe('pending')
    }
    expect(domainsMock.create).toHaveBeenCalledWith({
      name: 'hansbolag.example',
      region: 'eu-west-1',
      capabilities: { receiving: 'enabled', sending: 'disabled' },
    })
  })

  it('returns 409 when the company already has a domain', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_company_inbound_domains_company"' },
    })
    const result = await claimCustomDomain(supabase as unknown as SupabaseClient, 'company-1', 'hansbolag.example')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toContain('redan en egen domän')
    }
    expect(domainsMock.create).not.toHaveBeenCalled()
  })

  it('returns 409 when another company owns the domain, without leaking who', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_company_inbound_domains_domain"' },
    })
    const result = await claimCustomDomain(supabase as unknown as SupabaseClient, 'company-1', 'hansbolag.example')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toBe('Domänen är redan registrerad.')
    }
  })

  it('rolls back the row when Resend registration fails and no existing domain can be adopted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', company_id: 'company-1', domain: 'hansbolag.example' } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({
      data: null,
      error: { message: 'quota exceeded', statusCode: 422, name: 'validation_error' },
    })
    domainsMock.list.mockResolvedValue({ data: { data: [], has_more: false }, error: null })

    const result = await claimCustomDomain(supabase as unknown as SupabaseClient, 'company-1', 'hansbolag.example')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.error).toContain('quota exceeded')
    }
  })

  it('adopts an orphaned receiving-only Resend domain when create says it already exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', company_id: 'company-1', domain: 'hansbolag.example' } }) // insert
    enqueue({
      data: { id: 'row-1', resend_domain_id: 'rd_9', status: 'pending', domain: 'hansbolag.example' },
    }) // update
    domainsMock.create.mockResolvedValue({
      data: null,
      error: { message: 'domain already exists', statusCode: 409, name: 'validation_error' },
    })
    domainsMock.list.mockResolvedValue({
      data: {
        data: [
          {
            id: 'rd_9',
            name: 'HansBolag.example',
            status: 'pending',
            capabilities: { receiving: 'enabled', sending: 'disabled' },
          },
        ],
        has_more: false,
      },
      error: null,
    })
    domainsMock.get.mockResolvedValue({
      data: { id: 'rd_9', status: 'pending', records: [RECEIVING_RECORD] },
      error: null,
    })

    const result = await claimCustomDomain(supabase as unknown as SupabaseClient, 'company-1', 'hansbolag.example')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.resend_domain_id).toBe('rd_9')
  })

  it('refuses to adopt a sending domain: the platform outbound domain must never bind to a tenant', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', company_id: 'company-1', domain: 'hansbolag.example' } }) // insert
    enqueue({ data: null }) // rollback delete
    domainsMock.create.mockResolvedValue({
      data: null,
      error: { message: 'domain already exists', statusCode: 409, name: 'validation_error' },
    })
    domainsMock.list.mockResolvedValue({
      data: {
        data: [
          {
            id: 'rd_prod_send',
            name: 'hansbolag.example',
            status: 'verified',
            capabilities: { receiving: 'disabled', sending: 'enabled' },
          },
        ],
        has_more: false,
      },
      error: null,
    })

    const result = await claimCustomDomain(supabase as unknown as SupabaseClient, 'company-1', 'hansbolag.example')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toContain('underdomän')
    }
    expect(domainsMock.get).not.toHaveBeenCalled()
  })
})

describe('checkCustomDomainVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 'test-key'
  })

  it('returns 404 when the company has no custom domain', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = await checkCustomDomainVerification(supabase as unknown as SupabaseClient, 'company-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('persists the verified status from Resend', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'row-1', company_id: 'company-1', resend_domain_id: 'rd_1', verified_at: null },
    }) // select
    enqueue({
      data: { id: 'row-1', status: 'verified', domain: 'hansbolag.example' },
    }) // update
    domainsMock.verify.mockResolvedValue({ data: { object: 'domain', id: 'rd_1' }, error: null })
    domainsMock.get.mockResolvedValue({
      data: {
        id: 'rd_1',
        status: 'verified',
        capabilities: { receiving: 'enabled', sending: 'disabled' },
        records: [{ ...RECEIVING_RECORD, status: 'verified' }],
      },
      error: null,
    })

    const result = await checkCustomDomainVerification(supabase as unknown as SupabaseClient, 'company-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('verified')
    expect(domainsMock.verify).toHaveBeenCalledWith('rd_1')
  })

  it('never verifies a domain whose receiving capability is disabled', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'row-1', company_id: 'company-1', resend_domain_id: 'rd_send', verified_at: null },
    }) // select: no update should follow
    domainsMock.verify.mockResolvedValue({ data: { object: 'domain', id: 'rd_send' }, error: null })
    domainsMock.get.mockResolvedValue({
      data: {
        id: 'rd_send',
        status: 'verified', // verified for SENDING: must not count
        capabilities: { receiving: 'disabled', sending: 'enabled' },
        records: [],
      },
      error: null,
    })

    const result = await checkCustomDomainVerification(supabase as unknown as SupabaseClient, 'company-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toContain('mottagning')
    }
  })
})

describe('removeCustomDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 'test-key'
  })

  const RECEIVING_ONLY_DOMAIN = {
    id: 'rd_1',
    status: 'pending',
    capabilities: { receiving: 'enabled', sending: 'disabled' },
    records: [],
  }

  it('removes the Resend domain and deletes the row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', company_id: 'company-1', resend_domain_id: 'rd_1' } }) // select
    enqueue({ data: null }) // delete
    domainsMock.get.mockResolvedValue({ data: RECEIVING_ONLY_DOMAIN, error: null })
    domainsMock.remove.mockResolvedValue({ data: { id: 'rd_1', deleted: true }, error: null })

    const result = await removeCustomDomain(supabase as unknown as SupabaseClient, 'company-1')
    expect(result.ok).toBe(true)
    expect(domainsMock.remove).toHaveBeenCalledWith('rd_1')
  })

  it('tolerates a domain already gone from Resend', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', company_id: 'company-1', resend_domain_id: 'rd_1' } })
    enqueue({ data: null })
    domainsMock.get.mockResolvedValue({
      data: null,
      error: { message: 'not found', statusCode: 404, name: 'not_found' },
    })

    const result = await removeCustomDomain(supabase as unknown as SupabaseClient, 'company-1')
    expect(result.ok).toBe(true)
    expect(domainsMock.remove).not.toHaveBeenCalled()
  })

  it('keeps the row when Resend removal fails: a verified orphan must never become adoptable', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', company_id: 'company-1', resend_domain_id: 'rd_1' } })
    domainsMock.get.mockResolvedValue({ data: RECEIVING_ONLY_DOMAIN, error: null })
    domainsMock.remove.mockResolvedValue({
      data: null,
      error: { message: 'internal error', statusCode: 500, name: 'application_error' },
    })

    const result = await removeCustomDomain(supabase as unknown as SupabaseClient, 'company-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(502)
  })

  it('deletes the row but never the Resend domain when it is not receiving-only', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Legacy row bound to the platform's outbound sending domain.
    enqueue({ data: { id: 'row-1', company_id: 'company-1', resend_domain_id: 'rd_prod_send' } })
    enqueue({ data: null }) // row delete
    domainsMock.get.mockResolvedValue({
      data: {
        id: 'rd_prod_send',
        status: 'verified',
        capabilities: { receiving: 'disabled', sending: 'enabled' },
        records: [],
      },
      error: null,
    })

    const result = await removeCustomDomain(supabase as unknown as SupabaseClient, 'company-1')
    expect(result.ok).toBe(true)
    expect(domainsMock.remove).not.toHaveBeenCalled()
  })
})

describe('findCompanyForRecipientDomains', () => {
  it('returns the first match in recipient order regardless of row order', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { company_id: 'c2', domain: 'second.example' },
        { company_id: 'c1', domain: 'first.example' },
      ],
    })
    const match = await findCompanyForRecipientDomains(
      supabase as unknown as SupabaseClient,
      ['first.example', 'second.example'],
    )
    expect(match).toEqual({ companyId: 'c1', domain: 'first.example' })
  })

  it('returns null when nothing matches', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    const match = await findCompanyForRecipientDomains(
      supabase as unknown as SupabaseClient,
      ['unknown.example'],
    )
    expect(match).toBeNull()
  })

  it('returns null without querying when there are no recipient domains', async () => {
    const { supabase } = createQueuedMockSupabase()
    const match = await findCompanyForRecipientDomains(supabase as unknown as SupabaseClient, [])
    expect(match).toBeNull()
  })
})

describe('applyDomainStatusFromWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 'test-key'
  })

  it('updates the matching row and reports true when receiving is confirmed', async () => {
    domainsMock.get.mockResolvedValue({
      data: {
        id: 'rd_1',
        status: 'verified',
        capabilities: { receiving: 'enabled', sending: 'disabled' },
        records: [RECEIVING_RECORD],
      },
      error: null,
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', verified_at: null } })
    enqueue({ data: null }) // update
    const matched = await applyDomainStatusFromWebhook(supabase as unknown as SupabaseClient, {
      id: 'rd_1',
      status: 'verified',
      records: [],
    })
    expect(matched).toBe(true)
    expect(domainsMock.get).toHaveBeenCalledWith('rd_1')
  })

  it('never flips a sending-only domain to verified off the event status', async () => {
    domainsMock.get.mockResolvedValue({
      data: {
        id: 'rd_1',
        status: 'verified',
        capabilities: { receiving: 'disabled', sending: 'enabled' },
        records: [],
      },
      error: null,
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', verified_at: null } })
    enqueue({ data: null }) // update (last_checked_at only)
    const matched = await applyDomainStatusFromWebhook(supabase as unknown as SupabaseClient, {
      id: 'rd_1',
      status: 'verified',
      records: [],
    })
    // Row matched, but the verified transition was refused.
    expect(matched).toBe(true)
    expect(domainsMock.get).toHaveBeenCalledWith('rd_1')
  })

  it('keeps stored status when the capability lookup fails', async () => {
    domainsMock.get.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', verified_at: null } })
    enqueue({ data: null }) // update (last_checked_at only)
    const matched = await applyDomainStatusFromWebhook(supabase as unknown as SupabaseClient, {
      id: 'rd_1',
      status: 'verified',
    })
    expect(matched).toBe(true)
  })

  it('skips the capability lookup for non-verified statuses', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'row-1', verified_at: null } })
    enqueue({ data: null }) // update
    const matched = await applyDomainStatusFromWebhook(supabase as unknown as SupabaseClient, {
      id: 'rd_1',
      status: 'failed',
    })
    expect(matched).toBe(true)
    expect(domainsMock.get).not.toHaveBeenCalled()
  })

  it('reports false for unknown Resend domain ids', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const matched = await applyDomainStatusFromWebhook(supabase as unknown as SupabaseClient, {
      id: 'rd_unknown',
      status: 'verified',
    })
    expect(matched).toBe(false)
    expect(domainsMock.get).not.toHaveBeenCalled()
  })
})
