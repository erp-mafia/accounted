/**
 * /api/transactions/previous-system (crm#1954): the count behind the
 * attention line on Transaktioner, and the mark that sets the ignore flag on
 * the bank rows the previous system already booked. The selection itself is
 * tested in lib/transactions/__tests__/previous-system-rows.test.ts; here the
 * door: auth, the role gate, the body, the stale cut-off and the answer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createRowsMockSupabase, parseJsonResponse, type TableMockResolver } from '@/tests/helpers'

const COMPANY = 'company-1'
const CUTOFF = '2026-09-30'

type Row = Record<string, unknown>
type Mock = ReturnType<typeof createRowsMockSupabase>

let db: Mock
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(db.supabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { GET, POST } from '../route'

function tx(id: string, date: string, extra: Row = {}): Row {
  return {
    id,
    company_id: COMPANY,
    date,
    is_business: null,
    is_ignored: false,
    journal_entry_id: null,
    invoice_id: null,
    supplier_invoice_id: null,
    document_id: null,
    receipt_id: null,
    potential_journal_entry_id: null,
    ...extra,
  }
}

/** The update on transactions: applies the chain's filters, writes the rows and answers their ids. */
function writeTo(rows: Row[]): TableMockResolver {
  return (chain) => {
    let out = rows
    for (const { method, args } of chain) {
      const [column, value] = args as [string, unknown]
      if (method === 'eq') out = out.filter((r) => r[column] === value)
      else if (method === 'in') out = out.filter((r) => (value as unknown[]).includes(r[column]))
      else if (method === 'is') out = out.filter((r) => (r[column] ?? null) === value)
      else if (method === 'lte') out = out.filter((r) => String(r[column]) <= String(value))
    }
    const update = chain.find((c) => c.method === 'update')
    if (!update) return { data: out, error: null }
    for (const r of out) Object.assign(r, update.args[0] as Row)
    return { data: out.map((r) => ({ id: r.id })), error: null }
  }
}

/**
 * A migrated company: the imported books end on CUTOFF. `open` is what
 * public.open_bank_rows holds; a booked or ignored row is simply not in it.
 */
function seed(open: Row[], { imported = true }: { imported?: boolean } = {}) {
  db = createRowsMockSupabase({
    sie_imports: imported ? [{ id: 'import-1', company_id: COMPANY, status: 'completed' }] : [],
    journal_entries: [
      { id: 'e-1', company_id: COMPANY, entry_date: CUTOFF, status: 'posted', source_type: 'import', description: 'Bankavgift' },
    ],
    open_bank_rows: open.map((r) => ({ ...r })),
  })
  db.setTable('transactions', writeTo(open))
  db.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 't@t.se' } }, error: null })
}

const post = (body?: unknown) =>
  POST(createMockRequest('/api/transactions/previous-system', { method: 'POST', body }), { params: Promise.resolve({}) })
const get = () => GET(createMockRequest('/api/transactions/previous-system'), { params: Promise.resolve({}) })

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
  seed([])
})

describe('GET /api/transactions/previous-system', () => {
  it('returns 401 when unauthenticated', async () => {
    db.supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const response = await get()
    expect(response.status).toBe(401)
  })

  it('answers no cut-off and no rows for a company without a completed SIE import', async () => {
    seed([tx('a1', '2026-06-01')], { imported: false })

    const { status, body } = await parseJsonResponse<{ data: unknown }>(await get())
    expect(status).toBe(200)
    expect(body.data).toEqual({ cutoff: null, count: 0, first_date: null, last_date: null })
    expect(db.tables()).not.toContain('open_bank_rows')
  })

  it('counts the open rows on or before the cut-off, not the later ones or the linked ones', async () => {
    seed([
      tx('a1', '2026-05-04'),
      tx('a2', CUTOFF),
      tx('b-after', '2026-10-01'),
      tx('b-invoice', '2026-06-06', { invoice_id: 'inv-1' }),
    ])

    const { status, body } = await parseJsonResponse<{ data: unknown }>(await get())
    expect(status).toBe(200)
    expect(body.data).toEqual({ cutoff: CUTOFF, count: 2, first_date: '2026-05-04', last_date: CUTOFF })
  })
})

describe('POST /api/transactions/previous-system', () => {
  it('returns 401 when unauthenticated', async () => {
    db.supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const response = await post({ cutoff: CUTOFF })
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer and reads nothing', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const response = await post({ cutoff: CUTOFF })
    expect(response.status).toBe(403)
    expect(db.tables()).not.toContain('open_bank_rows')
  })

  it.each([
    ['no body', undefined],
    ['no cut-off', {}],
    ['a cut-off that is not a date', { cutoff: '30 september' }],
  ])('returns 400 for %s and writes nothing', async (_label, body) => {
    seed([tx('a1', '2026-05-04')])
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(db.findCalls('transactions', 'update')).toEqual([])
  })

  it('returns 409 and writes nothing when the imported books now end another day', async () => {
    const rows = [tx('a1', '2026-05-04')]
    seed(rows)

    const { status, body } = await parseJsonResponse<{ error: { code: string; details: unknown } }>(
      await post({ cutoff: '2026-08-31' }),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
    expect(body.error.details).toEqual({ reason: 'cutoff_changed', cutoff: CUTOFF })
    expect(db.findCalls('transactions', 'update')).toEqual([])
  })

  it('returns 409 when the SIE import is gone', async () => {
    seed([tx('a1', '2026-05-04')], { imported: false })

    const { status, body } = await parseJsonResponse<{ error: { details: unknown } }>(await post({ cutoff: CUTOFF }))
    expect(status).toBe(409)
    expect(body.error.details).toEqual({ reason: 'no_import', cutoff: null })
  })

  it('marks the rows on or before the cut-off with the ignore flag and answers their ids', async () => {
    const rows = [tx('a1', '2026-05-04'), tx('a2', CUTOFF), tx('b-after', '2026-10-01')]
    seed(rows)

    const { status, body } = await parseJsonResponse<{ data: unknown }>(await post({ cutoff: CUTOFF }))
    expect(status).toBe(200)
    expect(body.data).toEqual({ cutoff: CUTOFF, transaction_ids: ['a1', 'a2'] })
    expect(rows.map((r) => [r.id, r.is_ignored])).toEqual([
      ['a1', true],
      ['a2', true],
      ['b-after', false],
    ])
  })
})
