import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

/**
 * resources/read for a company (crm#1637). A multi-company agent read
 * Accounted://attention, Accounted://period/active and
 * Accounted://recent-activity for the default company with no company in the
 * payload, and mixed two companies in one report:
 *   - Accounted://company/{company_id}/{resource} reads any data resource
 *     for that company, membership-checked like a tool call's company_id;
 *   - an unscoped resource names the company it answered for, as a tool
 *     result does (not on a single-company key, which has no other);
 *   - a pinned connection reads only the pin.
 */

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'
const STRANGER_COMPANY_ID = '33333333-3333-4333-8333-333333333333'
const ENDPOINT = 'http://localhost:3000/api/extensions/ext/mcp-server/mcp'

const mocks = vi.hoisted(() => ({
  memberships: {} as Record<string, { role: string; name: string }>,
  reads: [] as Array<{ uri: string; companyId: string; query: string | null }>,
  getUserCompanies: vi.fn(),
  userId: 'user-0',
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getUserCompanies: (...args: unknown[]) => mocks.getUserCompanies(...args),
}))
vi.mock('@/lib/clients/fetch-client-overview', () => ({ getByraMembership: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'entitled', graceEndsAt: null }) }
})

// Every data resource answers which company it was read for.
vi.mock('../resources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resources')>()
  for (const resource of actual.dataResources) {
    resource.read = async (ctx) => {
      mocks.reads.push({ uri: resource.uri, companyId: ctx.companyId, query: ctx.query?.toString() ?? null })
      return { read_for: ctx.companyId }
    }
  }
  return actual
})

function serviceClient() {
  const membershipChain: Record<string, ReturnType<typeof vi.fn>> = {}
  let requested: string | null = null
  Object.assign(membershipChain, {
    select: vi.fn(() => membershipChain),
    eq: vi.fn((column: string, value: string) => {
      if (column === 'company_id') requested = value
      return membershipChain
    }),
    is: vi.fn(() => membershipChain),
    maybeSingle: vi.fn(async () => {
      const id = requested
      requested = null
      const membership = id ? mocks.memberships[id] : undefined
      return {
        data: membership && id
          ? { company_id: id, role: membership.role, companies: { archived_at: null, name: 'Legal', company_settings: { company_name: membership.name } } }
          : null,
        error: null,
      }
    }),
  })
  return {
    from: vi.fn((table: string) => {
      if (table === 'company_members') return membershipChain
      throw new Error(`Unexpected table: ${table}`)
    }),
  }
}

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    validateApiKey: vi.fn(async () => ({
      userId: mocks.userId,
      companyId: DEFAULT_COMPANY_ID,
      scopes: ['companies:read', 'reports:read', 'transactions:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
      mode: 'live',
      unattendedCommitLimit: null,
      allowedCompanyIds: null,
    })),
    createServiceClientNoCookies: vi.fn(() => serviceClient()),
  }
})

import { handleMcpRequest } from '../server'

function readResource(uri: string, pin?: string): Request {
  const url = new URL(ENDPOINT)
  if (pin) url.searchParams.set('company', pin)
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gnubok_sk_test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }),
  })
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  const json = await response.json()
  if (json.error) throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`)
  return JSON.parse(json.result.contents[0].text) as Record<string, unknown>
}

function companies(...ids: string[]) {
  mocks.getUserCompanies.mockResolvedValue(
    ids.map((id) => ({ company_id: id, companies: { id, name: mocks.memberships[id]?.name ?? id, archived_at: null } })),
  )
}

// getReachableCompanyCount caches per user: each test is its own user.
let userCounter = 0

describe('MCP resources for a company (crm#1637)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    userCounter += 1
    mocks.userId = `user-${userCounter}`
    mocks.reads.length = 0
    mocks.memberships = {
      [DEFAULT_COMPANY_ID]: { role: 'owner', name: 'Default AB' },
      [OTHER_COMPANY_ID]: { role: 'admin', name: 'Demo AB' },
    }
    companies(DEFAULT_COMPANY_ID, OTHER_COMPANY_ID)
  })

  it.each([
    ['attention', 'Accounted://attention'],
    ['period/active', 'Accounted://period/active'],
    ['period%2Factive', 'Accounted://period/active'],
    ['recent-activity', 'Accounted://recent-activity'],
    ['context', 'Accounted://company/current'],
  ])('reads Accounted://company/{id}/%s for that company, with the company first', async (path, resourceUri) => {
    const result = await payload(await handleMcpRequest(readResource(`Accounted://company/${OTHER_COMPANY_ID}/${path}`)))
    expect(result).toEqual({
      company: { company_id: OTHER_COMPANY_ID, name: 'Demo AB', is_default: false },
      read_for: OTHER_COMPANY_ID,
    })
    expect(mocks.reads).toEqual([{ uri: resourceUri, companyId: OTHER_COMPANY_ID, query: null }])
  })

  it('passes the query string of a company-scoped URI to the resource', async () => {
    await payload(await handleMcpRequest(readResource(`Accounted://company/${OTHER_COMPANY_ID}/ledger/context?limit=5`)))
    expect(mocks.reads).toEqual([{ uri: 'Accounted://ledger/context', companyId: OTHER_COMPANY_ID, query: 'limit=5' }])
  })

  it('refuses a company the key does not reach, without reading anything', async () => {
    const json = await (await handleMcpRequest(readResource(`Accounted://company/${STRANGER_COMPANY_ID}/attention`))).json()
    expect(json.error.code).toBe(-32602)
    expect(mocks.reads).toEqual([])
  })

  it('answers an unknown resource under a company as not found', async () => {
    const json = await (await handleMcpRequest(readResource(`Accounted://company/${OTHER_COMPANY_ID}/nope`))).json()
    expect(json.error.code).toBe(-32602)
    expect(json.error.message).toContain('Resource not found')
    expect(mocks.reads).toEqual([])
  })

  it('names the default company on an unscoped resource of a multi-company key', async () => {
    const result = await payload(await handleMcpRequest(readResource('Accounted://attention')))
    expect(result).toEqual({
      company: { company_id: DEFAULT_COMPANY_ID, name: 'Default AB', is_default: true },
      read_for: DEFAULT_COMPANY_ID,
    })
  })

  it('adds no company block for a single-company key', async () => {
    companies(DEFAULT_COMPANY_ID)
    const result = await payload(await handleMcpRequest(readResource('Accounted://period/active')))
    expect(result).toEqual({ read_for: DEFAULT_COMPANY_ID })
  })

  it('reads the pin on a pinned connection, and refuses another company there', async () => {
    const pinned = await payload(await handleMcpRequest(readResource('Accounted://recent-activity', OTHER_COMPANY_ID)))
    expect(pinned).toEqual({ read_for: OTHER_COMPANY_ID })
    mocks.reads.length = 0
    const json = await (await handleMcpRequest(readResource(`Accounted://company/${DEFAULT_COMPANY_ID}/attention`, OTHER_COMPANY_ID))).json()
    expect(json.error.code).toBe(-32602)
    expect(mocks.reads).toEqual([])
  })

  it('lists the company resource template', async () => {
    const response = await handleMcpRequest(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gnubok_sk_test-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/templates/list', params: {} }),
      }),
    )
    const json = await response.json()
    const templates = (json.result.resourceTemplates as Array<{ uriTemplate: string }>).map((t) => t.uriTemplate)
    expect(templates).toEqual(['Accounted://company/{company_id}/context', 'Accounted://company/{company_id}/{resource}'])
  })
})
