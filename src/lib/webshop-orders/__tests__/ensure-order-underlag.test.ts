import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'

const mockArchive = vi.fn()
vi.mock('@/lib/webshop-orders/order-underlag', () => ({
  ORDER_UNDERLAG_FILENAME_PREFIX: 'Orderunderlag',
  archiveWebshopOrderUnderlag: (...args: unknown[]) => mockArchive(...args),
}))

import { ensureWebshopOrderUnderlag } from '../ensure-order-underlag'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient

const log = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger

function orderRow(overrides: Record<string, unknown> = {}) {
  return { id: 'order-1', company_id: 'company-1', journal_entry_id: 'je-1', ...overrides }
}

describe('ensureWebshopOrderUnderlag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockArchive.mockResolvedValue({ ok: true, documentId: 'doc-new' })
  })

  it('reports not_found for an order outside the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const outcome = await ensureWebshopOrderUnderlag(supabase, 'company-1', 'user-1', 'order-1', log)
    expect(outcome).toEqual({ ok: false, kind: 'not_found' })
    expect(mockArchive).not.toHaveBeenCalled()
  })

  it('reports not_booked when the order has no verifikat', async () => {
    enqueue({ data: orderRow({ journal_entry_id: null }) })
    const outcome = await ensureWebshopOrderUnderlag(supabase, 'company-1', 'user-1', 'order-1', log)
    expect(outcome).toEqual({ ok: false, kind: 'not_booked' })
    expect(mockArchive).not.toHaveBeenCalled()
  })

  it('looks only for the current system orderunderlag on that verifikat', async () => {
    enqueue({ data: orderRow() })
    enqueue({ data: [] })
    await ensureWebshopOrderUnderlag(supabase, 'company-1', 'user-1', 'order-1', log)
    expect(findCalls('document_attachments', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['journal_entry_id', 'je-1'],
      ['upload_source', 'system'],
      ['is_current_version', true],
    ])
    expect(findCalls('document_attachments', 'ilike')).toEqual([['file_name', 'Orderunderlag%']])
  })

  it('archives when the verifikat has no orderunderlag', async () => {
    enqueue({ data: orderRow() })
    enqueue({ data: [] })
    const outcome = await ensureWebshopOrderUnderlag(supabase, 'company-1', 'user-1', 'order-1', log)
    expect(outcome).toEqual({
      ok: true,
      alreadyAttached: false,
      journalEntryId: 'je-1',
      documentId: 'doc-new',
    })
    expect(mockArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        userId: 'user-1',
        journalEntryId: 'je-1',
        order: expect.objectContaining({ id: 'order-1' }),
      }),
    )
  })

  it('never files a second copy: an existing orderunderlag is reported', async () => {
    enqueue({ data: orderRow() })
    enqueue({ data: [{ id: 'doc-old' }] })
    const outcome = await ensureWebshopOrderUnderlag(supabase, 'company-1', 'user-1', 'order-1', log)
    expect(outcome).toEqual({
      ok: true,
      alreadyAttached: true,
      journalEntryId: 'je-1',
      documentId: 'doc-old',
    })
    expect(mockArchive).not.toHaveBeenCalled()
  })

  it('fails closed when the lookup errors instead of archiving blind', async () => {
    enqueue({ data: orderRow() })
    enqueue({ data: null, error: { message: 'db down' } })
    const outcome = await ensureWebshopOrderUnderlag(supabase, 'company-1', 'user-1', 'order-1', log)
    expect(outcome).toEqual({ ok: false, kind: 'failed', journalEntryId: 'je-1' })
    expect(mockArchive).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalled()
  })

  it('reports failed when the archive fails again', async () => {
    enqueue({ data: orderRow() })
    enqueue({ data: [] })
    mockArchive.mockResolvedValue({ ok: false, documentId: null })
    const outcome = await ensureWebshopOrderUnderlag(supabase, 'company-1', 'user-1', 'order-1', log)
    expect(outcome).toEqual({ ok: false, kind: 'failed', journalEntryId: 'je-1' })
  })
})
