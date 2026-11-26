/**
 * GET /api/arkiv/agreements for a company with many agreements.
 *
 * The list holds up to 500 agreements, and their counterparties, source
 * documents and obligations are read by id with `.in()`. supabase-js puts the
 * ids in the GET query string, so 500 uuids (about 19.5 KB) were refused by
 * the gateway and the page answered 500. The obligations were also read in
 * one unpaged request, cut at 1000 rows, so 100 agreements with 21 monthly
 * payments each lost their next payment. The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past a self-hosted Kong's 8 KB
 * and answers at most 1000 rows, as PostgREST does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseJsonResponse } from '@/tests/helpers'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf, type GatewayRequest } from '@/tests/gateway-supabase'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))
vi.mock('@/lib/arkiv/agreements/dates', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/arkiv/agreements/dates')>()), todayIso: () => '2026-09-15' }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const MONTHS = 21

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const pad = (n: number) => String(n).padStart(2, '0')
/** The day of the month agreement n is paid on. */
const payDay = (n: number) => 1 + (n % 28)

/**
 * `count` monthly agreements, `perParty` to a counterparty and two to a
 * source document, each with an obligation a month from July 2025 to March
 * 2027 (ids in reverse due order): matched before today and expected after
 * it. Every tenth agreement instead missed July and August 2026 and has
 * nothing ahead (waived).
 */
function book(count: number, perParty = 2) {
  const agreements = []
  const obligations = []
  const parties = new Map<string, { id: string; company_id: string; display_name: string }>()
  const documents = new Map<string, { id: string; company_id: string; file_name: string }>()
  for (let n = 1; n <= count; n++) {
    const party = Math.ceil(n / perParty)
    const document = Math.ceil(n / 2)
    parties.set(uuid(party, 'b0000000'), { id: uuid(party, 'b0000000'), company_id: COMPANY, display_name: `Hyresvärd ${party}` })
    documents.set(uuid(document, 'c0000000'), { id: uuid(document, 'c0000000'), company_id: COMPANY, file_name: `avtal-${document}.pdf` })
    agreements.push({
      id: uuid(n, 'a0000000'),
      company_id: COMPANY,
      kind: 'rental',
      title: `Avtal ${n}`,
      status: 'active',
      counterparty_party_id: uuid(party, 'b0000000'),
      counterparty_name: null,
      amount: '1000.00',
      currency: 'SEK',
      period: 'monthly',
      starts_on: '2026-01-01',
      // Distinct, so the list comes back in agreement order.
      ends_on: new Date(Date.UTC(2028, 0, n)).toISOString().slice(0, 10),
      source_document_id: uuid(document, 'c0000000'),
      sources: { monthly_rent: { page: 1 } },
    })
    for (let m = 0; m < MONTHS; m++) {
      const due = new Date(Date.UTC(2025, 6 + m, payDay(n))).toISOString().slice(0, 10)
      const past = due < '2026-09-15'
      const missed = due.startsWith('2026-07') || due.startsWith('2026-08')
      const status = n % 10 === 0 ? (past ? (missed ? 'missed' : 'matched') : 'waived') : past ? 'matched' : 'expected'
      obligations.push({ id: uuid(n * 100 + (MONTHS - m), 'd0000000'), company_id: COMPANY, agreement_id: uuid(n, 'a0000000'), due_on: due, amount: '1000.00', currency: 'SEK', status, kind: 'payment' })
    }
  }
  return { agreements, agreement_obligations: obligations, parties: [...parties.values()], document_attachments: [...documents.values()] }
}

/** What the page says of agreement n: its counterparty, its file, and its next payment. */
function expected(n: number, perParty = 2) {
  const day = payDay(n)
  const next =
    n % 10 === 0
      ? { due_on: `2026-08-${pad(day)}`, status: 'missed' }
      : { due_on: day >= 15 ? `2026-09-${pad(day)}` : `2026-10-${pad(day)}`, status: 'expected' }
  return {
    id: uuid(n, 'a0000000'),
    counterparty: { party_id: uuid(Math.ceil(n / perParty), 'b0000000'), name: `Hyresvärd ${Math.ceil(n / perParty)}` },
    source: { document_id: uuid(Math.ceil(n / 2), 'c0000000'), file_name: `avtal-${Math.ceil(n / 2)}.pdf`, page: 1 },
    next_payment: { ...next, amount: 1000, currency: 'SEK', kind: 'payment' },
  }
}

const call = () => GET(new Request('http://localhost/api/arkiv/agreements'), {} as never)
const signInWith = (supabase: SupabaseClient) =>
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase } as never)
const slicesOf = (requests: GatewayRequest[], table: string, column: string) => requests.filter((r) => r.table === table).map((r) => inListOf(r, column).length)
/** The size of each distinct id list sent to the table: a paged slice sends its list once per page. */
const distinctSlicesOf = (requests: GatewayRequest[], table: string, column: string) =>
  [...new Set(requests.filter((r) => r.table === table).map((r) => inListOf(r, column).join(',')))].map((list) => list.split(',').length)

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ARKIV_BRAIN_COMPANY_IDS = COMPANY
  vi.mocked(getActiveCompanyId).mockResolvedValue(COMPANY)
})

describe('GET /api/arkiv/agreements: many agreements', () => {
  it('lists 500 agreements with their counterparty, their file and their next payment, in requests the gateway takes', async () => {
    const { supabase, requests, unmodelled } = createGatewaySupabase(book(500))
    signInWith(supabase)

    const { status, body } = await parseJsonResponse(await call())

    expect(status).toBe(200)
    const items = (body as { data: Array<Record<string, unknown>> }).data
    expect(items).toHaveLength(500)
    items.forEach((item, i) => expect(item).toMatchObject(expected(i + 1)))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    // 250 counterparties and 250 files, 100 at a time; the obligations of 100 agreements, 2100 rows, paged.
    expect(slicesOf(requests, 'parties', 'id')).toEqual([100, 100, 50])
    expect(slicesOf(requests, 'document_attachments', 'id')).toEqual([100, 100, 50])
    expect(distinctSlicesOf(requests, 'agreement_obligations', 'agreement_id')).toEqual([100, 100, 100, 100, 100])
    expect(unmodelled).toEqual([])
  })
})

describe('GET /api/arkiv/agreements: the slice boundary', () => {
  it.each([
    [100, [100]],
    [101, [100, 1]],
  ])('lists %i agreements with their next payment, the obligations read in slices of %j', async (count, slices) => {
    const { supabase, requests, unmodelled } = createGatewaySupabase(book(count))
    signInWith(supabase)

    const { status, body } = await parseJsonResponse(await call())

    expect(status).toBe(200)
    const items = (body as { data: Array<Record<string, unknown>> }).data
    expect(items).toHaveLength(count)
    items.forEach((item, i) => expect(item).toMatchObject(expected(i + 1)))
    expect(distinctSlicesOf(requests, 'agreement_obligations', 'agreement_id')).toEqual(slices)
    expect(unmodelled).toEqual([])
  })

  it.each([
    ['obligations', 'agreement_obligations', 'agreement_id'],
    ['counterparties', 'parties', 'id'],
  ])('answers 500, not a partial list, when the last slice of the %s cannot be read', async (_, table, column) => {
    const { supabase } = createGatewaySupabase(book(101, 1), {
      refuse: (request) => request.table === table && inListOf(request, column).length === 1,
    })
    signInWith(supabase)

    expect((await parseJsonResponse(await call())).status).toBe(500)
  })
})
