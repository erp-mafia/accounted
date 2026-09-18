import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: vi.fn(() => ({ tag: 'service' })) }))
vi.mock('@/lib/documents/read/store', () => ({ readUnreadDocuments: vi.fn() }))
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: vi.fn(async () => true) }))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { readUnreadDocuments } from '@/lib/documents/read/store'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'

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
    expect(readUnreadDocuments).toHaveBeenCalledWith({ tag: 'service' }, 12, expect.objectContaining({ budgetPagesPerDay: 0 }))
  })

  it('passes the daily page budget for voucher-tied history from the environment', async () => {
    process.env.ARKIV_BACKFILL_PAGES_PER_DAY = '250'
    ;(readUnreadDocuments as ReturnType<typeof vi.fn>).mockResolvedValue({ processed: 0, read: 0, skipped: 0, errors: 0 })
    await GET(new Request('http://localhost/api/documents/read/cron'))
    expect(readUnreadDocuments).toHaveBeenCalledWith({ tag: 'service' }, 12, expect.objectContaining({ budgetPagesPerDay: 250 }))
    delete process.env.ARKIV_BACKFILL_PAGES_PER_DAY
  })

  it('queues the classification of an untyped document read inside the rollout, and nothing outside it', async () => {
    process.env.ARKIV_COMPANY_IDS = 'co-1'
    ;(readUnreadDocuments as ReturnType<typeof vi.fn>).mockImplementation(async (_s: unknown, _n: number, opts: { onRead: (doc: Record<string, unknown>) => Promise<void> }) => {
      await opts.onRead({ id: 'd1', company_id: 'co-1', doc_type: null })
      await opts.onRead({ id: 'd2', company_id: 'co-1', doc_type: 'receipt' })
      await opts.onRead({ id: 'd3', company_id: 'co-2', doc_type: null })
      return { processed: 3, read: 3, skipped: 0, errors: 0 }
    })
    await GET(new Request('http://localhost/api/documents/read/cron'))
    expect(enqueueDocumentJob).toHaveBeenCalledTimes(1)
    expect(enqueueDocumentJob).toHaveBeenCalledWith({ tag: 'service' }, 'co-1', 'd1', 'classify')
    delete process.env.ARKIV_COMPANY_IDS
  })
})
