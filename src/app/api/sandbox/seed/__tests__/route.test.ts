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
vi.mock('@/lib/salary/personnummer', () => ({
  encryptPersonnummer: (value: string) => `encrypted:${value}`,
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

  return Object.assign(supabase, { deadlineInserts })
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
      new Set(['manual', 'invoice_created', 'invoice_paid', 'salary_payment']),
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
