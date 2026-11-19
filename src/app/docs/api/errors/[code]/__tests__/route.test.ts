import { describe, expect, it } from 'vitest'
import { buildCustomRoute } from 'next/dist/lib/build-custom-route'
import nextConfig from '../../../../../../../next.config'
import { GET } from '../route'

/**
 * The per-code address `docs_url` carried until 2026-11 (/docs/api/errors/<CODE>)
 * keeps landing: next.config.ts lets it through to this route, which forwards
 * it to the code's anchor in the one error catalogue page. Every other
 * /docs/api path still forwards to the docs site as before.
 */

function call(code: string) {
  return GET(new Request(`https://app.accounted.se/docs/api/errors/${code}`), {
    params: Promise.resolve({ code }),
  })
}

/** The first redirect Next.js applies to a path on the app host, compiled as Next compiles it. */
async function firstRedirect(path: string) {
  const rules = (await nextConfig.redirects!()).filter((rule) => !('has' in rule && rule.has))
  return rules.find((rule) => new RegExp(buildCustomRoute('redirect', rule, ['/_next']).regex, 'i').test(path))
}

describe('GET /docs/api/errors/[code]', () => {
  it.each([
    ['PERIOD_LOCKED', 'https://docs.accounted.se/errors#period_locked'],
    ['DOC_ATTACH_PERIOD_LOCKED', 'https://docs.accounted.se/errors#doc_attach_period_locked'],
    ['doc_attach_period_locked', 'https://docs.accounted.se/errors#doc_attach_period_locked'],
  ])('forwards %s to its catalogue anchor, permanently', async (code, location) => {
    const res = await call(code)
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe(location)
  })

  it('answers 404 for a segment that is not an error code', async () => {
    const res = await call('not-a-code')
    expect(res.status).toBe(404)
    expect(res.headers.get('location')).toBeNull()
  })
})

describe('next.config.ts /docs/api forward', () => {
  it.each(['/docs/api/errors/PERIOD_LOCKED', '/docs/api/errors/doc_attach_period_locked'])(
    'lets %s through to the route',
    async (path) => {
      expect(await firstRedirect(path)).toBeUndefined()
    },
  )

  it.each(['/docs/api/errors', '/docs/api/errors.md', '/docs/api/reference/invoices', '/docs/api/errors/not-a-code'])(
    'still forwards %s to the docs site',
    async (path) => {
      expect(await firstRedirect(path)).toMatchObject({
        destination: 'https://docs.accounted.se/:path',
        permanent: true,
      })
    },
  )

  it('still forwards the bare /docs/api to the docs site root', async () => {
    expect(await firstRedirect('/docs/api')).toMatchObject({
      destination: 'https://docs.accounted.se/',
      permanent: true,
    })
  })
})
