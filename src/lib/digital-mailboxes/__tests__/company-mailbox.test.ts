import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kivraCompanyMailboxForCompany, kivraCompanyMailboxMatch, readKivraMatchTenantKey, resetKeptCompanyMailboxAnswers } from '../company-mailbox'
import { KivraTenantClient } from '../kivra'
import { resetDigitalMailboxProviders } from '../providers'

const loadCompanyIdentity = vi.fn()
// The shared store and the limiter of the deployment: absent by default, so answers are kept in the process.
const store = vi.hoisted(() => ({
  redis: null as null | { get: (key: string) => Promise<unknown>; set: (key: string, value: string, options: { ex: number }) => Promise<unknown> },
  checkRateLimit: vi.fn(),
}))
vi.mock('@/lib/auth/rate-limit-http', () => ({ getRedis: () => store.redis, checkRateLimit: store.checkRateLimit }))
vi.mock('../connect', () => ({ loadCompanyIdentity: (...args: unknown[]) => loadCompanyIdentity(...args) }))

const BASE = 'https://sender.sandbox-api.kivra.com'
const COMPANY_ORG = '4420059208'
const SOLE_TRADER_ORG = '8507099805'
const supabase = {} as SupabaseClient

type Call = { url: string; body: unknown }
let calls: Call[]
let matchAnswer: () => Response

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function identity(orgNumber: string | null, isSandbox = false) {
  return { companyId: 'c1', name: 'Test AB', orgNumber, addressLine1: null, postalCode: null, city: null, isSandbox }
}

const matchCalls = () => calls.filter((c) => !c.url.endsWith('/v1/auth'))
const kivra = () => ({ sender: new KivraTenantClient(BASE, { clientId: 'id', clientSecret: 'secret' }) })

beforeEach(() => {
  calls = []
  matchAnswer = () => json({ list: [] })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, body: typeof init.body === 'string' && url.includes('/v2/') ? JSON.parse(init.body) : null })
    return url.endsWith('/v1/auth') ? json({ access_token: 'tok', expires_in: 3600 }) : matchAnswer()
  }))
  vi.stubEnv('KIVRA_CLIENT_ID', 'kc')
  vi.stubEnv('KIVRA_CLIENT_SECRET', 'ks')
  vi.stubEnv('KIVRA_PARTNER_CLIENT_ID', 'kp')
  vi.stubEnv('KIVRA_PARTNER_CLIENT_SECRET', 'kps')
  vi.stubEnv('KIVRA_ONBOARDING_URL', 'https://example.test/onboard')
  vi.stubEnv('DIGITAL_MAILBOX_COMPANY_IDS', '*')
  resetDigitalMailboxProviders()
  loadCompanyIdentity.mockReset()
  loadCompanyIdentity.mockResolvedValue(identity(COMPANY_ORG))
  store.redis = null
  store.checkRateLimit.mockReset()
  store.checkRateLimit.mockResolvedValue({ ok: true })
  resetKeptCompanyMailboxAnswers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetDigitalMailboxProviders()
})

describe('readKivraMatchTenantKey', () => {
  it('is null while unset or empty, else the trimmed key', () => {
    expect(readKivraMatchTenantKey({})).toBeNull()
    expect(readKivraMatchTenantKey({ KIVRA_MATCH_TENANT_KEY: '  ' })).toBeNull()
    expect(readKivraMatchTenantKey({ KIVRA_MATCH_TENANT_KEY: ' tk ' })).toBe('tk')
  })
})

describe('kivraCompanyMailboxMatch', () => {
  it('is has when Kivra lists the VAT number, and sends exactly that number', async () => {
    matchAnswer = () => json({ list: ['SE442005920801'] })
    await expect(kivraCompanyMailboxMatch({ kivra: kivra(), tenantKey: 'tk', orgNumber: COMPANY_ORG })).resolves.toBe('has')
    expect(matchCalls()).toEqual([{ url: `${BASE}/v2/tenant/tk/companymatch/vatnr`, body: { list: ['SE442005920801'] } }])
  })

  it('is none when Kivra does not list it', async () => {
    await expect(kivraCompanyMailboxMatch({ kivra: kivra(), tenantKey: 'tk', orgNumber: COMPANY_ORG })).resolves.toBe('none')
  })

  it('is unknown without a tenant key, and sends nothing', async () => {
    await expect(kivraCompanyMailboxMatch({ kivra: kivra(), tenantKey: null, orgNumber: COMPANY_ORG })).resolves.toBe('unknown')
    expect(calls).toEqual([])
  })

  it('is unknown when the deployment does not carry Kivra sending, and sends nothing', async () => {
    await expect(kivraCompanyMailboxMatch({ kivra: null, tenantKey: 'tk', orgNumber: COMPANY_ORG })).resolves.toBe('unknown')
    await expect(kivraCompanyMailboxMatch({ kivra: { sender: null }, tenantKey: 'tk', orgNumber: COMPANY_ORG })).resolves.toBe('unknown')
    expect(calls).toEqual([])
  })

  it('is unknown for a sole trader or a missing or invalid number, and sends nothing', async () => {
    for (const orgNumber of [SOLE_TRADER_ORG, null, '', '123']) {
      await expect(kivraCompanyMailboxMatch({ kivra: kivra(), tenantKey: 'tk', orgNumber })).resolves.toBe('unknown')
    }
    expect(calls).toEqual([])
  })

  it('is unknown when the provider call fails', async () => {
    matchAnswer = () => json({ message: 'no' }, 500)
    await expect(kivraCompanyMailboxMatch({ kivra: kivra(), tenantKey: 'tk', orgNumber: COMPANY_ORG })).resolves.toBe('unknown')
  })

  it('is unknown when the provider call times out', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/auth')) return json({ access_token: 'tok', expires_in: 3600 })
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }))
    await expect(kivraCompanyMailboxMatch({ kivra: kivra(), tenantKey: 'tk', orgNumber: COMPANY_ORG })).resolves.toBe('unknown')
  })
})

describe('kivraCompanyMailboxForCompany', () => {
  const env = { KIVRA_MATCH_TENANT_KEY: 'tk' }

  it('asks once and answers has or none for a company that has not connected Kivra', async () => {
    matchAnswer = () => json({ list: ['SE442005920801'] })
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('has')
    expect(matchCalls()).toHaveLength(1)
    matchAnswer = () => json({ list: [] })
    await expect(kivraCompanyMailboxForCompany(supabase, 'c2', { receive_state: 'ended' }, env)).resolves.toBe('none')
    expect(matchCalls()).toHaveLength(2)
  })

  it('keeps the answer per company: loading the list again does not ask Kivra again', async () => {
    matchAnswer = () => json({ list: ['SE442005920801'] })
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('has')
    matchAnswer = () => json({ list: [] })
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('has')
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('has')
    expect(matchCalls()).toHaveLength(1)
  })

  it('asks again once the kept answer has run out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('none')
      vi.setSystemTime(Date.now() + 9 * 60 * 1000)
      await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('none')
      expect(matchCalls()).toHaveLength(1)
      vi.setSystemTime(Date.now() + 2 * 60 * 1000)
      matchAnswer = () => json({ list: ['SE442005920801'] })
      await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('has')
      expect(matchCalls()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not repeat a failed call at once', async () => {
    matchAnswer = () => json({ error: 'down' }, 500)
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('unknown')
    const after = matchCalls().length
    matchAnswer = () => json({ list: ['SE442005920801'] })
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('unknown')
    expect(matchCalls()).toHaveLength(after)
  })

  it('shares one call between loads that arrive together', async () => {
    matchAnswer = () => json({ list: ['SE442005920801'] })
    const answers = await Promise.all([
      kivraCompanyMailboxForCompany(supabase, 'c1', null, env),
      kivraCompanyMailboxForCompany(supabase, 'c1', null, env),
      kivraCompanyMailboxForCompany(supabase, 'c1', null, env),
    ])
    expect(answers).toEqual(['has', 'has', 'has'])
    expect(matchCalls()).toHaveLength(1)
  })

  it('answers unknown without a call for a company past its hourly cap', async () => {
    store.checkRateLimit.mockResolvedValue({ ok: false })
    matchAnswer = () => json({ list: ['SE442005920801'] })
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('unknown')
    expect(calls).toEqual([])
    expect(store.checkRateLimit).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'kivra-company-match', identifier: 'c1' }))
  })

  it('reads and keeps the answer in the shared store when the deployment has one', async () => {
    const kept = new Map<string, string>()
    const set = vi.fn(async (key: string, value: string, _options: { ex: number }) => void kept.set(key, value))
    store.redis = { get: async (key) => kept.get(key) ?? null, set }
    matchAnswer = () => json({ list: ['SE442005920801'] })
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('has')
    expect(set).toHaveBeenCalledWith('kivra-company-mailbox:c1', 'has', { ex: 6 * 60 * 60 })
    // Another process: nothing kept in memory, the shared store answers.
    resetKeptCompanyMailboxAnswers()
    matchAnswer = () => json({ list: [] })
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('has')
    expect(matchCalls()).toHaveLength(1)
  })

  it('still answers when the shared store fails', async () => {
    store.redis = {
      get: async () => {
        throw new Error('store down')
      },
      set: async () => {
        throw new Error('store down')
      },
    }
    matchAnswer = () => json({ list: ['SE442005920801'] })
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('has')
  })

  it('does not ask while Kivra is connected or waiting for its activation', async () => {
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', { receive_state: 'active' }, env)).resolves.toBeNull()
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', { receive_state: 'pending' }, env)).resolves.toBeNull()
    expect(calls).toEqual([])
    expect(loadCompanyIdentity).not.toHaveBeenCalled()
  })

  it('is unknown without the tenant key and reads nothing', async () => {
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, {})).resolves.toBe('unknown')
    expect(calls).toEqual([])
    expect(loadCompanyIdentity).not.toHaveBeenCalled()
  })

  it('does not ask for a company outside the rollout', async () => {
    vi.stubEnv('DIGITAL_MAILBOX_COMPANY_IDS', 'someone-else')
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBeNull()
    expect(calls).toEqual([])
  })

  it('is unknown for a sole trader, the demo company, a missing company and a failed read, and sends nothing', async () => {
    loadCompanyIdentity.mockResolvedValueOnce(identity(SOLE_TRADER_ORG))
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('unknown')
    loadCompanyIdentity.mockResolvedValueOnce(identity(COMPANY_ORG, true))
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('unknown')
    loadCompanyIdentity.mockResolvedValueOnce(null)
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('unknown')
    loadCompanyIdentity.mockRejectedValueOnce(new Error('db'))
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('unknown')
    expect(calls).toEqual([])
  })

  it('is unknown when the deployment holds no Kivra sending client', async () => {
    vi.stubEnv('KIVRA_CLIENT_ID', '')
    vi.stubEnv('KIVRA_CLIENT_SECRET', '')
    resetDigitalMailboxProviders()
    await expect(kivraCompanyMailboxForCompany(supabase, 'c1', null, env)).resolves.toBe('unknown')
    expect(calls).toEqual([])
  })
})
