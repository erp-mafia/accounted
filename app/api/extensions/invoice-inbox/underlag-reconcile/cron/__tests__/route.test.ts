import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/extensions/loader', () => ({
  loadExtensions: vi.fn(),
}))

vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: {
    get: vi.fn(),
  },
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn().mockReturnValue({}),
}))

vi.mock('@/lib/transactions/inbox-underlag-reconcile', () => ({
  reconcileStrandedInboxUnderlag: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))

import { GET } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { loadExtensions } from '@/lib/extensions/loader'
import { reconcileStrandedInboxUnderlag } from '@/lib/transactions/inbox-underlag-reconcile'
import { verifyCronSecret } from '@/lib/auth/cron'

const mockRegistryGet = vi.mocked(extensionRegistry.get)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockReconcile = vi.mocked(reconcileStrandedInboxUnderlag)

function makeRequest() {
  return new Request('http://localhost/api/extensions/invoice-inbox/underlag-reconcile/cron', {
    headers: { authorization: 'Bearer synthetic-cron-secret' },
  })
}

const SUMMARY = {
  execute: true,
  scanned: 4,
  truncated: false,
  strandedOnBooked: 3,
  repaired: 2,
  alreadyAnchored: 0,
  stillUnlinked: 0,
  anchoredElsewhere: 1,
  companiesTouched: 1,
  historyAppended: 2,
  failures: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerifyCronSecret.mockReturnValue(null)
})

describe('GET /api/extensions/invoice-inbox/underlag-reconcile/cron', () => {
  it('returns 401 when the cron secret is rejected', async () => {
    mockVerifyCronSecret.mockReturnValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('returns 503 EXTENSION_DISABLED when the extension is not in the registry', async () => {
    // Physical extension routes deploy in every build; the registry, generated
    // from extensions.config.json, is what turns them on. Disabled must mean
    // no reconciling AND a visible failure if the cron is scheduled anyway.
    mockRegistryGet.mockReturnValue(undefined)

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.code).toBe('EXTENSION_DISABLED')
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('runs the reconciliation in execute mode and returns its summary when enabled', async () => {
    mockRegistryGet.mockReturnValue({ id: 'invoice-inbox' } as never)
    mockReconcile.mockResolvedValue(SUMMARY)

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(loadExtensions).toHaveBeenCalled()
    expect(mockRegistryGet).toHaveBeenCalledWith('invoice-inbox')
    expect(mockReconcile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ execute: true, actorId: 'cron.invoice_inbox_underlag_reconcile' }),
    )
    expect(response.status).toBe(200)
    expect(body.data).toEqual(SUMMARY)
  })
})
