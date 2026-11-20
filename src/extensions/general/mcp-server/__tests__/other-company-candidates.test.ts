import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

/**
 * crm#1953: a "not found" from a tool itself, on a key that reaches several
 * companies, names the company the call ran for and the others the key
 * reaches.
 *
 * A wrong company_id was already answered with candidates (the company
 * resolution refusing, company-echo-dispatch.test.ts). Once the company
 * resolved to the default, the tool's own lookup inside it answered a bare
 * "not found" for a record that lives in another reachable company, and only
 * the literal code NOT_FOUND counted as one. Covered here: the helper, and
 * the dispatcher's two exits for a failed execute() (the synchronous call
 * and the task).
 */

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'
const THIRD_COMPANY_ID = '33333333-3333-4333-8333-333333333333'
const TRANSACTION_ID = '44444444-4444-4444-8444-444444444444'
const PERIOD_ID = '55555555-5555-4555-8555-555555555555'
const OPERATION_ID = '66666666-6666-4666-8666-666666666666'

type TableMock = ReturnType<typeof import('@/tests/helpers').createTableMockSupabase>

const mocks = vi.hoisted(() => ({
  companies: [] as Array<{ id: string; name: string }>,
  allowedCompanyIds: null as string[] | null,
  table: null as unknown as TableMock,
  getUserCompanies: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getUserCompanies: (...args: unknown[]) => mocks.getUserCompanies(...args),
}))
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'entitled', graceEndsAt: null }) }
})

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const { createTableMockSupabase } = await import('@/tests/helpers')
  // Every table answers "no rows" except the two the dispatcher needs here:
  // the membership of the company a call resolves to, and the task row.
  mocks.table = createTableMockSupabase({
    company_members: (chainCalls) => {
      const companyId = chainCalls.find((call) => call.method === 'eq' && call.args[0] === 'company_id')?.args[1]
      const company = mocks.companies.find((candidate) => candidate.id === companyId)
      return {
        data: company
          ? { company_id: company.id, role: 'owner', companies: { archived_at: null, name: company.name, company_settings: null } }
          : null,
      }
    },
    mcp_tasks: {
      data: { id: 'task-1', status: 'working', status_message: null, poll_interval_ms: 2000, ttl_ms: 3600000, created_at: '2026-11-17T09:00:00.000Z' },
    },
  })
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn(async () => ({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: [...actual.ALL_SCOPES],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
      mode: 'live',
      allowedCompanyIds: mocks.allowedCompanyIds,
    })),
    createServiceClientNoCookies: vi.fn(() => mocks.table.supabase),
  }
})

import { handleMcpRequest, tools } from '../server'
import {
  OTHER_COMPANY_CANDIDATES_MAX,
  OTHER_COMPANY_NOTE,
  isNotFoundCode,
  resetReachableCompanyCountCache,
  withOtherCompanyCandidates,
} from '../company-routing'
import { TASKS_EXTENSION_ID } from '../tasks'

const DEFAULT_COMPANY = { id: DEFAULT_COMPANY_ID, name: 'Default AB' }
const OTHER_COMPANY = { id: OTHER_COMPANY_ID, name: 'Other AB' }
const THIRD_COMPANY = { id: THIRD_COMPANY_ID, name: 'Third AB' }

/** What a tool throws for a record its company does not hold: a registry code, 404. */
function notFound(code: string): Error {
  return Object.assign(new Error('not found'), { code })
}

function failExecute(toolName: string, error: Error) {
  const tool = tools.find((candidate) => candidate.name === toolName)!
  return vi.spyOn(tool, 'execute').mockRejectedValue(error)
}

function toolCall(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>, query = ''): Request {
  return new Request(`http://localhost:3000/api/extensions/ext/mcp-server/mcp${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
    }),
  })
}

async function callTool(name: string, args: Record<string, unknown>) {
  const json = await (await handleMcpRequest(toolCall(name, args))).json()
  const result = json.result as { isError?: boolean; content: Array<{ text: string }> }
  return { isError: result.isError === true, text: JSON.parse(result.content[0].text) as Record<string, unknown> }
}

const allocate = (args: Record<string, unknown> = {}) =>
  callTool('gnubok_match_batch_allocate', { transaction_id: TRANSACTION_ID, allocations: [], ...args })

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resetReachableCompanyCountCache()
  mocks.companies = [DEFAULT_COMPANY, OTHER_COMPANY]
  mocks.allowedCompanyIds = null
  mocks.table.reset()
  mocks.getUserCompanies.mockImplementation(async () =>
    mocks.companies.map((company) => ({
      company_id: company.id,
      role: 'owner',
      companies: { id: company.id, name: company.name, archived_at: null },
    }))
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isNotFoundCode', () => {
  it('reads every 404 code of the registry as a not found, not only NOT_FOUND', () => {
    for (const code of [
      'NOT_FOUND',
      'BATCH_TX_NOT_FOUND',
      'BATCH_INVOICE_NOT_FOUND',
      'BATCH_SUPPLIER_INVOICE_NOT_FOUND',
      'DOCUMENT_UPLOAD_NOT_FOUND',
      'INVOICE_NOT_FOUND',
    ]) {
      expect(isNotFoundCode(code), code).toBe(true)
    }
    for (const code of ['VALIDATION_ERROR', 'FORBIDDEN', 'BATCH_TX_ALREADY_BOOKED', 'capability_blocked', 'NO_SUCH_CODE']) {
      expect(isNotFoundCode(code), code).toBe(false)
    }
  })
})

describe('withOtherCompanyCandidates', () => {
  const ranFor = { company_id: DEFAULT_COMPANY_ID, name: 'Default AB', is_default: true }
  const call = (overrides: Partial<Parameters<typeof withOtherCompanyCandidates>[1]> = {}) => ({
    supabase: mocks.table.supabase as never,
    userId: 'user-1',
    company: ranFor,
    isSimpleCompanyMode: async () => false,
    ...overrides,
  })
  const refusal = (code: string) => ({ error: { code, message_en: 'x' } })

  it('puts the company first, then the refusal, the other companies and the note', async () => {
    const original = refusal('BATCH_TX_NOT_FOUND')
    const result = await withOtherCompanyCandidates(original, call())
    expect(Object.keys(result)).toEqual(['company', 'error', 'candidates', 'candidates_note'])
    expect(result).toEqual({
      company: ranFor,
      error: original.error,
      candidates: [{ company_id: OTHER_COMPANY_ID, name: 'Other AB' }],
      candidates_note: OTHER_COMPANY_NOTE,
    })
  })

  it('leaves the refusal untouched when it is not a not found', async () => {
    const original = refusal('VALIDATION_ERROR')
    expect(await withOtherCompanyCandidates(original, call())).toBe(original)
    expect(mocks.getUserCompanies).not.toHaveBeenCalled()
  })

  it('leaves it untouched for a tool that takes no company', async () => {
    const original = refusal('NOT_FOUND')
    expect(await withOtherCompanyCandidates(original, call({ company: null }))).toBe(original)
  })

  it('leaves it untouched in simple company mode (one company, or a pinned connection) without listing companies', async () => {
    const original = refusal('NOT_FOUND')
    expect(await withOtherCompanyCandidates(original, call({ isSimpleCompanyMode: async () => true }))).toBe(original)
    expect(mocks.getUserCompanies).not.toHaveBeenCalled()
  })

  it('leaves it untouched when the key reaches no other company', async () => {
    mocks.companies = [DEFAULT_COMPANY]
    const original = refusal('NOT_FOUND')
    expect(await withOtherCompanyCandidates(original, call())).toBe(original)
  })

  it('names only companies inside the key allowlist', async () => {
    mocks.companies = [DEFAULT_COMPANY, OTHER_COMPANY, THIRD_COMPANY]
    const result = await withOtherCompanyCandidates(
      refusal('NOT_FOUND'),
      call({ allowedCompanyIds: [DEFAULT_COMPANY_ID, THIRD_COMPANY_ID] })
    )
    expect(result).toMatchObject({ candidates: [{ company_id: THIRD_COMPANY_ID, name: 'Third AB' }] })
  })

  it(`names at most ${OTHER_COMPANY_CANDIDATES_MAX} companies and points at gnubok_list_companies for the rest`, async () => {
    mocks.companies = [
      DEFAULT_COMPANY,
      ...Array.from({ length: OTHER_COMPANY_CANDIDATES_MAX + 5 }, (_unused, index) => ({
        id: `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`,
        name: `Client ${index}`,
      })),
    ]
    const result = (await withOtherCompanyCandidates(refusal('NOT_FOUND'), call())) as { candidates: unknown[] }
    expect(result.candidates).toHaveLength(OTHER_COMPANY_CANDIDATES_MAX)
    expect(OTHER_COMPANY_NOTE).toContain('gnubok_list_companies')
  })

  it('never turns the refusal into another error when a lookup fails', async () => {
    const original = refusal('NOT_FOUND')
    mocks.getUserCompanies.mockRejectedValue(new Error('db down'))
    expect(await withOtherCompanyCandidates(original, call())).toBe(original)
    const failing = call({ isSimpleCompanyMode: async () => Promise.reject(new Error('db down')) })
    expect(await withOtherCompanyCandidates(original, failing)).toBe(original)
  })

  it('says what unblocks a client whose copy of the tool has no company_id', () => {
    expect(OTHER_COMPANY_NOTE).toContain('repeat the call with its company_id')
    expect(OTHER_COMPANY_NOTE).toContain('refresh or reconnect the Accounted connector, then start a new chat')
  })
})

describe('a not found from execute() at the dispatcher', () => {
  it('names the default company it looked in and the other company, for a domain 404 code', async () => {
    failExecute('gnubok_match_batch_allocate', notFound('BATCH_TX_NOT_FOUND'))

    const result = await allocate()

    expect(result.isError).toBe(true)
    expect((result.text.error as { code: string }).code).toBe('BATCH_TX_NOT_FOUND')
    expect(Object.keys(result.text)[0]).toBe('company')
    expect(result.text.company).toEqual({ company_id: DEFAULT_COMPANY_ID, name: 'Default AB', is_default: true })
    expect(result.text.candidates).toEqual([{ company_id: OTHER_COMPANY_ID, name: 'Other AB' }])
    expect(result.text.candidates_note).toBe(OTHER_COMPANY_NOTE)
  })

  it('names the default company as the candidate when the call named the other one', async () => {
    failExecute('gnubok_match_batch_allocate', notFound('BATCH_TX_NOT_FOUND'))

    const result = await allocate({ company_id: OTHER_COMPANY_ID })

    expect(result.text.company).toEqual({ company_id: OTHER_COMPANY_ID, name: 'Other AB', is_default: false })
    expect(result.text.candidates).toEqual([{ company_id: DEFAULT_COMPANY_ID, name: 'Default AB' }])
  })

  it('rewrites the tool name in the note for the accounted namespace', async () => {
    failExecute('gnubok_match_batch_allocate', notFound('BATCH_TX_NOT_FOUND'))
    const request = toolCall(
      'accounted_match_batch_allocate',
      { transaction_id: TRANSACTION_ID, allocations: [] },
      undefined,
      '?tool_namespace=accounted'
    )

    const json = await (await handleMcpRequest(request)).json()
    const text = JSON.parse(json.result.content[0].text) as { candidates_note: string }

    expect(text.candidates_note).toContain('accounted_list_companies')
    expect(text.candidates_note).not.toContain('gnubok_')
  })

  it('answers a key that reaches one company exactly as before', async () => {
    mocks.companies = [DEFAULT_COMPANY]
    failExecute('gnubok_match_batch_allocate', notFound('BATCH_TX_NOT_FOUND'))

    const result = await allocate()

    expect(result.isError).toBe(true)
    expect(Object.keys(result.text)).toEqual(['error'])
  })

  it('answers a refusal that is not a not found exactly as before', async () => {
    failExecute('gnubok_match_batch_allocate', notFound('BATCH_TX_ALREADY_BOOKED'))

    const result = await allocate()

    expect((result.text.error as { code: string }).code).toBe('BATCH_TX_ALREADY_BOOKED')
    expect(Object.keys(result.text)).toEqual(['error'])
  })

  it('names no other company for an approval that named none: the operation was looked up across companies', async () => {
    const execute = failExecute('gnubok_approve_pending_operation', notFound('NOT_FOUND'))

    const result = await callTool('gnubok_approve_pending_operation', { operation_id: OPERATION_ID })

    expect(execute).toHaveBeenCalledTimes(1)
    expect((result.text.error as { code: string }).code).toBe('NOT_FOUND')
    expect(Object.keys(result.text)).toEqual(['error'])
  })

  it('still names the other company for an approval that named the wrong one', async () => {
    failExecute('gnubok_approve_pending_operation', notFound('NOT_FOUND'))

    const result = await callTool('gnubok_approve_pending_operation', {
      operation_id: OPERATION_ID,
      company_id: OTHER_COMPANY_ID,
    })

    expect(result.text.company).toEqual({ company_id: OTHER_COMPANY_ID, name: 'Other AB', is_default: false })
    expect(result.text.candidates).toEqual([{ company_id: DEFAULT_COMPANY_ID, name: 'Default AB' }])
  })

  it('stores the same answer on a task that fails with a not found', async () => {
    failExecute('gnubok_audit_package', notFound('NOT_FOUND'))

    const response = await handleMcpRequest(
      toolCall(
        'gnubok_audit_package',
        { fiscal_period_id: PERIOD_ID },
        {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS_EXTENSION_ID]: {} } },
        }
      )
    )
    expect((await response.json()).result.resultType).toBe('task')

    await vi.waitFor(() => expect(mocks.table.payloads('mcp_tasks', 'update')).toHaveLength(1))
    const [update] = mocks.table.payloads('mcp_tasks', 'update') as Array<{ result: unknown }>
    const stored = update.result as { isError: boolean; content: Array<{ text: string }> }
    const text = JSON.parse(stored.content[0].text) as Record<string, unknown>
    expect(stored.isError).toBe(true)
    expect(text.company).toEqual({ company_id: DEFAULT_COMPANY_ID, name: 'Default AB', is_default: true })
    expect(text.candidates).toEqual([{ company_id: OTHER_COMPANY_ID, name: 'Other AB' }])
    expect(text.candidates_note).toBe(OTHER_COMPANY_NOTE)
  })
})
