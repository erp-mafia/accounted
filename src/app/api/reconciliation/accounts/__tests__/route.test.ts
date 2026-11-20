/**
 * Tests for the dashboard reconciliation routes (cookie session, withRouteContext):
 * GET /api/reconciliation/accounts, GET .../accounts/{accountKey},
 * GET .../accounts/{accountKey}/items, POST .../links, DELETE .../links/{linkId},
 * POST .../items/{itemId}/ignore. The service layer is mocked; the wrapper is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const listAccountsMock = vi.fn()
const statusMock = vi.fn()
const itemsMock = vi.fn()
const matchMock = vi.fn()
const unmatchMock = vi.fn()
const ignoreMock = vi.fn()
vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: (...args: unknown[]) => listAccountsMock(...args),
  getAccountStatus: (...args: unknown[]) => statusMock(...args),
}))
vi.mock('@/lib/reconciliation/items', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/items')>('@/lib/reconciliation/items')
  return { ...actual, listAccountItems: (...args: unknown[]) => itemsMock(...args) }
})
vi.mock('@/lib/reconciliation/actions', () => ({
  matchPairs: (...args: unknown[]) => matchMock(...args),
  unmatchLink: (...args: unknown[]) => unmatchMock(...args),
  setItemIgnored: (...args: unknown[]) => ignoreMock(...args),
}))

import { SkattekontoLinkError } from '@/lib/skatteverket/skattekonto-link'
import { GET as listGET } from '../route'
import { GET as statusGET } from '../[accountKey]/route'
import { GET as itemsGET } from '../[accountKey]/items/route'
import { POST as linksPOST } from '../[accountKey]/links/route'
import { DELETE as linkDELETE } from '../[accountKey]/links/[linkId]/route'
import { POST as ignorePOST } from '../[accountKey]/items/[itemId]/ignore/route'

const ROW = '22222222-2222-4222-8222-222222222222'
const ENTRY = '33333333-3333-4333-8333-333333333333'
const ENTRY_2 = '44444444-4444-4444-8444-444444444444'
const CASH = '55555555-5555-4555-8555-555555555555'
// Dynamic-route params for the handlers under test; `never` keeps each
// handler's own params type while letting one helper serve all of them.
const p = (obj: Record<string, string>) => ({ params: Promise.resolve(obj) }) as never

describe('dashboard reconciliation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    listAccountsMock.mockResolvedValue([{ account_key: 'skattekonto' }])
    statusMock.mockResolvedValue({ account_key: 'skattekonto', bridge: [] })
    itemsMock.mockResolvedValue({ items: [], count: 0, total_count: 0, has_more: false, older_unmatched_count: 0 })
    matchMock.mockResolvedValue({ dry_run: false, considered: 1, applied: [], skipped: [] })
    unmatchMock.mockResolvedValue({ external_id: ROW, previous_journal_entry_id: ENTRY })
    ignoreMock.mockResolvedValue({ external_id: ROW, is_ignored: true })
  })

  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await listGET(createMockRequest('/api/reconciliation/accounts'), { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
  })

  it('lists accounts, forwarding the window and with_status', async () => {
    const res = await listGET(
      createMockRequest('/api/reconciliation/accounts?date_from=2026-01-01&date_to=2026-08-20&with_status=false'),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { accounts: unknown[] } }>(res)
    expect(body.data.accounts).toHaveLength(1)
    expect(listAccountsMock).toHaveBeenCalledWith(supabase, 'company-1', {
      windowFrom: '2026-01-01',
      windowTo: '2026-08-20',
      withStatus: false,
    })
  })

  it('status: 404 on an invalid key, 404 when the service finds nothing, 200 otherwise', async () => {
    expect((await statusGET(createMockRequest('/api/reconciliation/accounts/1930'), p({ accountKey: '1930' }))).status).toBe(404)
    statusMock.mockResolvedValueOnce(null)
    expect((await statusGET(createMockRequest('/api/reconciliation/accounts/skattekonto'), p({ accountKey: 'skattekonto' }))).status).toBe(404)
    const res = await statusGET(createMockRequest('/api/reconciliation/accounts/skattekonto?date_from=2026-07-01'), p({ accountKey: 'skattekonto' }))
    expect(res.status).toBe(200)
    expect(statusMock).toHaveBeenLastCalledWith(supabase, 'company-1', 'skattekonto', { windowFrom: '2026-07-01', windowTo: null })
  })

  it('items: validates the bucket and forwards paging', async () => {
    expect((await itemsGET(createMockRequest('/api/reconciliation/accounts/skattekonto/items?bucket=x'), p({ accountKey: 'skattekonto' }))).status).toBe(400)
    const res = await itemsGET(createMockRequest('/api/reconciliation/accounts/skattekonto/items?bucket=proposed&limit=10&offset=20'), p({ accountKey: 'skattekonto' }))
    expect(res.status).toBe(200)
    expect(itemsMock).toHaveBeenCalledWith(supabase, 'company-1', 'skattekonto', expect.objectContaining({ bucket: 'proposed', limit: 10, offset: 20 }))
  })

  it('links: requires write, validates the body, forwards dry_run', async () => {
    requireWriteMock.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: 'Read only' }, { status: 403 }) })
    const forbidden = await linksPOST(
      createMockRequest('/api/reconciliation/accounts/skattekonto/links', { method: 'POST', body: { use_proposals: true } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(forbidden.status).toBe(403)

    const invalid = await linksPOST(
      createMockRequest('/api/reconciliation/accounts/skattekonto/links', { method: 'POST', body: { pairs: [] } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(invalid.status).toBe(400)

    const res = await linksPOST(
      createMockRequest('/api/reconciliation/accounts/skattekonto/links', {
        method: 'POST',
        body: { pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }], dry_run: true },
      }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(res.status).toBe(200)
    expect(matchMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'skattekonto',
      { pairs: [{ external_ids: [ROW], journal_entry_ids: [ENTRY] }] },
      { dryRun: true },
    )
  })

  it('links: forwards a bank 1:N pair with allocations, and rejects a one-element allocations array (#1553)', async () => {
    matchMock.mockResolvedValue({ dry_run: false, considered: 1, applied: [], skipped: [] })
    const pair = {
      external_ids: [ROW],
      journal_entry_ids: [ENTRY, ENTRY_2],
      allocations: [
        { journal_entry_id: ENTRY, amount: -500 },
        { journal_entry_id: ENTRY_2, amount: -300 },
      ],
    }
    const res = await linksPOST(
      createMockRequest(`/api/reconciliation/accounts/bank:${CASH}/links`, { method: 'POST', body: { pairs: [pair] } }),
      p({ accountKey: `bank:${CASH}` }),
    )
    expect(res.status).toBe(200)
    expect(matchMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', `bank:${CASH}`, { pairs: [pair] }, { dryRun: false })

    const invalid = await linksPOST(
      createMockRequest(`/api/reconciliation/accounts/bank:${CASH}/links`, {
        method: 'POST',
        body: { pairs: [{ ...pair, allocations: [{ journal_entry_id: ENTRY, amount: -800 }] }] },
      }),
      p({ accountKey: `bank:${CASH}` }),
    )
    expect(invalid.status).toBe(400)
  })

  it('links: forwards the page button\'s set_confidence_threshold and rejects one above 1 (crm#1668)', async () => {
    matchMock.mockResolvedValue({ dry_run: false, considered: 0, applied: [], skipped: [] })
    const res = await linksPOST(
      createMockRequest(`/api/reconciliation/accounts/bank:${CASH}/links`, {
        method: 'POST',
        body: { use_proposals: true, set_confidence_threshold: 0.9 },
      }),
      p({ accountKey: `bank:${CASH}` }),
    )
    expect(res.status).toBe(200)
    expect(matchMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      `bank:${CASH}`,
      { use_proposals: true, set_confidence_threshold: 0.9 },
      { dryRun: false },
    )

    const invalid = await linksPOST(
      createMockRequest(`/api/reconciliation/accounts/bank:${CASH}/links`, {
        method: 'POST',
        body: { use_proposals: true, set_confidence_threshold: 1.5 },
      }),
      p({ accountKey: `bank:${CASH}` }),
    )
    expect(invalid.status).toBe(400)
  })

  describe('links without an outside row: verifikat settled against each other (crm#1074)', () => {
    const SETTLEMENT_ID = '66666666-6666-4666-8666-666666666666'
    const settlement = {
      settlement_id: SETTLEMENT_ID,
      account_number: '1930',
      entries: [
        { journal_entry_id: ENTRY, voucher_series: 'A', voucher_number: 12, entry_date: '2026-03-18', amount: -1250 },
        { journal_entry_id: ENTRY_2, voucher_series: 'A', voucher_number: 31, entry_date: '2026-04-21', amount: 1250 },
      ],
    }
    const post = (body: unknown, accountKey = `bank:${CASH}`) =>
      linksPOST(
        createMockRequest(`/api/reconciliation/accounts/${accountKey}/links`, { method: 'POST', body }),
        p({ accountKey }),
      )

    it('401 when unauthenticated, 403 for a viewer', async () => {
      requireAuthMock.mockResolvedValue({
        user: null,
        supabase,
        error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      })
      expect((await post({ pairs: [{ journal_entry_ids: [ENTRY, ENTRY_2] }] })).status).toBe(401)
      expect(matchMock).not.toHaveBeenCalled()

      requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
      requireWriteMock.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: 'Read only' }, { status: 403 }) })
      expect((await post({ pairs: [{ journal_entry_ids: [ENTRY, ENTRY_2] }] })).status).toBe(403)
      expect(matchMock).not.toHaveBeenCalled()
    })

    it('400 for one verifikat with no outside row, with or without an empty external_ids', async () => {
      expect((await post({ pairs: [{ journal_entry_ids: [ENTRY] }] })).status).toBe(400)
      expect((await post({ pairs: [{ external_ids: [], journal_entry_ids: [ENTRY] }] })).status).toBe(400)
      expect((await post({ pairs: [{ external_ids: [], journal_entry_ids: [] }] })).status).toBe(400)
      expect(matchMock).not.toHaveBeenCalled()
    })

    it('404 for a malformed account key and for an account the company does not have', async () => {
      const malformed = await post({ pairs: [{ journal_entry_ids: [ENTRY, ENTRY_2] }] }, 'bank:nope')
      expect(malformed.status).toBe(404)
      expect(matchMock).not.toHaveBeenCalled()

      matchMock.mockResolvedValue(null)
      expect((await post({ pairs: [{ journal_entry_ids: [ENTRY, ENTRY_2] }] })).status).toBe(404)
    })

    it('forwards two verifikat with no outside row, external_ids defaulting to empty, and returns the settlement', async () => {
      matchMock.mockResolvedValue({ dry_run: false, considered: 1, applied: [], settled: [settlement], skipped: [] })
      const res = await post({ pairs: [{ journal_entry_ids: [ENTRY, ENTRY_2] }] })
      expect(res.status).toBe(200)
      expect(matchMock).toHaveBeenCalledWith(
        supabase,
        'company-1',
        'user-1',
        `bank:${CASH}`,
        { pairs: [{ external_ids: [], journal_entry_ids: [ENTRY, ENTRY_2] }] },
        { dryRun: false },
      )
      const { body } = await parseJsonResponse<{ data: { settled: unknown[]; applied: unknown[] } }>(res)
      expect(body.data.settled).toEqual([settlement])
      expect(body.data.applied).toEqual([])

      await post({ pairs: [{ external_ids: [], journal_entry_ids: [ENTRY, ENTRY_2] }], dry_run: true })
      expect(matchMock).toHaveBeenLastCalledWith(
        supabase,
        'company-1',
        'user-1',
        `bank:${CASH}`,
        { pairs: [{ external_ids: [], journal_entry_ids: [ENTRY, ENTRY_2] }] },
        { dryRun: true },
      )
    })

    it('DELETE with the settlement id undoes it: 200 with the verifikat, 404 for a non-uuid id or an unknown account', async () => {
      unmatchMock.mockResolvedValue({
        external_id: SETTLEMENT_ID,
        previous_journal_entry_id: null,
        settlement_id: SETTLEMENT_ID,
        journal_entry_ids: [ENTRY, ENTRY_2],
      })
      const del = (linkId: string) =>
        linkDELETE(
          createMockRequest(`/api/reconciliation/accounts/bank:${CASH}/links/${linkId}`, { method: 'DELETE' }),
          p({ accountKey: `bank:${CASH}`, linkId }),
        )
      const res = await del(SETTLEMENT_ID)
      expect(res.status).toBe(200)
      expect(unmatchMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', `bank:${CASH}`, SETTLEMENT_ID)
      const { body } = await parseJsonResponse<{ data: { settlement_id: string; journal_entry_ids: string[] } }>(res)
      expect(body.data).toMatchObject({ settlement_id: SETTLEMENT_ID, journal_entry_ids: [ENTRY, ENTRY_2] })

      expect((await del('not-a-uuid')).status).toBe(404)
      unmatchMock.mockResolvedValue(null)
      expect((await del(SETTLEMENT_ID)).status).toBe(404)
    })
  })

  it('unlink and ignore call the service with the ids', async () => {
    const del = await linkDELETE(createMockRequest(`/api/reconciliation/accounts/skattekonto/links/${ROW}`, { method: 'DELETE' }), p({ accountKey: 'skattekonto', linkId: ROW }))
    expect(del.status).toBe(200)
    expect(unmatchMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'skattekonto', ROW)

    const ign = await ignorePOST(createMockRequest(`/api/reconciliation/accounts/skattekonto/items/${ROW}/ignore`, { method: 'POST', body: { ignored: false } }), p({ accountKey: 'skattekonto', itemId: ROW }))
    expect(ign.status).toBe(200)
    expect(ignoreMock).toHaveBeenCalledWith(supabase, 'company-1', 'skattekonto', ROW, false, 'user-1')
  })

  it('Koppla bort on a bank row booked from itself answers its Swedish refusal, not 500 (PH 194)', async () => {
    const sv = 'Transaktionen är bokförd med verifikatet, inte bara kopplad till det, så kopplingen kan inte tas bort.'
    unmatchMock.mockRejectedValueOnce(new SkattekontoLinkError(sv, 'LINK_IS_BOOKING'))
    const res = await linkDELETE(
      createMockRequest(`/api/reconciliation/accounts/bank:${CASH}/links/${ROW}`, { method: 'DELETE' }),
      p({ accountKey: `bank:${CASH}`, linkId: ROW }),
    )
    expect(res.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: string; code: string }>(res)
    expect(body).toEqual({ error: sv, code: 'LINK_IS_BOOKING' })
  })
})
