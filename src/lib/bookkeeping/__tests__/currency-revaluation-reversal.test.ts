/**
 * accounted#58: each krona of exchange difference reaches 3960/7960 once.
 *
 * The revaluation is measured from the original booking rate, and so is every
 * payment that clears 1510. The balansdag revaluation is therefore turned back
 * on the next year's first day (syncCurrencyRevaluationReversals). These tests
 * run the real revaluation and the real återföring against an in-memory
 * ledger: the engine is replaced by a store that records what would be posted,
 * so the sums below are sums over every verifikat of both years.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateJournalEntryInput, Currency } from '@/types'

type Row = Record<string, unknown>

interface Line {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string | null
}

interface Entry extends Row {
  id: string
  company_id: string
  fiscal_period_id: string
  entry_date: string
  source_type: string
  source_id: string | null
  status: 'posted' | 'reversed'
  reverses_id?: string | null
  lines: Line[]
}

const store: { tables: Record<string, Row[]>; seq: number } = { tables: {}, seq: 0 }
const entries = () => store.tables.journal_entries as Entry[]

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(
    async (_sb: unknown, companyId: string, _userId: string, input: CreateJournalEntryInput) => {
      const entry: Entry = {
        id: `je-${++store.seq}`,
        company_id: companyId,
        fiscal_period_id: input.fiscal_period_id,
        entry_date: input.entry_date,
        description: input.description,
        source_type: input.source_type,
        source_id: input.source_id ?? null,
        status: 'posted',
        lines: input.lines.map((l) => ({ ...l })),
      }
      entries().push(entry)
      return entry
    },
  ),
  reverseEntry: vi.fn(async (_sb: unknown, companyId: string, _userId: string, entryId: string) => {
    const original = entries().find((e) => e.id === entryId)!
    original.status = 'reversed'
    const storno: Entry = {
      id: `je-${++store.seq}`,
      company_id: companyId,
      fiscal_period_id: original.fiscal_period_id,
      entry_date: original.entry_date,
      source_type: 'storno',
      source_id: original.source_id,
      reverses_id: original.id,
      status: 'posted',
      lines: original.lines.map((l) => ({ ...l, debit_amount: l.credit_amount, credit_amount: l.debit_amount })),
    }
    entries().push(storno)
    return storno
  }),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: vi.fn() }))

const { fetchExchangeRate } = await import('@/lib/currency/riksbanken')
const { reverseEntry } = await import('@/lib/bookkeeping/engine')
const {
  executeCurrencyRevaluation,
  revaluationReversalLines,
  syncCurrencyRevaluationReversals,
} = await import('../currency-revaluation')

/**
 * The PostgREST surface the revaluation and the återföring read, evaluated
 * against the in-memory tables: filters, a head count, paging and the
 * thenable terminal. journal_entries rows carry their lines inline.
 */
function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      let countOnly = false
      let page: [number, number] | null = null
      const matching = () => (store.tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      const resolve = () => {
        const all = matching()
        if (countOnly) return { data: null, count: all.length, error: null }
        return { data: page ? all.slice(page[0], page[1] + 1) : all, error: null }
      }
      const builder: Record<string, unknown> = {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          if (opts?.head) countOnly = true
          return builder
        },
        eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), builder),
        neq: (col: string, val: unknown) => (filters.push((r) => r[col] !== val), builder),
        in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), builder),
        is: (col: string, val: unknown) => (filters.push((r) => (r[col] ?? null) === val), builder),
        lte: (col: string, val: string) => (filters.push((r) => r[col] != null && String(r[col]) <= val), builder),
        order: () => builder,
        range: (from: number, to: number) => ((page = [from, to]), builder),
        maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
        then: (done: (v: unknown) => void, fail?: (e: unknown) => void) => Promise.resolve(resolve()).then(done, fail),
      }
      return builder
    },
  }
}

const COMPANY = 'company-1'
const USER = 'user-1'
const FY_2025 = { id: 'fy-2025', period_start: '2025-01-01' }
const FY_2026 = { id: 'fy-2026', period_start: '2026-01-01' }
const FY_2027 = { id: 'fy-2027', period_start: '2027-01-01' }

const AMOUNT_EUR = 1000
const ORIGINAL_RATE = 11.0
const RATES: Record<string, number> = { '2025-12-31': 11.5, '2026-12-31': 11.8 }

const sek = (x: number) => Math.round(x * 100) / 100

function seed() {
  store.seq = 0
  store.tables = {
    company_settings: [{ company_id: COMPANY, accounting_method: 'accrual', defer_invoice_booking: false }],
    invoices: [
      {
        id: 'inv-1',
        company_id: COMPANY,
        document_type: 'invoice',
        invoice_number: 'F-1',
        invoice_date: '2025-11-15',
        currency: 'EUR',
        exchange_rate: ORIGINAL_RATE,
        total: AMOUNT_EUR,
        paid_amount: 0,
        paid_at: null,
        status: 'sent',
        journal_entry_id: 'je-invoice',
      },
    ],
    supplier_invoices: [],
    invoice_payments: [],
    supplier_invoice_payments: [],
    // The invoice as issue booked it: 1510 at the original rate.
    journal_entries: [
      {
        id: 'je-invoice',
        company_id: COMPANY,
        fiscal_period_id: FY_2025.id,
        entry_date: '2025-11-15',
        source_type: 'invoice_created',
        source_id: 'inv-1',
        status: 'posted',
        lines: [
          { account_number: '1510', debit_amount: sek(AMOUNT_EUR * ORIGINAL_RATE), credit_amount: 0 },
          { account_number: '3308', debit_amount: 0, credit_amount: sek(AMOUNT_EUR * ORIGINAL_RATE) },
        ],
      } satisfies Entry,
    ],
  }
}

/** Debit less credit on `account` over the posted ledger, optionally one year only. */
function balance(account: string, fiscalPeriodId?: string): number {
  let net = 0
  for (const e of entries()) {
    if (fiscalPeriodId && e.fiscal_period_id !== fiscalPeriodId) continue
    for (const l of e.lines) if (l.account_number === account) net += l.debit_amount - l.credit_amount
  }
  return sek(net)
}

/** The exchange result booked (3960 credit less 7960 debit), optionally one year only. */
function fxResult(fiscalPeriodId?: string): number {
  return sek(-balance('3960', fiscalPeriodId) - balance('7960', fiscalPeriodId))
}

const nextOf = (period: { id: string; period_start: string }) => vi.fn(async () => period)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('POSTING_EVENTS', '')
  // Both balansdagar lie in the past: the as-of reconstruction is the path taken.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2027-03-01T12:00:00Z'))
  vi.mocked(fetchExchangeRate).mockImplementation(async (currency, date) => {
    const iso = (date as Date).toISOString().slice(0, 10)
    const rate = RATES[iso]
    return rate === undefined ? null : { currency: currency as Currency, rate, date: iso }
  })
  seed()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('two balansdagar on one open receivable (accounted#58)', () => {
  it('books (closing rate 2 - original rate) x amount once, and each year only its own part', async () => {
    const sb = fakeSupabase() as never

    // Year 1: the close values the receivable at 11.5 and turns it back on 1 January.
    await executeCurrencyRevaluation(sb, COMPANY, '2025-12-31', FY_2025.id, USER)
    const first = await syncCurrencyRevaluationReversals(sb, COMPANY, USER, FY_2025.id, nextOf(FY_2026))
    expect(first.posted).toHaveLength(1)
    expect(first.posted[0]).toMatchObject({
      fiscal_period_id: FY_2026.id,
      entry_date: '2026-01-01',
      source_type: 'currency_revaluation',
    })

    // Year 2: still open, valued at 11.8. Not refused as a second revaluation
    // of the year: the återföring that sits in it is not one.
    const second = await executeCurrencyRevaluation(sb, COMPANY, '2026-12-31', FY_2026.id, USER)
    expect(second).not.toBeNull()
    // Measured from the original rate again, which the återföring made right.
    expect(second!.preview.items[0]).toMatchObject({ original_rate: ORIGINAL_RATE, closing_rate: 11.8, difference_sek: 800 })

    const once = sek((RATES['2026-12-31'] - ORIGINAL_RATE) * AMOUNT_EUR)
    expect(fxResult()).toBe(once)
    // Each year books the difference that arose in it: 500 and then 300.
    expect(fxResult(FY_2025.id)).toBe(sek((RATES['2025-12-31'] - ORIGINAL_RATE) * AMOUNT_EUR))
    expect(fxResult(FY_2026.id)).toBe(sek((RATES['2026-12-31'] - RATES['2025-12-31']) * AMOUNT_EUR))
    // The receivable stands at the second closing rate, not above it.
    expect(balance('1510')).toBe(sek(AMOUNT_EUR * RATES['2026-12-31']))

    // Year 2's close turns back year 2's revaluation only: the återföring of
    // year 1 that sits in year 2 is never turned back again.
    const third = await syncCurrencyRevaluationReversals(sb, COMPANY, USER, FY_2026.id, nextOf(FY_2027))
    expect(third.posted).toHaveLength(1)
    expect(third.posted[0]).toMatchObject({ fiscal_period_id: FY_2027.id, source_id: second!.entry.id })
    expect(fxResult(FY_2027.id)).toBe(-800)
  })

  it('a payment after the balansdag realises the whole difference once, from the original rate', async () => {
    const sb = fakeSupabase() as never
    await executeCurrencyRevaluation(sb, COMPANY, '2025-12-31', FY_2025.id, USER)
    await syncCurrencyRevaluationReversals(sb, COMPANY, USER, FY_2025.id, nextOf(FY_2026))

    // What the payment doors book: 1510 cleared at the original rate, the
    // realised difference against it on 3960.
    const paidRate = 11.6
    entries().push({
      id: 'je-payment',
      company_id: COMPANY,
      fiscal_period_id: FY_2026.id,
      entry_date: '2026-03-10',
      source_type: 'invoice_paid',
      source_id: 'inv-1',
      status: 'posted',
      lines: [
        { account_number: '1930', debit_amount: sek(AMOUNT_EUR * paidRate), credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: sek(AMOUNT_EUR * ORIGINAL_RATE) },
        { account_number: '3960', debit_amount: 0, credit_amount: sek(AMOUNT_EUR * (paidRate - ORIGINAL_RATE)) },
      ],
    })
    Object.assign(store.tables.invoices[0], { status: 'paid', paid_amount: AMOUNT_EUR, paid_at: '2026-03-10' })
    store.tables.invoice_payments.push({ id: 'pay-1', company_id: COMPANY, invoice_id: 'inv-1', amount: AMOUNT_EUR, payment_date: '2026-03-10' })

    // Nothing open on the second balansdag: nothing to value.
    expect(await executeCurrencyRevaluation(sb, COMPANY, '2026-12-31', FY_2026.id, USER)).toBeNull()

    expect(fxResult()).toBe(sek((paidRate - ORIGINAL_RATE) * AMOUNT_EUR))
    expect(fxResult(FY_2026.id)).toBe(sek((paidRate - RATES['2025-12-31']) * AMOUNT_EUR))
    // No unrealised gain left behind on a paid receivable.
    expect(balance('1510')).toBe(0)
  })
})

describe('syncCurrencyRevaluationReversals', () => {
  it('posts nothing a second time', async () => {
    const sb = fakeSupabase() as never
    await executeCurrencyRevaluation(sb, COMPANY, '2025-12-31', FY_2025.id, USER)
    await syncCurrencyRevaluationReversals(sb, COMPANY, USER, FY_2025.id, nextOf(FY_2026))

    const again = await syncCurrencyRevaluationReversals(sb, COMPANY, USER, FY_2025.id, nextOf(FY_2026))

    expect(again).toEqual({ posted: [], stornoed: [] })
    expect(entries().filter((e) => e.fiscal_period_id === FY_2026.id)).toHaveLength(1)
  })

  it('reads one query and resolves no next year when the year holds no revaluation', async () => {
    const next = nextOf(FY_2026)

    const result = await syncCurrencyRevaluationReversals(fakeSupabase() as never, COMPANY, USER, FY_2025.id, next)

    expect(result).toEqual({ posted: [], stornoed: [] })
    expect(next).not.toHaveBeenCalled()
  })

  it('stornoes the återföring of a revaluation stornoed since, and posts no new one for it', async () => {
    const sb = fakeSupabase() as never
    const revaluation = await executeCurrencyRevaluation(sb, COMPANY, '2025-12-31', FY_2025.id, USER)
    const { posted } = await syncCurrencyRevaluationReversals(sb, COMPANY, USER, FY_2025.id, nextOf(FY_2026))
    // The year is reopened, or the revaluation stornoed by hand after a failed close.
    entries().find((e) => e.id === revaluation!.entry.id)!.status = 'reversed'

    const result = await syncCurrencyRevaluationReversals(sb, COMPANY, USER, FY_2025.id, nextOf(FY_2026))

    expect(result).toEqual({ posted: [], stornoed: [posted[0]!.id] })
    expect(vi.mocked(reverseEntry)).toHaveBeenCalledWith(sb, COMPANY, USER, posted[0]!.id)
    expect(balance('1510', FY_2026.id)).toBe(0)
  })

  it('every line of the återföring stands on the opposite side and the verifikat balances', () => {
    const lines = revaluationReversalLines([
      { account_number: '1510', debit_amount: 500, credit_amount: 0, line_description: 'Omvärdering kundfordringar' },
      { account_number: '2440', debit_amount: '0', credit_amount: '120.4', line_description: null },
      { account_number: '3960', debit_amount: 0, credit_amount: 500 },
      { account_number: '7960', debit_amount: 120.4, credit_amount: 0 },
    ])

    expect(lines).toEqual([
      { account_number: '1510', debit_amount: 0, credit_amount: 500, line_description: 'Återföring: Omvärdering kundfordringar' },
      { account_number: '2440', debit_amount: 120.4, credit_amount: 0, line_description: 'Återföring:' },
      { account_number: '3960', debit_amount: 500, credit_amount: 0, line_description: 'Återföring:' },
      { account_number: '7960', debit_amount: 0, credit_amount: 120.4, line_description: 'Återföring:' },
    ])
    const debit = sek(lines.reduce((s, l) => s + l.debit_amount, 0))
    const credit = sek(lines.reduce((s, l) => s + l.credit_amount, 0))
    expect(debit).toBe(credit)
    expect(debit).toBeGreaterThan(0)
  })
})
