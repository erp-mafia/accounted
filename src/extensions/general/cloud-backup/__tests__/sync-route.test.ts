import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: vi.fn() }
})
vi.mock('../lib/sync', () => ({ performSync: vi.fn() }))
vi.mock('../lib/run-claim', () => ({ withManualRunClaim: vi.fn() }))

import { cloudBackupExtension } from '../index'
import { performSync } from '../lib/sync'
import { withManualRunClaim } from '../lib/run-claim'
import type { ExtensionContext } from '@/lib/extensions/types'

/**
 * "Synka nu" runs under the same claim as the nightly cron
 * (lib/run-claim.ts): two runs on one destination uploaded the same archives
 * twice.
 */

const sync = cloudBackupExtension.apiRoutes!.find((r) => r.method === 'POST' && r.path === '/sync')!

const ctx = {
  userId: 'user-1',
  companyId: 'company-1',
  supabase: {},
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  settings: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
} as unknown as ExtensionContext

const request = (provider = 'google_drive') =>
  new Request(`https://test.local/api/extensions/ext/cloud-backup/sync?provider=${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ include_documents: true }),
  })

beforeEach(() => vi.clearAllMocks())

describe('POST /sync', () => {
  it('answers 409 sync_in_progress and uploads nothing while another run holds the destination', async () => {
    vi.mocked(withManualRunClaim).mockResolvedValue({ busy: true })

    const response = await sync.handler(request('dropbox'), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'sync_in_progress' })
    expect(withManualRunClaim).toHaveBeenCalledWith(
      ctx.supabase,
      { companyId: 'company-1', scheduleKey: 'dropbox_schedule' },
      expect.any(Function)
    )
    expect(performSync).not.toHaveBeenCalled()
  })

  it('runs the sync under the claim and answers its summary', async () => {
    vi.mocked(withManualRunClaim).mockImplementation((async (
      _supabase: unknown,
      _params: unknown,
      run: () => Promise<unknown>
    ) => ({ busy: false, result: await run() })) as never)
    vi.mocked(performSync).mockResolvedValue({
      ok: true,
      lastSync: { at: '2026-07-12T12:30:00Z', folder_id: 'folder-1', files: [], total_size_bytes: 10 },
      webViewLink: 'https://drive.google.com/drive/folders/folder-1',
      uploadedCount: 1,
      skippedCount: 2,
    })

    const response = await sync.handler(request(), ctx)

    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ uploaded_count: 1, skipped_count: 2 })
    expect(performSync).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }))
  })
})
