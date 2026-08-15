import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createMockRouteParams } from '@/tests/helpers'

/**
 * Undo for a bank row anchored through transaction_voucher_links.
 *
 * The distinction that matters here is legal, not cosmetic: a row coupled to
 * verifikat the user booked separately must be UNLINKED, never storno-reversed.
 * Reversing would cancel bookkeeping that is entirely correct and still owed by
 * the underlying affärshändelse. The scalar path keeps storno because there the
 * entry exists only because this transaction was categorized.
 */

const rows: Record<string, { data: unknown; error: unknown }> = {}
const deleted: string[] = []
const updates: Record<string, unknown>[] = []

function makeBuilder(table: string) {
  const chain: Record<string, unknown> = {}
  const self = () => chain as never
  for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'limit']) {
    chain[m] = vi.fn(self)
  }
  chain.delete = vi.fn(() => {
    deleted.push(table)
    return chain as never
  })
  chain.update = vi.fn((payload: Record<string, unknown>) => {
    updates.push({ table, ...payload })
    return chain as never
  })
  chain.single = vi.fn(async () => rows[table] ?? { data: null, error: { message: 'not found' } })
  chain.maybeSingle = chain.single
  // Awaiting the builder itself (the list reads) resolves to the queued row.
  chain.then = (resolve: (v: unknown) => void) =>
    resolve(rows[table] ?? { data: [], error: null })
  return chain
}

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn((table: string) => makeBuilder(table)),
  rpc: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/sandbox/guard', () => ({ guardSandbox: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', () => ({ reverseEntry: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn().mockResolvedValue(undefined),
}))

import { NextResponse } from 'next/server'
import { POST } from '../route'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { logMatchEvent } from '@/lib/invoices/match-log'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function req() {
  return new Request('http://localhost/api/transactions/tx-1/uncategorize', { method: 'POST' })
}

describe('POST /api/transactions/[id]/uncategorize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(rows)) delete rows[k]
    deleted.length = 0
    updates.length = 0
    // clearAllMocks resets calls but NOT implementations, so a test that swaps
    // `from` for a failure builder would otherwise leak into the next one.
    mockSupabase.from.mockImplementation((table: string) => makeBuilder(table))
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await parseJsonResponse(
      await POST(req(), createMockRouteParams({ id: 'tx-1' })),
    )
    expect(status).toBe(401)
  })

  it('returns 404 when the transaction is not found', async () => {
    rows.transactions = { data: null, error: { message: 'not found' } }

    const { status } = await parseJsonResponse(
      await POST(req(), createMockRouteParams({ id: 'tx-1' })),
    )
    expect(status).toBe(404)
  })

  it('returns 400 when the row is anchored by neither the scalar nor a link', async () => {
    rows.transactions = { data: { id: 'tx-1', journal_entry_id: null }, error: null }
    rows.transaction_voucher_links = { data: [], error: null }

    const { status, body } = await parseJsonResponse(
      await POST(req(), createMockRouteParams({ id: 'tx-1' })),
    )
    expect(status).toBe(400)
    expect((body as { error: string }).error).toContain('no journal entry')
  })

  it('unlinks a split row WITHOUT storno', async () => {
    rows.transactions = { data: { id: 'tx-1', journal_entry_id: null }, error: null }
    rows.transaction_voucher_links = {
      data: [{ journal_entry_id: 'je-a' }, { journal_entry_id: 'je-b' }],
      error: null,
    }

    const { status, body } = await parseJsonResponse(
      await POST(req(), createMockRouteParams({ id: 'tx-1' })),
    )

    expect(status).toBe(200)
    expect(body).toMatchObject({ success: true, unlinked_count: 2, reversed: false })
    // The heart of this route: those verifikat are the user's own correct
    // bookkeeping and must survive the undo untouched.
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(deleted).toContain('transaction_voucher_links')
  })

  it('records which verifikat a split row was detached from', async () => {
    rows.transactions = { data: { id: 'tx-1', journal_entry_id: null }, error: null }
    rows.transaction_voucher_links = {
      data: [{ journal_entry_id: 'je-a' }, { journal_entry_id: 'je-b' }],
      error: null,
    }

    await POST(req(), createMockRouteParams({ id: 'tx-1' }))

    // With the links deleted there is no other record of the coupling.
    expect(logMatchEvent).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      'tx-1',
      'unmatched',
      expect.objectContaining({
        previousState: expect.objectContaining({
          unlinked_journal_entry_ids: ['je-a', 'je-b'],
        }),
      }),
    )
  })

  it('does not clear the scalar when link deletion failed', async () => {
    rows.transactions = { data: { id: 'tx-1', journal_entry_id: null }, error: null }
    rows.transaction_voucher_links = {
      data: [{ journal_entry_id: 'je-a' }],
      error: null,
    }
    // Make the delete path report failure by swapping the builder for this table.
    mockSupabase.from.mockImplementation((table: string) => {
      const b = makeBuilder(table)
      if (table === 'transaction_voucher_links') {
        b.delete = vi.fn(() => {
          const err = makeBuilder(table)
          err.then = (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: { message: 'delete failed' } })
          return err as never
        })
      }
      return b
    })

    const { status } = await parseJsonResponse(
      await POST(req(), createMockRouteParams({ id: 'tx-1' })),
    )

    expect(status).toBe(500)
    expect(updates.some((u) => u.table === 'transactions')).toBe(false)
  })

  it('still storno-reverses a row booked through categorization', async () => {
    rows.transactions = { data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null }
    rows.transaction_voucher_links = { data: [], error: null }
    rows.journal_entries = { data: { id: 'je-1', status: 'posted' }, error: null }

    const { status, body } = await parseJsonResponse(
      await POST(req(), createMockRouteParams({ id: 'tx-1' })),
    )

    expect(status).toBe(200)
    expect(body).toMatchObject({ success: true, reversed: true })
    expect(reverseEntry).toHaveBeenCalledWith(mockSupabase, 'company-1', 'user-1', 'je-1')
  })

  it('also clears the mirror link row on a single-link coupling', async () => {
    // The single-link case keeps the scalar and the link in sync, so leaving
    // the link behind would keep the row reading as booked through the
    // junction after its entry was reversed.
    rows.transactions = { data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null }
    rows.transaction_voucher_links = { data: [{ journal_entry_id: 'je-1' }], error: null }
    rows.journal_entries = { data: { id: 'je-1', status: 'posted' }, error: null }

    const { status } = await parseJsonResponse(
      await POST(req(), createMockRouteParams({ id: 'tx-1' })),
    )

    expect(status).toBe(200)
    expect(reverseEntry).toHaveBeenCalled()
    expect(deleted).toContain('transaction_voucher_links')
  })

  it('returns 400 when the scalar entry is not posted', async () => {
    rows.transactions = { data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null }
    rows.transaction_voucher_links = { data: [], error: null }
    rows.journal_entries = { data: { id: 'je-1', status: 'draft' }, error: null }

    const { status } = await parseJsonResponse(
      await POST(req(), createMockRouteParams({ id: 'tx-1' })),
    )

    expect(status).toBe(400)
    expect(reverseEntry).not.toHaveBeenCalled()
  })
})
