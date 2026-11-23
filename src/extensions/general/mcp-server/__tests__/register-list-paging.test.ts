import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'

/**
 * gnubok_list_customers and gnubok_list_articles answer in pages (crm#2151).
 *
 * Both returned the whole register in one buffered response. The route sends
 * a result twice (pretty-printed in content[0].text and compact as
 * structuredContent), and Vercel refuses a buffered function response over
 * 4.5 MB: the largest customer register in production (44 280 customers)
 * comes to about 34 MB, and four more registers pass the limit too.
 *
 * The change is additive. A call without limit or offset still gets the whole
 * register, in the same order, when it fits one answer; only a register too
 * large for one answer (a call that cannot succeed today) gets its first page,
 * with has_more, next_offset and total_count saying there is more. limit and
 * offset page any register in the same order.
 */

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
// Vercel's documented ceiling for a buffered (non-streamed) function response.
const VERCEL_RESPONSE_LIMIT_BYTES = 4_500_000

const mocks = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  masked: [] as Array<string | null | undefined>,
}))

/**
 * A PostgREST-shaped client over in-memory tables: every filter the two tools
 * use, and range() answering the slice, as fetchAllRows pages through it.
 */
function tableQuery(table: string) {
  const filters: Array<(row: Record<string, unknown>) => boolean> = []
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      if (column !== 'company_id') filters.push((row) => row[column] === value)
      return chain
    },
    is: (column: string, value: unknown) => {
      filters.push((row) => (row[column] ?? null) === value)
      return chain
    },
    or: (expression: string) => {
      // name.ilike.%x%,article_number.ilike.%x%
      const needle = /ilike\.%([^%]*)%/.exec(expression)?.[1]?.toLowerCase() ?? ''
      filters.push((row) =>
        [row.name, row.article_number].some((v) => String(v ?? '').toLowerCase().includes(needle)),
      )
      return chain
    },
    order: () => chain,
    range: async (from: number, to: number) => {
      const rows = (mocks.tables[table] ?? [])
        .filter((row) => filters.every((f) => f(row)))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      return { data: rows.slice(from, to + 1), error: null }
    },
  })
  return chain
}

function memberships() {
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: async () => ({
      data: {
        company_id: COMPANY_ID,
        role: 'owner',
        companies: { archived_at: null, name: 'Registret', company_settings: { company_name: 'Registret' } },
      },
      error: null,
    }),
  })
  return chain
}

function serviceClient() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'company_members') return memberships()
      if (table === 'customers' || table === 'articles') return tableQuery(table)
      throw new Error(`Unexpected table: ${table}`)
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: { email: 'a@b.se' } } }) } },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getUserCompanies: vi.fn().mockResolvedValue([
    { company_id: '11111111-1111-4111-8111-111111111111', companies: { id: '11111111-1111-4111-8111-111111111111', name: 'Registret', archived_at: null } },
  ]),
}))
vi.mock('@/lib/clients/fetch-client-overview', () => ({ getByraMembership: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'entitled', graceEndsAt: null }) }
})
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: ['companies:read', 'customers:read', 'articles:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
    }),
    createServiceClientNoCookies: vi.fn(() => serviceClient()),
  }
})
// Counts the personnummer each answer opens; the masking itself is real.
vi.mock('@/lib/customers/protect-personal-number', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/customers/protect-personal-number')>()
  return {
    ...actual,
    maskStoredCustomerPersonalNumber: (value: string | null | undefined) => {
      mocks.masked.push(value)
      return actual.maskStoredCustomerPersonalNumber(value)
    },
  }
})

import { handleMcpRequest, MCP_ANSWER_BUDGET_BYTES, toolResultWireBytes, tools } from '../server'

const listCustomers = tools.find((t) => t.name === 'gnubok_list_customers')!
const listArticles = tools.find((t) => t.name === 'gnubok_list_articles')!

const pad = (i: number, width: number) => String(i).padStart(width, '0')

/** A customer row of the size production's registers average (about 310 bytes compact). */
function customerRow(i: number): Record<string, unknown> {
  return {
    id: `0b6c1d2e-3f40-4a5b-8c6d-${pad(i, 12)}`,
    // Names run against the ids, so the answer's order proves the name sort.
    name: `Kund ${pad(99_999 - i, 5)} Aktiebolag`,
    customer_type: 'business',
    email: `faktura.${pad(i, 5)}@exempel.se`,
    org_number: `556${pad(i, 7)}`,
    vat_number: `SE556${pad(i, 7)}01`,
    personal_number: null,
    default_payment_terms: 30,
    city: 'Stockholm',
    country: 'SE',
    party_id: `1a2b3c4d-5e6f-4a5b-8c6d-${pad(i, 12)}`,
    archived_at: null,
  }
}

function articleRow(i: number): Record<string, unknown> {
  return {
    id: `2c3d4e5f-6a7b-4c8d-9e0f-${pad(i, 12)}`,
    article_number: `A${pad(i, 5)}`,
    name: `Artikel ${pad(99_999 - i, 5)} konsulttimme`,
    name_en: `Article ${pad(99_999 - i, 5)} consulting hour`,
    type: 'tjanst',
    unit: 'tim',
    price_excl_vat: 1250,
    vat_rate: 25,
    revenue_account: '3041',
    housework_type: null,
    active: true,
  }
}

type ListAnswer = {
  count: number
  total_count: number
  has_more: boolean
  next_offset?: number
} & Record<string, unknown>

async function callTool(tool: typeof listCustomers, args: Record<string, unknown>): Promise<ListAnswer> {
  return (await tool.execute(args, COMPANY_ID, 'user-1', serviceClient() as never)) as ListAnswer
}

const ids = (rows: unknown) => (rows as Array<{ id: string }>).map((r) => r.id)

function toolCall(name: string, args: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}

async function routeAnswer(name: string, args: Record<string, unknown>) {
  const response = await handleMcpRequest(toolCall(name, args))
  const body = await response.text()
  const json = JSON.parse(body) as {
    result: { isError?: boolean; content: Array<{ text: string }>; structuredContent: ListAnswer }
  }
  return { bytes: Buffer.byteLength(body, 'utf8'), result: json.result }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mocks.tables = {}
  mocks.masked = []
})

describe('gnubok_list_customers: the whole register when it fits one answer', () => {
  it('answers every customer, by name, as before, and says nothing more is left', async () => {
    mocks.tables.customers = Array.from({ length: 1_002 }, (_, i) => customerRow(i))

    const answer = await callTool(listCustomers, {})

    expect(answer.count).toBe(1_002)
    expect(answer.total_count).toBe(1_002)
    expect(answer.has_more).toBe(false)
    expect(answer).not.toHaveProperty('next_offset')
    const names = (answer.customers as Array<{ name: string }>).map((c) => c.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'sv')))
    expect(names[0]).toBe('Kund 98998 Aktiebolag')
  })
})

describe('gnubok_list_customers: limit and offset', () => {
  it('pages the register in the order of the whole answer: disjoint, complete, with next_offset', async () => {
    mocks.tables.customers = Array.from({ length: 250 }, (_, i) => customerRow(i))
    const whole = ids((await callTool(listCustomers, {})).customers)

    const first = await callTool(listCustomers, { limit: 100 })
    const second = await callTool(listCustomers, { limit: 100, offset: first.next_offset })
    const last = await callTool(listCustomers, { limit: 100, offset: second.next_offset })

    expect([first.count, second.count, last.count]).toEqual([100, 100, 50])
    expect([first.total_count, second.total_count, last.total_count]).toEqual([250, 250, 250])
    expect([first.has_more, second.has_more, last.has_more]).toEqual([true, true, false])
    expect([first.next_offset, second.next_offset]).toEqual([100, 200])
    expect(last).not.toHaveProperty('next_offset')
    expect([...ids(first.customers), ...ids(second.customers), ...ids(last.customers)]).toEqual(whole)
  })

  it('answers an offset past the end with an empty page and the true total', async () => {
    mocks.tables.customers = Array.from({ length: 30 }, (_, i) => customerRow(i))
    const answer = await callTool(listCustomers, { limit: 10, offset: 500 })
    expect(answer.customers).toEqual([])
    expect(answer.total_count).toBe(30)
    expect(answer.has_more).toBe(false)
  })

  it('caps a page at 100 rows, under the size at which some MCP hosts cut a result', async () => {
    mocks.tables.customers = Array.from({ length: 450 }, (_, i) => customerRow(i))
    const answer = await callTool(listCustomers, { limit: 10_000 })
    expect(answer.count).toBe(100)
    expect(answer.next_offset).toBe(100)
    expect(JSON.stringify(answer, null, 2).length).toBeLessThan(50_000)
  })

  it('opens only the personnummer of the customers it answers', async () => {
    const { encryptPersonnummer } = await import('@/lib/salary/personnummer')
    const sealed = encryptPersonnummer('199001019802')
    mocks.tables.customers = Array.from({ length: 300 }, (_, i) => ({
      ...customerRow(i),
      customer_type: 'individual',
      org_number: null,
      vat_number: null,
      personal_number: sealed,
    }))

    const answer = await callTool(listCustomers, { limit: 10 })

    expect(answer.count).toBe(10)
    expect(mocks.masked).toHaveLength(10)
    for (const customer of answer.customers as Array<Record<string, unknown>>) {
      expect(customer).not.toHaveProperty('personal_number')
      expect(customer.personal_number_masked).toBe('********-9802')
    }
  })
})

describe('gnubok_list_customers: a register too large for one answer', () => {
  it('answers its first page and says how many there are and where the next page starts', async () => {
    mocks.tables.customers = Array.from({ length: 8_000 }, (_, i) => customerRow(i))
    const answer = await callTool(listCustomers, {})

    expect(answer.count).toBe(100)
    expect(answer.total_count).toBe(8_000)
    expect(answer.has_more).toBe(true)
    expect(answer.next_offset).toBe(100)
    // The same cut as the paged calls: page 1, then where next_offset points.
    const first = await callTool(listCustomers, { limit: 100 })
    const next = await callTool(listCustomers, { offset: answer.next_offset })
    expect(ids(answer.customers)).toEqual(ids(first.customers))
    expect(ids(next.customers)).not.toContain(ids(answer.customers)[99])
    expect(next.next_offset).toBe(200)
  })

  it('answers the whole register on self-hosted Docker, which has no response size limit', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    try {
      mocks.tables.customers = Array.from({ length: 8_000 }, (_, i) => customerRow(i))
      const answer = await callTool(listCustomers, {})
      expect(answer.count).toBe(8_000)
      expect(answer.has_more).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('pages only past the size one answer can carry: the largest register that fits is answered whole', async () => {
    // What the tool answers for n customers when it answers them all.
    const wholeBytes = (n: number) => {
      const customers = Array.from({ length: n }, (_, i) => {
        const { personal_number: _sealed, ...row } = customerRow(i)
        return row
      })
      return toolResultWireBytes({ customers, count: n, total_count: n, has_more: false })
    }
    const perRow = wholeBytes(1_001) - wholeBytes(1_000)
    let fits = Math.floor(MCP_ANSWER_BUDGET_BYTES / perRow)
    while (wholeBytes(fits + 1) <= MCP_ANSWER_BUDGET_BYTES) fits += 1
    while (wholeBytes(fits) > MCP_ANSWER_BUDGET_BYTES) fits -= 1

    mocks.tables.customers = Array.from({ length: fits }, (_, i) => customerRow(i))
    const largestWhole = await callTool(listCustomers, {})
    expect(largestWhole.count).toBe(fits)
    expect(largestWhole.has_more).toBe(false)

    mocks.tables.customers = Array.from({ length: fits + 1 }, (_, i) => customerRow(i))
    const oneMore = await callTool(listCustomers, {})
    expect(oneMore.count).toBe(100)
    expect(oneMore.total_count).toBe(fits + 1)
    expect(oneMore.has_more).toBe(true)
  }, 60_000)
})

describe('gnubok_list_articles: same paging', () => {
  it('answers the whole register without limit when it fits, every page with limit and offset', async () => {
    mocks.tables.articles = Array.from({ length: 1_500 }, (_, i) => articleRow(i))

    const whole = await callTool(listArticles, {})
    expect(whole.count).toBe(1_500)
    expect(whole.total_count).toBe(1_500)
    expect(whole.has_more).toBe(false)

    const page = await callTool(listArticles, { limit: 50, offset: 100 })
    expect(page.count).toBe(50)
    expect(page.total_count).toBe(1_500)
    expect(page.next_offset).toBe(150)
    expect(ids(page.articles)).toEqual(ids(whole.articles).slice(100, 150))
  })

  it('keeps the query filter, and counts what it matches', async () => {
    mocks.tables.articles = Array.from({ length: 120 }, (_, i) => articleRow(i))
    const answer = await callTool(listArticles, { query: 'A0001', limit: 5 })
    // Article numbers A00010..A00019: 10 matches.
    expect(answer.total_count).toBe(10)
    expect(answer.count).toBe(5)
    expect(answer.has_more).toBe(true)
  })

  it('answers the first page of a catalogue too large for one answer', async () => {
    mocks.tables.articles = Array.from({ length: 12_000 }, (_, i) => articleRow(i))
    const answer = await callTool(listArticles, {})
    expect(answer.count).toBe(100)
    expect(answer.total_count).toBe(12_000)
    expect(answer.has_more).toBe(true)
  })
})

describe('the answer through the MCP route (judge: response bytes against the platform limit)', () => {
  it('delivers the largest production register (44 280 customers) within the limit, as a first page', async () => {
    mocks.tables.customers = Array.from({ length: 44_280 }, (_, i) => customerRow(i))

    const { bytes, result } = await routeAnswer('gnubok_list_customers', {})

    expect(result.isError).not.toBe(true)
    expect(bytes).toBeLessThan(VERCEL_RESPONSE_LIMIT_BYTES)
    expect(result.structuredContent.total_count).toBe(44_280)
    expect(result.structuredContent.has_more).toBe(true)
    expect(result.structuredContent.next_offset).toBe(100)
    // What the model reads says it too.
    expect(JSON.parse(result.content[0].text)).toMatchObject({ has_more: true, total_count: 44_280, next_offset: 100 })
  }, 60_000)

  it('delivers a register that fits whole exactly as before: every row, nothing more to fetch', async () => {
    mocks.tables.customers = Array.from({ length: 3_000 }, (_, i) => customerRow(i))

    const { bytes, result } = await routeAnswer('gnubok_list_customers', {})

    expect(result.isError).not.toBe(true)
    expect(bytes).toBeLessThan(VERCEL_RESPONSE_LIMIT_BYTES)
    expect(result.structuredContent.count).toBe(3_000)
    expect(result.structuredContent.has_more).toBe(false)
    // The size the tool decides on is the size the route sends, give or take
    // the JSON-RPC envelope.
    expect(Math.abs(bytes - toolResultWireBytes(result.structuredContent))).toBeLessThan(1_000)
  }, 60_000)

  it('delivers the largest production catalogue (8 341 articles) within the limit', async () => {
    mocks.tables.articles = Array.from({ length: 8_341 }, (_, i) => articleRow(i))

    const { bytes, result } = await routeAnswer('gnubok_list_articles', {})

    expect(result.isError).not.toBe(true)
    expect(bytes).toBeLessThan(VERCEL_RESPONSE_LIMIT_BYTES)
    expect(result.structuredContent.total_count).toBe(8_341)
  }, 60_000)
})
