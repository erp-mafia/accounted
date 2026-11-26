/**
 * A Skatteverket connection is written only by the person who made it
 * (20261126131346_skatteverket_tokens_own_row_writes.sql), against real
 * Postgres.
 *
 * One company, its owner A and an admin B, each with their own BankID
 * session row in skatteverket_tokens:
 *
 *   - through a session (RLS applies), B cannot write a row under A's
 *     user_id, change A's row, upsert onto it, take it over, hand B's own row
 *     to A, or delete A's row, and the owner cannot delete B's row. Each of
 *     these went through under the policies of
 *     20260702093000_rls_role_gate_and_voucher_rpc_guards.sql.
 *   - B can still create, refresh and remove B's own row, and a viewer still
 *     cannot write at all.
 *   - every path the application writes the table through still works. The
 *     token store (src/extensions/general/skatteverket/lib/token-store.ts)
 *     runs each of them on the service role: connect, a second member
 *     connecting, a refresh of a colleague's token that serves a company
 *     read, the needs_reconsent flag, clearing a revoked token, disconnect.
 *     Account deletion runs the SECURITY DEFINER erasure from the person's
 *     own session. Both pass RLS by design, so these cases pin that routing,
 *     not the policies. A company read still finds a colleague's connection:
 *     SELECT is unchanged.
 *   - a member who leaves the company takes their connection out of its
 *     reads (findCompanyTokenUser in
 *     src/extensions/general/skatteverket/lib/resolve-auth.ts), in a
 *     colleague's session and on the service role alike, and their row is
 *     kept.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { findCompanyTokenUser, resolveUserReadAuth } from '@/extensions/general/skatteverket/lib/resolve-auth'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import {
  deleteTokens,
  getTokenHealth,
  getTokens,
  markNeedsReconsent,
  storeTokens,
} from '@/extensions/general/skatteverket/lib/token-store'
import type { SkatteverketTokens } from '@/extensions/general/skatteverket/types'
import { insertAuthUser, insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'
import { createPgRest, type PgRest } from './postgrest-over-pg'
import { getPool, withUserContext } from './setup'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null, sessions: [] as PgRest[] }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

// The token store builds its own service-role client (getServiceClient in
// token-store.ts) whatever client its caller hands it: give it the shim.
vi.mock('@/lib/supabase/service-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/service-client')>()
  const { createPgRest } = await import('./postgrest-over-pg')
  shim.rest ??= createPgRest({ role: 'service_role' })
  return {
    ...actual,
    createServiceRoleClient: (_url: string, _key: string, options?: Parameters<typeof actual.createServiceRoleClient>[2]) =>
      actual.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
        ...options,
        global: { ...options?.global, fetch: shim.rest!.fetch },
        realtime: { transport: UnusedRealtimeTransport as never },
      }),
  }
})

/** A signed-in session of `userId`, served as PostgREST serves one (RLS applies). */
function sessionOf(userId: string): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId })
  shim.sessions.push(rest)
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: rest.fetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

/** The service role, as the crons hold it (served by the shim above). */
function serviceRole(): SupabaseClient {
  return createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role')
}

/** One statement in `userId`'s session (RLS applies), rolled back afterwards. */
function asMember(userId: string, sql: string, params: unknown[]) {
  return withUserContext(userId, (client) => client.query(sql, params))
}

const INSERT_ROW = `INSERT INTO public.skatteverket_tokens (user_id, company_id, access_token, refresh_token, expires_at)
  VALUES ($1, $2, 'enc-access-session', 'enc-refresh-session', now() + interval '1 hour')`

const RLS_REFUSED = { code: '42501', message: expect.stringMatching(/row-level security/) }

function tokens(tag: string, refreshCount = 0): SkatteverketTokens {
  return {
    access_token: `${tag}-access`,
    refresh_token: `${tag}-refresh`,
    expires_at: Date.now() + 60 * 60 * 1000,
    refresh_count: refreshCount,
    scope: 'momsdeklaration agd',
  }
}

/** The company's token rows as the database holds them, read past RLS. */
async function rowsOf(companyId: string) {
  const { rows } = await getPool().query<{ id: string; user_id: string; status: string; refresh_count: number }>(
    `SELECT id, user_id, status, refresh_count FROM public.skatteverket_tokens
      WHERE company_id = $1 ORDER BY created_at, id`,
    [companyId],
  )
  return rows
}

let companyId: string
let ownerA: string
let adminB: string

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://pg-real.invalid')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'pg-real-service-role')
  vi.stubEnv('SKATTEVERKET_TOKEN_ENCRYPTION_KEY', 'pg-real-skatteverket-token-key')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  ;({ userId: ownerA, companyId } = await seedCompany())
  adminB = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: adminB, role: 'admin' })
  await setActiveCompany(ownerA, companyId)
  await setActiveCompany(adminB, companyId)
})

afterEach(() => {
  // Every request the paths under test sent stayed inside the shim's grammar.
  const unsupported = [shim.rest, ...shim.sessions.splice(0)].flatMap((rest) => rest?.unsupported.splice(0) ?? [])
  expect(unsupported).toEqual([])
})

describe('through a session, a member writes only their own Skatteverket connection', () => {
  it("B cannot store a connection under A's user_id", async () => {
    // A has no row here, so only the policy can refuse it (the unique key
    // would refuse a second row for A anyway).
    await expect(asMember(adminB, INSERT_ROW, [ownerA, companyId])).rejects.toMatchObject(RLS_REFUSED)
  })

  it("B cannot change A's connection: the update reaches no row", async () => {
    await storeTokens(sessionOf(ownerA), ownerA, tokens('a'), companyId)

    const changed = await asMember(
      adminB,
      `UPDATE public.skatteverket_tokens
          SET access_token = 'enc-access-session', status = 'needs_reconsent'
        WHERE user_id = $1 AND company_id = $2`,
      [ownerA, companyId],
    )
    expect(changed.rowCount).toBe(0)
  })

  it("B cannot upsert onto A's connection", async () => {
    await storeTokens(sessionOf(ownerA), ownerA, tokens('a'), companyId)

    // The SET names no credential column: excluded.access_token would be
    // refused by the column grants (42501, permission denied) before the
    // policies are asked.
    await expect(
      asMember(
        adminB,
        `${INSERT_ROW}
         ON CONFLICT (user_id, company_id)
           DO UPDATE SET status = 'needs_reconsent', expires_at = excluded.expires_at`,
        [ownerA, companyId],
      ),
    ).rejects.toMatchObject(RLS_REFUSED)
    expect(await rowsOf(companyId)).toEqual([expect.objectContaining({ user_id: ownerA, status: 'active' })])
  })

  it("B cannot take over A's connection: the update reaches no row", async () => {
    await storeTokens(sessionOf(ownerA), ownerA, tokens('a'), companyId)

    const changed = await asMember(
      adminB,
      `UPDATE public.skatteverket_tokens SET user_id = $1 WHERE user_id = $2 AND company_id = $3`,
      [adminB, ownerA, companyId],
    )
    expect(changed.rowCount).toBe(0)
    expect(await rowsOf(companyId)).toEqual([expect.objectContaining({ user_id: ownerA })])
  })

  it("B cannot hand B's own connection to A", async () => {
    await storeTokens(sessionOf(adminB), adminB, tokens('b'), companyId)

    await expect(
      asMember(
        adminB,
        `UPDATE public.skatteverket_tokens SET user_id = $1 WHERE user_id = $2 AND company_id = $3`,
        [ownerA, adminB, companyId],
      ),
    ).rejects.toMatchObject(RLS_REFUSED)
  })

  it("B cannot delete A's connection, and the owner cannot delete B's", async () => {
    await storeTokens(sessionOf(ownerA), ownerA, tokens('a'), companyId)
    await storeTokens(sessionOf(adminB), adminB, tokens('b'), companyId)
    const DELETE_ROW = `DELETE FROM public.skatteverket_tokens WHERE user_id = $1 AND company_id = $2`

    expect((await asMember(adminB, DELETE_ROW, [ownerA, companyId])).rowCount).toBe(0)
    expect((await asMember(ownerA, DELETE_ROW, [adminB, companyId])).rowCount).toBe(0)
  })

  it('B can still create, refresh and remove their own connection', async () => {
    await storeTokens(sessionOf(ownerA), ownerA, tokens('a'), companyId)

    const counts = await withUserContext(adminB, async (client) => {
      const created = await client.query(INSERT_ROW, [adminB, companyId])
      const refreshed = await client.query(
        `UPDATE public.skatteverket_tokens
            SET access_token = 'enc-access-refreshed', refresh_count = refresh_count + 1
          WHERE user_id = $1 AND company_id = $2`,
        [adminB, companyId],
      )
      const removed = await client.query(
        `DELETE FROM public.skatteverket_tokens WHERE user_id = $1 AND company_id = $2`,
        [adminB, companyId],
      )
      return [created.rowCount, refreshed.rowCount, removed.rowCount]
    })
    expect(counts).toEqual([1, 1, 1])
  })

  it('a viewer still cannot write, not even their own connection', async () => {
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, companyId)

    await expect(asMember(viewer, INSERT_ROW, [viewer, companyId])).rejects.toMatchObject(RLS_REFUSED)
  })
})

// These pin the routing, not the policies. The token store writes on its own
// service-role client (getServiceClient in token-store.ts), whichever client
// its caller hands it, and the account erasure is a SECURITY DEFINER function
// that runs as the table owner: RLS applies to neither, so a policy change
// cannot fail these cases, while a store write moved onto the caller's session
// would. The policies are pinned in the block above.
describe('every path the application writes the table through still works, past RLS (routing, not policies)', () => {
  it('connect, a second member connecting, a refresh of a colleague token, the reconsent flag, a revoked token and disconnect', async () => {
    // A connects (the OAuth callback stores the caller's own row).
    const aConnected = await storeTokens(sessionOf(ownerA), ownerA, tokens('a'), companyId)

    // B has not connected: a company read in B's session runs on A's
    // connection (findCompanyTokenUser reads company-wide, SELECT unchanged).
    expect(await findCompanyTokenUser(sessionOf(adminB), companyId, { preferUserId: adminB })).toMatchObject({
      userId: ownerA,
      needsReconsent: false,
    })

    // That read refreshes A's token: refreshTokenForUser stores it back on
    // the token owner's row, handed B's session.
    const aRefreshed = await storeTokens(sessionOf(adminB), ownerA, tokens('a-refreshed', 1), companyId)
    expect(aRefreshed).not.toBe(aConnected)
    expect(await getTokens(sessionOf(adminB), ownerA, companyId)).toMatchObject({
      row_id: aRefreshed,
      access_token: 'a-refreshed-access',
      refresh_count: 1,
    })

    // B connects too: B's own row; A's stays as it was.
    const bConnected = await storeTokens(sessionOf(adminB), adminB, tokens('b'), companyId)
    expect(await rowsOf(companyId)).toEqual([
      { id: aRefreshed, user_id: ownerA, status: 'active', refresh_count: 1 },
      { id: bConnected, user_id: adminB, status: 'active', refresh_count: 0 },
    ])
    expect(await findCompanyTokenUser(sessionOf(adminB), companyId, { preferUserId: adminB })).toMatchObject({
      userId: adminB,
    })

    // A cron's terminal verdict on A's token flags A's row, by its version.
    await markNeedsReconsent(sessionOf(adminB), ownerA, companyId, 'SESSION_EXPIRED', {
      rowId: aRefreshed,
      refreshCount: 1,
    })
    expect(await getTokenHealth(sessionOf(ownerA), ownerA, companyId)).toMatchObject({
      status: 'needs_reconsent',
      last_error_code: 'SESSION_EXPIRED',
    })

    // Skatteverket answers that A's token is revoked during a read B started:
    // that stored token is cleared.
    await deleteTokens(sessionOf(adminB), ownerA, companyId, aRefreshed)
    expect(await rowsOf(companyId)).toEqual([{ id: bConnected, user_id: adminB, status: 'active', refresh_count: 0 }])

    // B disconnects (the /disconnect route deletes the caller's own row).
    await deleteTokens(sessionOf(adminB), adminB, companyId)
    expect(await rowsOf(companyId)).toEqual([])
  })

  it("deleting B's account through B's own session clears B's connection and leaves A's", async () => {
    const aConnected = await storeTokens(sessionOf(ownerA), ownerA, tokens('a'), companyId)
    await storeTokens(sessionOf(adminB), adminB, tokens('b'), companyId)

    // POST /api/account/delete calls this RPC on the session client.
    const { error } = await sessionOf(adminB).rpc('anonymize_user_account', { target_user_id: adminB })
    expect(error).toBeNull()

    expect(await rowsOf(companyId)).toEqual([{ id: aConnected, user_id: ownerA, status: 'active', refresh_count: 0 }])
  })
})

describe("a member who leaves the company takes their connection out of the company's reads", () => {
  /** What DELETE /api/company/members/[id] does: the membership goes, the token row stays. */
  async function leaveCompany(userId: string) {
    await getPool().query(`DELETE FROM public.company_members WHERE company_id = $1 AND user_id = $2`, [
      companyId,
      userId,
    ])
  }

  it("B connects and leaves: A's session and a cron find no connection, and B's row is kept", async () => {
    const bConnected = await storeTokens(sessionOf(adminB), adminB, tokens('b'), companyId)
    expect(await findCompanyTokenUser(sessionOf(ownerA), companyId, { preferUserId: ownerA })).toMatchObject({
      userId: adminB,
    })

    await leaveCompany(adminB)

    // A's session reads the company's rows (SELECT is company-wide) and its
    // members; a cron reads both on the service role.
    expect(await findCompanyTokenUser(sessionOf(ownerA), companyId, { preferUserId: ownerA })).toBeNull()
    expect(await findCompanyTokenUser(serviceRole(), companyId)).toBeNull()
    expect(await resolveUserReadAuth(serviceRole(), companyId)).toEqual({ ok: false, reason: 'no_token' })
    // Nothing is deleted: the row is B's.
    expect(await rowsOf(companyId)).toEqual([{ id: bConnected, user_id: adminB, status: 'active', refresh_count: 0 }])
  })

  it("A and B connected and B leaves: reads run on A's connection, also when B's id is the one passed", async () => {
    await storeTokens(sessionOf(ownerA), ownerA, tokens('a'), companyId)
    await storeTokens(sessionOf(adminB), adminB, tokens('b'), companyId)
    expect(await findCompanyTokenUser(serviceRole(), companyId)).toMatchObject({ userId: adminB })

    await leaveCompany(adminB)

    expect(await findCompanyTokenUser(serviceRole(), companyId)).toMatchObject({ userId: ownerA })
    expect(await findCompanyTokenUser(serviceRole(), companyId, { preferUserId: adminB })).toMatchObject({
      userId: ownerA,
    })
    expect(await resolveUserReadAuth(serviceRole(), companyId, { userId: adminB })).toMatchObject({
      ok: true,
      tokenUserId: ownerA,
    })
  })
})
