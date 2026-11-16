/**
 * GET /system-connection: the settings card's status and the fallback link
 * for appointing Accounted as ombud. The ombud is appointed for the company,
 * so the link must open Skatteverket's company guide, never the page for a
 * private person (skatteverket.se/ombud lands on "Ombud för en privatperson").
 *
 * The card shows `appointment` (lib/skatteverket/ombud-appointment.ts): a
 * grant Skatteverket has not registered yet reads as waiting, never as the
 * red "Saknas" it showed on 2026-11-08 for a receipt that said "mottagen".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The dispatcher's session check, for the 401 case below.
const mockCreateClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
  createClient: (...a: unknown[]) => mockCreateClient(...a),
}))

const mockRequireCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }
})

const mockGetConnection = vi.fn()
vi.mock('../lib/connection-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, getConnection: (...a: unknown[]) => mockGetConnection(...a) }
})

import { skatteverketExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse, testRoutes } from '@/tests/helpers'
import { extensionRegistry } from '@/lib/extensions/registry'
import { GET as dispatch } from '@/app/api/extensions/ext/[...path]/route'

const ENV_KEYS = ['SKATTEVERKET_SYSTEM_AUTH_MODE', 'SKATTEVERKET_SYSTEM_AUTH_MECHANISM', 'SKATTEVERKET_ENABLED']
let savedEnv: Record<string, string | undefined>

function findRoute() {
  const route = testRoutes(skatteverketExtension).find(
    (r) => r.method === 'GET' && r.path === '/system-connection'
  )
  if (!route) throw new Error('system-connection route not registered')
  return route
}

const ctx = {
  userId: 'user-1',
  companyId: 'company-1',
  extensionId: 'skatteverket',
  requestId: 'req_test',
  supabase: {},
} as unknown as ExtensionContext

const request = () => new Request('http://localhost/api/extensions/ext/skatteverket/system-connection')

beforeEach(() => {
  vi.clearAllMocks()
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'on'
  process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM = 'stub'
  mockRequireCapability.mockResolvedValue(null)
  mockGetConnection.mockResolvedValue(null)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('GET /system-connection', () => {
  it('a company without the Skatteverket feature hears "not available", as with system auth off: an availability read, not a refusal', async () => {
    const { NextResponse } = await import('next/server')
    mockRequireCapability.mockResolvedValue(NextResponse.json({ error: 'capability_blocked' }, { status: 403 }))
    const res = await findRoute().handler(request(), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false, mode: 'on' })
    expect(mockGetConnection).not.toHaveBeenCalled()
  })

  it('reports unavailable while system auth is off', async () => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'off'
    const res = await findRoute().handler(request(), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false, mode: 'off' })
  })

  it('links to Skatteverket\'s guide for appointing an ombud for a company, not a private person', async () => {
    const res = await findRoute().handler(request(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.available).toBe(true)
    const url = new URL(body.grant_url)
    expect(url.protocol).toBe('https:')
    expect(url.hostname).toMatch(/^(www\.)?skatteverket\.se$/)
    expect(url.pathname).toMatch(/^\/foretag\/.*\/utseombudforettforetag\./)
    expect(body.behorigheter.map((b: { key: string }) => b.key)).toEqual(['lasombud', 'moms_ombud'])
  })
})

/** The register's 404 "Ingen funnen" right after signing, as prod recorded it. */
const NOT_LISTED_YET = { status: 'denied', detail: 'OMBUD_GRANT_MISSING (ombudsregister otillgängligt: OBR_HTTP_ERROR: 404)' }

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    environment: 'test',
    org_number: '165560000000',
    status: 'pending',
    lasombud_status: 'denied',
    moms_ombud_status: 'denied',
    verified_at: null,
    last_probe_at: '2026-11-08T13:19:06Z',
    last_probe_detail: { lasombud: NOT_LISTED_YET, moms_ombud: NOT_LISTED_YET },
    last_error: null,
    created_at: '2026-11-08T13:15:55Z',
    ...overrides,
  }
}

describe('GET /system-connection: the appointment the card shows', () => {
  it('no row: not appointed yet', async () => {
    const res = await findRoute().handler(request(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.connection).toBeNull()
    expect(body.appointment).toEqual({ state: 'none', predatesOptIn: false })
  })

  it('signed, and Skatteverket has not registered it yet: waiting, not missing', async () => {
    mockGetConnection.mockResolvedValue(connectionRow())
    const body = await (await findRoute().handler(request(), ctx)).json()
    expect(body.appointment).toEqual({ state: 'waiting', predatesOptIn: false })
    // The raw row is still there for anyone who reads it.
    expect(body.connection.lasombud_status).toBe('denied')
  })

  it('one behörighet granted, the other never: appointed, the other not included', async () => {
    mockGetConnection.mockResolvedValue(
      connectionRow({
        status: 'partial',
        lasombud_status: 'granted',
        last_probe_detail: { lasombud: { status: 'granted', detail: 'ombudsregister: lasombud aktiv 2026-11-07' }, moms_ombud: NOT_LISTED_YET },
      }),
    )
    const body = await (await findRoute().handler(request(), ctx)).json()
    expect(body.appointment).toEqual({
      state: 'appointed',
      roles: { lasombud: 'granted', moms_ombud: 'not_included' },
      predatesOptIn: false,
    })
  })

  it('a grant Skatteverket withdrew: withdrawn, the one red state', async () => {
    const withdrawn = { status: 'denied', detail: 'ombudsregister 2026-11-09: huvudman saknas', reason: 'withdrawn' }
    mockGetConnection.mockResolvedValue(connectionRow({ verified_at: '2026-11-08T22:51:22Z', last_probe_detail: { lasombud: withdrawn, moms_ombud: withdrawn } }))
    const body = await (await findRoute().handler(request(), ctx)).json()
    expect(body.appointment).toEqual({
      state: 'withdrawn',
      roles: { lasombud: 'withdrawn', moms_ombud: 'withdrawn' },
      predatesOptIn: false,
    })
  })
})

describe('GET /system-connection through the extension dispatcher', () => {
  beforeEach(() => {
    process.env.SKATTEVERKET_ENABLED = 'true'
    extensionRegistry.clear()
    extensionRegistry.register(skatteverketExtension)
  })
  afterEach(() => extensionRegistry.clear())

  it('401 without a session: no connection is read', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'Not authenticated' } })
    mockCreateClient.mockResolvedValue(supabase)

    const response = await dispatch(createMockRequest('/api/extensions/ext/skatteverket/system-connection'), {
      params: Promise.resolve({ path: ['skatteverket', 'system-connection'] }),
    })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(mockCreateClient).toHaveBeenCalled()
    expect(mockGetConnection).not.toHaveBeenCalled()
  })
})

