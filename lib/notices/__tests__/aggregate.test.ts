import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockSupabase, createQueuedMockSupabase } from '@/tests/helpers'
import type { Notice } from '../types'

const detectMocks = vi.hoisted(() => ({
  broken: vi.fn(),
  skv: vi.fn(),
  backup: vi.fn(),
  expiring: vi.fn(),
  unexplained: vi.fn(),
  other: vi.fn(),
}))

vi.mock('../categories', () => ({
  detectBrokenBankConnections: detectMocks.broken,
  detectSkvDisconnected: detectMocks.skv,
  detectBackupFailing: detectMocks.backup,
  detectExpiringBankConnections: detectMocks.expiring,
  detectSkvUnexplained: detectMocks.unexplained,
  detectOtherAccountHint: detectMocks.other,
}))

import { getCompanyNotices } from '../aggregate'

const notice = (category: Notice['category'], id: string): Notice => ({
  id,
  category,
  severity: 'warning',
  messageKey: category,
  actionKey: `${category}_action`,
  actionHref: '/x',
})

const { supabase: mockSupabase, mockResult } = createMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  detectMocks.broken.mockResolvedValue(null)
  detectMocks.skv.mockResolvedValue(null)
  detectMocks.backup.mockResolvedValue(null)
  detectMocks.expiring.mockResolvedValue(null)
  detectMocks.unexplained.mockResolvedValue(null)
  detectMocks.other.mockResolvedValue(null)
  mockResult({ data: [] }) // notice_dismissals: none
})

describe('getCompanyNotices', () => {
  it('returns an empty list when nothing is degraded', async () => {
    await expect(
      getCompanyNotices(supabase, 'company-1', { userId: 'user-1' }),
    ).resolves.toEqual([])
  })

  it('orders notices by the documented priority regardless of resolution order', async () => {
    detectMocks.other.mockResolvedValue(notice('other_account_hint', 'other_account_hint'))
    detectMocks.expiring.mockResolvedValue(notice('bank_connection_expiring', 'exp:1'))
    detectMocks.broken.mockResolvedValue(notice('bank_connection_broken', 'broken:1'))
    detectMocks.backup.mockResolvedValue(notice('backup_failing', 'backup:1'))
    detectMocks.skv.mockResolvedValue(notice('skv_disconnected', 'skv:1'))

    const notices = await getCompanyNotices(supabase, 'company-1', { userId: 'user-1' })
    expect(notices.map((n) => n.category)).toEqual([
      'bank_connection_broken',
      'skv_disconnected',
      'backup_failing',
      'bank_connection_expiring',
      'other_account_hint',
    ])
  })

  it('hides dismissed notice ids and keeps the rest', async () => {
    detectMocks.broken.mockResolvedValue(notice('bank_connection_broken', 'broken:1'))
    detectMocks.skv.mockResolvedValue(notice('skv_disconnected', 'skv:1'))
    mockResult({ data: [{ notice_id: 'broken:1' }] })

    const notices = await getCompanyNotices(supabase, 'company-1', { userId: 'user-1' })
    expect(notices.map((n) => n.id)).toEqual(['skv:1'])
  })

  it('does NOT hide a notice whose state discriminator changed since the dismissal', async () => {
    detectMocks.broken.mockResolvedValue(notice('bank_connection_broken', 'broken:2'))
    mockResult({ data: [{ notice_id: 'broken:1' }] })

    const notices = await getCompanyNotices(supabase, 'company-1', { userId: 'user-1' })
    expect(notices.map((n) => n.id)).toEqual(['broken:2'])
  })

  it('shows everything when the dismissal read fails (over-show beats hiding a real problem)', async () => {
    detectMocks.broken.mockResolvedValue(notice('bank_connection_broken', 'broken:1'))
    mockResult({ error: { message: 'boom' } })

    const notices = await getCompanyNotices(supabase, 'company-1', { userId: 'user-1' })
    expect(notices.map((n) => n.id)).toEqual(['broken:1'])
  })

  it('passes the caller identity through to the per-user predicates', async () => {
    const now = new Date('2026-08-19T12:00:00Z')
    await getCompanyNotices(supabase, 'company-1', { userId: 'user-1', now })
    expect(detectMocks.skv).toHaveBeenCalledWith(supabase, 'user-1', 'company-1', now)
    expect(detectMocks.expiring).toHaveBeenCalledWith(supabase, 'company-1', now)
  })
})

describe('stale-dismissal reaping (contract in lib/notices/types.ts)', () => {
  // A queued mock records builder calls, so the delete (or its absence) is
  // observable. The backup id is timestamp-free and identical per incident,
  // making it the category whose resurface behavior depends on reaping.
  const BACKUP_ID = 'backup_failing:google_drive=sync_error'
  const backupNotice = notice('backup_failing', BACKUP_ID)
  const queued = createQueuedMockSupabase()
  const qSupabase = queued.supabase as unknown as SupabaseClient

  beforeEach(() => {
    queued.reset()
  })

  it('keeps a persisting failure dismissed across two aggregations (no reap while failing)', async () => {
    detectMocks.backup.mockResolvedValue(backupNotice)

    queued.enqueue({ data: [{ notice_id: BACKUP_ID }] })
    const first = await getCompanyNotices(qSupabase, 'company-1', { userId: 'user-1' })
    queued.enqueue({ data: [{ notice_id: BACKUP_ID }] })
    const second = await getCompanyNotices(qSupabase, 'company-1', { userId: 'user-1' })

    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(queued.findCalls('notice_dismissals', 'delete')).toEqual([])
  })

  it('reaps the stored dismissal once the category is healthy again', async () => {
    // All detects resolve null (healthy) via the outer beforeEach.
    queued.enqueue({ data: [{ notice_id: BACKUP_ID }] }) // dismissal read
    queued.enqueue({ data: null }) // delete result

    const notices = await getCompanyNotices(qSupabase, 'company-1', { userId: 'user-1' })

    expect(notices).toEqual([])
    expect(queued.findCalls('notice_dismissals', 'delete').length).toBe(1)
    expect(queued.findCall('notice_dismissals', 'in')).toEqual(['notice_id', [BACKUP_ID]])
  })

  it('hands the reap to deferReap instead of awaiting it on the read path (Hem streams)', async () => {
    queued.enqueue({ data: [{ notice_id: BACKUP_ID }] }) // dismissal read
    queued.enqueue({ data: null }) // delete result, consumed only when the task runs
    const deferred: Array<() => Promise<void>> = []

    const notices = await getCompanyNotices(qSupabase, 'company-1', {
      userId: 'user-1',
      deferReap: (task) => deferred.push(task),
    })

    expect(notices).toEqual([])
    expect(deferred).toHaveLength(1)
    expect(queued.findCalls('notice_dismissals', 'delete')).toEqual([])

    await deferred[0]()
    expect(queued.findCalls('notice_dismissals', 'delete').length).toBe(1)
    expect(queued.findCall('notice_dismissals', 'in')).toEqual(['notice_id', [BACKUP_ID]])
  })

  it('resurfaces a NEW failure after the healthy spell reaped the dismissal', async () => {
    // error -> dismiss: hidden while the incident persists.
    detectMocks.backup.mockResolvedValue(backupNotice)
    queued.enqueue({ data: [{ notice_id: BACKUP_ID }] })
    expect(await getCompanyNotices(qSupabase, 'company-1', { userId: 'user-1' })).toEqual([])

    // success: the read reaps the now-stale dismissal.
    detectMocks.backup.mockResolvedValue(null)
    queued.enqueue({ data: [{ notice_id: BACKUP_ID }] })
    queued.enqueue({ data: null })
    expect(await getCompanyNotices(qSupabase, 'company-1', { userId: 'user-1' })).toEqual([])
    expect(queued.findCall('notice_dismissals', 'in')).toEqual(['notice_id', [BACKUP_ID]])

    // new error later, same id: the dismissal is gone, so it surfaces again.
    detectMocks.backup.mockResolvedValue(backupNotice)
    queued.enqueue({ data: [] })
    expect(
      (await getCompanyNotices(qSupabase, 'company-1', { userId: 'user-1' })).map((n) => n.id),
    ).toEqual([BACKUP_ID])
  })

  it('never reaps other_account_hint: its id has no category-prefix discriminator', async () => {
    queued.enqueue({ data: [{ notice_id: 'other_account_hint' }] })
    await getCompanyNotices(qSupabase, 'company-1', { userId: 'user-1' })
    expect(queued.findCalls('notice_dismissals', 'delete')).toEqual([])
  })

  it('swallows a failed reap and still returns the computed notices', async () => {
    detectMocks.broken.mockResolvedValue(notice('bank_connection_broken', 'bank_connection_broken:c1=expired'))
    queued.enqueue({ data: [{ notice_id: BACKUP_ID }] })
    queued.enqueue({ error: { message: 'boom' } }) // delete fails
    const notices = await getCompanyNotices(qSupabase, 'company-1', { userId: 'user-1' })
    expect(notices.map((n) => n.id)).toEqual(['bank_connection_broken:c1=expired'])
  })
})
