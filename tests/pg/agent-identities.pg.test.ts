import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'
import { getClient, getPool, withUserContext } from './setup'

/**
 * Agent identities with one human sponsor (migration 20261029100000).
 *
 * Locks in:
 *   - a key is attached to its identity when it is minted: every OAuth key
 *     of one (user, client) to one connector identity, so a reconnect lands
 *     on the same agent; a manual key to an identity of its own, named after
 *     it; a service account's key to the identity the account got when it
 *     was created;
 *   - a user session can neither choose nor change a key's identity, nor
 *     write identities; the sponsor reads their own and nobody else does;
 *   - validate_and_increment_api_key returns the identity and client, and
 *     refuses every key of a paused identity (api_key_refusal names it
 *     AGENT_PAUSED) without counting the request, including a key minted by a
 *     reconnect during the pause;
 *   - rotate_mcp_refresh_token answers 'paused' and rotates nothing while the
 *     identity is paused, and the same token rotates once it is resumed;
 *   - pause and resume are the sponsor's alone, and a pause cancels the
 *     agent's in-flight MCP tasks;
 *   - an identity goes with its sponsor's account, so account deletion and
 *     sandbox teardown (DELETE FROM auth.users) are never blocked by it;
 *   - the backfill groups existing keys like the trigger, revokes a connector
 *     whose keys are all revoked, writes no audit rows and keeps updated_at,
 *     and is idempotent.
 */

const OAUTH_NAME = 'MCP-klient (OAuth)'

function fakeHash(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
}

async function seedOwner() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

/** Mint a key the way both doors do: create_api_key_with_allowlist (service role). */
async function mintKey(params: {
  userId: string
  companyId: string
  name?: string
  client?: string | null
  oauth?: boolean
}): Promise<{ id: string; keyHash: string; refreshHash: string | null }> {
  const keyHash = fakeHash()
  const refreshHash = params.oauth ? fakeHash() : null
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT public.create_api_key_with_allowlist(
       $1, $2, $3, 'gnubok_sk_abcdefgh', $4, ARRAY['companies:read'], NULL, $5, $6,
       NULL, NULL, NULL, NULL, NULL
     ) AS id`,
    [
      params.userId,
      params.companyId,
      keyHash,
      params.name ?? (params.oauth ? OAUTH_NAME : 'Skriptnyckel'),
      params.client ?? null,
      refreshHash,
    ],
  )
  return { id: rows[0]!.id, keyHash, refreshHash }
}

interface IdentityRow {
  id: string
  sponsor_user_id: string
  kind: string
  client: string | null
  display_name: string
  service_account_id: string | null
  paused_at: Date | null
  paused_by: string | null
  revoked_at: Date | null
}

async function identityOfKey(keyId: string): Promise<IdentityRow> {
  const { rows } = await getPool().query<IdentityRow>(
    `SELECT ai.* FROM public.api_keys k JOIN public.agent_identities ai ON ai.id = k.agent_identity_id WHERE k.id = $1`,
    [keyId],
  )
  expect(rows, `key ${keyId} has no agent identity`).toHaveLength(1)
  return rows[0]!
}

async function validate(keyHash: string) {
  const { rows } = await getPool().query<{
    user_id: string
    api_key_id: string
    agent_identity_id: string | null
    client: string | null
  }>(
    `SELECT user_id, api_key_id, agent_identity_id, client FROM public.validate_and_increment_api_key($1)`,
    [keyHash],
  )
  return rows
}

async function refusal(keyHash: string): Promise<string | null> {
  const { rows } = await getPool().query<{ refusal: string | null }>(
    `SELECT public.api_key_refusal($1) AS refusal`,
    [keyHash],
  )
  return rows[0]!.refusal
}

/**
 * Run `fn` as the user (authenticated role, JWT sub) and COMMIT, unlike
 * withUserContext which always rolls back: a pause has to outlive the call
 * for the validation that follows to see it.
 */
async function asUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const pause = (userId: string, identityId: string) =>
  asUser(userId, async (client) => {
    const { rows } = await client.query<IdentityRow>(`SELECT * FROM public.pause_agent_identity($1)`, [identityId])
    return rows[0]!
  })

const resume = (userId: string, identityId: string) =>
  asUser(userId, async (client) => {
    const { rows } = await client.query<IdentityRow>(`SELECT * FROM public.resume_agent_identity($1)`, [identityId])
    return rows[0]!
  })

describe('agent identities (pg)', () => {
  it('attaches every OAuth key of one user and client to one connector identity', async () => {
    const { userId, companyId } = await seedOwner()
    const first = await mintKey({ userId, companyId, oauth: true, client: 'claude' })
    const reconnect = await mintKey({ userId, companyId, oauth: true, client: 'claude' })
    const chatgpt = await mintKey({ userId, companyId, oauth: true, client: 'chatgpt' })

    const identity = await identityOfKey(first.id)
    expect(identity).toMatchObject({
      sponsor_user_id: userId,
      kind: 'connector',
      client: 'claude',
      display_name: 'Claude',
      service_account_id: null,
      paused_at: null,
      revoked_at: null,
    })
    expect((await identityOfKey(reconnect.id)).id).toBe(identity.id)

    const other = await identityOfKey(chatgpt.id)
    expect(other).toMatchObject({ kind: 'connector', client: 'chatgpt', display_name: 'ChatGPT' })
    expect(other.id).not.toBe(identity.id)

    // Another person's Claude is another agent.
    const colleague = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: colleague, role: 'admin' })
    const theirs = await mintKey({ userId: colleague, companyId, oauth: true, client: 'claude' })
    expect((await identityOfKey(theirs.id)).id).not.toBe(identity.id)

    // A registered client is named by its registration.
    const { rows: reg } = await getPool().query<{ id: string }>(
      `INSERT INTO public.oauth_client_registrations (user_id, client_name, redirect_uri)
       VALUES ($1, 'Bokföringsboten', 'https://bot.example/callback') RETURNING id`,
      [userId],
    )
    const registered = await mintKey({ userId, companyId, oauth: true, client: `registered:${reg[0]!.id}` })
    expect(await identityOfKey(registered.id)).toMatchObject({ kind: 'connector', display_name: 'Bokföringsboten' })
  })

  it('gives every manual key an identity of its own, named after the key, revoked with it', async () => {
    const { userId, companyId } = await seedOwner()
    const a = await mintKey({ userId, companyId, name: 'Nattlig export' })
    const b = await mintKey({ userId, companyId, name: 'Nattlig export' })

    const identityA = await identityOfKey(a.id)
    const identityB = await identityOfKey(b.id)
    expect(identityA).toMatchObject({ kind: 'api_key', display_name: 'Nattlig export', sponsor_user_id: userId })
    expect(identityB.id).not.toBe(identityA.id)

    await getPool().query(`UPDATE public.api_keys SET revoked_at = now() WHERE id = $1`, [a.id])
    expect((await identityOfKey(a.id)).revoked_at).not.toBeNull()
    expect((await identityOfKey(b.id)).revoked_at).toBeNull()
  })

  it("attaches a service account's keys to the identity the account got at creation, revoked with the account", async () => {
    const { userId: ownerId, companyId } = await seedOwner()
    const { rows: accounts } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.create_service_account($1, 'Fakturasynk', $2, $2)`,
      [companyId, ownerId],
    )
    const accountId = accounts[0]!.id
    const { rows: identities } = await getPool().query<IdentityRow>(
      `SELECT * FROM public.agent_identities WHERE service_account_id = $1`,
      [accountId],
    )
    expect(identities).toHaveLength(1)
    expect(identities[0]).toMatchObject({
      kind: 'service_account',
      sponsor_user_id: ownerId,
      display_name: 'Fakturasynk',
      revoked_at: null,
    })

    const mint = async () => {
      const { rows } = await getPool().query<{ id: string }>(
        `SELECT public.create_service_account_key($1, $2, $3, 'gnubok_sk_abcdefgh', 'Nyckel', '{invoices:read}',
           'live', false, NULL, $4) AS id`,
        [companyId, accountId, fakeHash(), ownerId],
      )
      return rows[0]!.id
    }
    const k1 = await mint()
    const k2 = await mint()
    expect((await identityOfKey(k1)).id).toBe(identities[0]!.id)
    expect((await identityOfKey(k2)).id).toBe(identities[0]!.id)

    // Revoking one key leaves the account's identity live; revoking the account does not.
    await getPool().query(`UPDATE public.api_keys SET revoked_at = now() WHERE id = $1`, [k1])
    expect((await identityOfKey(k1)).revoked_at).toBeNull()
    await getPool().query(`SELECT public.revoke_service_account($1, $2, $3)`, [companyId, accountId, ownerId])
    expect((await identityOfKey(k2)).revoked_at).not.toBeNull()

    // An account deleted with its company takes its identity along, and the
    // keys' foreign key lets go even inside a user's request (the attach
    // guard refuses every other change from a session). Rolled back.
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: ownerId, role: 'authenticated' }),
      ])
      await client.query(`DELETE FROM public.service_accounts WHERE id = $1`, [accountId])
      const { rows: left } = await client.query(
        `SELECT 1 FROM public.agent_identities WHERE service_account_id = $1`,
        [accountId],
      )
      expect(left).toEqual([])
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('validates with the identity and client, and refuses a paused agent until it is resumed', async () => {
    const { userId, companyId } = await seedOwner()
    const key = await mintKey({ userId, companyId, oauth: true, client: 'claude' })
    const identity = await identityOfKey(key.id)

    expect(await validate(key.keyHash)).toEqual([
      { user_id: userId, api_key_id: key.id, agent_identity_id: identity.id, client: 'claude' },
    ])
    expect(await refusal(key.keyHash)).toBeNull()

    const paused = await pause(userId, identity.id)
    expect(paused.paused_at).not.toBeNull()
    expect(paused.paused_by).toBe(userId)

    const before = await getPool().query<{ request_count: number }>(
      `SELECT request_count FROM public.api_keys WHERE id = $1`,
      [key.id],
    )
    expect(await validate(key.keyHash)).toEqual([])
    expect(await refusal(key.keyHash)).toBe('AGENT_PAUSED')
    const after = await getPool().query<{ request_count: number }>(
      `SELECT request_count FROM public.api_keys WHERE id = $1`,
      [key.id],
    )
    expect(after.rows[0]!.request_count).toBe(before.rows[0]!.request_count)

    // A reconnect during the pause lands on the same, still paused, agent.
    const reconnect = await mintKey({ userId, companyId, oauth: true, client: 'claude' })
    expect((await identityOfKey(reconnect.id)).id).toBe(identity.id)
    expect(await validate(reconnect.keyHash)).toEqual([])
    expect(await refusal(reconnect.keyHash)).toBe('AGENT_PAUSED')

    // Pausing again keeps the first pause.
    const again = await pause(userId, identity.id)
    expect(again.paused_at!.getTime()).toBe(paused.paused_at!.getTime())

    const resumed = await resume(userId, identity.id)
    expect(resumed).toMatchObject({ paused_at: null, paused_by: null })
    expect(await validate(key.keyHash)).toHaveLength(1)
    expect(await validate(reconnect.keyHash)).toHaveLength(1)

    // A manual key: validate returns its own identity and no client.
    const manual = await mintKey({ userId, companyId, name: 'Skript' })
    const [row] = await validate(manual.keyHash)
    expect(row).toMatchObject({ agent_identity_id: (await identityOfKey(manual.id)).id, client: null })
  })

  it('refuses a refresh while the agent is paused, and rotates the same token once resumed', async () => {
    const { userId, companyId } = await seedOwner()
    const key = await mintKey({ userId, companyId, oauth: true, client: 'claude' })
    const identity = await identityOfKey(key.id)

    const rotate = async () => {
      const { rows } = await getPool().query<{ outcome: string; api_key_id: string | null }>(
        `SELECT outcome, api_key_id FROM public.rotate_mcp_refresh_token($1, $2, $3, 'gnubok_sk_rotated', 120)`,
        [key.refreshHash, 'next-refresh-' + key.id, 'next-key-' + key.id],
      )
      return rows[0]!
    }

    await pause(userId, identity.id)
    expect(await rotate()).toEqual({ outcome: 'paused', api_key_id: key.id })
    const unchanged = await getPool().query<{ key_hash: string; refresh_token_hash: string }>(
      `SELECT key_hash, refresh_token_hash FROM public.api_keys WHERE id = $1`,
      [key.id],
    )
    expect(unchanged.rows[0]).toEqual({ key_hash: key.keyHash, refresh_token_hash: key.refreshHash })

    await resume(userId, identity.id)
    expect(await rotate()).toEqual({ outcome: 'rotated', api_key_id: key.id })

    // The predecessor is refused too while paused (step 2 of the rotation).
    await pause(userId, identity.id)
    const { rows } = await getPool().query<{ outcome: string }>(
      `SELECT outcome FROM public.rotate_mcp_refresh_token($1, $2, $3, 'gnubok_sk_rotated', 120)`,
      [key.refreshHash, 'next-refresh-' + key.id, 'next-key-' + key.id],
    )
    expect(rows[0]!.outcome).toBe('paused')
  })

  it('lets only the sponsor pause, resume and read an identity, and no session write it', async () => {
    const { userId, companyId } = await seedOwner()
    const colleague = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: colleague, role: 'admin' })
    const key = await mintKey({ userId, companyId, oauth: true, client: 'claude' })
    const identity = await identityOfKey(key.id)

    await expect(pause(colleague, identity.id)).rejects.toThrow(/AGENT_IDENTITY_NOT_FOUND/)
    await expect(resume(colleague, identity.id)).rejects.toThrow(/AGENT_IDENTITY_NOT_FOUND/)
    // The service role has no auth.uid(): not a sponsor.
    await expect(
      getPool().query(`SELECT public.pause_agent_identity($1)`, [identity.id]),
    ).rejects.toThrow(/AGENT_IDENTITY_NOT_FOUND/)

    const visibleTo = (uid: string) =>
      withUserContext(uid, async (client) => {
        const { rows } = await client.query(`SELECT id FROM public.agent_identities WHERE id = $1`, [identity.id])
        return rows.length
      })
    expect(await visibleTo(userId)).toBe(1)
    expect(await visibleTo(colleague)).toBe(0)

    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.agent_identities SET paused_at = now() WHERE id = $1`, [identity.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.agent_identities (sponsor_user_id, kind, display_name) VALUES ($1, 'api_key', 'Egen')`,
          [userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    // A company admin cannot move a key to another identity or detach it.
    const manual = await mintKey({ userId, companyId, name: 'Skript' })
    const manualIdentity = await identityOfKey(manual.id)
    for (const target of [identity.id, null]) {
      await expect(
        withUserContext(userId, (client) =>
          client.query(`UPDATE public.api_keys SET agent_identity_id = $2 WHERE id = $1`, [manual.id, target]),
        ),
      ).rejects.toMatchObject({ code: '42501' })
    }
    expect((await identityOfKey(manual.id)).id).toBe(manualIdentity.id)

    // Nor mint a key under an identity of their choosing.
    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, agent_identity_id)
           VALUES ($1, $2, $3, 'gnubok_sk_x', 'x', $4)`,
          [userId, companyId, fakeHash(), identity.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    // Who an identity is never changes; a revocation is final.
    await expect(
      getPool().query(`UPDATE public.agent_identities SET sponsor_user_id = $2 WHERE id = $1`, [identity.id, colleague]),
    ).rejects.toThrow(/fixed/)
    await getPool().query(`UPDATE public.api_keys SET revoked_at = now() WHERE id = $1`, [manual.id])
    await expect(
      getPool().query(`UPDATE public.agent_identities SET revoked_at = NULL WHERE id = $1`, [manualIdentity.id]),
    ).rejects.toThrow(/final/)
    await expect(pause(userId, manualIdentity.id)).rejects.toThrow(/AGENT_IDENTITY_REVOKED/)
  })

  it("goes with its sponsor's account, paused or not, keys and all", async () => {
    const { companyId } = await seedOwner()
    const sponsor = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: sponsor, role: 'admin' })
    const connector = await mintKey({ userId: sponsor, companyId, oauth: true, client: 'claude' })
    const manual = await mintKey({ userId: sponsor, companyId, name: 'Skript' })
    const identityIds = [(await identityOfKey(connector.id)).id, (await identityOfKey(manual.id)).id]
    await pause(sponsor, identityIds[0]!)

    await getPool().query(`DELETE FROM auth.users WHERE id = $1`, [sponsor])

    const identities = await getPool().query(`SELECT id FROM public.agent_identities WHERE id = ANY($1::uuid[])`, [
      identityIds,
    ])
    expect(identities.rows).toHaveLength(0)
    const keys = await getPool().query(`SELECT id FROM public.api_keys WHERE id = ANY($1::uuid[])`, [
      [connector.id, manual.id],
    ])
    expect(keys.rows).toHaveLength(0)
  })

  it("cancels the paused agent's in-flight MCP tasks and nobody else's", async () => {
    const { userId, companyId } = await seedOwner()
    const claude = await mintKey({ userId, companyId, oauth: true, client: 'claude' })
    const script = await mintKey({ userId, companyId, name: 'Skript' })

    const task = async (apiKeyId: string, status = 'working') => {
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO public.mcp_tasks (company_id, user_id, api_key_id, tool_name, status)
         VALUES ($1, $2, $3, 'accounted_import_sie', $4) RETURNING id`,
        [companyId, userId, apiKeyId, status],
      )
      return rows[0]!.id
    }
    const working = await task(claude.id)
    const done = await task(claude.id, 'completed')
    const unrelated = await task(script.id)

    await pause(userId, (await identityOfKey(claude.id)).id)

    const { rows } = await getPool().query<{ id: string; status: string; status_message: string | null }>(
      `SELECT id, status, status_message FROM public.mcp_tasks WHERE id = ANY($1::uuid[])`,
      [[working, done, unrelated]],
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(working)).toMatchObject({ status: 'cancelled', status_message: expect.stringMatching(/pausad/) })
    expect(byId.get(done)!.status).toBe('completed')
    expect(byId.get(unrelated)!.status).toBe('working')
  })

  it('backfills existing keys like the trigger, quietly and idempotently', async () => {
    const { userId, companyId } = await seedOwner()

    // Keys as they stood before the migration: no identity. The attach
    // trigger is held off for the seed only.
    const seeded: Record<string, string> = {}
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE public.api_keys DISABLE TRIGGER api_keys_set_agent_identity')
      const insert = async (label: string, values: {
        name: string
        client?: string | null
        refresh?: boolean
        revokedAt?: string | null
        createdAt: string
      }) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO public.api_keys
             (user_id, company_id, key_hash, key_prefix, name, client, refresh_token_hash, revoked_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'gnubok_sk_seed', $4, $5, $6, $7, $8, $8) RETURNING id`,
          [
            userId,
            companyId,
            fakeHash(),
            values.name,
            values.client ?? null,
            values.refresh ? fakeHash() : null,
            values.revokedAt ?? null,
            values.createdAt,
          ],
        )
        seeded[label] = rows[0]!.id
      }
      await insert('claudeOld', { name: OAUTH_NAME, client: 'claude', refresh: true, revokedAt: '2026-09-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z' })
      await insert('claudeLive', { name: OAUTH_NAME, client: 'claude', refresh: true, createdAt: '2026-08-15T00:00:00Z' })
      await insert('chatgptA', { name: OAUTH_NAME, client: 'chatgpt', refresh: true, revokedAt: '2026-09-03T00:00:00Z', createdAt: '2026-08-02T00:00:00Z' })
      await insert('chatgptB', { name: OAUTH_NAME, client: 'chatgpt', refresh: true, revokedAt: '2026-09-05T00:00:00Z', createdAt: '2026-08-03T00:00:00Z' })
      // An OAuth key from before refresh tokens and api_keys.client.
      await insert('legacy', { name: OAUTH_NAME, createdAt: '2026-05-01T00:00:00Z' })
      await insert('manualLive', { name: 'Min skriptnyckel', createdAt: '2026-06-01T00:00:00Z' })
      await insert('manualRevoked', { name: 'Gammal nyckel', revokedAt: '2026-07-01T00:00:00Z', createdAt: '2026-06-02T00:00:00Z' })
      await client.query('ALTER TABLE public.api_keys ENABLE TRIGGER api_keys_set_agent_identity')
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
    const ids = Object.values(seeded)

    await getPool().query('SELECT public.backfill_agent_identities()')

    const claude = await identityOfKey(seeded.claudeOld!)
    expect(claude).toMatchObject({ kind: 'connector', client: 'claude', display_name: 'Claude', revoked_at: null })
    expect((await identityOfKey(seeded.claudeLive!)).id).toBe(claude.id)

    const chatgpt = await identityOfKey(seeded.chatgptA!)
    expect((await identityOfKey(seeded.chatgptB!)).id).toBe(chatgpt.id)
    expect(chatgpt.revoked_at?.toISOString()).toBe('2026-09-05T00:00:00.000Z')

    expect(await identityOfKey(seeded.legacy!)).toMatchObject({
      kind: 'connector',
      client: null,
      display_name: 'AI-anslutning',
      revoked_at: null,
    })
    expect(await identityOfKey(seeded.manualLive!)).toMatchObject({
      kind: 'api_key',
      display_name: 'Min skriptnyckel',
      revoked_at: null,
    })
    const revokedManual = await identityOfKey(seeded.manualRevoked!)
    expect(revokedManual).toMatchObject({ kind: 'api_key', display_name: 'Gammal nyckel' })
    expect(revokedManual.revoked_at?.toISOString()).toBe('2026-07-01T00:00:00.000Z')

    // A new Claude key joins the live connector; a new ChatGPT key starts a new one.
    const newClaude = await mintKey({ userId, companyId, oauth: true, client: 'claude' })
    expect((await identityOfKey(newClaude.id)).id).toBe(claude.id)
    const newChatgpt = await mintKey({ userId, companyId, oauth: true, client: 'chatgpt' })
    expect((await identityOfKey(newChatgpt.id)).id).not.toBe(chatgpt.id)

    // No audit row and no updated_at change for the attach.
    const audit = await getPool().query(
      `SELECT 1 FROM public.audit_log WHERE table_name = 'api_keys' AND action = 'UPDATE' AND record_id = ANY($1::uuid[])`,
      [ids],
    )
    expect(audit.rows).toEqual([])
    const updated = await getPool().query<{ updated_at: Date; created_at: Date }>(
      `SELECT updated_at, created_at FROM public.api_keys WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [ids],
    )
    expect(updated.rows.every((r) => r.updated_at.getTime() === r.created_at.getTime())).toBe(true)

    // The triggers it held off are back on.
    const triggers = await getPool().query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid = 'public.api_keys'::regclass
          AND tgname IN ('audit_api_keys_update', 'set_updated_at_api_keys', 'api_keys_set_agent_identity')
        ORDER BY tgname`,
    )
    expect(triggers.rows).toEqual([
      { tgname: 'api_keys_set_agent_identity', tgenabled: 'O' },
      { tgname: 'audit_api_keys_update', tgenabled: 'O' },
      { tgname: 'set_updated_at_api_keys', tgenabled: 'O' },
    ])

    // Idempotent: a second run creates and changes nothing.
    const count = async () =>
      (
        await getPool().query<{ n: string }>(
          `SELECT count(*) AS n FROM public.agent_identities WHERE sponsor_user_id = $1`,
          [userId],
        )
      ).rows[0]!.n
    const before = await count()
    await getPool().query('SELECT public.backfill_agent_identities()')
    expect(await count()).toBe(before)
    expect((await identityOfKey(seeded.claudeOld!)).id).toBe(claude.id)
  })

  it('keeps every new function away from anon and the backfill away from every API role', async () => {
    const { rows } = await getPool().query<{ fn: string; anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT f AS fn,
              has_function_privilege('anon', f, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', f, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', f, 'EXECUTE') AS service
         FROM unnest(ARRAY[
           'public.api_key_refusal(text)',
           'public.pause_agent_identity(uuid)',
           'public.resume_agent_identity(uuid)',
           'public.validate_and_increment_api_key(text)',
           'public.rotate_mcp_refresh_token(text, text, text, text, integer)',
           'public.agent_identity_for_key(uuid, text, text, boolean, uuid)'
         ]) AS f`,
    )
    const byFn = Object.fromEntries(rows.map((r) => [r.fn, r]))
    expect(byFn['public.api_key_refusal(text)']).toMatchObject({ anon: false, authenticated: false, service: true })
    expect(byFn['public.pause_agent_identity(uuid)']).toMatchObject({ anon: false, authenticated: true })
    expect(byFn['public.resume_agent_identity(uuid)']).toMatchObject({ anon: false, authenticated: true })
    expect(byFn['public.validate_and_increment_api_key(text)']).toMatchObject({
      anon: false,
      authenticated: false,
      service: true,
    })
    expect(byFn['public.rotate_mcp_refresh_token(text, text, text, text, integer)']).toMatchObject({
      anon: false,
      authenticated: false,
      service: true,
    })
    expect(byFn['public.agent_identity_for_key(uuid, text, text, boolean, uuid)']).toMatchObject({
      anon: false,
      authenticated: false,
    })

    const backfill = await getPool().query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', 'public.backfill_agent_identities()', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.backfill_agent_identities()', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.backfill_agent_identities()', 'EXECUTE') AS service`,
    )
    expect(backfill.rows[0]).toEqual({ anon: false, authenticated: false, service: false })
  })
})
