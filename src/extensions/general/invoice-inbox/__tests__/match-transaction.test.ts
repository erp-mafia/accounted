import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  testRoutes,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const fit = vi.hoisted(() => ({ gate: vi.fn(), check: vi.fn() }))
vi.mock('@/lib/documents/bank-match/fit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/bank-match/fit')>()),
  documentFitGate: fit.gate,
}))

function findRoute(method: string, path: string) {
  return testRoutes(invoiceInboxExtension).find(
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

// crm#1479: a file dropped on the wrong purchase in the Inkorg became
// underlag on that purchase's verifikat. The drop asks for the comparison
// (check_fit); the person's "attach anyway" sends mismatch_reason.
describe('POST /items/:id/match-transaction: the drop compares both sides', () => {
  const MISMATCH = {
    document_vendor: 'Synthetic AI Ltd',
    document_amount: 90,
    document_currency: 'EUR',
    document_amount_sek: 1029.6,
    transaction_text: 'PODCASTTOOL',
    transaction_amount: -202.78,
    transaction_currency: 'SEK',
  }
  let mock: ReturnType<typeof createQueuedMockSupabase>
  beforeEach(() => {
    mock = createQueuedMockSupabase()
    fit.gate.mockReset()
    fit.check.mockReset()
    fit.gate.mockReturnValue(fit.check)
  })

  it('refuses with 409 DOC_ROW_MISMATCH naming both sides, and writes nothing', async () => {
    fit.check.mockResolvedValue({
      code: 'DOC_ROW_MISMATCH',
      details: MISMATCH,
      messageSv: 'Underlaget verkar höra till ett annat köp: det är från Synthetic AI Ltd på 90,00 €',
    })
    mock.enqueue({ data: { id: 'tx-1', document_id: null, amount: -202.78, currency: 'SEK', description: 'PODCASTTOOL' } })
    mock.enqueue({ data: { id: 'item-1', document_id: 'doc-1', matched_transaction_id: null } })
    const ctx = buildCtx(mock.supabase)
    const res = await matchRoute.handler(
      makeReq('/items/item-1/match-transaction', { transaction_id: 'tx-1', check_fit: true }),
      ctx,
    )
    const { body } = await parseJsonResponse<{ error: { code: string; message: string; details: unknown } }>(res)
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('DOC_ROW_MISMATCH')
    expect(body.error.details).toEqual(MISMATCH)
    expect(body.error.message).toContain('Synthetic AI Ltd')
    expect(fit.gate).toHaveBeenCalledWith(mock.supabase, 'company-1', undefined)
    expect(fit.check).toHaveBeenCalledWith('doc-1', expect.objectContaining({ id: 'tx-1' }))
    expect(mock.supabase.from).not.toHaveBeenCalledWith('document_attachments')
  })

  it('links it when the person confirms', async () => {
    fit.check.mockResolvedValue(null)
    mock.enqueue({ data: { id: 'tx-1', document_id: null } })
    mock.enqueue({ data: { id: 'item-1', document_id: 'doc-1', matched_transaction_id: null } })
    mock.enqueue({ data: { id: 'item-1', matched_transaction_id: 'tx-1' } })
    mock.enqueue({ data: null })
    const ctx = buildCtx(mock.supabase)
    const res = await matchRoute.handler(
      makeReq('/items/item-1/match-transaction', { transaction_id: 'tx-1', check_fit: true, mismatch_reason: 'confirmed_in_app' }),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(fit.gate).toHaveBeenCalledWith(mock.supabase, 'company-1', 'confirmed_in_app')
  })

  it('does not compare for the pickers that show both sides (no check_fit)', async () => {
    mock.enqueue({ data: { id: 'tx-1', document_id: 'existing-doc' } })
    mock.enqueue({ data: { id: 'item-1', document_id: 'doc-1', matched_transaction_id: null } })
    mock.enqueue({ data: { id: 'item-1', matched_transaction_id: 'tx-1' } })
    const ctx = buildCtx(mock.supabase)
    const res = await matchRoute.handler(
      makeReq('/items/item-1/match-transaction', { transaction_id: 'tx-1' }),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(fit.gate).not.toHaveBeenCalled()
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

})
