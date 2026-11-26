import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { NextResponse } from 'next/server'
import { createMockSupabase, createMockRouteParams } from '@/tests/helpers'

const authState = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
}))
const requireWriteMock = vi.hoisted(() => vi.fn())
const supabaseRef = vi.hoisted(() => ({ supabase: null as unknown }))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (!authState.user) {
      return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
    }
    return { user: authState.user, supabase: supabaseRef.supabase }
  }),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn(),
}))

vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return {
    requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
    isCompanyAdmin: vi.fn(async () => true),
    companyAdminRequiredResponse: actual.companyAdminRequiredResponse,
  }
})

import { withRouteContext } from '../with-route-context'
import { malformedUuidParam } from '../uuid-params'
import { getActiveCompanyId } from '@/lib/company/context'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const ASSET_ID = '7b0c1e2a-4d5f-4a6b-8c9d-0e1f2a3b4c5d'
const COMPONENT_ID = '2f1e0d9c-8b7a-4c6d-9e5f-4a3b2c1d0e9f'

type Params = { params: Promise<{ id: string; componentId: string }> }

function componentRoute(options: { requireWrite?: boolean } = {}) {
  const handler = vi.fn(async () => NextResponse.json({ data: { ok: true } }))
  const route = withRouteContext<Params>('test.asset_component', handler, {
    ...options,
    uuidParams: { id: 'ASSET_NOT_FOUND', componentId: 'ASSET_COMPONENT_NOT_FOUND' },
  })
  return { route, handler }
}

const request = (method = 'GET') => new Request('http://localhost/api/assets/x/components/y', { method })

describe('malformedUuidParam', () => {
  it('passes every declared parameter that holds a uuid, in either case', () => {
    expect(malformedUuidParam({ id: ASSET_ID, componentId: COMPONENT_ID.toUpperCase() }, { id: 'A', componentId: 'B' })).toBeNull()
  })

  it('names the first declared parameter that is not a uuid, with its code', () => {
    expect(malformedUuidParam({ id: ASSET_ID, componentId: 'new' }, { id: 'A', componentId: 'B' })).toEqual({
      param: 'componentId',
      code: 'B',
    })
  })

  it('judges only the declared parameters', () => {
    expect(malformedUuidParam({ id: ASSET_ID, year: '2026' }, { id: 'A' })).toBeNull()
    expect(malformedUuidParam({ id: 'new' }, undefined)).toBeNull()
  })

  it('counts a declared parameter the request lacks, or a catch-all array, as no uuid', () => {
    expect(malformedUuidParam({}, { id: 'A' })).toEqual({ param: 'id', code: 'A' })
    expect(malformedUuidParam(undefined, { id: 'A' })).toEqual({ param: 'id', code: 'A' })
    expect(malformedUuidParam({ id: [ASSET_ID] }, { id: 'A' })).toEqual({ param: 'id', code: 'A' })
  })

  it('refuses the other spellings Postgres would also read as a uuid', () => {
    // The canonical form is the one every id column and every link uses.
    expect(malformedUuidParam({ id: `{${ASSET_ID}}` }, { id: 'A' })).not.toBeNull()
    expect(malformedUuidParam({ id: ASSET_ID.replace(/-/g, '') }, { id: 'A' })).not.toBeNull()
  })
})

describe('withRouteContext uuidParams', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.user = { id: 'user-1' }
    supabaseRef.supabase = createMockSupabase().supabase
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('answers the declared not-found before the handler for an id that is not a uuid', async () => {
    const { route, handler } = componentRoute()

    const res = await route(request(), createMockRouteParams({ id: 'new', componentId: COMPONENT_ID }))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('ASSET_NOT_FOUND')
    expect(body.error.requestId).toMatch(/^req_/)
    expect(res.headers.get('X-Request-Id')).toBe(body.error.requestId)
    expect(handler).not.toHaveBeenCalled()
  })

  it('answers the code of the parameter that is malformed', async () => {
    const { route, handler } = componentRoute()

    const res = await route(request(), createMockRouteParams({ id: ASSET_ID, componentId: 'new' }))

    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('ASSET_COMPONENT_NOT_FOUND')
    expect(handler).not.toHaveBeenCalled()
  })

  it('hands uuids to the handler unchanged', async () => {
    const { route, handler } = componentRoute()
    const params = createMockRouteParams({ id: ASSET_ID, componentId: COMPONENT_ID })

    const res = await route(request(), params)

    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ companyId: 'company-1' }), params)
  })

  it('still answers 401 first to a caller who is not signed in', async () => {
    authState.user = null
    const { route, handler } = componentRoute()

    const res = await route(request(), createMockRouteParams({ id: 'new', componentId: 'new' }))

    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('still answers the role gate first on a write route', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'viewer' }, { status: 403 }) })
    const { route, handler } = componentRoute({ requireWrite: true })

    const res = await route(request('DELETE'), createMockRouteParams({ id: 'new', componentId: COMPONENT_ID }))

    expect(res.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('leaves the answers of the handler alone: its own failure stays a 500', async () => {
    // Only the parameter is judged. A uuid parse error from the handler's own
    // work is a fault in our code and must not read as a missing row.
    const route = withRouteContext<Params>(
      'test.asset_component',
      async () => NextResponse.json({ error: 'invalid input syntax for type uuid' }, { status: 500 }),
      { uuidParams: { id: 'ASSET_NOT_FOUND', componentId: 'ASSET_COMPONENT_NOT_FOUND' } },
    )

    const res = await route(request(), createMockRouteParams({ id: ASSET_ID, componentId: COMPONENT_ID }))

    expect(res.status).toBe(500)
  })
})

describe('the codes the session routes declare', () => {
  // A code the registry does not know answers INTERNAL_ERROR, a 500: the
  // very answer the option exists to replace.
  function routeFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') routeFiles(full, out)
      } else if (entry.name === 'route.ts') {
        out.push(full)
      }
    }
    return out
  }

  const declared = routeFiles(join(process.cwd(), 'src/app/api')).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/uuidParams:\s*\{([^}]*)\}/g)].flatMap((m) =>
      [...m[1].matchAll(/['"]?(\w+)['"]?\s*:\s*'([A-Z0-9_]+)'/g)].map(([, param, code]) => ({ file, param, code })),
    ),
  )

  it('finds the declarations', () => {
    expect(declared.length).toBeGreaterThan(0)
  })

  it('declares only registered 404 codes', () => {
    const wrong = declared.filter(({ code }) => getErrorEntry(code)?.httpStatus !== 404)
    expect(wrong).toEqual([])
  })
})
