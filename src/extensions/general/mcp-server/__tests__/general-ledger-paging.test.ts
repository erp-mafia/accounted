import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { roundOre } from '@/lib/money'
import type { GeneralLedgerAccount, GeneralLedgerReport } from '@/lib/reports/general-ledger'

/**
 * gnubok_get_general_ledger answers a large ledger in pages.
 *
 * The tool returned every line of the range in one answer, which the route
 * sends twice (pretty-printed in content[0].text and compact as
 * structuredContent). A busy company's year is tens of megabytes that way:
 * past the limit of a buffered function response on the hosted service, and
 * far past what any MCP host lets a model read.
 *
 * The change is additive, as for the register lists. Without limit or
 * offset, a ledger that fits one answer is answered whole, as before, now
 * with count, total_count and has_more; only a ledger too large for one
 * answer gets its first page. limit and offset page any ledger by line, in
 * the whole answer's order.
 */

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const PERIOD_ID = '22222222-2222-4222-8222-222222222222'
// The documented ceiling for a buffered (non-streamed) function response.
const BUFFERED_RESPONSE_LIMIT_BYTES = 4_500_000

const mocks = vi.hoisted(() => ({
  report: null as GeneralLedgerReport | null,
}))

vi.mock('@/lib/reports/general-ledger', () => ({
  generateGeneralLedger: vi.fn(async () => mocks.report),
}))
vi.mock('@/lib/reports/data-status', () => ({
  buildReportDataStatus: vi.fn(async () => ({ preliminary: false, caveats: [] })),
}))

const PERIOD_ROW = { id: PERIOD_ID, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }

function serviceClient() {
  const periods: Record<string, unknown> = {}
  Object.assign(periods, {
    select: () => periods,
    eq: () => periods,
    order: () => periods,
    limit: () => periods,
    single: async () => ({ data: PERIOD_ROW, error: null }),
    maybeSingle: async () => ({ data: PERIOD_ROW, error: null }),
  })
  const memberships: Record<string, unknown> = {}
  Object.assign(memberships, {
    select: () => memberships,
    eq: () => memberships,
    is: () => memberships,
    maybeSingle: async () => ({
      data: {
        company_id: COMPANY_ID,
        role: 'owner',
        companies: { archived_at: null, name: 'Huvudboken', company_settings: { company_name: 'Huvudboken' } },
      },
      error: null,
    }),
  })
  return {
    from: vi.fn((table: string) => {
      if (table === 'fiscal_periods') return periods
      if (table === 'company_members') return memberships
      throw new Error(`Unexpected table: ${table}`)
    }),
    // A report through the route holds the SIE period-read lease while it runs.
    rpc: vi.fn(async (name: string) => ({ data: name === 'acquire_sie_period_read' ? 'lease-1' : null, error: null })),
    auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: { email: 'a@b.se' } } }) } },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getUserCompanies: vi.fn().mockResolvedValue([
    { company_id: '11111111-1111-4111-8111-111111111111', companies: { id: '11111111-1111-4111-8111-111111111111', name: 'Huvudboken', archived_at: null } },
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
      scopes: ['companies:read', 'reports:read'],
      apiKeyId: 'key-1',
      apiKeyName: 'Test Key',
    }),
    createServiceClientNoCookies: vi.fn(() => serviceClient()),
  }
})

import { handleMcpRequest, MCP_ANSWER_BUDGET_BYTES, toolResultWireBytes, tools } from '../server'

const generalLedger = tools.find((t) => t.name === 'gnubok_get_general_ledger')!

const pad = (i: number, width: number) => String(i).padStart(width, '0')

/**
 * A ledger of `lineCount` lines over `accountCount` accounts, lines of a
 * realistic size (a verifikat text of a few dozen characters), plus the given
 * number of balance-only accounts (a balance carried in, no lines in the
 * range) before the first, between, and after the last account with lines.
 */
function ledger(lineCount: number, accountCount: number, balanceOnly = 0): GeneralLedgerReport {
  const accounts: GeneralLedgerAccount[] = []
  const balanceAccount = (n: number): GeneralLedgerAccount => ({
    account_number: String(1000 + n),
    account_name: `Saldokonto ${n}`,
    opening_balance: 1000 + n,
    lines: [],
    closing_balance: 1000 + n,
    total_debit: 0,
    total_credit: 0,
  })
  let placed = 0
  for (let b = 0; b < balanceOnly; b++) accounts.push(balanceAccount(b))
  for (let a = 0; a < accountCount; a++) {
    const share = Math.floor(lineCount / accountCount) + (a < lineCount % accountCount ? 1 : 0)
    let balance = 0
    const lines = Array.from({ length: share }, (_, k) => {
      const i = placed + k
      balance = roundOre(balance + 125.5)
      return {
        date: `2026-${pad(1 + (i % 12), 2)}-${pad(1 + (i % 28), 2)}`,
        voucher_series: 'A',
        voucher_number: i + 1,
        journal_entry_id: `3c4d5e6f-7a8b-4c9d-8e0f-${pad(i, 12)}`,
        description: `Kundinbetalning faktura ${pad(i, 7)} Exempelkund AB`,
        source_type: 'bank_transaction',
        debit: 125.5,
        credit: 0,
        balance,
      }
    })
    placed += share
    accounts.push({
      account_number: String(2000 + a * 10),
      account_name: `Konto ${a}`,
      opening_balance: 0,
      lines,
      closing_balance: balance,
      total_debit: roundOre(share * 125.5),
      total_credit: 0,
    })
    // Balance-only accounts between the first two accounts with lines.
    if (a === 0) {
      for (let b = 0; b < balanceOnly; b++) accounts.push({ ...balanceAccount(500 + b), account_number: String(2001 + b) })
    }
  }
  for (let b = 0; b < balanceOnly; b++) accounts.push({ ...balanceAccount(900 + b), account_number: String(9000 + b) })
  return { accounts, period: { start: '2026-01-01', end: '2026-12-31' } }
}

type LedgerAnswer = {
  accounts: Array<GeneralLedgerAccount & { line_count?: number }>
  count: number
  total_count: number
  has_more: boolean
  next_offset?: number
  period: { start: string; end: string }
  data_status: unknown
}

async function callTool(args: Record<string, unknown>): Promise<LedgerAnswer> {
  return (await generalLedger.execute({ period_id: PERIOD_ID, ...args }, COMPANY_ID, 'user-1', serviceClient() as never)) as LedgerAnswer
}

function toolCall(args: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/extensions/ext/mcp-server/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'gnubok_get_general_ledger', arguments: { period_id: PERIOD_ID, ...args } },
    }),
  })
}

async function routeAnswer(args: Record<string, unknown>) {
  const response = await handleMcpRequest(toolCall(args))
  const body = await response.text()
  const json = JSON.parse(body) as {
    result: { isError?: boolean; content: Array<{ text: string }>; structuredContent: LedgerAnswer }
  }
  return { bytes: Buffer.byteLength(body, 'utf8'), result: json.result }
}

/** Every page from offset 0, following next_offset. */
async function allPages(limit: number): Promise<LedgerAnswer[]> {
  const pages: LedgerAnswer[] = []
  let offset: number | undefined = 0
  while (offset !== undefined) {
    const page: LedgerAnswer = await callTool({ limit, offset })
    pages.push(page)
    offset = page.next_offset
  }
  return pages
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mocks.report = null
})

describe('gnubok_get_general_ledger: the whole ledger when it fits one answer', () => {
  it('answers every account and line as before, and says nothing more is left', async () => {
    mocks.report = ledger(2_000, 20, 2)

    const answer = await callTool({})

    expect(answer.accounts).toEqual(ledger(2_000, 20, 2).accounts)
    expect(answer.period).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(answer.data_status).toEqual({ preliminary: false, caveats: [] })
    expect(answer.count).toBe(2_000)
    expect(answer.total_count).toBe(2_000)
    expect(answer.has_more).toBe(false)
    expect(answer).not.toHaveProperty('next_offset')
  })

  it('answers an empty ledger whole', async () => {
    mocks.report = { accounts: [], period: { start: '2026-01-01', end: '2026-12-31' } }
    const answer = await callTool({})
    expect(answer.accounts).toEqual([])
    expect([answer.count, answer.total_count, answer.has_more]).toEqual([0, 0, false])
  })
})

describe('gnubok_get_general_ledger: limit and offset', () => {
  it('pages by line: together the pages give every account once and every line once, in order', async () => {
    mocks.report = ledger(1_234, 7, 2)
    const whole = ledger(1_234, 7, 2)

    const pages = await allPages(100)

    expect(pages.map((p) => p.count)).toEqual([...Array(12).fill(100), 34])
    expect(new Set(pages.map((p) => p.total_count))).toEqual(new Set([1_234]))
    expect(pages.map((p) => p.has_more)).toEqual([...Array(12).fill(true), false])
    expect(pages.slice(0, -1).map((p) => p.next_offset)).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1) * 100))

    // A balance-only account is on exactly one page; an account with lines
    // only on the pages that carry some of them.
    const appearances = new Map<string, number>()
    for (const page of pages) {
      for (const account of page.accounts) {
        appearances.set(account.account_number, (appearances.get(account.account_number) ?? 0) + 1)
        if (account.line_count! > 0) expect(account.lines.length, account.account_number).toBeGreaterThan(0)
      }
    }
    for (const account of whole.accounts.filter((a) => a.lines.length === 0)) {
      expect(appearances.get(account.account_number), account.account_number).toBe(1)
    }

    // Reassembled from the pages, the ledger is the whole answer.
    const seen = new Map<string, GeneralLedgerAccount & { line_count?: number }>()
    const order: string[] = []
    for (const page of pages) {
      for (const account of page.accounts) {
        const earlier = seen.get(account.account_number)
        if (earlier) {
          earlier.lines.push(...account.lines)
          continue
        }
        order.push(account.account_number)
        seen.set(account.account_number, { ...account, lines: [...account.lines] })
      }
    }
    expect(order).toEqual(whole.accounts.map((a) => a.account_number))
    for (const account of whole.accounts) {
      const { line_count: lineCount, ...rebuilt } = seen.get(account.account_number)!
      expect(rebuilt).toEqual(account)
      expect(lineCount).toBe(account.lines.length)
    }
  })

  it('puts a balance-only account on the page that holds the line after it, and trailing ones on the last page', async () => {
    mocks.report = ledger(250, 2, 1)
    // Accounts: 1000 (balance only), 2000 (125 lines), 2001 (balance only), 2010 (125 lines), 9000 (balance only).
    const first = await callTool({ limit: 100 })
    const second = await callTool({ limit: 100, offset: 100 })
    const last = await callTool({ limit: 100, offset: 200 })

    expect(first.accounts.map((a) => a.account_number)).toEqual(['1000', '2000'])
    expect(second.accounts.map((a) => a.account_number)).toEqual(['2000', '2001', '2010'])
    expect(last.accounts.map((a) => a.account_number)).toEqual(['2010', '9000'])
    expect(second.accounts[1]).toMatchObject({ lines: [], line_count: 0, opening_balance: 1500, closing_balance: 1500 })
  })

  it('keeps an account that ends exactly at a page end off the next page, and the balance-only account after it on the next', async () => {
    mocks.report = ledger(200, 2, 1)
    // Accounts: 1000 (balance only), 2000 (lines 0-99), 2001 (balance only), 2010 (lines 100-199), 9000 (balance only).
    const first = await callTool({ limit: 100 })
    const second = await callTool({ limit: 100, offset: 100 })

    expect(first.accounts.map((a) => a.account_number)).toEqual(['1000', '2000'])
    expect(first).toMatchObject({ count: 100, has_more: true, next_offset: 100 })
    expect(second.accounts.map((a) => a.account_number)).toEqual(['2001', '2010', '9000'])
    expect(second).toMatchObject({ count: 100, has_more: false })
    expect(second).not.toHaveProperty('next_offset')
  })

  it('keeps each account whole-range balances and totals on every page', async () => {
    mocks.report = ledger(300, 1)
    const page = await callTool({ limit: 50, offset: 120 })
    const account = ledger(300, 1).accounts[0]

    expect(page.accounts).toHaveLength(1)
    expect(page.accounts[0]).toMatchObject({
      account_number: account.account_number,
      opening_balance: account.opening_balance,
      closing_balance: account.closing_balance,
      total_debit: account.total_debit,
      total_credit: account.total_credit,
      line_count: 300,
    })
    expect(page.accounts[0].lines).toEqual(account.lines.slice(120, 170))
  })

  it('answers an offset past the end with an empty page and the true total', async () => {
    mocks.report = ledger(30, 3, 1)
    const answer = await callTool({ limit: 10, offset: 500 })
    expect(answer.accounts).toEqual([])
    expect(answer.count).toBe(0)
    expect(answer.total_count).toBe(30)
    expect(answer.has_more).toBe(false)
  })

  it('caps a page at 100 lines, under the size at which some MCP hosts cut a result', async () => {
    mocks.report = ledger(450, 3)
    const answer = await callTool({ limit: 10_000 })
    expect(answer.count).toBe(100)
    expect(answer.next_offset).toBe(100)
    expect(JSON.stringify(answer, null, 2).length).toBeLessThan(50_000)
  })
})

describe('gnubok_get_general_ledger: a ledger too large for one answer', () => {
  it('answers its first page and says how many lines there are and where the next page starts', async () => {
    mocks.report = ledger(30_000, 12)

    const answer = await callTool({})

    expect(answer.count).toBe(100)
    expect(answer.total_count).toBe(30_000)
    expect(answer.has_more).toBe(true)
    expect(answer.next_offset).toBe(100)
    expect(answer).toEqual(await callTool({ limit: 100 }))
  })

  it('answers the whole ledger on self-hosted Docker, which has no response size limit', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    try {
      mocks.report = ledger(30_000, 12)
      const answer = await callTool({})
      expect(answer.count).toBe(30_000)
      expect(answer.has_more).toBe(false)
      expect(answer.accounts).toEqual(ledger(30_000, 12).accounts)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('pages only past the size one answer can carry: the largest ledger that fits is answered whole', async () => {
    // What the tool answers for n lines when it answers them all.
    const wholeBytes = (n: number) =>
      toolResultWireBytes({
        ...ledger(n, 4),
        data_status: { preliminary: false, caveats: [] },
        count: n,
        total_count: n,
        has_more: false,
      })
    const perLine = wholeBytes(1_001) - wholeBytes(1_000)
    let fits = Math.floor(MCP_ANSWER_BUDGET_BYTES / perLine)
    while (wholeBytes(fits + 1) <= MCP_ANSWER_BUDGET_BYTES) fits += 1
    while (wholeBytes(fits) > MCP_ANSWER_BUDGET_BYTES) fits -= 1

    mocks.report = ledger(fits, 4)
    const largestWhole = await callTool({})
    expect(largestWhole.count).toBe(fits)
    expect(largestWhole.has_more).toBe(false)

    mocks.report = ledger(fits + 1, 4)
    const oneMore = await callTool({})
    expect(oneMore.count).toBe(100)
    expect(oneMore.total_count).toBe(fits + 1)
    expect(oneMore.has_more).toBe(true)
  }, 60_000)
})

describe('the answer through the MCP route (judge: response bytes against the platform limit)', () => {
  it('delivers a ledger of 100 000 lines within the limit, as a first page the model can read', async () => {
    mocks.report = ledger(100_000, 40)

    const { bytes, result } = await routeAnswer({})

    expect(result.isError).not.toBe(true)
    expect(bytes).toBeLessThan(BUFFERED_RESPONSE_LIMIT_BYTES)
    expect(result.structuredContent).toMatchObject({ count: 100, total_count: 100_000, has_more: true, next_offset: 100 })
    // The page is the ledger's first 100 lines, with their account as in the whole answer.
    const whole = ledger(100_000, 40)
    const [account] = result.structuredContent.accounts
    expect(result.structuredContent.accounts).toHaveLength(1)
    expect(account).toEqual({ ...whole.accounts[0], lines: whole.accounts[0].lines.slice(0, 100), line_count: 2_500 })
    // What the model reads says it too.
    expect(JSON.parse(result.content[0].text)).toMatchObject({ has_more: true, total_count: 100_000, next_offset: 100 })
  }, 60_000)

  it('takes limit and offset through the route and answers that page', async () => {
    mocks.report = ledger(1_000, 4)

    const { result } = await routeAnswer({ limit: 50, offset: 300 })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ count: 50, total_count: 1_000, has_more: true, next_offset: 350 })
    const lines = result.structuredContent.accounts.flatMap((a) => a.lines)
    expect(lines.map((l) => l.voucher_number)).toEqual(Array.from({ length: 50 }, (_, i) => 301 + i))
  }, 60_000)

  it('delivers a ledger that fits whole exactly as before: every line, nothing more to fetch', async () => {
    mocks.report = ledger(3_000, 10, 1)

    const { bytes, result } = await routeAnswer({})

    expect(result.isError).not.toBe(true)
    expect(bytes).toBeLessThan(BUFFERED_RESPONSE_LIMIT_BYTES)
    expect(result.structuredContent.accounts).toEqual(ledger(3_000, 10, 1).accounts)
    expect(result.structuredContent).toMatchObject({ count: 3_000, total_count: 3_000, has_more: false })
    // The size the tool decides on is the size the route sends, give or take the envelope.
    expect(Math.abs(bytes - toolResultWireBytes(result.structuredContent))).toBeLessThan(1_000)
  }, 60_000)
})
