import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createJournalEntry: vi.fn(),
  checkRateLimit: vi.fn(),
  ensureSandboxAgentProfile: vi.fn(),
  markEntriesNoDocRequired: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: mocks.requireAuth }))
vi.mock('@/lib/bookkeeping/engine', () => ({ createJournalEntry: mocks.createJournalEntry }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: mocks.checkRateLimit }))
vi.mock('@/lib/sandbox/ensure-agent', () => ({
  ensureSandboxAgentProfile: mocks.ensureSandboxAgentProfile,
}))
vi.mock('@/lib/bookkeeping/no-doc-required', () => ({
  markEntriesNoDocRequired: mocks.markEntriesNoDocRequired,
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/lib/bookkeeping/bas-reference', () => ({
  getBASReference: (accountNumber: string) => ({
    account_name: `Account ${accountNumber}`,
    account_class: Number(accountNumber[0]),
    account_group: accountNumber.slice(0, 2),
    account_type: 'asset',
    normal_balance: 'debit',
    sru_code: null,
    k2_excluded: false,
  }),
}))
vi.mock('@/lib/salary/personnummer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/personnummer')>()),
  encryptPersonnummer: (value: string) => `encrypted:${value}`,
  decryptPersonnummer: (value: string) => value.replace(/^encrypted:/, ''),
}))
// The year's payroll figures and tax table the seed hands the salary engine.
vi.mock('@/lib/salary/payroll-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payroll-config')>()),
  loadPayrollConfig: async (_db: unknown, year: number) => ({
    configYear: year,
    avgifterTotal: 0.3142,
    avgifterReduced65plus: 0.1021,
    avgifterYouthRate: 0.2081,
    avgifterYouthSalaryCap: 25000,
    avgifterVaxaStodRate: 0.1021,
    avgifterVaxaStodCap: 35000,
    reducedAvgiftAge: 67,
    slpRate: 0.2426,
    sjuklonRate: 0.8,
    karensavdragFactor: 0.2,
  }),
}))
vi.mock('@/lib/salary/tax-tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/tax-tables')>()),
  fetchTaxTableRates: async (year: number, tableNumber: number, column: number) => ({
    rates: [{
      tableYear: year, tableNumber, columnNumber: column,
      incomeFrom: 0, incomeTo: 9999999, kind: 'amount', taxAmount: 5000,
    }],
    source: 'fallback',
  }),
}))
vi.mock('../customers', () => ({
  buildSandboxCustomers: () => [
    { name: 'Björk & Partner AB' },
    { name: 'Schmidt GmbH' },
    { name: 'Anna Lindström' },
  ],
}))
vi.mock('../pending-operations', () => ({ buildSandboxPendingOperations: () => [] }))
vi.mock('../articles', () => ({ buildSandboxArticles: () => [] }))
import { POST } from '../route'

interface MockSupabaseResult {
  supabase: ReturnType<typeof makeClient>
  deadlineInserts: unknown[][]
}

function makeClient() {
  let rowId = 0
  let attempt = 0
  let state = 'new'
  const deadlineInserts: unknown[][] = []
  const tableInserts: Array<{ table: string; payload: unknown }> = []

  const from = vi.fn((table: string) => {
    if (table === 'journal_entries' || table === 'journal_entry_lines') throw new Error('Seed must use the engine')
    let insertPayload: unknown = undefined
    const chain: Record<string, unknown> = {}

    const insertedRows = () => {
      if (insertPayload === undefined) return []
      const rows = Array.isArray(insertPayload) ? insertPayload : [insertPayload]
      return rows.map(row => ({
        ...(row as Record<string, unknown>),
        id: `${table}-${++rowId}`,
      }))
    }

    chain.insert = (payload: unknown) => {
      insertPayload = payload
      tableInserts.push({ table, payload })
      if (table === 'deadlines') deadlineInserts.push(payload as unknown[])
      return chain
    }
    chain.update = () => chain
    chain.select = () => chain
    for (const method of ['eq', 'in', 'is', 'order', 'limit', 'gte', 'lte', 'not', 'or']) {
      chain[method] = () => chain
    }
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.single = async () => ({ data: insertedRows()[0] ?? { id: `${table}-${++rowId}` }, error: null })
    chain.then = (resolve: (value: unknown) => void) => resolve({
      data: insertedRows(),
      error: null,
    })

    return chain
  })

  const supabase = {
    from,
    rpc: vi.fn(async (fn: string, args?: { p_success?: boolean }) => {
      if (fn === 'claim_sandbox_seed') {
        if (state === 'running') return { data: { status: 'busy' }, error: null }
        if (state !== 'complete') { attempt++; state = 'running' }
        return { data: { status: state, company_id: `company-${attempt}`, attempt_id: `attempt-${attempt}` }, error: null }
      }
      if (fn === 'finish_sandbox_seed') {
        state = args?.p_success ? 'complete' : 'failed'
        return { data: true, error: null }
      }
      return { data: null, error: null }
    }),
  }

  return Object.assign(supabase, { deadlineInserts, tableInserts })
}

function createMockSupabase(): MockSupabaseResult {
  const supabase = makeClient()
  return { supabase, deadlineInserts: supabase.deadlineInserts }
}

function authenticate(supabase: ReturnType<typeof makeClient>) {
  mocks.requireAuth.mockResolvedValue({
    error: null, user: { id: 'user-1', is_anonymous: true }, supabase,
  })
}

function request(): Request {
  return new Request('http://localhost:3000/api/sandbox/seed', {
    method: 'POST',
    headers: { 'x-forwarded-for': '192.0.2.15' },
  })
}

describe('POST /api/sandbox/seed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0))
    mocks.checkRateLimit.mockResolvedValue({ ok: true })
    mocks.createJournalEntry.mockImplementation(async (_db, companyId, _user, input) => ({
      id: `entry-${mocks.createJournalEntry.mock.calls.length}`, company_id: companyId, ...input,
    }))
    mocks.ensureSandboxAgentProfile.mockResolvedValue(undefined)
    mocks.markEntriesNoDocRequired.mockResolvedValue(undefined)
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('returns 401 when authentication fails', async () => {
    mocks.requireAuth.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(request())

    expect(response.status).toBe(401)
  })

  it('inserts the canonical quarterly VAT deadline during a successful seed', async () => {
    const { supabase, deadlineInserts } = createMockSupabase()
    mocks.requireAuth.mockResolvedValue({
      error: null,
      user: { id: 'user-1', is_anonymous: true },
      supabase,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ seeded: true })
    expect(deadlineInserts).toHaveLength(1)
    expect(deadlineInserts[0][0]).toMatchObject({
      title: 'Momsdeklaration Q2 2026',
      due_date: '2026-08-17',
      tax_deadline_type: 'moms_quarterly',
      tax_period: '2026-Q2',
    })
  })
  it('rejects registered users without claiming or writing', async () => {
    const db = makeClient()
    mocks.requireAuth.mockResolvedValue({ error: null, user: { id: 'real', is_anonymous: false }, supabase: db })
    expect((await POST(request())).status).toBe(403)
    expect(db.rpc).not.toHaveBeenCalled()
    expect(db.from).not.toHaveBeenCalled()
  })

  it('posts history, invoice and payroll through the engine without preset audit fields', async () => {
    const db = makeClient()
    authenticate(db)
    expect((await POST(request())).status).toBe(200)
    const inputs = mocks.createJournalEntry.mock.calls.map(call => call[3])
    expect(new Set(inputs.map(input => input.source_type))).toEqual(
      new Set(['manual', 'invoice_created', 'invoice_paid', 'supplier_invoice_registered', 'salary_payment']),
    )
    for (const input of inputs) {
      expect(input).not.toHaveProperty('committed_at')
      expect(input).not.toHaveProperty('commit_method')
      expect(input).not.toHaveProperty('voucher_number')
      expect(input).not.toHaveProperty('status')
      expect(input.lines.length).toBeGreaterThan(1)
    }
    expect(db.rpc).toHaveBeenLastCalledWith('finish_sandbox_seed', {
      p_attempt_id: 'attempt-1', p_success: true,
    })
  })

  it('records the paid demo invoice in invoice_payments through the single writer (#2019)', async () => {
    const db = makeClient()
    authenticate(db)
    expect((await POST(request())).status).toBe(200)
    const paymentVoucherIndex = mocks.createJournalEntry.mock.calls.findIndex(call => call[3].source_type === 'invoice_paid')
    expect(paymentVoucherIndex).toBeGreaterThanOrEqual(0)
    const paymentRows = db.tableInserts.filter(insert => insert.table === 'invoice_payments')
    expect(paymentRows).toHaveLength(1)
    expect(paymentRows[0].payload).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-1',
      amount: 18750,
      currency: 'SEK',
      payment_date: '2026-04-30',
      journal_entry_id: `entry-${paymentVoucherIndex + 1}`,
      transaction_id: null,
      source: 'manual',
    })
  })

  it('posts only balanced verifikat (BFL: debit equals credit, both above zero)', async () => {
    for (const now of [new Date(2026, 4, 15, 12), new Date(2026, 0, 3, 12)]) {
      vi.setSystemTime(now)
      mocks.createJournalEntry.mockClear()
      authenticate(makeClient())
      expect((await POST(request())).status).toBe(200)
      expect(mocks.createJournalEntry.mock.calls.length).toBeGreaterThan(0)
      for (const call of mocks.createJournalEntry.mock.calls) {
        const input = call[3] as { description: string; lines: Array<{ debit_amount: number; credit_amount: number }> }
        const debit = Math.round(input.lines.reduce((n, l) => n + l.debit_amount, 0) * 100) / 100
        const credit = Math.round(input.lines.reduce((n, l) => n + l.credit_amount, 0) * 100) / 100
        expect(debit, input.description).toBe(credit)
        expect(debit, input.description).toBeGreaterThan(0)
      }
    }
  })

  it('books the representation lunch on 6072 with its deductible VAT, syfte and deltagare (accounted#80, crm#1342)', async () => {
    const db = makeClient()
    authenticate(db)
    expect((await POST(request())).status).toBe(200)

    const registrations = mocks.createJournalEntry.mock.calls
      .map(call => call[3])
      .filter(input => input.source_type === 'supplier_invoice_registered')
    expect(registrations).toHaveLength(1)
    const [representation] = registrations
    const byAccount = Object.fromEntries(
      representation.lines.map((l: { account_number: string }) => [l.account_number, l]),
    )
    expect(Object.keys(byAccount).sort()).toEqual(['2440', '2641', '6072'])
    expect(byAccount['6072']).toMatchObject({ debit_amount: 240, credit_amount: 0 })
    expect(byAccount['2641']).toMatchObject({ debit_amount: 28.8, credit_amount: 0 })
    expect(byAccount['2440']).toMatchObject({ debit_amount: 0, credit_amount: 268.8 })
    expect(representation.notes).toMatch(/Syfte: .+Deltagare: .+\(.+\)/)

    // Every place the lunch appears books the same account: the registered
    // invoice's row and the inbox item behind the staged operation.
    const itemRows = db.tableInserts
      .filter(insert => insert.table === 'supplier_invoice_items')
      .flatMap(insert => insert.payload as Array<{ account_number: string; vat_rate: number; vat_amount: number }>)
    expect(itemRows.find(row => row.vat_rate === 0.12)).toMatchObject({ account_number: '6072', vat_amount: 28.8 })
    expect(itemRows.some(row => row.account_number === '5810')).toBe(false)
    const inbox = db.tableInserts.find(insert => insert.table === 'invoice_inbox_items')!.payload as {
      extracted_data: { lineItems: Array<{ account_number: string }> }
    }
    expect(inbox.extracted_data.lineItems.map(item => item.account_number)).toEqual(['6072'])

    // The account exists in the chart before anything posts to it.
    const chartRows = db.tableInserts
      .filter(insert => insert.table === 'chart_of_accounts')
      .flatMap(insert => insert.payload as Array<{ account_number: string }>)
    expect(chartRows.map(row => row.account_number)).toContain('6072')
  })

  it('does not seed again after completion', async () => {
    const db = makeClient()
    authenticate(db)
    await POST(request())
    const count = mocks.createJournalEntry.mock.calls.length
    expect(await (await POST(request())).json()).toEqual({ seeded: false, topped_up: true })
    expect(mocks.createJournalEntry).toHaveBeenCalledTimes(count)
  })

  it('retries a failed seed in a fresh company instead of topping up partial settings', async () => {
    const db = makeClient()
    authenticate(db)
    mocks.createJournalEntry.mockRejectedValueOnce(new Error('posting failed'))
    expect((await POST(request())).status).toBe(500)
    expect(db.rpc).toHaveBeenLastCalledWith('finish_sandbox_seed', { p_attempt_id: 'attempt-1', p_success: false })
    expect((await POST(request())).status).toBe(200)
    expect(mocks.createJournalEntry.mock.calls[0][1]).toBe('company-1')
    expect(mocks.createJournalEntry.mock.calls.at(-1)?.[1]).toBe('company-2')
  })

  it('returns 409 to a concurrent request without releasing the first request claim', async () => {
    const db = makeClient()
    authenticate(db)
    let release!: () => void
    let entered!: () => void
    const posting = new Promise<void>(resolve => { entered = resolve })
    mocks.createJournalEntry.mockImplementationOnce(async () => {
      entered()
      await new Promise<void>(resolve => { release = resolve })
      return { id: 'first' }
    })
    const first = POST(request())
    await posting
    const second = await POST(request())
    expect(second.status).toBe(409)
    expect(second.headers.get('Retry-After')).toBe('5')
    expect(db.rpc.mock.calls.filter(call => call[0] === 'finish_sandbox_seed')).toHaveLength(0)
    release()
    expect((await first).status).toBe(200)
  })

  it('fails closed if claim storage is unavailable', async () => {
    const db = makeClient()
    authenticate(db)
    db.rpc.mockResolvedValueOnce({ data: null, error: null })
    expect((await POST(request())).status).toBe(500)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('keeps every engine input inside the seeded period in January', async () => {
    vi.setSystemTime(new Date(2026, 0, 3, 12))
    authenticate(makeClient())
    expect((await POST(request())).status).toBe(200)
    for (const call of mocks.createJournalEntry.mock.calls) {
      expect(call[3].entry_date >= '2026-01-01').toBe(true)
      expect(call[3].entry_date <= '2026-12-31').toBe(true)
    }
  })

})
