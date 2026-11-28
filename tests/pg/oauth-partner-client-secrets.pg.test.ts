import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getPool, runAsServiceRole, withUserContext } from './setup'

/**
 * pg-real coverage for migration 20261127153716_oauth_partner_client_secrets.
 *
 * A partner client (oauth_partner_clients) can be issued a client secret and
 * is then a confidential client. Locks in:
 *   - only the SHA-256 of a secret is stored, no API role can read the
 *     hashes, and only the operator can issue one;
 *   - the client_id is the slug, and the answer to "does this request
 *     authenticate as the grant's client" (oauth_client_authentication);
 *   - rotation with an overlap, and an overlap of 0 that stops the old
 *     secret at once;
 *   - no downgrade: a client that held a secret never authenticates as a
 *     public client again, and its rows cannot be deleted or rewritten;
 *   - the refresh rotation of a confidential client's grant runs only for
 *     its own credentials and writes nothing otherwise, while a public
 *     client's grant rotates through rotate_mcp_refresh_token as before.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** A slug of its own per test: lower-case hex behind a letter. */
function newSlug(): string {
  return `p${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

async function addPartner(slug: string, opts: { revoked?: boolean } = {}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.oauth_partner_clients (slug, name, host, path, revoked_at)
     VALUES ($1, 'Partner', $2, '/oauth/callback', CASE WHEN $3 THEN now() END)`,
    [slug, `${slug}-${randomUUID().slice(0, 6)}.example.com`, opts.revoked ?? false],
  )
}

type Issued = {
  client_id: string
  client_secret: string
  client_id_issued_at: string
  client_secret_expires_at: string
  previous_secrets_expire_at: Date | null
}

/** Issue as the operator (the pool's postgres role), as the migration header says. */
async function issue(slug: string, overlap?: string): Promise<Issued> {
  const { rows } = overlap === undefined
    ? await getPool().query<Issued>(`SELECT * FROM public.issue_oauth_partner_client_secret($1)`, [slug])
    : await getPool().query<Issued>(`SELECT * FROM public.issue_oauth_partner_client_secret($1, $2::interval)`, [slug, overlap])
  return rows[0]!
}

/** oauth_client_authentication as the token route calls it: service role, the secret's hash. */
async function authenticate(client: string | null, clientId: string | null, secret: string | null): Promise<string> {
  const { rows } = await runAsServiceRole((c) =>
    c.query<{ answer: string }>(`SELECT public.oauth_client_authentication($1, $2, $3) AS answer`, [
      client,
      clientId,
      secret === null ? null : sha(secret),
    ]),
  )
  return rows[0]!.answer
}

async function secretRows(slug: string) {
  const { rows } = await getPool().query<{ id: string; secret_hash: string; expires_at: Date | null; revoked_at: Date | null }>(
    `SELECT id, secret_hash, expires_at, revoked_at FROM public.oauth_partner_client_secrets WHERE slug = $1 ORDER BY created_at, id`,
    [slug],
  )
  return rows
}

describe('oauth_partner_client_secrets (migration 20261127153716)', () => {
  it('keeps the hashes from every API role: RLS on, no policies, no privileges at all', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.oauth_partner_client_secrets'::regclass`,
    )
    expect(rls.rows[0]?.relrowsecurity).toBe(true)
    const policies = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'oauth_partner_client_secrets'`,
    )
    expect(policies.rows[0]?.n).toBe('0')

    const grants = await getPool().query<{ role: string; any_privilege: boolean }>(
      `SELECT r.role,
              has_table_privilege(r.role, 'public.oauth_partner_client_secrets', 'SELECT')
           OR has_table_privilege(r.role, 'public.oauth_partner_client_secrets', 'INSERT')
           OR has_table_privilege(r.role, 'public.oauth_partner_client_secrets', 'UPDATE')
           OR has_table_privilege(r.role, 'public.oauth_partner_client_secrets', 'DELETE') AS any_privilege
         FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
        ORDER BY r.role`,
    )
    expect(grants.rows).toEqual([
      { role: 'anon', any_privilege: false },
      { role: 'authenticated', any_privilege: false },
      { role: 'service_role', any_privilege: false },
    ])
  })

  it('lets the service role ask about clients but never issue a secret; anon and members get nothing', async () => {
    const { rows } = await getPool().query<{ fn: string; anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT f AS fn,
              has_function_privilege('anon', f, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', f, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', f, 'EXECUTE') AS service
         FROM unnest(ARRAY[
           'public.issue_oauth_partner_client_secret(text, interval)',
           'public.oauth_client_has_secret(text)',
           'public.oauth_client_authentication(text, text, text)',
           'public.rotate_mcp_refresh_token_for_client(text, text, text, text, integer, text, text)',
           'public.rotate_mcp_refresh_token(text, text, text, text, integer)'
         ]) AS f`,
    )
    const byFn = Object.fromEntries(rows.map((r) => [r.fn, { anon: r.anon, authenticated: r.authenticated, service: r.service }]))
    expect(byFn).toEqual({
      'public.issue_oauth_partner_client_secret(text, interval)': { anon: false, authenticated: false, service: false },
      'public.oauth_client_has_secret(text)': { anon: false, authenticated: false, service: true },
      'public.oauth_client_authentication(text, text, text)': { anon: false, authenticated: false, service: true },
      'public.rotate_mcp_refresh_token_for_client(text, text, text, text, integer, text, text)': { anon: false, authenticated: false, service: true },
      'public.rotate_mcp_refresh_token(text, text, text, text, integer)': { anon: false, authenticated: false, service: true },
    })

    const slug = newSlug()
    await addPartner(slug)
    await expect(
      runAsServiceRole((c) => c.query(`SELECT * FROM public.issue_oauth_partner_client_secret($1)`, [slug])),
    ).rejects.toThrow(/permission denied/)
    const { userId } = await seedCompany()
    await expect(
      withUserContext(userId, (c) => c.query(`SELECT * FROM public.issue_oauth_partner_client_secret($1)`, [slug])),
    ).rejects.toThrow(/permission denied/)
    await expect(
      runAsServiceRole((c) => c.query(`SELECT * FROM public.oauth_partner_client_secrets LIMIT 1`)),
    ).rejects.toThrow(/permission denied/)
  })

  it('issues a secret once: the client_id is the slug and only the SHA-256 is stored (RFC 7591 section 3.2.1 fields)', async () => {
    const slug = newSlug()
    await addPartner(slug)
    const { rows: partner } = await getPool().query<{ epoch: string }>(
      `SELECT extract(epoch FROM min(created_at))::bigint::text AS epoch FROM public.oauth_partner_clients WHERE slug = $1`,
      [slug],
    )

    const issued = await issue(slug)
    expect(issued.client_id).toBe(slug)
    expect(issued.client_secret).toMatch(/^accounted_cs_[0-9a-f]{64}$/)
    expect(String(issued.client_secret_expires_at)).toBe('0')
    expect(String(issued.client_id_issued_at)).toBe(partner[0]!.epoch)
    expect(issued.previous_secrets_expire_at).toBeNull()

    const stored = await getPool().query(`SELECT * FROM public.oauth_partner_client_secrets WHERE slug = $1`, [slug])
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0].secret_hash).toBe(sha(issued.client_secret))
    expect(stored.rows[0].expires_at).toBeNull()
    expect(JSON.stringify(stored.rows)).not.toContain(issued.client_secret)

    // Two issuances never share a secret.
    expect((await issue(slug)).client_secret).not.toBe(issued.client_secret)
  })

  it('answers public for a client without a secret and authenticates a partner only with its own client_id and a live secret', async () => {
    const slug = newSlug()
    await addPartner(slug)
    const client = `partner:${slug}`

    expect(await authenticate(client, slug, 'anything')).toBe('public')
    expect(await authenticate('claude', null, null)).toBe('public')
    expect(await authenticate(`registered:${randomUUID()}`, 'x', 'y')).toBe('public')
    expect(await authenticate(null, null, null)).toBe('public')

    const { client_secret: secret } = await issue(slug)
    expect(await authenticate(client, slug, secret)).toBe('authenticated')
    expect(await authenticate(client, slug, `${secret}0`)).toBe('refused')
    expect(await authenticate(client, slug, null)).toBe('refused')
    expect(await authenticate(client, null, secret)).toBe('refused')
    expect(await authenticate(client, 'otherclient', secret)).toBe('refused')

    // Another partner's secret is no use for this one.
    const other = newSlug()
    await addPartner(other)
    const { client_secret: otherSecret } = await issue(other)
    expect(await authenticate(client, other, otherSecret)).toBe('refused')
    expect(await authenticate(client, slug, otherSecret)).toBe('refused')
  })

  it('rotates with an overlap: both secrets work until it ends; an overlap of 0 stops the old ones at once', async () => {
    const slug = newSlug()
    await addPartner(slug)
    const client = `partner:${slug}`
    const first = await issue(slug)

    const second = await issue(slug, '1 hour')
    expect(second.previous_secrets_expire_at).not.toBeNull()
    const [a, b] = await secretRows(slug)
    expect(a!.secret_hash).toBe(sha(first.client_secret))
    const left = new Date(a!.expires_at!).getTime() - Date.now()
    expect(left).toBeGreaterThan(50 * 60 * 1000)
    expect(left).toBeLessThanOrEqual(61 * 60 * 1000)
    expect(b!.expires_at).toBeNull()
    expect(await authenticate(client, slug, first.client_secret)).toBe('authenticated')
    expect(await authenticate(client, slug, second.client_secret)).toBe('authenticated')

    // A later rotation never lengthens an overlap already running.
    const third = await issue(slug, '7 days')
    const rows = await secretRows(slug)
    expect(new Date(rows[0]!.expires_at!).getTime()).toBe(new Date(a!.expires_at!).getTime())

    const fourth = await issue(slug, '0')
    expect(await authenticate(client, slug, first.client_secret)).toBe('refused')
    expect(await authenticate(client, slug, second.client_secret)).toBe('refused')
    expect(await authenticate(client, slug, third.client_secret)).toBe('refused')
    expect(await authenticate(client, slug, fourth.client_secret)).toBe('authenticated')
  })

  it('never treats a client that held a secret as public again', async () => {
    const slug = newSlug()
    await addPartner(slug)
    const client = `partner:${slug}`
    const { client_secret: secret } = await issue(slug)
    await getPool().query(`UPDATE public.oauth_partner_client_secrets SET revoked_at = now() WHERE slug = $1`, [slug])

    expect(await authenticate(client, slug, secret)).toBe('refused')
    expect(await authenticate(client, null, null)).toBe('refused')
    const holds = await runAsServiceRole((c) => c.query<{ holds: boolean }>(`SELECT public.oauth_client_has_secret($1) AS holds`, [client]))
    expect(holds.rows[0]!.holds).toBe(true)
  })

  it('refuses deleting a secret, rewriting whose it is or its hash, and un-revoking it', async () => {
    const slug = newSlug()
    await addPartner(slug)
    await issue(slug)
    const [row] = await secretRows(slug)

    await expect(getPool().query(`DELETE FROM public.oauth_partner_client_secrets WHERE id = $1`, [row!.id])).rejects.toThrow(/never deleted/)
    await expect(
      getPool().query(`UPDATE public.oauth_partner_client_secrets SET slug = 'someoneelse' WHERE id = $1`, [row!.id]),
    ).rejects.toThrow(/fixed/)
    await expect(
      getPool().query(`UPDATE public.oauth_partner_client_secrets SET secret_hash = $2 WHERE id = $1`, [row!.id, sha('mine')]),
    ).rejects.toThrow(/fixed/)
    await getPool().query(`UPDATE public.oauth_partner_client_secrets SET revoked_at = now() WHERE id = $1`, [row!.id])
    await expect(
      getPool().query(`UPDATE public.oauth_partner_client_secrets SET revoked_at = NULL WHERE id = $1`, [row!.id]),
    ).rejects.toThrow(/stays revoked/)
  })

  it('issues only to an active partner, with an overlap between 0 and 30 days', async () => {
    await expect(issue(newSlug())).rejects.toThrow(/no active partner client/)
    const revoked = newSlug()
    await addPartner(revoked, { revoked: true })
    await expect(issue(revoked)).rejects.toThrow(/no active partner client/)

    const slug = newSlug()
    await addPartner(slug)
    await expect(issue(slug, '-1 second')).rejects.toThrow(/between 0 and 30 days/)
    await expect(issue(slug, '31 days')).rejects.toThrow(/between 0 and 30 days/)
    expect(await secretRows(slug)).toHaveLength(0)
  })
})

describe('refresh rotation of a confidential client (migration 20261127153716)', () => {
  type Pair = { refresh: string; key: string }
  type RotateResult = { outcome: string; scopes: string[] | null; api_key_id: string | null }

  const token = (label: string) => sha(`${label}:${randomUUID()}`)
  const successorOf = (refreshHash: string): Pair => ({ refresh: sha(`refresh:${refreshHash}`), key: sha(`access:${refreshHash}`) })

  async function insertGrant(client: string, refresh: string): Promise<string> {
    const { userId, companyId } = await seedCompany()
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.api_keys (id, user_id, company_id, key_hash, key_prefix, name, scopes, refresh_token_hash, client)
       VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'MCP-klient (OAuth)', ARRAY['reports:read'], $5, $6)`,
      [id, userId, companyId, token('k'), refresh, client],
    )
    return id
  }

  /** The call a request without credentials makes, as every public client's does. */
  async function present(presented: string): Promise<RotateResult> {
    const pair = successorOf(presented)
    const { rows } = await runAsServiceRole((c) =>
      c.query<RotateResult>(`SELECT * FROM public.rotate_mcp_refresh_token($1, $2, $3, 'gnubok_sk_next', 120)`, [
        presented,
        pair.refresh,
        pair.key,
      ]),
    )
    return rows[0]!
  }

  /** The call a request with client credentials makes. */
  async function presentAs(presented: string, clientId: string, secret: string): Promise<RotateResult> {
    const pair = successorOf(presented)
    const { rows } = await runAsServiceRole((c) =>
      c.query<RotateResult>(
        `SELECT * FROM public.rotate_mcp_refresh_token_for_client($1, $2, $3, 'gnubok_sk_next', 120, $4, $5)`,
        [presented, pair.refresh, pair.key, clientId, sha(secret)],
      ),
    )
    return rows[0]!
  }

  async function grant(id: string) {
    const { rows } = await getPool().query(
      `SELECT refresh_token_hash, previous_refresh_token_hash, key_hash, revoked_at FROM public.api_keys WHERE id = $1`,
      [id],
    )
    return rows[0]
  }

  it("rotates a public client's grant exactly as before, credentials or not", async () => {
    const r1 = token('r1')
    const id = await insertGrant('claude', r1)
    expect(await present(r1)).toEqual({ outcome: 'rotated', scopes: ['reports:read'], api_key_id: id })
    expect((await grant(id)).refresh_token_hash).toBe(successorOf(r1).refresh)

    // A partner's valid credentials change nothing for a grant that is not the partner's.
    const slug = newSlug()
    await addPartner(slug)
    const { client_secret: secret } = await issue(slug)
    const r2 = successorOf(r1).refresh
    expect((await presentAs(r2, slug, secret)).outcome).toBe('rotated')
  })

  it("refuses a confidential client's grant without its credentials and writes nothing, also for a grant minted before the secret", async () => {
    const slug = newSlug()
    await addPartner(slug)
    const r1 = token('r1')
    const id = await insertGrant(`partner:${slug}`, r1)
    // Minted while the partner was public: the secret applies from issuance on.
    const { client_secret: secret } = await issue(slug)
    const before = await grant(id)

    expect(await present(r1)).toEqual({ outcome: 'client_auth_required', scopes: null, api_key_id: id })
    expect((await presentAs(r1, slug, 'wrong')).outcome).toBe('client_auth_required')
    const other = newSlug()
    await addPartner(other)
    expect((await presentAs(r1, other, (await issue(other)).client_secret)).outcome).toBe('client_auth_required')
    expect(await grant(id)).toEqual(before)

    expect(await presentAs(r1, slug, secret)).toEqual({ outcome: 'rotated', scopes: ['reports:read'], api_key_id: id })
    expect((await grant(id)).refresh_token_hash).toBe(successorOf(r1).refresh)
  })

  it('answers a replay or a retired token without the credentials with client_auth_required and revokes nothing', async () => {
    const slug = newSlug()
    await addPartner(slug)
    const { client_secret: secret } = await issue(slug)
    const r1 = token('r1')
    const id = await insertGrant(`partner:${slug}`, r1)
    const r2 = successorOf(r1).refresh
    const r3 = successorOf(r2).refresh

    expect((await presentAs(r1, slug, secret)).outcome).toBe('rotated')
    // r1 is now the predecessor: a replay without the secret gets nothing.
    expect((await present(r1)).outcome).toBe('client_auth_required')
    expect((await presentAs(r1, slug, secret)).outcome).toBe('replayed')

    expect((await presentAs(r2, slug, secret)).outcome).toBe('rotated')
    expect((await grant(id)).refresh_token_hash).toBe(r3)
    // r1 is retired now: reuse detection would revoke the grant, but not for
    // a request that cannot authenticate as the client.
    expect((await present(r1)).outcome).toBe('client_auth_required')
    expect((await grant(id)).revoked_at).toBeNull()

    expect((await presentAs(r1, slug, secret)).outcome).toBe('reuse_revoked')
    expect((await grant(id)).revoked_at).not.toBeNull()
  })
})
