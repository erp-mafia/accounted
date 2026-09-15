import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/documents/read/store', () => ({ readUnreadDocuments: vi.fn() }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { readUnreadDocuments } from '@/lib/documents/read/store'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'key'
})

describe('GET /api/documents/read/cron', () => {
  it('rejects a request without the cron secret', async () => {
    ;(verifyCronSecret as ReturnType<typeof vi.fn>).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const { status } = await parseJsonResponse(await GET(new Request('http://localhost/api/documents/read/cron')))
    expect(status).toBe(401)
    expect(readUnreadDocuments).not.toHaveBeenCalled()
  })

  it('reads one bounded batch of unread documents and reports the counts', async () => {
    ;(readUnreadDocuments as ReturnType<typeof vi.fn>).mockResolvedValue({ processed: 3, read: 2, skipped: 1, errors: 0 })
    const { status, body } = await parseJsonResponse(await GET(new Request('http://localhost/api/documents/read/cron')))
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, processed: 3, read: 2 })
    expect(readUnreadDocuments).toHaveBeenCalledWith({ tag: 'service' }, 12)
  })
})
