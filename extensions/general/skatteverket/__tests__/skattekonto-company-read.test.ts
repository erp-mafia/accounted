/**
 * Skattekonto read routes resolve the COMPANY's connection, not the caller's
 * (#1673): a member who never pressed "Anslut" sees the saldo snapshot and can
 * trigger a sync on the token another member connected. The auth handed to
 * the sync carries the token owner's userId, so the refresh writes back to
 * the owner's row. Two connected members both keep working, and a company
 * with no row at all still answers 401 NOT_CONNECTED (the page's empty state).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})

const mockSyncSkattekonto = vi.fn()
vi.mock('../lib/skattekonto-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/skattekonto-sync')>()
  return { ...actual, syncSkattekonto: (...args: unknown[]) => mockSyncSkattekonto(...args) }
})

import { skatteverketExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

const A = 'user-a'
const B = 'user-b'
const COMPANY = 'company-1'
type TokenRow = { user_id: string; status: string; created_at: string }

function makeContext(userId: string, tokenRows: TokenRow[]): ExtensionContext {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain)
  chain.order = vi.fn().mockResolvedValue({ data: tokenRows, error: null })
  chain.maybeSingle = vi.fn(() => {
    throw new Error('maybeSingle() must not be used for the company token lookup')
  })
  const supabase = { from: vi.fn(() => chain) }
  return {
    userId,
    companyId: COMPANY,
    extensionId: 'skatteverket',
    requestId: 'req_test',
    supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    settings: {
      get: vi.fn(async (key: string) => {
        if (key === 'skattekonto_balance_snapshot') {
          return { saldo: { saldoSkatteverket: 1234.5, saldoKronofogden: 0 }, fetchedAt: 1_700_000_000_000 }
        }
        if (key === 'skattekonto_last_synced_at') return '2026-08-18T06:00:00.000Z'
        return null
      }),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function route(method: string, path: string) {
  const found = skatteverketExtension.apiRoutes?.find(r => r.method === method && r.path === path)
  if (!found) throw new Error(`${method} ${path} must be registered`)
  return found
}

function req(method: string, path: string) {
  return new Request(`https://test.local/api/extensions/ext/skatteverket${path}`, { method })
}

const A_ROW: TokenRow = { user_id: A, status: 'active', created_at: '2026-08-18T09:00:00Z' }
const B_ROW: TokenRow = { user_id: B, status: 'active', created_at: '2026-08-18T10:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
  mockSyncSkattekonto.mockResolvedValue({
    booked: 1,
    upcoming: 0,
    saldoSkatteverket: 1234.5,
    saldoKronofogden: 0,
    syncedAt: '2026-08-18T12:00:00.000Z',
  })
})

describe('GET /skattekonto/saldo: company-scoped connected check', () => {
  it('one member connects, both members read the snapshot', async () => {
    const handler = route('GET', '/skattekonto/saldo').handler

    const asA = await handler(req('GET', '/skattekonto/saldo'), makeContext(A, [A_ROW]))
    expect(asA.status).toBe(200)

    const asB = await handler(req('GET', '/skattekonto/saldo'), makeContext(B, [A_ROW]))
    expect(asB.status).toBe(200)
    const body = (await asB.json()) as { data: { saldoSkatteverket: number } | null }
    expect(body.data?.saldoSkatteverket).toBe(1234.5)
  })

  it('both members connect, both read (no maybeSingle failure on two rows)', async () => {
    const handler = route('GET', '/skattekonto/saldo').handler
    const asA = await handler(req('GET', '/skattekonto/saldo'), makeContext(A, [B_ROW, A_ROW]))
    const asB = await handler(req('GET', '/skattekonto/saldo'), makeContext(B, [B_ROW, A_ROW]))
    expect(asA.status).toBe(200)
    expect(asB.status).toBe(200)
  })

  it('no member has connected -> 401 NOT_CONNECTED (page empty state)', async () => {
    const handler = route('GET', '/skattekonto/saldo').handler
    const res = await handler(req('GET', '/skattekonto/saldo'), makeContext(B, []))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'NOT_CONNECTED' })
  })

  it('a row flagged needs_reconsent still counts as connected (stale snapshot stays visible)', async () => {
    const handler = route('GET', '/skattekonto/saldo').handler
    const res = await handler(
      req('GET', '/skattekonto/saldo'),
      makeContext(B, [{ ...A_ROW, status: 'needs_reconsent' }]),
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /skattekonto/sync: syncs on the company token, refresh goes to the owner', () => {
  it('member B triggers a sync on member A\'s token: auth carries A as the token owner', async () => {
    const ctx = makeContext(B, [A_ROW])
    const res = await route('POST', '/skattekonto/sync').handler(req('POST', '/skattekonto/sync'), ctx)
    expect(res.status).toBe(200)
    expect(mockSyncSkattekonto).toHaveBeenCalledTimes(1)
    const [passedCtx, auth] = mockSyncSkattekonto.mock.calls[0]
    expect(passedCtx).toBe(ctx)
    expect(auth).toEqual({ mode: 'user', supabase: ctx.supabase, userId: A, companyId: COMPANY })
  })

  it('both connected: each member syncs on their own token', async () => {
    const asA = makeContext(A, [B_ROW, A_ROW])
    await route('POST', '/skattekonto/sync').handler(req('POST', '/skattekonto/sync'), asA)
    expect(mockSyncSkattekonto.mock.calls[0][1]).toMatchObject({ mode: 'user', userId: A })

    const asB = makeContext(B, [B_ROW, A_ROW])
    await route('POST', '/skattekonto/sync').handler(req('POST', '/skattekonto/sync'), asB)
    expect(mockSyncSkattekonto.mock.calls[1][1]).toMatchObject({ mode: 'user', userId: B })
  })

  it('nobody connected -> 401 NOT_CONNECTED without touching SKV', async () => {
    const res = await route('POST', '/skattekonto/sync').handler(
      req('POST', '/skattekonto/sync'),
      makeContext(B, []),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'NOT_CONNECTED' })
    expect(mockSyncSkattekonto).not.toHaveBeenCalled()
  })

  it('only dead rows -> 401 SESSION_EXPIRED reconnect prompt, no refresh attempt', async () => {
    const res = await route('POST', '/skattekonto/sync').handler(
      req('POST', '/skattekonto/sync'),
      makeContext(B, [{ ...A_ROW, status: 'needs_reconsent' }]),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'SESSION_EXPIRED' })
    expect(mockSyncSkattekonto).not.toHaveBeenCalled()
  })
})
