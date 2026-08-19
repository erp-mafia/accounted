import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockSupabase } from '@/tests/helpers'
import type { Notice } from '../types'

const detectMocks = vi.hoisted(() => ({
  broken: vi.fn(),
  skv: vi.fn(),
  backup: vi.fn(),
  expiring: vi.fn(),
  other: vi.fn(),
}))

vi.mock('../categories', () => ({
  detectBrokenBankConnections: detectMocks.broken,
  detectSkvDisconnected: detectMocks.skv,
  detectBackupFailing: detectMocks.backup,
  detectExpiringBankConnections: detectMocks.expiring,
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
