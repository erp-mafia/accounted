/**
 * A REAL supabase-js client, pointed at a real PostgREST, over a real Postgres
 * with every migration replayed.
 *
 * Why this is not the same thing as the pg-real suite: those tests hold a `pg`
 * Pool and write SQL. The MCP tools do not write SQL. They call
 * `supabase.from('x').select('a, b:c(d)')`, and the string inside `.select()`
 * is parsed by PostgREST, not by Postgres. A misspelled column, a resource
 * embed whose foreign key does not exist, an `or=(...)` whose grammar is
 * slightly off, a `.contains()` against a non-jsonb column: every one of those
 * is a runtime 400 from PostgREST that a mocked client answers cheerfully and a
 * SQL test never reaches.
 */
import { createHmac } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Must match PGRST_JWT_SECRET in tests/tool-pg/docker-compose.yml. */
export const TOOL_PG_JWT_SECRET =
  'super-secret-jwt-token-with-at-least-32-characters-long'

export const TOOL_PG_REST_URL = process.env.TOOL_PG_REST_URL ?? 'http://127.0.0.1:54330'
export const TOOL_PG_DATABASE_URL =
  process.env.TOOL_PG_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54329/postgres'

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Hand-rolled HS256 rather than a JWT library: this repo is AGPL and audits its
 * dependency surface, and a signed JWT is three base64url segments and one
 * HMAC. Not worth a dependency, and definitely not worth one that ships only to
 * tests.
 */
export function signServiceRoleJwt(secret = TOOL_PG_JWT_SECRET): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      role: 'service_role',
      iss: 'tool-pg',
      // Fixed far-future expiry: the harness is disposable and a clock-derived
      // value would make an otherwise deterministic suite time-dependent.
      exp: 4102444800,
    }),
  )
  const signature = base64url(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  )
  return `${header}.${payload}.${signature}`
}

/**
 * Service-role client, which is what the MCP server actually uses:
 * `createServiceClientNoCookies()` on the API-key path. RLS is therefore NOT
 * the thing under test here; the query grammar is. Tenant isolation on this
 * surface comes from explicit `.eq('company_id', ...)` discipline, and a tool
 * that forgets it is exactly the kind of bug these tests can catch.
 */
/**
 * `createClient` eagerly constructs a RealtimeClient, which resolves a
 * WebSocket implementation and throws "native WebSocket not found" on Node 20.
 * CI runs Node 20; local machines may not, which is exactly the kind of
 * difference that turns into a green local run and a red CI one.
 *
 * Nothing here subscribes to realtime, and RealtimeClient only RESOLVES the
 * constructor rather than instantiating it, so handing it an inert class is
 * enough. Bumping the job to Node 22 would work too, but it would make this the
 * only job in the repo on a different runtime for a feature it never uses.
 */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('tool-pg: realtime is not used by these tests')
  }
}

export function createToolPgClient(): SupabaseClient {
  const key = signServiceRoleJwt()
  return createClient(TOOL_PG_REST_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
    realtime: { transport: UnusedRealtimeTransport as never },
    global: {
      headers: { apikey: key },
      // supabase-js hard-codes a `/rest/v1` prefix onto every PostgREST
      // request, because that is where Supabase's own gateway mounts it. A
      // bare PostgREST serves at the root, so without this rewrite every
      // query 404s.
      //
      // That is not a hypothetical: the first version of this harness omitted
      // it, all 55 sweep queries 404d, the tools reported the empty response
      // as "Database error: undefined", and the suite passed green while
      // exercising nothing at all. The self-test in query-grammar.tool.test.ts
      // exists to make that failure mode loud.
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const rewritten = url.replace('/rest/v1/', '/').replace(/\/rest\/v1$/, '')
        return fetch(rewritten, init)
      },
    },
  })
}
