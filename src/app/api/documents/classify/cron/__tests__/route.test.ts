import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

const from = vi.fn()

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => ({ from })) }))
vi.mock('@/lib/documents/classify/classify', () => ({ classifyUnclassifiedDocuments: vi.fn() }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { classifyUnclassifiedDocuments } from '@/lib/documents/classify/classify'

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>
const request = () => new Request('http://localhost/api/documents/classify/cron')

// The untyped-rows scan, answered with the company ids given.
function scanReturning(companyIds: Array<string | null>) {
  const api: Record<string, unknown> = {}
  for (const m of ['select', 'is', 'not', 'gt', 'order']) api[m] = () => api
  api.limit = () => Promise.resolve({ data: companyIds.map((company_id) => ({ company_id })), error: null })
  from.mockReturnValue(api)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key'
  asMock(classifyUnclassifiedDocuments).mockResolvedValue({ processed: 2, classified: 2, held: 1, skipped: 0, errors: 0 })
})

describe('GET /api/documents/classify/cron', () => {
  it('rejects a request without the cron secret', async () => {
    asMock(verifyCronSecret).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const { status } = await parseJsonResponse(await GET(request()))
    expect(status).toBe(401)
    expect(classifyUnclassifiedDocuments).not.toHaveBeenCalled()
  })



  it('finds the companies from the newest untyped rows: the shelf is on for everyone', async () => {
    scanReturning(['co-9', 'co-9', null, 'co-3'])
    await GET(request())
    expect(asMock(classifyUnclassifiedDocuments).mock.calls.map((c) => c[1])).toEqual(['co-9', 'co-3'])
  })
})
