import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { timeTrackingApiRoutes } from '../api-routes'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: vi.fn().mockResolvedValue({ ok: true }) }))

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const ENTRY_ID = '22222222-2222-4222-8222-222222222222'
const INVOICE_ID = '33333333-3333-4333-8333-333333333333'

function route(method: string, path: string) {
  const found = timeTrackingApiRoutes.find((r) => r.method === method && r.path === path)
  if (!found) throw new Error(`no route ${method} ${path}`)
  return found.handler
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let stored: Record<string, unknown>
let ctx: ExtensionContext

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  stored = {}
  ctx = {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'time-tracking',
    supabase: mock.supabase as unknown as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: {
      get: vi.fn(async (key?: string) => (stored[key ?? 'settings'] ?? null) as never),
      set: vi.fn(async (key: string, value: unknown) => {
        stored[key] = value
      }),
      clear: vi.fn(),
    },
    storage: { download: vi.fn(), upload: vi.fn(), getPublicUrl: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    services: {},
  } as unknown as ExtensionContext
})

const validEntry = { entry_date: '2026-06-15', consultant: 'gk', customer_id: CUSTOMER_ID, hours: 2.5 }

describe('auth', () => {
  it('answers 401 for every route without a company context', async () => {
    for (const r of timeTrackingApiRoutes) {
      const res = await r.handler(createMockRequest('/api/extensions/ext/time-tracking' + r.path, { method: r.method }), undefined)
      expect(res.status, `${r.method} ${r.path}`).toBe(401)
    }
  })
})

describe('POST /entries', () => {
  it('rejects invalid hours with 400', async () => {
    const res = await route('POST', '/entries')(
      createMockRequest('/x', { method: 'POST', body: { ...validEntry, hours: 30 } }),
      ctx,
    )
    expect(res.status).toBe(400)
  })

  it('rejects a customer from another company with 400', async () => {
    mock.enqueue({ data: null })
    const res = await route('POST', '/entries')(createMockRequest('/x', { method: 'POST', body: validEntry }), ctx)
    expect(res.status).toBe(400)
  })

  it('creates the entry scoped to the company with upper-cased initials', async () => {
    mock.enqueue({ data: null }) // settings: none yet
    mock.enqueue({ data: [{ id: CUSTOMER_ID, name: 'Galärbryggan', customer_number: null }] })
    mock.enqueue({
      data: [{ ...validEntry, id: ENTRY_ID, consultant: 'GK', hours: '2.50', customer_name: null, customers: { name: 'Galärbryggan' } }],
    })
    const res = await route('POST', '/entries')(createMockRequest('/x', { method: 'POST', body: validEntry }), ctx)
    const { status, body } = await parseJsonResponse<{ data: { hours: number; customer_name: string } }>(res)

    expect(status).toBe(201)
    expect(body.data).toMatchObject({ hours: 2.5, customer_name: 'Galärbryggan' })
    expect((mock.findCall('time_entries', 'insert')?.[0] as unknown[])[0]).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-1',
      consultant: 'GK',
      source: 'manual',
    })
  })

  it('takes project codes exactly: no near-miss match without an approver', async () => {
    mock.enqueue({ data: null })
    mock.enqueue({ data: [{ id: CUSTOMER_ID, name: 'Galärbryggan', customer_number: null }] })
    mock.enqueue({ data: [{ code: 'P12', name: 'Bokslut 2026' }] })
    const res = await route('POST', '/entries')(
      createMockRequest('/x', { method: 'POST', body: { ...validEntry, project_code: 'P1' } }),
      ctx,
    )
    expect(res.status).toBe(400)
    expect(mock.findCall('time_entries', 'insert')).toBeUndefined()
  })
})

describe('PATCH and DELETE /entries/:id', () => {
  it('answers 404 for an entry outside the company', async () => {
    mock.enqueue({ data: null })
    const res = await route('DELETE', '/entries/:id')(
      createMockRequest('/x', { method: 'DELETE', searchParams: { _id: ENTRY_ID } }),
      ctx,
    )
    expect(res.status).toBe(404)
  })

  it('refuses to change an invoiced entry with 409', async () => {
    mock.enqueue({ data: { id: ENTRY_ID, invoice_id: INVOICE_ID } })
    const res = await route('PATCH', '/entries/:id')(
      createMockRequest('/x', { method: 'PATCH', body: validEntry, searchParams: { _id: ENTRY_ID } }),
      ctx,
    )
    expect(res.status).toBe(409)
    expect(mock.findCall('time_entries', 'update')).toBeUndefined()
  })

  it('deletes an uninvoiced entry', async () => {
    mock.enqueue({ data: { ...validEntry, id: ENTRY_ID, invoice_id: null, customers: null } })
    mock.enqueue({ data: [{ id: ENTRY_ID }] })
    const res = await route('DELETE', '/entries/:id')(
      createMockRequest('/x', { method: 'DELETE', searchParams: { _id: ENTRY_ID } }),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(mock.findCalls('time_entries', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(mock.findCalls('time_entries', 'is')).toContainEqual(['invoice_id', null])
  })
})

describe('PUT /settings', () => {
  const base = { consultants: [{ code: 'AB', name: 'Anna' }, { code: 'GK', name: 'Gustav' }], activity_codes: [], customer_links: [], default_hourly_rate: null }

  it('links only the caller, via my_consultant, and keeps others\' links', async () => {
    stored.settings = { ...base, consultants: [{ code: 'AB', name: 'Anna', user_id: 'user-2' }, { code: 'GK', name: 'Gustav' }] }
    const res = await route('PUT', '/settings')(
      createMockRequest('/x', {
        method: 'PUT',
        // A client trying to move user-2's link is ignored; only my_consultant links, and only the caller.
        body: { ...base, consultants: [{ code: 'AB', name: 'Anna', user_id: 'user-1' }, { code: 'GK', name: 'Gustav' }], my_consultant: 'gk' },
      }),
      ctx,
    )
    const { status, body } = await parseJsonResponse<{ my_consultant: string | null }>(res)
    expect(status).toBe(200)
    expect(body.my_consultant).toBe('GK')
    expect((stored.settings as { consultants: unknown[] }).consultants).toEqual([
      { code: 'AB', name: 'Anna', user_id: 'user-2' },
      { code: 'GK', name: 'Gustav', user_id: 'user-1' },
    ])
  })

  it('refuses a my_consultant that is not registered', async () => {
    const res = await route('PUT', '/settings')(
      createMockRequest('/x', { method: 'PUT', body: { ...base, my_consultant: 'ZZ' } }),
      ctx,
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /entries/mark-invoiced', () => {
  it('answers 404 when the invoice is not the company’s', async () => {
    mock.enqueue({ data: null })
    const res = await route('POST', '/entries/mark-invoiced')(
      createMockRequest('/x', { method: 'POST', body: { entry_ids: [ENTRY_ID], invoice_id: INVOICE_ID } }),
      ctx,
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /entries/mark-invoiced-externally', () => {
  it('marks billable entries before the date that are on no Accounted invoice', async () => {
    mock.enqueue({ data: [{ id: ENTRY_ID }, { id: INVOICE_ID }] })
    const res = await route('POST', '/entries/mark-invoiced-externally')(
      createMockRequest('/x', { method: 'POST', body: { before: '2026-08-01' } }),
      ctx,
    )
    const { status, body } = await parseJsonResponse<{ data: { updated: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.updated).toBe(2)
    expect(mock.findCall('time_entries', 'update')).toEqual([{ invoiced_externally: true }])
    expect(mock.findCall('time_entries', 'lt')).toEqual(['entry_date', '2026-08-01'])
    expect(mock.findCalls('time_entries', 'is')).toContainEqual(['invoice_id', null])
    expect(mock.findCalls('time_entries', 'eq')).toEqual(
      expect.arrayContaining([['company_id', 'company-1'], ['is_billable', true], ['invoiced_externally', false]]),
    )
  })

  it('undoes the marking for the same range', async () => {
    mock.enqueue({ data: [] })
    await route('POST', '/entries/mark-invoiced-externally')(
      createMockRequest('/x', { method: 'POST', body: { before: '2026-08-01', invoiced_externally: false } }),
      ctx,
    )
    expect(mock.findCall('time_entries', 'update')).toEqual([{ invoiced_externally: false }])
    expect(mock.findCalls('time_entries', 'eq')).toContainEqual(['invoiced_externally', true])
  })

  it('rejects a missing date', async () => {
    const res = await route('POST', '/entries/mark-invoiced-externally')(createMockRequest('/x', { method: 'POST', body: {} }), ctx)
    expect(res.status).toBe(400)
  })
})

describe('import', () => {
  function workbookRequest(options?: unknown): Request {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Datum', 'Medarb', 'Kund', 'A-kod', 'Timmar', 'Kommentar'],
        ['2026-06-15', 'GK', 'GF', '1', 7.5, 'momsutredning'],
        ['2026-07-03', 'GK', 'AK', '1', 2.25, 'bokf'],
      ]),
      'Transaktioner',
    )
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Kundkod', 'Namn'], ['GF', 'Galärbryggan']]), 'Kunder')
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const form = new FormData()
    form.append('file', new File([bytes], 'Prored.xlsx'))
    if (options) form.append('options', JSON.stringify(options))
    return new Request('http://localhost/x', { method: 'POST', body: form })
  }

  it('rejects a request without a file with 400', async () => {
    const res = await route('POST', '/import/preview')(
      new Request('http://localhost/x', { method: 'POST', body: new FormData() }),
      ctx,
    )
    expect(res.status).toBe(400)
  })

  it('previews customers and suggests a link by name', async () => {
    mock.enqueue({ data: [{ id: CUSTOMER_ID, name: 'Galärbryggan' }] })
    const res = await route('POST', '/import/preview')(workbookRequest(), ctx)
    const { status, body } = await parseJsonResponse<{
      data: { row_count: number; customers: Array<{ code: string; suggested_customer_id: string | null }> }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.row_count).toBe(2)
    expect(body.data.customers).toEqual([
      expect.objectContaining({ code: 'AK', suggested_customer_id: null }),
      expect.objectContaining({ code: 'GF', suggested_customer_id: CUSTOMER_ID }),
    ])
  })

  it('upserts rows idempotently, applies links and from_date, and stores the registers', async () => {
    mock.enqueue({ data: [{ id: CUSTOMER_ID }] })
    mock.enqueue({ data: [{ id: 'new-1' }] })
    const res = await route('POST', '/import/commit')(
      workbookRequest({ from_date: '2026-06-01', links: [{ code: 'gf', customer_id: CUSTOMER_ID }] }),
      ctx,
    )
    const { status, body } = await parseJsonResponse<{ data: { considered: number; inserted: number } }>(res)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ considered: 2, inserted: 1, already_imported: 1 })
    const [rows, opts] = mock.findCall('time_entries', 'upsert') as [Array<Record<string, unknown>>, unknown]
    expect(opts).toEqual({ onConflict: 'company_id,import_key', ignoreDuplicates: true })
    expect(rows.find((r) => r.customer_code === 'GF')).toMatchObject({
      customer_id: CUSTOMER_ID,
      customer_name: 'Galärbryggan',
      company_id: 'company-1',
      source: 'import',
    })
    expect(rows.find((r) => r.customer_code === 'AK')?.customer_id).toBeNull()
    expect(stored.settings).toMatchObject({ customer_links: [{ code: 'GF', customer_id: CUSTOMER_ID }] })
  })

  it('drops a link to a customer of another company', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    await route('POST', '/import/commit')(workbookRequest({ links: [{ code: 'GF', customer_id: CUSTOMER_ID }] }), ctx)
    const [rows] = mock.findCall('time_entries', 'upsert') as [Array<Record<string, unknown>>]
    expect(rows.every((r) => r.customer_id === null)).toBe(true)
  })
})
