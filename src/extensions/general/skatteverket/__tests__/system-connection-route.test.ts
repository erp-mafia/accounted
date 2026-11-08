/**
 * GET /system-connection: the settings card's status and the fallback link
 * for appointing Accounted as ombud. The ombud is appointed for the company,
 * so the link must open Skatteverket's company guide, never the page for a
 * private person (skatteverket.se/ombud lands on "Ombud för en privatperson").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
import { testRoutes } from '@/tests/helpers'

const ENV_KEYS = ['SKATTEVERKET_SYSTEM_AUTH_MODE', 'SKATTEVERKET_SYSTEM_AUTH_MECHANISM']
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
  it('refuses when the capability gate blocks', async () => {
    const { NextResponse } = await import('next/server')
    mockRequireCapability.mockResolvedValue(NextResponse.json({ error: 'capability_blocked' }, { status: 403 }))
    const res = await findRoute().handler(request(), ctx)
    expect(res.status).toBe(403)
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
