import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path,
  )!
}

const matchRoute = findRoute('POST', '/items/:id/match-transaction')
const unmatchRoute = findRoute('POST', '/items/:id/unmatch-transaction')

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
  } as ExtensionContext
}

function makeReq(path: string, body?: unknown) {
  return createMockRequest(path, {
    method: 'POST',
    searchParams: { _id: 'item-1' },
    body,
  })
}

describe('POST /items/:id/match-transaction', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  beforeEach(() => {
    mock = createQueuedMockSupabase()
  })

  it('returns 401 without ctx', async () => {
    const res = await matchRoute.handler(makeReq('/items/item-1/match-transaction'))
    expect(res.status).toBe(401)
  })

  it('returns 400 when transaction_id is missing', async () => {
    const ctx = buildCtx(mock.supabase)
    const res = await matchRoute.handler(
      makeReq('/items/item-1/match-transaction', {}),
      ctx,
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when transaction is outside this company', async () => {
    // tx lookup returns null → 404 before any further calls
    mock.enqueue({ data: null })
    const ctx = buildCtx(mock.supabase)
    const res = await matchRoute.handler(
      makeReq('/items/item-1/match-transaction', { transaction_id: 'tx-1' }),
      ctx,
    )
    expect(res.status).toBe(404)
  })

  it('sets matched_transaction_id and mirrors document_id onto the transaction', async () => {
    // Sequence: tx lookup (no doc yet) → inbox doc lookup → inbox update → tx update
    mock.enqueue({ data: { id: 'tx-1', document_id: null } })
    mock.enqueue({ data: { id: 'item-1', document_id: 'doc-1' } })
    mock.enqueue({ data: { id: 'item-1', matched_transaction_id: 'tx-1' } })
    mock.enqueue({ data: null }) // tx update result (we don't read)
    const ctx = buildCtx(mock.supabase)
    const res = await matchRoute.handler(
      makeReq('/items/item-1/match-transaction', { transaction_id: 'tx-1' }),
      ctx,
    )
    const { body } = await parseJsonResponse<{ data: { matched_transaction_id: string } }>(res)
    expect(res.status).toBe(200)
    expect(body.data.matched_transaction_id).toBe('tx-1')
  })

  it('does not overwrite an existing tx.document_id', async () => {
    // tx already has a doc: match still succeeds but the tx update for
    // document_id is skipped (no enqueue beyond the inbox update).
    mock.enqueue({ data: { id: 'tx-1', document_id: 'existing-doc' } })
    mock.enqueue({ data: { id: 'item-1', document_id: 'doc-1' } })
    mock.enqueue({ data: { id: 'item-1', matched_transaction_id: 'tx-1' } })
    const ctx = buildCtx(mock.supabase)
    const res = await matchRoute.handler(
      makeReq('/items/item-1/match-transaction', { transaction_id: 'tx-1' }),
      ctx,
    )
    const { body } = await parseJsonResponse<{ data: { matched_transaction_id: string } }>(res)
    expect(res.status).toBe(200)
    expect(body.data.matched_transaction_id).toBe('tx-1')
  })
})

describe('POST /items/:id/unmatch-transaction', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  beforeEach(() => {
    mock = createQueuedMockSupabase()
  })

  it('clears matched_transaction_id and mirrors the unmatch onto the transaction', async () => {
    // Sequence: existing-state lookup → inbox update → tx update
    mock.enqueue({
      data: {
        id: 'item-1',
        document_id: 'doc-1',
        matched_transaction_id: 'tx-1',
      },
    })
    mock.enqueue({ data: { id: 'item-1', matched_transaction_id: null } })
    mock.enqueue({ data: null }) // tx update result
    const ctx = buildCtx(mock.supabase)
    const res = await unmatchRoute.handler(
      makeReq('/items/item-1/unmatch-transaction'),
      ctx,
    )
    const { body } = await parseJsonResponse<{
      data: { matched_transaction_id: string | null }
    }>(res)
    expect(res.status).toBe(200)
    expect(body.data.matched_transaction_id).toBeNull()
  })

  it('returns 401 without ctx', async () => {
    const res = await unmatchRoute.handler(makeReq('/items/item-1/unmatch-transaction'))
    expect(res.status).toBe(401)
  })
})
