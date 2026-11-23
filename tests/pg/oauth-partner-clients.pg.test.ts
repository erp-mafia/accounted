import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getPool, runAsServiceRole, withUserContext } from './setup'

/**
 * pg-real coverage for migration 20261122153300_oauth_partner_clients.
 *
 * oauth_partner_clients holds the partner OAuth clients the MCP OAuth
 * endpoints accept (src/lib/auth/oauth-partner-clients.ts). Locks in:
 *   - service role only: RLS on, no policies, nothing for anon or
 *     authenticated; the service role reads, inserts and updates but never
 *     deletes (rows are revoked, so old keys keep their partner's name);
 *   - the shapes the matcher relies on: a lower-case DNS host, a path of
 *     plain segments, exact or prefix, never a prefix on a whole host, a slug
 *     that no built-in provider or connection kind uses;
 *   - a prefix row carries a note saying who vetted the paths under it;
 *   - one active row per (host, path), free again once revoked.
 */

function host(): string {
  return `p${randomUUID().slice(0, 8)}.example.com`
}

type Row = { slug?: string; name?: string; host?: string; path?: string; match?: string; note?: string | null; revoked_at?: string | null }

const VETTED = 'No customer pages or redirects under the prefix (checked 2026-11-22)'

async function insert(row: Row) {
  const values = { slug: 'acme', name: 'Acme', host: host(), path: '/oauth/callback', match: 'exact', note: null, revoked_at: null, ...row }
  return getPool().query<{ id: string }>(
    `INSERT INTO public.oauth_partner_clients (slug, name, host, path, match, note, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [values.slug, values.name, values.host, values.path, values.match, values.note, values.revoked_at],
  )
}

describe('oauth_partner_clients (migration 20261122153300)', () => {
  it('has RLS enabled, no policies, nothing for anon or authenticated, and no DELETE for the service role', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.oauth_partner_clients'::regclass`)
    expect(rls.rows[0]?.relrowsecurity).toBe(true)

    const policies = await getPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'oauth_partner_clients'`)
    expect(policies.rows[0]?.n).toBe('0')

    const grants = await getPool().query<{ role: string; can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(
      `SELECT r.role,
              has_table_privilege(r.role, 'public.oauth_partner_clients', 'SELECT') AS can_select,
              has_table_privilege(r.role, 'public.oauth_partner_clients', 'INSERT') AS can_insert,
              has_table_privilege(r.role, 'public.oauth_partner_clients', 'UPDATE') AS can_update,
              has_table_privilege(r.role, 'public.oauth_partner_clients', 'DELETE') AS can_delete
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
       ORDER BY r.role`,
    )
    expect(grants.rows).toEqual([
      { role: 'anon', can_select: false, can_insert: false, can_update: false, can_delete: false },
      { role: 'authenticated', can_select: false, can_insert: false, can_update: false, can_delete: false },
      { role: 'service_role', can_select: true, can_insert: true, can_update: true, can_delete: false },
    ])
  })

  it('lets a signed-in member neither read nor add a partner', async () => {
    const { userId } = await seedCompany()
    await expect(withUserContext(userId, (client) => client.query(`SELECT * FROM public.oauth_partner_clients LIMIT 1`))).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(userId, (client) =>
        client.query(`INSERT INTO public.oauth_partner_clients (slug, name, host, path) VALUES ('evil', 'Evil', 'evil.example.com', '/cb')`),
      ),
    ).rejects.toThrow(/permission denied/)
  })

  it('lets the service role add, read and revoke a partner, but not delete one', async () => {
    const h = host()
    const inserted = await runAsServiceRole((client) =>
      client.query<{ id: string; match: string; revoked_at: string | null }>(
        `INSERT INTO public.oauth_partner_clients (slug, name, host, path, match, note) VALUES ('gateway', 'Gateway', $1, '/upstream', 'prefix', $2) RETURNING id, match, revoked_at`,
        [h, VETTED],
      ),
    )
    expect(inserted.rows).toEqual([{ id: expect.any(String), match: 'prefix', revoked_at: null }])
    const id = inserted.rows[0]!.id

    const read = await runAsServiceRole((client) =>
      client.query<{ slug: string }>(`SELECT slug FROM public.oauth_partner_clients WHERE host = $1 AND revoked_at IS NULL`, [h]),
    )
    expect(read.rows).toEqual([{ slug: 'gateway' }])

    await runAsServiceRole((client) => client.query(`UPDATE public.oauth_partner_clients SET revoked_at = now() WHERE id = $1`, [id]))
    await expect(runAsServiceRole((client) => client.query(`DELETE FROM public.oauth_partner_clients WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/)
  })

  it('defaults to an exact match and accepts the shapes the matcher reads', async () => {
    const exact = await getPool().query<{ match: string }>(
      `INSERT INTO public.oauth_partner_clients (slug, name, host, path) VALUES ('acme', 'Acme AB', $1, '/api/oauth/callback/accounted') RETURNING match`,
      [host()],
    )
    expect(exact.rows).toEqual([{ match: 'exact' }])
    await expect(insert({ path: '/' })).resolves.toBeTruthy()
    await expect(insert({ path: '/upstream/', match: 'prefix', note: VETTED })).resolves.toBeTruthy()
    await expect(insert({ path: '/v1.2/cb_x-y' })).resolves.toBeTruthy()
    await expect(insert({ host: `dev.${host()}` })).resolves.toBeTruthy()
  })

  it.each([
    ['an upper-case slug', { slug: 'Acme' }, /oauth_partner_clients_slug_format/],
    ['a one-letter slug', { slug: 'a' }, /oauth_partner_clients_slug_format/],
    ['a slug with a dash', { slug: 'acme-gw' }, /oauth_partner_clients_slug_format/],
    ['a built-in provider as slug', { slug: 'claude' }, /oauth_partner_clients_slug_not_built_in/],
    ['a connection kind as slug', { slug: 'partner' }, /oauth_partner_clients_slug_not_built_in/],
    ['an empty name', { name: '' }, /oauth_partner_clients_name_format/],
    ['a name with outer spaces', { name: ' Acme ' }, /oauth_partner_clients_name_format/],
    ['a name with a control character', { name: 'Acme\u0007' }, /oauth_partner_clients_name_format/],
    ['an upper-case host', { host: 'Partner.example.com' }, /oauth_partner_clients_host_format/],
    ['a host without a dot', { host: 'localhost' }, /oauth_partner_clients_host_format/],
    ['an IP address', { host: '10.0.0.1' }, /oauth_partner_clients_host_format/],
    ['a host with a port', { host: 'partner.example.com:8443' }, /oauth_partner_clients_host_format/],
    ['a host with a scheme', { host: 'https://partner.example.com' }, /oauth_partner_clients_host_format/],
    ['a path without a leading slash', { path: 'oauth/callback' }, /oauth_partner_clients_path_format/],
    ['a dot segment', { path: '/oauth/../callback' }, /oauth_partner_clients_path_format/],
    ['percent-encoding', { path: '/oauth/%2e%2e' }, /oauth_partner_clients_path_format/],
    ['a query', { path: '/oauth/callback?x=1' }, /oauth_partner_clients_path_format/],
    ['an empty segment', { path: '//callback' }, /oauth_partner_clients_path_format/],
    ['an unknown match kind', { match: 'regex' }, /oauth_partner_clients_match_check/],
    ['a prefix on a whole host', { path: '/', match: 'prefix', note: VETTED }, /oauth_partner_clients_prefix_not_root/],
    ['a prefix without a note', { path: '/upstream', match: 'prefix' }, /oauth_partner_clients_prefix_has_note/],
    ['a prefix with a blank note', { path: '/upstream', match: 'prefix', note: '  ' }, /oauth_partner_clients_prefix_has_note/],
  ])('refuses %s', async (_label, row, constraint) => {
    await expect(insert(row)).rejects.toThrow(constraint)
  })

  it('holds one active row per callback, free again once revoked', async () => {
    const h = host()
    const first = await insert({ host: h, path: '/cb' })
    await expect(insert({ host: h, path: '/cb', slug: 'other' })).rejects.toThrow(/uq_oauth_partner_clients_active_callback/)
    // Another path on the same host is another callback.
    await expect(insert({ host: h, path: '/cb2' })).resolves.toBeTruthy()

    await getPool().query(`UPDATE public.oauth_partner_clients SET revoked_at = now() WHERE id = $1`, [first.rows[0]!.id])
    await expect(insert({ host: h, path: '/cb', slug: 'other' })).resolves.toBeTruthy()
  })

  it('refuses a revocation dated before the row was added', async () => {
    const row = await insert({})
    await expect(
      getPool().query(`UPDATE public.oauth_partner_clients SET revoked_at = created_at - interval '1 day' WHERE id = $1`, [row.rows[0]!.id]),
    ).rejects.toThrow(/oauth_partner_clients_revoked_after_created/)
  })
})
