import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const db = createQueuedMockSupabase()
const auth = vi.fn()
const reads = vi.hoisted(() => ({ chain: vi.fn(), references: vi.fn(), rattelse: vi.fn(), period: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => auth(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/core/bookkeeping/journal-entry-chain', () => ({ getJournalEntryChain: reads.chain }))
vi.mock('@/lib/core/bookkeeping/journal-entry-references', () => ({ getJournalEntryUnderlagReferences: reads.references }))
vi.mock('@/lib/core/bookkeeping/journal-entry-corrections', () => ({ getJournalEntryRattelseLog: reads.rattelse }))
vi.mock('@/lib/core/bookkeeping/period-service', () => ({ resolvePeriodStatusForDate: reads.period }))

import { GET } from '../route'

const id = '550e8400-e29b-41d4-a716-446655440000'
const entry = { id, entry_date: '2026-01-01', status: 'posted', lines: [{ account_number: '1930' }] }
const get = (entryId = id) => GET(createMockRequest(`/api/bookkeeping/journal-entries/${entryId}/detail`), createMockRouteParams({ id: entryId }))

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
  auth.mockResolvedValue({ user: { id: 'user-1' }, supabase: db.supabase })
  reads.chain.mockResolvedValue({ entry, chain: [], is_last_in_series: true })
  reads.references.mockResolvedValue([{ id: 'invoice-1', kind: 'customer_invoice' }])
  reads.rattelse.mockResolvedValue({ ok: true, data: [{ id: 'rattelse-1', actor_label: 'Owner' }] })
  reads.period.mockResolvedValue({ status: 'open' })
  db.enqueue({ data: [{ id: 'retag-1' }], error: null })
})

describe('journal entry detail read', () => {
  it('requires authentication', async () => {
    auth.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    expect(reads.chain).not.toHaveBeenCalled()
  })

  it('rejects malformed entry identifiers before database reads', async () => {
    const response = await get('invalid')
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.any(String), message_en: expect.any(String) })
    expect(reads.chain).not.toHaveBeenCalled()
  })

  it('returns 404 before reading metadata for a foreign or missing entry', async () => {
    reads.chain.mockResolvedValue(null)
    const response = await get()
    expect(response.status).toBe(404)
    expect((await response.json()).error).toMatchObject({ code: 'JOURNAL_ENTRY_NOT_FOUND', message: expect.any(String), message_en: expect.any(String) })
    expect(reads.references).not.toHaveBeenCalled()
    expect(reads.rattelse).not.toHaveBeenCalled()
    expect(reads.period).not.toHaveBeenCalled()
  })

  it('returns the existing company-scoped readers in one private response', async () => {
    const response = await get()
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)
    expect(status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(body.data).toMatchObject({ entry, references: [{ id: 'invoice-1' }], retag_log: [{ id: 'retag-1' }], rattelse_log: [{ id: 'rattelse-1' }], period_status: 'open' })
    expect(reads.chain).toHaveBeenCalledWith(db.supabase, 'company-1', id)
    expect(reads.references).toHaveBeenCalledWith(db.supabase, 'company-1', id)
    expect(reads.rattelse).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), id, expect.any(Function))
    expect(reads.period).toHaveBeenCalledWith(db.supabase, 'company-1', entry.entry_date)
    expect(db.supabase.from).toHaveBeenCalledWith('dimension_retag_log')
  })

  it('distinguishes a successful empty reference read from a failed read', async () => {
    reads.references.mockResolvedValue([])
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get())
    expect(body.data.references).toEqual([])
    reads.references.mockRejectedValue(new Error('unavailable'))
    db.enqueue({ data: [], error: null })
    const { status, body: failed } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get())
    expect(status).toBe(200)
    expect(failed.data.references).toBeNull()
    expect(failed.data.period_status).toBe('open')
  })

  it('keeps the voucher readable and period-sensitive actions closed when optional reads fail', async () => {
    reads.references.mockRejectedValue(new Error('unavailable'))
    reads.rattelse.mockResolvedValue({ ok: false, code: 'JOURNAL_RATTELSE_LOG_FAILED' })
    reads.period.mockRejectedValue(new Error('unavailable'))
    db.reset()
    db.enqueue({ data: null, error: { message: 'unavailable' } })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get())
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ entry, references: null, retag_log: [], rattelse_log: [], period_status: null })
  })
})
