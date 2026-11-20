import { afterAll, describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * Migration 20261017124500: vendor_logos, the fleet-wide cache of vendor
 * icons. Its domain list is the union of every customer's vendors, so a
 * browser session (anon or authenticated) must neither read nor write it;
 * only the service role does.
 */
const SHA = 'a'.repeat(64)
const DOMAINS = ['pgtest-loopia.se', 'pgtest-hallon.se', 'pgtest-anon.se', 'pgtest-svc.se']

afterAll(async () => {
  await getPool().query(`DELETE FROM public.vendor_logos WHERE domain = ANY($1)`, [DOMAINS])
})

async function asAnon<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`)
    await client.query('SET LOCAL ROLE anon')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
}

describe('vendor_logos (pg)', () => {
  it('is invisible and unwritable to a signed-in member', async () => {
    const { userId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.vendor_logos (domain, status, storage_path, source, width, sha256)
       VALUES ('pgtest-loopia.se', 'found', $1, 'apple-touch-icon', 180, $2)`,
      [`vendor-icons/${SHA}.png`, SHA],
    )

    await expect(
      withUserContext(userId, (c) => c.query(`SELECT domain FROM public.vendor_logos`)),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) => c.query(`INSERT INTO public.vendor_logos (domain) VALUES ('pgtest-hallon.se')`)),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) => c.query(`UPDATE public.vendor_logos SET status = 'missing' WHERE domain = 'pgtest-loopia.se'`)),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) => c.query(`DELETE FROM public.vendor_logos WHERE domain = 'pgtest-loopia.se'`)),
    ).rejects.toMatchObject({ code: '42501' })

    const { rows } = await getPool().query(`SELECT status FROM public.vendor_logos WHERE domain = 'pgtest-loopia.se'`)
    expect(rows).toEqual([{ status: 'found' }])
  })

  it('is invisible and unwritable to anon', async () => {
    await expect(asAnon((c) => c.query(`SELECT domain FROM public.vendor_logos`))).rejects.toMatchObject({ code: '42501' })
    await expect(
      asAnon((c) => c.query(`INSERT INTO public.vendor_logos (domain) VALUES ('pgtest-anon.se')`)),
    ).rejects.toMatchObject({ code: '42501' })
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.vendor_logos WHERE domain = 'pgtest-anon.se'`)
    expect(rows[0].n).toBe(0)
  })

  it('is read and written by the service role', async () => {
    const status = await runAsServiceRole(async (c) => {
      await c.query(`INSERT INTO public.vendor_logos (domain) VALUES ('pgtest-svc.se')`)
      await c.query(`UPDATE public.vendor_logos SET status = 'missing', attempts = 0 WHERE domain = 'pgtest-svc.se'`)
      const { rows } = await c.query<{ status: string }>(`SELECT status FROM public.vendor_logos WHERE domain = 'pgtest-svc.se'`)
      return rows[0]?.status
    })
    expect(status).toBe('missing')
  })

  it('refuses a domain that is not a lower-case host, and a found row without its hashed file', async () => {
    await expect(getPool().query(`INSERT INTO public.vendor_logos (domain) VALUES ('WWW.Example.SE')`)).rejects.toThrow(/check constraint/)
    await expect(getPool().query(`INSERT INTO public.vendor_logos (domain) VALUES ('localhost')`)).rejects.toThrow(/check constraint/)
    await expect(
      getPool().query(`INSERT INTO public.vendor_logos (domain, status) VALUES ('pgtest-hallon.se', 'found')`),
    ).rejects.toThrow(/vendor_logos_found_has_file/)
    await expect(
      getPool().query(
        `INSERT INTO public.vendor_logos (domain, status, storage_path, source, sha256)
         VALUES ('pgtest-hallon.se', 'found', 'vendor-icons/hallon.se.png', 'icon', $1)`,
        [SHA],
      ),
    ).rejects.toThrow(/check constraint/)
  })
})
