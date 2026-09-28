import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

/**
 * Dispatcher-level behaviour of a pinned connection (`?company=<uuid>` on
 * the MCP URL):
 *   - the pin is checked like a company_id (membership + allowlist) on every
 *     authenticated request; an unreachable or malformed pin is a JSON-RPC
 *     error, never a 401;
 *   - the pin becomes the default: a call without company_id runs there;
 *   - tools/list hides gnubok_list_companies and the scoped tools and
 *     projects no company_id property; initialize states the pin;
 *   - a call naming another company_id is FORBIDDEN, a scoped tool is a
 *     VALIDATION_ERROR naming the pin;
 *   - an anonymous request with a pin is unaffected.
 */

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const PINNED_COMPANY_ID = '22222222-2222-4222-8222-222222222222'
const STRANGER_COMPANY_ID = '33333333-3333-4333-8333-333333333333'
const ENDPOINT = 'http://localhost:3000/api/extensions/ext/mcp-server/mcp'

const mocks = vi.hoisted(() => ({
  memberships: {} as Record<string, { role: string; name: string }>,
  membershipLookups: [] as string[],
  pendingRows: [] as Array<Record<string, unknown>>,
  allowedCompanyIds: null as string[] | null,
  getUserCompanies: vi.fn(),
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
      if (id) mocks.membershipLookups.push(id)
      const membership = id ? mocks.memberships[id] : undefined
      return {
        data: membership && id
          ? { company_id: id, role: membership.role, companies: { archived_at: null, name: 'Legal', company_settings: { company_name: membership.name } } }
          : null,
        error: null,
      }
    }),
  })
  const pendingChain: Record<string, ReturnType<typeof vi.fn>> = {}
  const pendingResult = () => ({ data: mocks.pendingRows, error: null, count: mocks.pendingRows.length })
  Object.assign(pendingChain, {
    select: vi.fn(() => pendingChain),
    eq: vi.fn(() => pendingChain),
    in: vi.fn(() => pendingChain),
    order: vi.fn(() => pendingChain),
    range: vi.fn(async () => pendingResult()),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  })
  const settingsChain = {
    select: vi.fn(() => ({ in: vi.fn(() => ({ order: vi.fn(() => ({ range: vi.fn().mockResolvedValue({ data: [], error: null }) })) })) })),
  }
  return {
    from: vi.fn((table: string) => {
      if (table === 'company_members') return membershipChain
      if (table === 'pending_operations') return pendingChain
      if (table === 'company_settings') return settingsChain
      throw new Error(`Unexpected table: ${table}`)
    }),
  }
}

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    validateApiKey: vi.fn(async () => ({
      userId: 'user-1',
      companyId: DEFAULT_COMPANY_ID,
      scopes: ['companies:read', 'pending_operations:read', 'pending_operations:approve'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
      mode: 'live',
      unattendedCommitLimit: null,
      allowedCompanyIds: mocks.allowedCompanyIds,
    })),
    createServiceClientNoCookies: vi.fn(() => serviceClient()),
  }
})

import { handleMcpRequest } from '../server'

function rpc(
  body: Record<string, unknown>,
  options: { pin?: string | null; anonymous?: boolean } = {}
): Request {
  const url = new URL(ENDPOINT)
  if (options.pin !== undefined && options.pin !== null) url.searchParams.set('company', options.pin)
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.anonymous ? {} : { Authorization: 'Bearer gnubok_sk_test-token' }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  })
}

const toolCall = (name: string, args: Record<string, unknown>, options?: { pin?: string; anonymous?: boolean }) =>
  rpc({ method: 'tools/call', params: { name, arguments: args } }, options)

async function parseTool(response: Response) {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: Array<{ text: string }> }
  return {
    isError: result.isError === true,
    text: JSON.parse(result.content[0].text) as Record<string, unknown>,
  }
}

async function listTools(options?: { pin?: string; anonymous?: boolean }) {
  const response = await handleMcpRequest(rpc({ method: 'tools/list', params: {} }, options))
  const json = await response.json()
  return json.result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>
}

describe('pinned connection at the dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.membershipLookups.length = 0
    mocks.memberships = {
      [DEFAULT_COMPANY_ID]: { role: 'owner', name: 'Default AB' },
      [PINNED_COMPANY_ID]: { role: 'admin', name: 'Pinned AB' },
    }
    mocks.pendingRows = []
    mocks.allowedCompanyIds = null
    mocks.getUserCompanies.mockResolvedValue([
      { company_id: DEFAULT_COMPANY_ID, companies: { id: DEFAULT_COMPANY_ID, name: 'Default AB', archived_at: null } },
      { company_id: PINNED_COMPANY_ID, companies: { id: PINNED_COMPANY_ID, name: 'Pinned AB', archived_at: null } },
    ])
  })

  it('routes a call without company_id to the pin, without a company block (simple mode)', async () => {
    const result = await parseTool(
      await handleMcpRequest(toolCall('gnubok_list_pending_operations', {}, { pin: PINNED_COMPANY_ID }))
    )
    expect(result.isError).toBe(false)
    // A pinned connection is simple company mode by definition: one company,
    // named once in the instructions, never repeated on results.
    expect(result.text).not.toHaveProperty('company')
    // The pin check and the call's own resolution both look at the pin only.
    expect(mocks.membershipLookups).toEqual([PINNED_COMPANY_ID, PINNED_COMPANY_ID])
  })

  it('accepts an explicit company_id equal to the pin (any case)', async () => {
    const result = await parseTool(
      await handleMcpRequest(
        toolCall('gnubok_list_pending_operations', { company_id: PINNED_COMPANY_ID.toUpperCase() }, { pin: PINNED_COMPANY_ID })
      )
    )
    expect(result.isError).toBe(false)
    expect(result.text).not.toHaveProperty('company')
    expect(mocks.membershipLookups).toContain(PINNED_COMPANY_ID)
  })

  it('refuses a call naming another company with FORBIDDEN and no candidates', async () => {
    const result = await parseTool(
      await handleMcpRequest(
        toolCall('gnubok_list_pending_operations', { company_id: DEFAULT_COMPANY_ID }, { pin: PINNED_COMPANY_ID })
      )
    )
    expect(result.isError).toBe(true)
    const error = result.text.error as { code: string; message_en: string }
    expect(error.code).toBe('FORBIDDEN')
    expect(error.message_en).toContain('This connection is pinned to Pinned AB')
    expect(result.text.candidates).toBeUndefined()
    // Only the pin itself was ever resolved: the other company was never looked up.
    expect(mocks.membershipLookups).toEqual([PINNED_COMPANY_ID])
  })

  it('refuses a scoped tool with a VALIDATION_ERROR naming the pin', async () => {
    const result = await parseTool(
      await handleMcpRequest(toolCall('gnubok_client_overview', {}, { pin: PINNED_COMPANY_ID }))
    )
    expect(result.isError).toBe(true)
    const error = result.text.error as { code: string; message_en: string }
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message_en).toContain('pinned to Pinned AB')
    expect(mocks.getUserCompanies).not.toHaveBeenCalled()
  })

  it('hides the company switch and the scoped tools from tools/list and projects no company_id', async () => {
    const free = await listTools()
    const freeNames = free.map((t) => t.name)
    expect(freeNames).toContain('gnubok_list_companies')
    expect(freeNames).toContain('gnubok_client_overview')
    const freePending = free.find((t) => t.name === 'gnubok_list_pending_operations')!
    expect(freePending.inputSchema.properties?.company_id).toBeDefined()

    const pinned = await listTools({ pin: PINNED_COMPANY_ID })
    const pinnedNames = pinned.map((t) => t.name)
    expect(pinnedNames).not.toContain('gnubok_list_companies')
    for (const scoped of ['gnubok_client_overview', 'gnubok_run_across_companies', 'gnubok_stage_across_companies', 'gnubok_portfolio_readiness']) {
      expect(pinnedNames).not.toContain(scoped)
    }
    expect(pinnedNames).toContain('gnubok_list_pending_operations')
    for (const tool of pinned) {
      expect(tool.inputSchema.properties?.company_id, tool.name).toBeUndefined()
    }
  })

  it('states the pin in the initialize instructions', async () => {
    const response = await handleMcpRequest(
      rpc({ method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { pin: PINNED_COMPANY_ID })
    )
    const json = await response.json()
    const instructions = json.result.instructions as string
    expect(instructions).toContain(`this connection is pinned to Pinned AB (${PINNED_COMPANY_ID})`)
    expect(instructions).not.toContain('gnubok_list_companies lists every company this key reaches')
  })

  it('answers a pin the key cannot reach with a JSON-RPC error, not a 401', async () => {
    const response = await handleMcpRequest(
      toolCall('gnubok_list_pending_operations', {}, { pin: STRANGER_COMPANY_ID })
    )
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.error.code).toBe(-32602)
    expect(json.error.message).toContain(STRANGER_COMPANY_ID)
    expect(json.result).toBeUndefined()
  })

  it('answers a pin outside the key allowlist the same way, even for a member company', async () => {
    mocks.allowedCompanyIds = [DEFAULT_COMPANY_ID]
    const response = await handleMcpRequest(
      rpc({ method: 'tools/list', params: {} }, { pin: PINNED_COMPANY_ID })
    )
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.error.code).toBe(-32602)
    expect(mocks.membershipLookups).toEqual([])
  })

  it('answers a malformed pin with a 400 JSON-RPC error', async () => {
    const response = await handleMcpRequest(
      rpc({ method: 'tools/list', params: {} }, { pin: 'acme' })
    )
    expect(response.status).toBe(400)
    const json = await response.json()
    expect(json.error.code).toBe(-32602)
    expect(json.error.message).toContain('company')
  })

  it('leaves anonymous requests alone until they connect', async () => {
    const response = await handleMcpRequest(
      rpc({ method: 'tools/list', params: {} }, { pin: 'acme', anonymous: true })
    )
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(Array.isArray(json.result.tools)).toBe(true)
    expect(json.result.tools.map((t: { name: string }) => t.name)).toContain('gnubok_list_companies')
  })

  it('lists only the pinned company from gnubok_list_companies when called anyway', async () => {
    const result = await parseTool(
      await handleMcpRequest(toolCall('gnubok_list_companies', {}, { pin: PINNED_COMPANY_ID }))
    )
    expect(result.isError).toBe(false)
    const companies = result.text.companies as Array<{ company_id: string; is_default: boolean }>
    expect(companies.map((c) => c.company_id)).toEqual([PINNED_COMPANY_ID])
    expect(companies[0].is_default).toBe(true)
    expect(result.text.default_company_id).toBe(PINNED_COMPANY_ID)
  })
})
