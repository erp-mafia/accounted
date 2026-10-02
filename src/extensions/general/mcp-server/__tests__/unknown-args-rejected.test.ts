/**
 * tools/call rejects unknown top-level parameters instead of dropping them.
 *
 * Feedback seq 261545: gnubok_query_journal called with {query} instead of
 * {text} silently returned the whole journal. Hosts do not reliably enforce
 * inputSchema, so the server does (arg-guard.ts), before execute() and as
 * the structured VALIDATION_ERROR envelope. Read-only report tools map known
 * synonyms first (report-arg-aliases.ts); an alias value its guard refuses
 * falls back to the same rejection.
 *
 * The service client records every builder call, and the SIE read lease is
 * granted, so a call that passes the guards really runs the tool and the
 * tests can assert on the filters it sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'

const { recordedCalls } = vi.hoisted(() => ({
  recordedCalls: [] as Array<{ method: string; args: unknown[] }>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  const resolving = (value: unknown): unknown => {
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(value)
          }
          return (...args: unknown[]) => {
            recordedCalls.push({ method: String(prop), args })
            return chain
          }
        },
      },
    )
    return chain
  }
  const empty = resolving({ data: null, error: null })
  const membership = resolving({
    data: { company_id: '11111111-1111-4111-8111-111111111111', role: 'owner' },
    error: null,
  })
  // withSIEExternalReport holds every ledger report behind this lease; a
  // missing token failed the call before the tool ever ran.
  const leaseToken = resolving({ data: 'lease-token-1', error: null })
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      // documents:read: gnubok_ask_document's hint below passes the scope check.
      scopes: ['reports:read', 'transactions:read', 'documents:read'],
      apiKeyId: 'key-live-1',
      apiKeyName: 'Live Key',
      mode: 'live',
    }),
    createServiceClientNoCookies: vi.fn(() => ({
      from: (table: string) => (table === 'company_members' ? membership : empty),
      rpc: (fn: string) => (fn === 'acquire_sie_period_read' ? leaseToken : empty),
    })),
  }
})

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { handleMcpRequest } from '../server'

function mcpToolCall(name: string, args: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

async function parsedToolResult(response: Response): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const json = await response.json()
  const result = json.result as { isError?: boolean; content: { text: string }[] }
  return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) }
}

type ToolError = { code: string; message_en: string; retryable: boolean }

async function expectValidationError(name: string, args: Record<string, unknown>): Promise<ToolError> {
  const { isError, payload } = await parsedToolResult(await handleMcpRequest(mcpToolCall(name, args)))
  expect(isError).toBe(true)
  const error = payload.error as ToolError
  expect(error.code).toBe('VALIDATION_ERROR')
  expect(error.retryable).toBe(false)
  return error
}

const calls = (method: string) => recordedCalls.filter((c) => c.method === method).map((c) => c.args)

describe('MCP tools/call unknown-parameter guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    recordedCalls.length = 0
  })

  it('rejects a misspelled parameter with a structured VALIDATION_ERROR naming the valid keys', async () => {
    const error = await expectValidationError('gnubok_query_journal', { searchterm: 'hyra' })
    expect(error.message_en).toContain('"searchterm"')
    expect(error.message_en).toContain('text')
  })

  // report-arg-aliases.ts: the {query} call that feedback seq 261545 saw
  // silently return the whole journal now searches, instead of failing.
  it('maps a known report-tool synonym onto the canonical parameter and runs the search', async () => {
    const response = await handleMcpRequest(mcpToolCall('gnubok_query_journal', { query: 'hyra' }))
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(false)
    expect((payload.applied_filters as { text: string | null }).text).toBe('hyra')
    // The entry-description leg sent the pattern (the line leg only queries
    // lines once entries matched, and this client returns none).
    expect(calls('ilike')).toContainEqual(['description', '%hyra%'])
  })

  it('reads a voucher reference alias as series plus number, and filters on it', async () => {
    const response = await handleMcpRequest(mcpToolCall('gnubok_query_journal', { voucher_number: 'A12' }))
    const { isError, payload } = await parsedToolResult(response)

    expect(isError).toBe(false)
    expect(payload.applied_filters).toMatchObject({
      voucher_series: 'A',
      voucher_number_from: 12,
      voucher_number_to: 12,
    })
    expect(calls('eq')).toContainEqual(['voucher_series', 'A'])
    expect(calls('gte')).toContainEqual(['voucher_number', 12])
    expect(calls('lte')).toContainEqual(['voucher_number', 12])
  })

  it('rejects a voucher alias value it cannot read, with a hint, instead of returning the whole journal', async () => {
    const error = await expectValidationError('gnubok_query_journal', { voucher_number: 'A12B' })
    expect(error.message_en).toContain('Unknown parameter "voucher_number"')
    expect(error.message_en).toContain('Did you mean: "voucher_number" -> "voucher_number_from"?')
    // Refused before any journal read.
    expect(recordedCalls.filter((c) => c.args[0] === 'voucher_number' || c.args[0] === 'description')).toEqual([])
  })

  it('rejects a canonical voucher bound that is not a number instead of skipping the filter', async () => {
    const error = await expectValidationError('gnubok_query_journal', { voucher_number_from: 'A12' })
    expect(error.message_en).toContain('voucher_number_from must be a voucher number')
  })

  it('rejects a partial ledger account on the general ledger alias instead of returning an empty ledger', async () => {
    const error = await expectValidationError('gnubok_get_general_ledger', { account_number: '19' })
    expect(error.message_en).toContain('Unknown parameter "account_number"')
    expect(error.message_en).toContain('Did you mean: "account_number" -> "account_from"?')
  })

  it('refuses an alias given together with its canonical parameter', async () => {
    const error = await expectValidationError('gnubok_get_kpi_report', {
      metric: 'cash_position',
      metrics: ['net_result'],
    })
    expect(error.message_en).toContain('Conflicting parameters')
    expect(error.message_en).toContain('"metric" (read as "metrics") overlaps "metrics"')
  })

  it('words a multi-key alias conflict truthfully', async () => {
    const error = await expectValidationError('gnubok_query_journal', {
      voucher_number: 12,
      voucher_number_to: 20,
    })
    expect(error.message_en).toContain(
      '"voucher_number" (read as "voucher_number_from" and "voucher_number_to") overlaps "voucher_number_to"',
    )
    expect(error.message_en).not.toContain('mean the same thing')
  })

  it('names the likely parameter for an unknown synonym on a non-aliased tool', async () => {
    const error = await expectValidationError('gnubok_get_ar_ledger', { as_of: '2026-01-01' })
    expect(error.message_en).toContain('Did you mean: "as_of" -> "as_of_date"?')
  })

  // Prod telemetry 2026-09-23..28: these were rejected with no hint at all.
  // Still rejected: a hint never runs the call under the name it suggests.
  it('shows the exact record_ref for a document_id holding a uuid, and still refuses the call', async () => {
    const uuid = '0b8f6a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b'
    const error = await expectValidationError('gnubok_ask_document', {
      document_id: uuid,
      question: 'Vad är uppsägningstiden?',
    })
    expect(error.message_en).toContain(`Did you mean: "document_id" -> "record_ref": "document:${uuid}"?`)
    expect(error.message_en).toContain('Unknown keys are rejected, not ignored.')
  })

  it('points an id-shaped key at the one required identifier (structural fallback)', async () => {
    const error = await expectValidationError('gnubok_get_inbox_item', { id: '0b8f6a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
    expect(error.message_en).toContain('Did you mean: "id" -> "inbox_item_id"?')
  })

  it('names since for a lower bound and nothing for an upper bound on a since-only list', async () => {
    const error = await expectValidationError('gnubok_list_verifikat_without_documents', {
      date_from: '2026-01-01',
      until: '2026-06-30',
    })
    expect(error.message_en).toContain('Unknown parameters "date_from", "until"')
    expect(error.message_en).toContain('Did you mean: "date_from" -> "since"? ')
    expect(error.message_en).not.toContain('"until" ->')
  })

  it('names slug for a skill name on gnubok_load_skill', async () => {
    const error = await expectValidationError('gnubok_load_skill', { name: 'vat-declaration' })
    expect(error.message_en).toContain('Did you mean: "name" -> "slug"?')
  })

  it('treats Object.prototype names as plain unknown parameters, not as synonyms', async () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      const error = await expectValidationError('gnubok_get_ar_ledger', { [key]: 'x' })
      expect(error.message_en).toContain(`Unknown parameter "${key}"`)
      expect(error.message_en).not.toContain('Did you mean')
    }
    // "__proto__" only survives as an own key through JSON, as it does on the wire.
    const error = await expectValidationError(
      'gnubok_query_journal',
      JSON.parse('{"__proto__": "x"}') as Record<string, unknown>,
    )
    expect(error.message_en).toContain('Unknown parameter "__proto__"')
  })

  it('reports an unknown KPI metric as a permanent VALIDATION_ERROR, not a retryable unknown error', async () => {
    const error = await expectValidationError('gnubok_get_kpi_report', { metrics: ['revenue_growth'] })
    expect(error.message_en).toContain('Unknown metric(s): "revenue_growth"')
    expect(error.message_en).toContain('Valid: gross_margin')

    // Through the singular alias too.
    const viaAlias = await expectValidationError('gnubok_get_kpi_report', { metric: 'revenue_growth' })
    expect(viaAlias.message_en).toContain('Unknown metric(s): "revenue_growth"')

    const notArray = await expectValidationError('gnubok_get_kpi_report', { metrics: 'cash_position' })
    expect(notArray.message_en).toContain('metrics must be an array')
  })

  it('does not fire for a well-formed call (the tool itself runs)', async () => {
    const response = await handleMcpRequest(mcpToolCall('gnubok_list_skills', {}))
    const { payload } = await parsedToolResult(response)
    const error = payload.error as { code?: string } | undefined
    expect(error?.code).not.toBe('VALIDATION_ERROR')
  })
})
