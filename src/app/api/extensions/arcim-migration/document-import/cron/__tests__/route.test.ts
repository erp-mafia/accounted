import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn().mockReturnValue(null) }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => ({})) }))
vi.mock('@/extensions/general/arcim-migration/lib/document-import-continuation', () => ({
  runDocumentImportContinuation: vi.fn(),
}))
import { GET, maxDuration } from '../route'
import { extensionRegistry } from '@/lib/extensions/registry'
import { verifyCronSecret } from '@/lib/auth/cron'
import { runDocumentImportContinuation } from '@/extensions/general/arcim-migration/lib/document-import-continuation'

const request = () => new Request('http://localhost/api/extensions/arcim-migration/document-import/cron')

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  vi.mocked(extensionRegistry.get).mockResolvedValue({ id: 'arcim-migration' } as never)
})
afterEach(() => vi.useRealTimers())

describe('underlag continuation cron (crm#1581)', () => {
  it('refuses an unauthenticated invocation before doing work', async () => {
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({}, { status: 401 }))
    expect((await GET(request())).status).toBe(401)
    expect(runDocumentImportContinuation).not.toHaveBeenCalled()
  })

  it('answers 200 skipped for a disabled extension', async () => {
    vi.mocked(extensionRegistry.get).mockResolvedValue(undefined)
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(runDocumentImportContinuation).not.toHaveBeenCalled()
  })

  it('sweeps until 690 s in and cuts an overrun at 770 s, under the 800 s the platform allows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const result = { eligible: 1, claimed: 1, slices: 1, completed: 0, reconnect: 0, failed: 0, released: 0 }
    vi.mocked(runDocumentImportContinuation).mockResolvedValue(result)

    const response = await GET(request())

    expect(maxDuration).toBe(800)
    expect(runDocumentImportContinuation).toHaveBeenCalledWith({
      supabase: expect.anything(),
      deadline: start + 690_000,
      hardDeadline: start + 770_000,
    })
    expect(await response.json()).toEqual({ data: result })
  })

  it('surfaces a failure instead of an empty successful run', async () => {
    vi.mocked(runDocumentImportContinuation).mockRejectedValue(new Error('database unavailable'))
    expect((await GET(request())).status).toBe(500)
  })
})
