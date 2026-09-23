/**
 * The cron shell around the assistant reads: authorization, the kill
 * switch, the AI gate, and one stored read per planned transaction. The
 * plan and the read itself are covered in lib/agent/categorize/__tests__.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({})) }))
const aiStatus = vi.fn()
vi.mock('@/lib/ai', () => ({ getAiStatus: () => aiStatus() }))
const planAssistantReads = vi.fn()
const readTransaction = vi.fn()
const storeRead = vi.fn()
vi.mock('@/lib/agent/categorize/read', () => ({
  planAssistantReads: (...a: unknown[]) => planAssistantReads(...a),
  readTransaction: (...a: unknown[]) => readTransaction(...a),
  storeRead: (...a: unknown[]) => storeRead(...a),
}))

import { verifyCronSecret } from '@/lib/auth/cron'
import { createServiceClient } from '@/lib/supabase/server'
import { GET } from '../route'

const ORIGINAL_MODE = process.env.ASSISTANT_READS_MODE
const request = () => new Request('https://app.accounted.se/api/agent/categorize/cron')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  aiStatus.mockReturnValue({ configured: true })
  planAssistantReads.mockResolvedValue([])
  readTransaction.mockResolvedValue({ read: { transaction_id: 'tx-1', account: '5410', confidence: 0.7, has_underlag: false } })
  storeRead.mockResolvedValue(undefined)
  delete process.env.ASSISTANT_READS_MODE
})

afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.ASSISTANT_READS_MODE
  else process.env.ASSISTANT_READS_MODE = ORIGINAL_MODE
})

describe('GET /api/agent/categorize/cron', () => {
  it('rejects an unauthorized caller without touching the database', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled()
    expect(planAssistantReads).not.toHaveBeenCalled()
  })

  it('is off when ASSISTANT_READS_MODE=off', async () => {
    process.env.ASSISTANT_READS_MODE = 'off'
    const res = await GET(request())
    const body = await res.json()
    expect(body.skipped).toBe(true)
    expect(planAssistantReads).not.toHaveBeenCalled()
  })

  it('skips quietly when no AI backend is configured', async () => {
    aiStatus.mockReturnValue({ configured: false })
    const body = await (await GET(request())).json()
    expect(body).toMatchObject({ success: true, skipped: true, reason: 'ai_unconfigured' })
    expect(planAssistantReads).not.toHaveBeenCalled()
  })

  it('reads and stores each planned transaction, and one failure does not stop the rest', async () => {
    const tx = (id: string) => ({ id, company_id: 'co-1', amount: -100, description: 'x' })
    planAssistantReads.mockResolvedValue([
      { companyId: 'co-1', entityType: 'aktiebolag', vatRegistered: true, tx: tx('tx-1') },
      { companyId: 'co-1', entityType: 'aktiebolag', vatRegistered: true, tx: tx('tx-2') },
    ])
    readTransaction
      .mockRejectedValueOnce(new Error('model down'))
      .mockResolvedValueOnce({ read: { transaction_id: 'tx-2', account: '6570', confidence: 0.9, has_underlag: true } })
    const body = await (await GET(request())).json()
    expect(body).toMatchObject({ success: true, planned: 2, succeeded: 1, failed: 1 })
    expect(storeRead).toHaveBeenCalledTimes(1)
    expect(storeRead.mock.calls[0][2]).toMatchObject({ transaction_id: 'tx-2' })
    expect(readTransaction.mock.calls[0][3]).toMatchObject({ entityType: 'aktiebolag', vatRegistered: true, samples: 2 })
  })
})
