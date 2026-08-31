/**
 * Every read-only MCP tool, run once against a real PostgREST.
 *
 * ## What this catches that nothing else does
 *
 * A tool's query is half TypeScript and half a string that PostgREST parses at
 * request time. `select('a, b:c(d)')` names columns and a resource embed;
 * `or('a.is.null,b.not.in.(1,2)')` is a grammar; `.contains()` requires a jsonb
 * or array column. All of it is resolved by PostgREST, none of it by the type
 * system, and a mocked client answers every one of them cheerfully.
 *
 * As of 2026-08-27 all 100 files in extensions/general/mcp-server/__tests__
 * fake supabase; query-journal.test.ts states that its query chain is
 * "exercised by the live MCP smoke test", and no such test exists in CI. So
 * this class of bug (a 42703 undefined column, a PGRST200 missing relationship)
 * reaches production and shows up as an agent-reported failure.
 *
 * ## What a failure here means, and what it does not
 *
 * This asserts ONLY that the query is well-formed against the real schema. A
 * tool that legitimately refuses because a required argument is missing, or
 * because the seeded company has no data, is not a failure: those are filtered
 * out below. The bar is deliberately narrow so the suite stays honest.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { tools } from '@/extensions/general/mcp-server/server'
import { seedCompany } from '@/tests/pg/fixtures'
import { createToolPgClient, TOOL_PG_REST_URL } from './client'

/**
 * Postgres and PostgREST error codes that mean "this query is malformed", as
 * opposed to "this request was refused for a domain reason".
 */
const MALFORMED_QUERY_CODES = new Set([
  '42703', // undefined_column
  '42P01', // undefined_table
  '42883', // undefined_function
  '42P10', // invalid_column_reference
  'PGRST100', // parse error in the query-string specifier
  'PGRST200', // requested embed has no relationship
  'PGRST202', // requested function not found in the schema cache
])

/**
 * Errors are captured at the TRANSPORT, not from the thrown Error.
 *
 * This matters more than it sounds. Sweeping the tools and inspecting what they
 * throw looks equivalent and is not: the tools wrap failures in their own prose
 * and lose the payload doing it, so a real 42703 arrives as the string
 * "Database error: undefined" and every classifier downstream sees nothing. The
 * first version of this file passed for exactly that reason while 55 real
 * queries were failing underneath it.
 *
 * Intercepting fetch sees what PostgREST actually said, regardless of how the
 * calling tool chose to report it.
 */
interface CapturedFailure {
  tool: string
  status: number
  code: string | null
  message: string
  url: string
}

const captured: CapturedFailure[] = []
/** Every request that reached PostgREST, failed or not. */
let requestCount = 0
let currentTool = '(none)'
const originalFetch = globalThis.fetch
const REST_HOST = TOOL_PG_REST_URL.replace(/^https?:\/\//, '')

beforeAll(() => {
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args)
    const url = String(args[0])
    if (url.includes(REST_HOST)) requestCount += 1
    if (!response.ok && url.includes(REST_HOST)) {
      let code: string | null = null
      let message = ''
      try {
        const body = (await response.clone().json()) as { code?: string; message?: string }
        code = typeof body.code === 'string' ? body.code : null
        message = typeof body.message === 'string' ? body.message : JSON.stringify(body)
      } catch {
        message = await response.clone().text()
      }
      captured.push({ tool: currentTool, status: response.status, code, message, url })
    }
    return response
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

const readTools = tools.filter((t) => t.annotations.readOnlyHint === true)

let companyId: string
let userId: string
let client: ReturnType<typeof createToolPgClient>

beforeAll(async () => {
  // Constructed ONCE, here, on purpose. Building it inside the sweep loop puts
  // it inside the per-tool try/catch, so a client that cannot be constructed at
  // all is swallowed 74 times as a "domain refusal" and the suite reports a
  // clean sweep having issued zero queries. That is not hypothetical: it is
  // what this file did on CI, where Node 20 could not give supabase-js a
  // WebSocket and every createClient threw.
  client = createToolPgClient()
  const seeded = await seedCompany()
  companyId = seeded.companyId
  userId = seeded.userId
}, 30_000)

describe('MCP read tools against real PostgREST', () => {
  it('has a non-trivial number of read tools to sweep', () => {
    // Guards against the filter silently matching nothing after a refactor,
    // which would turn this whole file into a no-op that always passes.
    expect(readTools.length).toBeGreaterThan(50)
  })

  it('detects a malformed query, so that a green sweep means something', async () => {
    // The self-test that the previous version of this file needed and did not
    // have. A harness that cannot see a failure reports none, and the sweep
    // below would then pass forever while the surface it guards rotted.
    currentTool = '(self-test)'
    const before = captured.length
    await client.from('transactions').select('no_such_column_exists').limit(1)
    currentTool = '(none)'

    const detected = captured.slice(before).filter((f) => f.code && MALFORMED_QUERY_CODES.has(f.code))
    expect(detected.length, 'a deliberately bad column was not detected').toBeGreaterThan(0)
    expect(detected[0].code).toBe('42703')

    // Drop the deliberate failure so it cannot pollute the sweep assertion.
    captured.length = before
  }, 30_000)

  it('issues no malformed query', async () => {
    for (const tool of readTools) {
      currentTool = tool.name
      try {
        await tool.execute({ __keyScopes: [] }, companyId, userId, client as never, {
          type: 'api_key',
        })
      } catch {
        // A domain refusal (missing argument, no data, scope, capability) is
        // not what this file is about. Only what PostgREST said counts, and
        // that was captured at the transport above.
      }
    }
    currentTool = '(none)'

    // Proof of life, and it has to be a real number. A sweep that issues
    // nothing reports no failures and passes, which is how this file lied
    // twice: once locally when every query 404d on the /rest/v1 prefix, and
    // once on CI when every client construction threw. Both times the assertion
    // here was satisfiable without a single request being made.
    //
    // 50 is well under the 87 observed on 2026-08-27 and well above anything a
    // broken harness produces, which is zero.
    expect(requestCount, 'the sweep barely reached PostgREST').toBeGreaterThan(50)

    const malformed = captured
      .filter((f) => f.code && MALFORMED_QUERY_CODES.has(f.code))
      .map((f) => `${f.tool}: ${f.code} ${f.message}`)

    expect([...new Set(malformed)]).toEqual([])
  }, 300_000)
})
