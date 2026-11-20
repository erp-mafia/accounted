import { describe, it, expect, vi } from 'vitest'
import { createMockSupabase, createQueuedMockSupabase, createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { resolvePrimaryBankAccount, resolvePrimaryBankAccountRow, resolveSettlementAccount } from '../settlement-account'
import { BookkeepingDatabaseError } from '../errors'
import { paymentBankRow } from '@/lib/cash-accounts/primary'
import { errorResponse, getStructuredError } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const noopLog = { warn: vi.fn() } as unknown as import('@/lib/logger').Logger

describe('resolveSettlementAccount', () => {
  describe('no cash_account_id: single-enabled-account currency fallback (#1722)', () => {
    it('resolves the single enabled account for the currency instead of 1930', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: [{ ledger_account: '1920' }], error: null })

      const result = await resolveSettlementAccount(supabase as never, 'company-1', null, noopLog)

      expect(result).toBe('1920')
      expect(supabase.from).toHaveBeenCalledWith('cash_accounts')
      // The candidate listing must be narrowed to enabled accounts in the
      // transaction's currency (SEK by default), mirroring the client-side
      // resolveAccount semantics.
      const eqArgs = findCalls('cash_accounts', 'eq')
      expect(eqArgs).toContainEqual(['company_id', 'company-1'])
      expect(eqArgs).toContainEqual(['enabled', true])
      expect(eqArgs).toContainEqual(['currency', 'SEK'])
    })

    it('counts bank accounts only, so a company card never makes the only bank ambiguous', async () => {
      // A company with one 1940 account and a SEK card on 2890: the query asks
      // for kind 'bank', so the card is not a second candidate (20261028090000).
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: [{ ledger_account: '1940' }], error: null })

      const result = await resolveSettlementAccount(supabase as never, 'company-1', null, noopLog, 'SEK')

      expect(result).toBe('1940')
      expect(findCalls('cash_accounts', 'eq')).toContainEqual(['kind', 'bank'])
    })

    it('filters candidates by the currency argument', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: [{ ledger_account: '1939' }], error: null })

      const result = await resolveSettlementAccount(
        supabase as never,
        'company-1',
        null,
        noopLog,
        'EUR',
      )

      expect(result).toBe('1939')
      expect(findCalls('cash_accounts', 'eq')).toContainEqual(['currency', 'EUR'])
    })

    it('keeps the 1930 fallback when the company has no enabled account in the currency', async () => {
      // A SEK transaction in a company whose only enabled cash account is EUR:
      // the currency-narrowed listing comes back empty.
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: [], error: null })

      const result = await resolveSettlementAccount(
        supabase as never,
        'company-1',
        null,
        noopLog,
        'SEK',
      )

      expect(result).toBe('1930')
      expect(findCalls('cash_accounts', 'eq')).toContainEqual(['currency', 'SEK'])
    })

    it('keeps the 1930 fallback when several enabled accounts share the currency', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({
        data: [{ ledger_account: '1920' }, { ledger_account: '1930' }],
        error: null,
      })

      const result = await resolveSettlementAccount(supabase as never, 'company-1', null, noopLog)

      expect(result).toBe('1930')
    })

    it('warns and keeps the 1930 fallback when the candidate lookup errors', async () => {
      // Unlike the explicit-cashAccountId branch (#842), this branch never
      // queried before, so an infra error degrades to the historical fallback
      // instead of failing the request.
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null, error: { message: 'boom' } })
      const warn = vi.fn()

      const result = await resolveSettlementAccount(supabase as never, 'company-1', null, {
        warn,
      } as unknown as import('@/lib/logger').Logger)

      expect(result).toBe('1930')
      expect(warn).toHaveBeenCalledWith(
        'settlement-account currency fallback lookup failed; defaulting to 1930',
        expect.objectContaining({ companyId: 'company-1', currency: 'SEK' }),
      )
    })

    it('warns and keeps the 1930 fallback when the single row has no ledger_account', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: [{ ledger_account: null }], error: null })
      const warn = vi.fn()

      const result = await resolveSettlementAccount(supabase as never, 'company-1', null, {
        warn,
      } as unknown as import('@/lib/logger').Logger)

      expect(result).toBe('1930')
      expect(warn).toHaveBeenCalledWith(
        'settlement-account currency fallback row has no ledger_account; defaulting to 1930',
        expect.objectContaining({ companyId: 'company-1', currency: 'SEK' }),
      )
    })
  })

  it('returns the linked cash account ledger_account', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: { ledger_account: '1940' }, error: null })

    const result = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog)

    expect(result).toBe('1940')
    expect(supabase.from).toHaveBeenCalledWith('cash_accounts')
  })

  describe("explicit cash_account_id and the transaction's currency (feedback seq 753539)", () => {
    // An Enable Banking account stored with currency 'XXX' resolved its ledger
    // here, so match_batch_allocate staged a verifikat, while the bank-booking
    // guards (which find the account only in the transaction's currency)
    // refused it at approval with BANK_BOOKING_CASH_ACCOUNT_MISSING.
    it.each([
      ['XXX', 'SEK'],
      ['SEK', 'USD'],
      ['EUR', 'SEK'],
    ])('refuses a linked %s account for a %s transaction', async (accountCurrency, txCurrency) => {
      const { supabase, mockResult } = createMockSupabase()
      mockResult({ data: { ledger_account: '1930', currency: accountCurrency }, error: null })

      const err = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog, txCurrency)
        .then(() => null, (e: unknown) => e)

      expect(err).toMatchObject({ code: 'BANK_BOOKING_CURRENCY_MISMATCH' })
      expect((err as Error).message).toContain(`in ${txCurrency} but its bank account 1930 is in ${accountCurrency}`)
      // What an agent and the dashboard receive: the registered code, its
      // Swedish sentence, not retryable, 409 on the REST envelope.
      expect(getStructuredError(err)).toMatchObject({
        code: 'BANK_BOOKING_CURRENCY_MISMATCH',
        message_sv: getErrorEntry('BANK_BOOKING_CURRENCY_MISMATCH')!.message_sv,
        retryable: false,
      })
      expect(errorResponse(err, { error: vi.fn(), warn: vi.fn() }).status).toBe(409)
    })

    it('returns a linked account in the transaction currency', async () => {
      const { supabase, mockResult } = createMockSupabase()
      mockResult({ data: { ledger_account: '1932', currency: 'EUR' }, error: null })

      expect(await resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog, 'EUR')).toBe('1932')
    })

    it('does not check a caller that omits the currency', async () => {
      const { supabase, mockResult } = createMockSupabase()
      mockResult({ data: { ledger_account: '1930', currency: 'XXX' }, error: null })

      expect(await resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog)).toBe('1930')
    })
  })

  it('throws a BookkeepingDatabaseError instead of silently falling back when the lookup errors', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: { message: 'boom' } })

    await expect(
      resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    await expect(
      resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', noopLog),
    ).rejects.toMatchObject({
      operation: 'resolve_settlement_account',
      message: expect.stringContaining('boom'),
    })
  })

  it('falls back to 1930 when cash_account_id does not match any row', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: null })

    const result = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-unknown', noopLog)

    expect(result).toBe('1930')
  })

  it('falls back to 1930 and warns when the row has no ledger_account', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: { ledger_account: null }, error: null })
    const warn = vi.fn()

    const result = await resolveSettlementAccount(supabase as never, 'company-1', 'ca-1', {
      warn,
    } as unknown as import('@/lib/logger').Logger)

    expect(result).toBe('1930')
    expect(warn).toHaveBeenCalledWith(
      'settlement-account lookup returned no ledger_account; defaulting to 1930',
      expect.objectContaining({ cashAccountId: 'ca-1' }),
    )
  })
})

// Issue #3097: a payment with no bank row of its own (the net pay of a salary
// run) lands on the company's primary cash account, never a hardcoded 1930.
describe('resolvePrimaryBankAccount', () => {
  const primary = (overrides: Record<string, unknown> = {}) => ({
    ledger_account: '1931',
    enabled: true,
    currency: 'SEK',
    ...overrides,
  })

  it("returns the primary's ledger account when it is an enabled SEK bank account", async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: primary(), error: null })

    expect(await resolvePrimaryBankAccount(supabase as never, 'company-1', noopLog)).toBe('1931')
    // One lookup: the primary, scoped to the company. No fallback listing.
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(findCalls('cash_accounts', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['is_primary', true],
    ])
  })

  it('keeps 1930 for a company whose primary IS 1930', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: primary({ ledger_account: '1930' }), error: null })

    expect(await resolvePrimaryBankAccount(supabase as never, 'company-1', noopLog)).toBe('1930')
  })

  it('never lands on a disabled primary: falls back to the only enabled SEK account', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: primary({ ledger_account: '1930', enabled: false }), error: null })
    enqueue({ data: [{ ledger_account: '1931' }], error: null }) // enabled SEK candidates
    const warn = vi.fn()

    const result = await resolvePrimaryBankAccount(supabase as never, 'company-1', {
      warn,
    } as unknown as import('@/lib/logger').Logger)

    expect(result).toBe('1931')
    expect(findCalls('cash_accounts', 'eq')).toContainEqual(['enabled', true])
    expect(findCalls('cash_accounts', 'eq')).toContainEqual(['currency', 'SEK'])
    expect(warn).toHaveBeenCalledWith(
      'primary cash account cannot carry a payment; resolving without it',
      expect.objectContaining({ companyId: 'company-1', ledgerAccount: '1930', reason: 'disabled' }),
    )
  })

  it('skips a foreign-currency primary and a non-bank primary', async () => {
    for (const unusable of [primary({ ledger_account: '1932', currency: 'EUR' }), primary({ ledger_account: '1910' })]) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: unusable, error: null })
      enqueue({ data: [{ ledger_account: '1931' }], error: null })

      expect(await resolvePrimaryBankAccount(supabase as never, 'company-1', noopLog)).toBe('1931')
    }
  })

  it('keeps the legacy 1930 when the company has no cash accounts at all', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // no primary
    enqueue({ data: [], error: null }) // no enabled SEK account

    expect(await resolvePrimaryBankAccount(supabase as never, 'company-1', noopLog)).toBe('1930')
  })

  it('keeps 1930 when there is no usable primary and several enabled SEK accounts', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })
    enqueue({ data: [{ ledger_account: '1931' }, { ledger_account: '1932' }], error: null })

    expect(await resolvePrimaryBankAccount(supabase as never, 'company-1', noopLog)).toBe('1930')
  })

  it('throws on a failed primary lookup instead of booking on 1930', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })

    await expect(resolvePrimaryBankAccount(supabase as never, 'company-1', noopLog)).rejects.toMatchObject({
      name: 'BookkeepingDatabaseError',
      operation: 'resolve_settlement_account',
      message: expect.stringContaining('boom'),
    })
  })
})

// crm#1483: the payment files pay from the row the salary is booked on, so the
// row resolution and the ledger resolution are one function.
describe('resolvePrimaryBankAccountRow', () => {
  it("returns the eligible primary's id with its ledger account", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ca-1931', ledger_account: '1931', enabled: true, currency: 'SEK' }, error: null })

    expect(await resolvePrimaryBankAccountRow(supabase as never, 'company-1', noopLog)).toEqual({
      id: 'ca-1931',
      ledger_account: '1931',
    })
  })

  it('returns the only enabled SEK account, with its id, when the primary cannot carry a payment', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ca-1930', ledger_account: '1930', enabled: false, currency: 'SEK' }, error: null })
    enqueue({ data: [{ id: 'ca-1931', ledger_account: '1931' }], error: null })

    expect(await resolvePrimaryBankAccountRow(supabase as never, 'company-1', noopLog)).toEqual({
      id: 'ca-1931',
      ledger_account: '1931',
    })
  })

  it('returns 1930 with no row when nothing answers, exactly what resolvePrimaryBankAccount books on', async () => {
    const a = createQueuedMockSupabase()
    a.enqueue({ data: null, error: null })
    a.enqueue({ data: [], error: null })
    expect(await resolvePrimaryBankAccountRow(a.supabase as never, 'company-1', noopLog)).toEqual({
      id: null,
      ledger_account: '1930',
    })

    const b = createQueuedMockSupabase()
    b.enqueue({ data: null, error: null })
    b.enqueue({ data: [], error: null })
    expect(await resolvePrimaryBankAccount(b.supabase as never, 'company-1', noopLog)).toBe('1930')
  })
})

// A dialog names the account from the list it holds (paymentBankRow), the
// booking reads it (resolvePrimaryBankAccountRow): one row set must give one
// answer, or the preview shows one bank account and the verifikat books another.
describe('paymentBankRow mirrors resolvePrimaryBankAccountRow', () => {
  interface Row {
    id: string
    company_id: string
    ledger_account: string
    enabled: boolean
    currency: string
    is_primary: boolean
    kind: 'bank' | 'card'
  }

  const row = (ledger_account: string, overrides: Partial<Row> = {}): Row => ({
    id: `ca-${ledger_account}`,
    company_id: 'company-1',
    ledger_account,
    enabled: true,
    currency: 'SEK',
    is_primary: false,
    kind: 'bank',
    ...overrides,
  })

  /** cash_accounts as Postgres answers a chain: its eq filters, its columns, its limit, and one row or none from maybeSingle. */
  const postgres = (rows: Row[]): TableMockResolver => (chain) => {
    const argsOf = (method: string) => chain.find((call) => call.method === method)?.args
    const columns = String(argsOf('select')?.[0]).split(', ') as Array<keyof Row>
    const answer = rows
      .filter((candidate) => chain.every((call) => call.method !== 'eq' || candidate[call.args[0] as keyof Row] === call.args[1]))
      .slice(0, (argsOf('limit')?.[0] as number | undefined) ?? rows.length)
      .map((candidate) => Object.fromEntries(columns.map((column) => [column, candidate[column]])))
    return { data: argsOf('maybeSingle') ? (answer[0] ?? null) : answer }
  }

  const rowSets: Array<[string, Row[], string | null]> = [
    ['a usable primary', [row('1930'), row('1931', { is_primary: true })], '1931'],
    ['a primary on another currency', [row('1932', { is_primary: true, currency: 'EUR' }), row('1931')], '1931'],
    ['a disabled primary', [row('1930', { is_primary: true, enabled: false }), row('1931')], '1931'],
    // Enabled, SEK and of kind bank: the listing counts it beside the bank account.
    ['a primary off 19xx', [row('1686', { is_primary: true }), row('1931')], null],
    [
      'no primary and one enabled SEK row',
      [row('1931'), row('1932', { currency: 'EUR' }), row('1940', { enabled: false }), row('2890', { kind: 'card' })],
      '1931',
    ],
    ['no primary and two enabled SEK rows', [row('1931'), row('1940')], null],
    ['no rows at all', [], null],
  ]

  it.each(rowSets)('%s', async (_name, rows, expected) => {
    const { supabase } = createTableMockSupabase({ cash_accounts: postgres(rows) })

    const server = await resolvePrimaryBankAccountRow(supabase as never, 'company-1', noopLog)
    const client = paymentBankRow(rows)

    // No row answers: the booking keeps the 1930 fallback, the dialog names none.
    expect(server).toEqual(expected ? { id: `ca-${expected}`, ledger_account: expected } : { id: null, ledger_account: '1930' })
    expect(client?.ledger_account ?? null).toBe(expected)
    expect(client?.id ?? null).toBe(server.id)
  })
})
