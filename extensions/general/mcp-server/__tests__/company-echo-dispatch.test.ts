import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

/**
 * Dispatcher-level behaviour of "one connection, every company":
 *   - every company-scoped result announces its company first (text block
 *     and _meta), while structuredContent keeps the tool's own shape;
 *   - approve/reject route to the operation's own company when the caller
 *     names only the operation_id;
 *   - a company the key cannot reach is answered with the companies it can.
 */

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'
const STRANGER_COMPANY_ID = '33333333-3333-4333-8333-333333333333'
const OPERATION_ID = '99999999-9999-4999-8999-999999999999'

const mocks = vi.hoisted(() => ({
  memberships: {} as Record<string, { role: string; name: string }>,
  membershipLookups: [] as string[],
  operationRow: null as Record<string, unknown> | null,
  pendingRows: [] as Array<Record<string, unknown>>,
  commit: vi.fn(),
  getUserCompanies: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => mocks.commit(...args),
}))
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
    maybeSingle: vi.fn(async () => ({ data: mocks.operationRow ? { company_id: mocks.operationRow.company_id } : null, error: null })),
    single: vi.fn(async () => ({ data: mocks.operationRow, error: mocks.operationRow ? null : { message: 'none' } })),
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
    auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: { email: 'a@b.se' } } }) } },
  }
}

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['companies:read', 'pending_operations:read', 'pending_operations:approve'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
    }),
    createServiceClientNoCookies: vi.fn(() => serviceClient()),
  }
})

import { handleMcpRequest } from '../server'

function toolCall(name: string, args: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

async function parse(response: Response) {
  const json = await response.json()
  const result = json.result as {
    isError?: boolean
    content: Array<{ text: string }>
    structuredContent?: Record<string, unknown>
    _meta?: Record<string, unknown>
  }
  return {
    isError: result.isError === true,
    text: JSON.parse(result.content[0].text) as Record<string, unknown>,
    structured: result.structuredContent,
    meta: result._meta,
  }
}

describe('company echo and operation routing at the dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.membershipLookups.length = 0
    mocks.memberships = {
      [DEFAULT_COMPANY_ID]: { role: 'owner', name: 'Default AB' },
      [OTHER_COMPANY_ID]: { role: 'admin', name: 'Other AB' },
    }
    mocks.operationRow = null
    mocks.pendingRows = []
    mocks.getUserCompanies.mockResolvedValue([
      { company_id: DEFAULT_COMPANY_ID, companies: { id: DEFAULT_COMPANY_ID, name: 'Default AB', archived_at: null } },
      { company_id: OTHER_COMPANY_ID, companies: { id: OTHER_COMPANY_ID, name: 'Other AB', archived_at: null } },
    ])
  })

  it('announces the company first in the text block and in _meta, not in structuredContent', async () => {
    const result = await parse(
      await handleMcpRequest(toolCall('gnubok_list_pending_operations', { company_id: OTHER_COMPANY_ID }))
    )
    expect(result.isError).toBe(false)
    expect(Object.keys(result.text)[0]).toBe('company')
    expect(result.text.company).toEqual({ company_id: OTHER_COMPANY_ID, name: 'Other AB', is_default: false })
    expect(result.structured).toBeDefined()
    expect(result.structured).not.toHaveProperty('company')
    expect(result.meta).toMatchObject({ company: { company_id: OTHER_COMPANY_ID, name: 'Other AB', is_default: false } })
  })

  it('marks the default company as such when company_id is omitted', async () => {
    const result = await parse(await handleMcpRequest(toolCall('gnubok_list_pending_operations', {})))
    expect(result.text.company).toEqual({ company_id: DEFAULT_COMPANY_ID, name: 'Default AB', is_default: true })
  })

  it('routes an approval to the operation company without company_id', async () => {
    mocks.operationRow = {
      id: OPERATION_ID,
      company_id: OTHER_COMPANY_ID,
      operation_type: 'ignore_transaction',
      risk_level: 'low',
      status: 'pending',
    }
    mocks.commit.mockResolvedValue({ status: 'committed', data: {} })

    const result = await parse(
      await handleMcpRequest(toolCall('gnubok_approve_pending_operation', { operation_id: OPERATION_ID }))
    )

    expect(result.isError).toBe(false)
    expect(mocks.membershipLookups).toEqual([OTHER_COMPANY_ID])
    expect(mocks.commit).toHaveBeenCalledWith(expect.anything(), 'user-1', OTHER_COMPANY_ID, mocks.operationRow, expect.anything())
    expect(result.text.company).toEqual({ company_id: OTHER_COMPANY_ID, name: 'Other AB', is_default: false })
    expect(result.text.status).toBe('committed')
  })

  it('answers a company the key cannot reach with the companies it can', async () => {
    const result = await parse(
      await handleMcpRequest(toolCall('gnubok_list_pending_operations', { company_id: STRANGER_COMPANY_ID }))
    )
    expect(result.isError).toBe(true)
    expect((result.text.error as { code: string }).code).toBe('NOT_FOUND')
    expect(result.text.candidates).toEqual([
      { company_id: DEFAULT_COMPANY_ID, name: 'Default AB' },
      { company_id: OTHER_COMPANY_ID, name: 'Other AB' },
    ])
  })
})
