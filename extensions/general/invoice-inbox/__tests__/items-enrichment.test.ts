/**
 * GET /items and GET /items/:id: the booked-transaction enrichment.
 *
 * matched_transaction_journal_entry_id names the verifikat that booked the
 * matched transaction; underlag_status (#1548) says whether THIS item's
 * document reached it. The UI reads an item as booked only when both agree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  makeInvoiceInboxItem,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const resolveBooked = vi.fn()
const resolveAnchoring = vi.fn()
vi.mock('@/lib/transactions/inbox-underlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/inbox-underlag')>()),
  resolveBookedJournalEntryIds: (...a: unknown[]) => resolveBooked(...a),
  resolveUnderlagAnchoring: (...a: unknown[]) => resolveAnchoring(...a),
}))

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find((r) => r.method === method && r.path === path)!
}

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

type EnrichedItem = {
  id: string
  matched_transaction_journal_entry_id: string | null
  underlag_status: 'anchored' | 'unlinked' | 'anchored_elsewhere' | null
}

const TX1 = 'tx-1'
const TX2 = 'tx-2'
const JE1 = 'je-1'
const JE2 = 'je-2'

function anchoring(entries: Record<string, 'anchored' | 'unlinked' | 'anchored_elsewhere'>) {
  return new Map(
    Object.entries(entries).map(([id, status]) => [id, { status, document_journal_entry_id: null }]),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveBooked.mockResolvedValue(new Map())
  resolveAnchoring.mockResolvedValue(new Map())
})

describe('GET /items', () => {
  const route = findRoute('GET', '/items')
  const req = () => createMockRequest('/items', { method: 'GET' })

  it('returns 401 without a context', async () => {
    expect((await route.handler(req())).status).toBe(401)
  })

  it('returns 500 when the list query fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    expect((await route.handler(req(), buildCtx(supabase))).status).toBe(500)
  })

  it('derives the verifikat and the per-item underlag status for matched, unstamped items', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        makeInvoiceInboxItem({ id: 'anchored', matched_transaction_id: TX1, document_id: 'doc-a' }),
        makeInvoiceInboxItem({ id: 'unlinked', matched_transaction_id: TX1, document_id: 'doc-b' }),
        makeInvoiceInboxItem({ id: 'elsewhere', matched_transaction_id: TX2, document_id: 'doc-c' }),
        makeInvoiceInboxItem({ id: 'unbooked', matched_transaction_id: 'tx-open', document_id: 'doc-d' }),
        makeInvoiceInboxItem({ id: 'stamped', matched_transaction_id: TX1, created_journal_entry_id: JE1 }),
        makeInvoiceInboxItem({ id: 'unmatched', document_id: 'doc-e' }),
      ],
    })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1], [TX2, JE2]]))
    resolveAnchoring.mockResolvedValue(
      anchoring({ anchored: 'anchored', unlinked: 'unlinked', elsewhere: 'anchored_elsewhere' }),
    )

    const { status, body } = await parseJsonResponse<{ data: { items: EnrichedItem[] } }>(
      await route.handler(req(), buildCtx(supabase)),
    )
    expect(status).toBe(200)
    const byId = Object.fromEntries(body.data.items.map((i) => [i.id, i]))

    expect(byId.anchored).toMatchObject({ matched_transaction_journal_entry_id: JE1, underlag_status: 'anchored' })
    expect(byId.unlinked).toMatchObject({ matched_transaction_journal_entry_id: JE1, underlag_status: 'unlinked' })
    expect(byId.elsewhere).toMatchObject({
      matched_transaction_journal_entry_id: JE2,
      underlag_status: 'anchored_elsewhere',
    })
    expect(byId.unbooked).toMatchObject({ matched_transaction_journal_entry_id: null, underlag_status: null })
    // A stamped item is booked by its own column; the derived fields say
    // nothing more about it (the verifikat id it carries here is the shared
    // per-transaction resolution, not a per-item claim).
    expect(byId.stamped.underlag_status).toBeNull()
    expect(byId.unmatched).toMatchObject({ matched_transaction_journal_entry_id: null, underlag_status: null })

    // Only the unstamped matched transactions are resolved, once, and only
    // the items on booked ones go to the anchoring read.
    expect(resolveBooked).toHaveBeenCalledTimes(1)
    expect(resolveBooked).toHaveBeenCalledWith(expect.anything(), 'company-1', [TX1, TX2, 'tx-open'])
    expect(resolveAnchoring).toHaveBeenCalledWith(expect.anything(), 'company-1', [
      { id: 'anchored', document_id: 'doc-a', journalEntryId: JE1 },
      { id: 'unlinked', document_id: 'doc-b', journalEntryId: JE1 },
      { id: 'elsewhere', document_id: 'doc-c', journalEntryId: JE2 },
    ])
  })

  it('reports null underlag_status when the anchoring read could not classify the item', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [makeInvoiceInboxItem({ id: 'i1', matched_transaction_id: TX1, document_id: 'doc-a' })] })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    resolveAnchoring.mockResolvedValue(new Map())

    const { body } = await parseJsonResponse<{ data: { items: EnrichedItem[] } }>(
      await route.handler(req(), buildCtx(supabase)),
    )
    expect(body.data.items[0]).toMatchObject({ matched_transaction_journal_entry_id: JE1, underlag_status: null })
  })
})

describe('GET /items/:id', () => {
  const route = findRoute('GET', '/items/:id')
  const req = (id?: string) => createMockRequest(id ? `/items/${id}?_id=${id}` : '/items/x', { method: 'GET' })

  it('returns 401 without a context', async () => {
    expect((await route.handler(req('i1'))).status).toBe(401)
  })

  it('returns 400 without an id', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect((await route.handler(req(), buildCtx(supabase))).status).toBe(400)
  })

  it('returns 404 when the item does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect((await route.handler(req('missing'), buildCtx(supabase))).status).toBe(404)
  })

  it('derives the verifikat and underlag status for a matched, unstamped item', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'i1', matched_transaction_id: TX1, document_id: 'doc-a' }) })
    resolveBooked.mockResolvedValue(new Map([[TX1, JE1]]))
    resolveAnchoring.mockResolvedValue(anchoring({ i1: 'anchored_elsewhere' }))

    const { status, body } = await parseJsonResponse<{ data: EnrichedItem }>(
      await route.handler(req('i1'), buildCtx(supabase)),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      id: 'i1',
      matched_transaction_journal_entry_id: JE1,
      underlag_status: 'anchored_elsewhere',
    })
    expect(resolveAnchoring).toHaveBeenCalledWith(expect.anything(), 'company-1', [
      { id: 'i1', document_id: 'doc-a', journalEntryId: JE1 },
    ])
  })

  it('skips both lookups for a stamped item and reports null', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({ id: 'i1', matched_transaction_id: TX1, created_journal_entry_id: JE1 }),
    })

    const { body } = await parseJsonResponse<{ data: EnrichedItem }>(
      await route.handler(req('i1'), buildCtx(supabase)),
    )
    expect(body.data).toMatchObject({ matched_transaction_journal_entry_id: null, underlag_status: null })
    expect(resolveBooked).not.toHaveBeenCalled()
    expect(resolveAnchoring).not.toHaveBeenCalled()
  })

  it('reports null underlag status when the matched transaction is not booked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ id: 'i1', matched_transaction_id: 'tx-open', document_id: 'doc-a' }) })
    resolveBooked.mockResolvedValue(new Map())

    const { body } = await parseJsonResponse<{ data: EnrichedItem }>(
      await route.handler(req('i1'), buildCtx(supabase)),
    )
    expect(body.data).toMatchObject({ matched_transaction_journal_entry_id: null, underlag_status: null })
    expect(resolveAnchoring).not.toHaveBeenCalled()
  })
})
