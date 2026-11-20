/**
 * GET /items and GET /items/:id check the bank for items it was never
 * checked for (bank_match_checked_at null): the list after its answer, a
 * bounded batch; the detail at once, for the one item opened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const scheduled: Array<() => Promise<void> | void> = []
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (work: () => Promise<void> | void) => {
    scheduled.push(work)
  },
}))

const checkNeverChecked = vi.fn()
vi.mock('@/lib/operations/inbox-bank-match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operations/inbox-bank-match')>()),
  checkNeverCheckedInboxItems: (...a: unknown[]) => checkNeverChecked(...a),
  proposeBankMatchForInboxItem: vi.fn(),
}))

const resolveBooked = vi.fn()
vi.mock('@/lib/transactions/inbox-underlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/inbox-underlag')>()),
  resolveBookedJournalEntryIds: (...a: unknown[]) => resolveBooked(...a),
}))
vi.mock('@/lib/vendor-logos/read', () => ({ vendorLogoUrls: vi.fn().mockResolvedValue(new Map()) }))
vi.mock('@/lib/categories/inbox-purchase-category', () => ({
  resolveInboxPurchaseCategories: vi.fn().mockResolvedValue(new Map()),
  resolveInboxPurchaseCategoryChoices: vi.fn().mockResolvedValue({ proposal: null, alternatives: [] }),
}))

import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createMockRequest, createQueuedMockSupabase, makeInvoiceInboxItem, parseJsonResponse, testRoutes } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

function findRoute(method: string, path: string) {
  return testRoutes(invoiceInboxExtension).find((r) => r.method === method && r.path === path)!
}

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

/** An open item with a document, never checked unless the test says otherwise. */
const unchecked = (id: string, created_at: string, overrides: Record<string, unknown> = {}) => ({
  ...makeInvoiceInboxItem({ id, document_id: `doc-${id}`, created_at, extracted_data: { totals: { total: 83 } } as never }),
  bank_match_checked_at: null,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  scheduled.length = 0
  resolveBooked.mockResolvedValue(new Map())
  checkNeverChecked.mockResolvedValue([])
})

describe('GET /items: never-checked items', () => {
  const route = findRoute('GET', '/items')
  const req = () => createMockRequest('/items', { method: 'GET' })

  it('answers first, then checks the newest few after the answer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const rows = Array.from({ length: 8 }, (_, i) => unchecked(`i${i}`, `2026-09-0${i + 1}T00:00:00Z`))
    enqueue({ data: rows })
    const { status, body } = await parseJsonResponse<{ data: { items: unknown[] } }>(await route.handler(req(), buildCtx(supabase)))
    expect(status).toBe(200)
    expect(body.data.items).toHaveLength(8)
    // Not yet: the check runs after the answer.
    expect(checkNeverChecked).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    await scheduled[0]()
    expect(checkNeverChecked).toHaveBeenCalledWith(supabase, 'company-1', ['i7', 'i6', 'i5', 'i4', 'i3'], expect.anything())
  })

  it('schedules nothing when every item was checked, or a check landed just now', async () => {
    const checked = createQueuedMockSupabase()
    checked.enqueue({ data: [unchecked('a', '2026-09-01T00:00:00Z', { bank_match_checked_at: '2026-10-01T00:00:00Z' })] })
    await route.handler(req(), buildCtx(checked.supabase))
    expect(scheduled).toHaveLength(0)

    const recent = createQueuedMockSupabase()
    recent.enqueue({
      data: [
        unchecked('a', '2026-09-01T00:00:00Z'),
        unchecked('b', '2026-09-02T00:00:00Z', { bank_match_checked_at: new Date(Date.now() - 1_000).toISOString() }),
      ],
    })
    await route.handler(req(), buildCtx(recent.supabase))
    expect(scheduled).toHaveLength(0)
  })

  it('the backlog: items checked only under older rules are checked again, in the same batch', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const olderRules = { bank_match_checked_at: '2026-10-01T00:00:00Z', bank_match_source_key: 'v1:0000abcd' }
    const currentRules = { bank_match_checked_at: '2026-10-01T00:00:00Z', bank_match_source_key: 'v1:0000abcd-r2' }
    enqueue({ data: [unchecked('older', '2026-09-01T00:00:00Z', olderRules), unchecked('current', '2026-09-02T00:00:00Z', currentRules)] })
    await route.handler(req(), buildCtx(supabase))
    expect(scheduled).toHaveLength(1)
    await scheduled[0]()
    expect(checkNeverChecked).toHaveBeenCalledWith(supabase, 'company-1', ['older'], expect.anything())
  })

  it('reads bank_match_checked_at with the list', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [] })
    await route.handler(req(), buildCtx(supabase))
    expect(String(findCall('invoice_inbox_items', 'select')?.[0])).toContain('bank_match_checked_at')
  })
})

describe('GET /items/:id: a never-checked item', () => {
  const route = findRoute('GET', '/items/:id')
  const req = (id: string) => createMockRequest(`/items/${id}?_id=${id}`, { method: 'GET' })

  it('is checked before the bank match is read, and the fresh answer is what the read sees', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: unchecked('item-1', '2026-09-01T00:00:00Z') })
    // The fresh bank_match columns after the check: nothing found.
    enqueue({ data: { bank_match_transaction_id: null, bank_match_basis: null, bank_match_evidence_level: null, bank_match_checked_at: '2026-10-19T10:00:00Z', bank_match_source_key: 'v1:x' } })
    checkNeverChecked.mockResolvedValue(['item-1'])
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await route.handler(req('item-1'), buildCtx(supabase)))
    expect(status).toBe(200)
    expect(checkNeverChecked).toHaveBeenCalledWith(supabase, 'company-1', ['item-1'], expect.anything())
    expect(body.data).toMatchObject({ bank_match_checked_at: '2026-10-19T10:00:00Z', bank_match: null })
  })

  it('an item checked only under older rules is checked again when opened', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: unchecked('item-1', '2026-09-01T00:00:00Z', { bank_match_checked_at: '2026-10-01T00:00:00Z', bank_match_source_key: 'v1:0000abcd' }) })
    enqueue({ data: { bank_match_transaction_id: null, bank_match_basis: null, bank_match_evidence_level: null, bank_match_checked_at: '2026-10-19T10:00:00Z', bank_match_source_key: 'v1:0000abcd-r2' } })
    checkNeverChecked.mockResolvedValue(['item-1'])
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await route.handler(req('item-1'), buildCtx(supabase)))
    expect(status).toBe(200)
    expect(checkNeverChecked).toHaveBeenCalledWith(supabase, 'company-1', ['item-1'], expect.anything())
    expect(body.data).toMatchObject({ bank_match_source_key: 'v1:0000abcd-r2', bank_match: null })
  })

  it('checks nothing for an item checked before, or one that is not open', async () => {
    for (const row of [
      unchecked('item-1', '2026-09-01T00:00:00Z', { bank_match_checked_at: '2026-10-01T00:00:00Z' }),
      unchecked('item-1', '2026-09-01T00:00:00Z', { created_journal_entry_id: 'je-1' }),
      { ...makeInvoiceInboxItem({ id: 'item-1', document_id: 'doc-1' }) },
    ]) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: row })
      expect((await route.handler(req('item-1'), buildCtx(supabase))).status).toBe(200)
    }
    expect(checkNeverChecked).not.toHaveBeenCalled()
  })
})
