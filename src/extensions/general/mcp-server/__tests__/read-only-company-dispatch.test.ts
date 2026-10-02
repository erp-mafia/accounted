import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

/**
 * Dispatcher-level behaviour of a key with a per-company access level
 * (api_key_companies.access, migration 20260928112724): the key reaches two
 * companies where the user is owner, and may only read in one of them.
 *   - a write tool in the read-only company is refused FORBIDDEN before it
 *     runs, naming the company, whatever the key's scopes say;
 *   - read tools run there as usual;
 *   - gnubok_list_companies reports the access per company;
 *   - cross-company staging refuses the read-only company per row.
 */

// Hoisted: the api-keys mock factory below reads both ids at hoist time.
const { WRITE_COMPANY_ID, READ_ONLY_COMPANY_ID } = vi.hoisted(() => ({
  WRITE_COMPANY_ID: '11111111-1111-4111-8111-111111111111',
  READ_ONLY_COMPANY_ID: '22222222-2222-4222-8222-222222222222',
}))
const ENDPOINT = 'http://localhost:3000/api/extensions/ext/mcp-server/mcp'

const mocks = vi.hoisted(() => ({
  memberships: {} as Record<string, { role: string; name: string }>,
  tablesTouched: [] as string[],
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
  Object.assign(pendingChain, {
    select: vi.fn(() => pendingChain),
    eq: vi.fn(() => pendingChain),
    in: vi.fn(() => pendingChain),
    order: vi.fn(() => pendingChain),
    range: vi.fn(async () => ({ data: [], error: null, count: 0 })),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  })
  const settingsChain = {
    select: vi.fn(() => ({ in: vi.fn(() => ({ order: vi.fn(() => ({ range: vi.fn().mockResolvedValue({ data: [], error: null }) })) })) })),
  }
  return {
    from: vi.fn((table: string) => {
      mocks.tablesTouched.push(table)
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
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: WRITE_COMPANY_ID,
      scopes: ['companies:read', 'pending_operations:read', 'customers:write', 'transactions:write'],
      apiKeyId: 'key-1',
      apiKeyName: 'Two-company key',
      mode: 'live',
      unattendedCommitLimit: null,
      allowedCompanyIds: [WRITE_COMPANY_ID, READ_ONLY_COMPANY_ID],
      readOnlyCompanyIds: [READ_ONLY_COMPANY_ID],
    }),
    createServiceClientNoCookies: vi.fn(() => serviceClient()),
  }
})

import { handleMcpRequest } from '../server'

function toolCall(name: string, args: Record<string, unknown>): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gnubok_sk_test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

async function parseTool(response: Response) {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: Array<{ text: string }> }
  return {
    isError: result.isError === true,
    text: JSON.parse(result.content[0].text) as Record<string, unknown>,
  }
}

function errorOf(text: Record<string, unknown>) {
  return text.error as { code: string; message_en?: string; message?: string }
}

describe('per-company access level at the dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mocks.tablesTouched.length = 0
    mocks.memberships = {
      [WRITE_COMPANY_ID]: { role: 'owner', name: 'Skriv AB' },
      [READ_ONLY_COMPANY_ID]: { role: 'owner', name: 'Läs AB' },
    }
    mocks.getUserCompanies.mockResolvedValue([
      { company_id: WRITE_COMPANY_ID, role: 'owner', companies: { id: WRITE_COMPANY_ID, name: 'Skriv AB', archived_at: null, org_number: null, entity_type: 'aktiebolag', team_id: null } },
      { company_id: READ_ONLY_COMPANY_ID, role: 'owner', companies: { id: READ_ONLY_COMPANY_ID, name: 'Läs AB', archived_at: null, org_number: null, entity_type: 'aktiebolag', team_id: null } },
    ])
  })

  it('refuses a write tool in the read-only company before it runs, naming the company', async () => {
    const result = await parseTool(
      await handleMcpRequest(toolCall('gnubok_create_customer', { company_id: READ_ONLY_COMPANY_ID, name: 'Kund AB' }))
    )
    expect(result.isError).toBe(true)
    const error = errorOf(result.text)
    expect(error.code).toBe('FORBIDDEN')
    expect(JSON.stringify(result.text)).toMatch(/read-only access to Läs AB/)
    // Refused at the gate: the tool never reached a customer table.
    expect(mocks.tablesTouched).not.toContain('customers')
  })

  it('lets the same write tool past the gate in the company the key may write in', async () => {
    const result = await parseTool(
      await handleMcpRequest(toolCall('gnubok_create_customer', { company_id: WRITE_COMPANY_ID, name: 'Kund AB' }))
    )
    // The tool itself runs (and meets this stub's missing tables), so
    // whatever it answers, it is not the read-only refusal.
    expect(JSON.stringify(result.text)).not.toMatch(/read-only access/)
  })

  it('runs read tools in the read-only company as usual', async () => {
    const result = await parseTool(
      await handleMcpRequest(toolCall('gnubok_list_pending_operations', { company_id: READ_ONLY_COMPANY_ID }))
    )
    expect(result.isError).toBe(false)
  })

  it('reports the access per company from gnubok_list_companies', async () => {
    const result = await parseTool(await handleMcpRequest(toolCall('gnubok_list_companies', {})))
    expect(result.isError).toBe(false)
    const companies = result.text.companies as Array<{ company_id: string; access: string }>
    expect(Object.fromEntries(companies.map((c) => [c.company_id, c.access]))).toEqual({
      [WRITE_COMPANY_ID]: 'write',
      [READ_ONLY_COMPANY_ID]: 'read',
    })
  })

  it('refuses the read-only company per row in cross-company staging, staging nothing there', async () => {
    const result = await parseTool(
      await handleMcpRequest(
        toolCall('gnubok_stage_across_companies', {
          tool: 'gnubok_ignore_transaction',
          arguments: { transaction_id: '33333333-3333-4333-8333-333333333333' },
          scope: [READ_ONLY_COMPANY_ID],
        })
      )
    )
    expect(result.isError).toBe(false)
    const rows = result.text.results as Array<{ company: { company_id: string }; ok: boolean; error?: { code: string; message: string } }>
    expect(rows).toHaveLength(1)
    expect(rows[0].company.company_id).toBe(READ_ONLY_COMPANY_ID)
    expect(rows[0].ok).toBe(false)
    expect(rows[0].error?.code).toBe('FORBIDDEN')
    expect(rows[0].error?.message).toMatch(/read-only access to Läs AB/)
    expect(result.text.staged_count).toBe(0)
  })
})
