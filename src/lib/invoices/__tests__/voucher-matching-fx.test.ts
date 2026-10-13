/**
 * Foreign-currency voucher matching, both sides of the sub-ledger.
 *
 * THE BUG THESE COVER: `journal_entry_lines.currency` labels the DOCUMENT, not
 * the AMOUNT. `lib/bookkeeping/currency-utils.ts#buildCurrencyMetadata` stamps
 * `currency: 'EUR'` + `amount_in_currency` onto a line whose debit/credit
 * columns hold SEK. So every "the currencies match, so these amounts are
 * comparable" guard passed on exactly the FX rows it existed to catch, and then
 * compared a SEK ledger figure against a remainder quoted in the invoice's
 * currency.
 *
 * The customer-invoice matcher made it worse than a bad score: the amount band
 * is pushed into SQL, so a SEK `credit_amount` was bounded by a EUR band and
 * the one correct voucher was dropped BEFORE scoring ever ran, leaving only
 * same-magnitude coincidences behind. That is why the candidate query here runs
 * against a mock that actually APPLIES the filters (see
 * {@link createFilteringSupabase}) instead of a queued mock that ignores them:
 * a queued mock cannot tell a correct pre-filter from a broken one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  findMatchingVouchersForInvoice,
  validateVoucherForInvoiceLink,
} from '../voucher-matching'
import {
  findMatchingVouchersForSupplierInvoice,
  validateVoucherForSupplierInvoiceLink,
} from '../supplier-voucher-matching'
import { makeInvoice, makeSupplierInvoice, createQueuedMockSupabase } from '@/tests/helpers'

// Which voucher line settles the invoice is a DB function
// (supplier_invoice_settlement_side, read through supplier-settlement-side.ts).
// Stubbed so the lookup takes no slot in the queued Supabase mock. Every test
// in this file is the 244x-debit side and is unchanged by issue #2854; the
// 19xx-credit side is in supplier-voucher-matching-kontantmetod.test.ts. The
// customer-side matcher in this file does not use it.
vi.mock('@/lib/invoices/supplier-settlement-side', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supplier-settlement-side')>()
  return { ...actual, resolveSupplierSettlementSide: async () => actual.AP_DEBIT_SIDE }
})

// ============================================================
// A mock that actually executes the filters
// ============================================================

type FilterOp = 'eq' | 'gt' | 'gte' | 'lte' | 'like'

interface RecordedFilter {
  op: FilterOp
  column: string
  value: unknown
}

/**
 * A `.or('col.op.val,col.op.val', { referencedTable })` call: the conditions
 * are ORed with each other and the whole group ANDs with the other filters,
 * exactly as PostgREST composes it. The FX prefilter's two-sided floor band
 * (floor <= |amount_in_currency| <= ceil) rides on this shape, so the mock has
 * to execute it rather than swallow it.
 */
interface RecordedOrGroup {
  op: 'or'
  conditions: RecordedFilter[]
}

type AnyRecordedFilter = RecordedFilter | RecordedOrGroup

interface FixtureLine {
  id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  currency: string | null
  /** Omitted entirely on rows that predate the FX columns. */
  amount_in_currency?: number | string | null
}

interface FixtureEntry {
  id: string
  voucher_series: string
  voucher_number: number
  entry_date: string
  description: string
  status: string
  source_type: string
  fiscal_period_id: string
  company_id: string
  journal_entry_lines: FixtureLine[]
}

/**
 * SQL comparison semantics, including the part that carries this whole test
 * file: a comparison against NULL is UNKNOWN, so the row does NOT survive a
 * WHERE clause. A line with no `amount_in_currency` therefore drops out of the
 * foreign band by itself, which is correct: it carries no rate, so it cannot be
 * expressed in the invoice's currency at all.
 */
function valueMatches(value: unknown, filter: RecordedFilter): boolean {
  if (value === null || value === undefined) return false
  if (filter.op === 'like') {
    const pattern = String(filter.value)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
    return new RegExp(`^${pattern}$`).test(String(value))
  }
  if (filter.op === 'eq') return value === filter.value
  // Ordered comparisons run numerically on numerics and lexically otherwise,
  // which is what Postgres does per column type. `entry_date` ranges arrive as
  // ISO date strings, where lexical order IS chronological order.
  const numA = Number(value)
  const numB = Number(filter.value)
  const numeric = !Number.isNaN(numA) && !Number.isNaN(numB)
  const a: number | string = numeric ? numA : String(value)
  const b: number | string = numeric ? numB : String(filter.value)
  if (filter.op === 'gt') return a > b
  if (filter.op === 'gte') return a >= b
  return a <= b
}

const EMBED_PREFIX = 'journal_entry_lines.'

/** Whether a recorded filter (or every branch of an or-group) targets the embed. */
function targetsEmbeddedLines(f: AnyRecordedFilter): boolean {
  if (f.op === 'or') return f.conditions.every((c) => c.column.startsWith(EMBED_PREFIX))
  return f.column.startsWith(EMBED_PREFIX)
}

function stripEmbedPrefix(f: RecordedFilter): RecordedFilter {
  return f.column.startsWith(EMBED_PREFIX)
    ? { ...f, column: f.column.slice(EMBED_PREFIX.length) }
    : f
}

/** One filter (or one or-group: any branch suffices) against one row. */
function rowSatisfies(row: Record<string, unknown>, f: AnyRecordedFilter): boolean {
  if (f.op === 'or') return f.conditions.some((c) => rowSatisfies(row, c))
  return valueMatches(row[f.column], f)
}

/**
 * Apply the recorded filters the way PostgREST does for
 * `journal_entries?select=...,journal_entry_lines!inner(...)`:
 * plain columns filter the entries, `journal_entry_lines.*` columns filter the
 * EMBEDDED rows, and because the embed is `!inner` an entry whose lines are all
 * filtered away disappears from the result entirely. That last part is the
 * mechanism the bug rode in on.
 */
function applyEntryFilters(entries: FixtureEntry[], filters: AnyRecordedFilter[]): FixtureEntry[] {
  const entryFilters = filters.filter((f) => !targetsEmbeddedLines(f))
  const lineFilters = filters.filter(targetsEmbeddedLines).map((f): AnyRecordedFilter =>
    f.op === 'or'
      ? { ...f, conditions: f.conditions.map(stripEmbedPrefix) }
      : stripEmbedPrefix(f)
  )

  const result: FixtureEntry[] = []
  for (const entry of entries) {
    const entryOk = entryFilters.every((f) =>
      rowSatisfies(entry as unknown as Record<string, unknown>, f)
    )
    if (!entryOk) continue
    const lines = entry.journal_entry_lines.filter((line) =>
      lineFilters.every((f) => rowSatisfies(line as unknown as Record<string, unknown>, f))
    )
    if (lines.length === 0) continue
    result.push({ ...entry, journal_entry_lines: lines })
  }
  return result
}

interface FilteringMockConfig {
  accountingMethod?: 'accrual' | 'cash'
  entries: FixtureEntry[]
  /** Rows returned by the invoice_payments / supplier_invoice_payments dedup. */
  existingLinks?: { journal_entry_id: string }[]
  periods?: { id: string; is_closed: boolean; locked_at: string | null }[]
}

/**
 * Minimal PostgREST stand-in for the two matcher call graphs. Records the
 * filters per query and resolves them against `config.entries` at await time,
 * so the assertions below are about which vouchers SURVIVE, not about which
 * filter strings were typed.
 */
function createFilteringSupabase(config: FilteringMockConfig) {
  const queries: { table: string; columns: string; filters: AnyRecordedFilter[]; limit?: number }[] = []

  function chainFor(table: string) {
    const filters: AnyRecordedFilter[] = []
    const record = { table, columns: '', filters }
    queries.push(record)

    const findEntry = () => {
      const idFilter = filters.find(
        (f): f is RecordedFilter => f.op === 'eq' && f.column === 'id'
      )
      const entry = config.entries.find((e) => e.id === idFilter?.value)
      if (!entry) return null
      const { journal_entry_lines: _lines, ...rest } = entry
      return rest
    }

    const resolveList = (): { data: unknown; error: null } => {
      switch (table) {
        case 'journal_entries': {
          // The two-step fetch (lib/bookkeeping/entry-lines.ts) asks for bare
          // entries; the embed path asks for entries WITH lines. Both are
          // filtered identically; only the shape differs.
          const matched = applyEntryFilters(config.entries, filters)
          if (record.columns.includes('journal_entry_lines')) {
            return { data: matched, error: null }
          }
          return {
            data: matched.map(({ journal_entry_lines: _l, ...rest }) => rest),
            error: null,
          }
        }
        case 'journal_entry_lines': {
          // Second leg of the two-step fetch, plus the validators' direct read.
          const idFilter = filters.find(
            (f): f is RecordedFilter =>
              f.op !== 'or' && f.column === 'journal_entry_id' && (f.op === 'eq' || f.op === 'like')
          )
          const inIds = (record as { inIds?: string[] }).inIds
          const scoped = config.entries.filter((e) =>
            idFilter ? e.id === idFilter.value : (inIds ?? [e.id]).includes(e.id)
          )
          const lineFilters = filters.filter(
            (f): f is RecordedFilter =>
              f.op !== 'or' && f.column !== 'journal_entry_id' && !f.column.startsWith(EMBED_PREFIX)
          )
          const lines = scoped.flatMap((e) =>
            e.journal_entry_lines
              .filter((line) =>
                lineFilters.every((f) =>
                  valueMatches((line as unknown as Record<string, unknown>)[f.column], f)
                )
              )
              .map((line) => ({ ...line, journal_entry_id: e.id }))
          )
          return { data: lines, error: null }
        }
        case 'invoice_payments':
        case 'supplier_invoice_payments':
          return { data: config.existingLinks ?? [], error: null }
        case 'fiscal_periods':
          return {
            data:
              config.periods ??
              [...new Set(config.entries.map((e) => e.fiscal_period_id))].map((id) => ({
                id,
                is_closed: false,
                locked_at: null,
              })),
            error: null,
          }
        default:
          return { data: [], error: null }
      }
    }

    const resolveSingle = (): { data: unknown; error: null } => {
      if (table === 'company_settings') {
        return { data: { accounting_method: config.accountingMethod ?? 'accrual' }, error: null }
      }
      if (table === 'journal_entries') return { data: findEntry(), error: null }
      return { data: null, error: null }
    }

    const chain: Record<string, unknown> = {}
    for (const op of ['eq', 'gt', 'gte', 'lte', 'like'] as FilterOp[]) {
      chain[op] = (column: string, value: unknown) => {
        filters.push({ op, column, value })
        return chain
      }
    }
    chain.select = (columns?: string) => {
      record.columns = String(columns ?? '')
      return chain
    }
    chain.in = (column: string, values: string[]) => {
      if (column === 'journal_entry_id') (record as { inIds?: string[] }).inIds = values
      return chain
    }
    // `.or()` is parsed and EXECUTED, not swallowed: the FX prefilter's floor
    // band lives in an or-group, and a mock that ignores it cannot tell a
    // correct two-sided band from no band at all.
    chain.or = (filterString: string, opts?: { referencedTable?: string; foreignTable?: string }) => {
      const prefix = opts?.referencedTable ?? opts?.foreignTable
      const conditions: RecordedFilter[] = String(filterString)
        .split(',')
        .map((part) => {
          const [column, op, ...valueParts] = part.split('.')
          return {
            op: op as FilterOp,
            column: prefix ? `${prefix}.${column}` : column,
            value: valueParts.join('.'),
          }
        })
      filters.push({ op: 'or', conditions })
      return chain
    }
    for (const op of ['order', 'range', 'not', 'is']) {
      chain[op] = () => chain
    }
    chain.limit = (n: number) => {
      ;(record as { limit?: number }).limit = n
      return chain
    }
    chain.maybeSingle = () => Promise.resolve(resolveSingle())
    chain.single = () => Promise.resolve(resolveSingle())
    chain.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
      Promise.resolve(resolveList()).then(onOk, onErr)
    return chain
  }

  return {
    supabase: { from: vi.fn((table: string) => chainFor(table)), rpc: vi.fn() },
    queries,
  }
}

// ============================================================
// Fixtures: one EUR invoice, three vouchers competing for it
// ============================================================

/** 1000 EUR outstanding, booked at 11.50 SEK/EUR = 11 500 kr. */
function eurInvoice() {
  return makeInvoice({
    id: 'inv-eur',
    invoice_number: 'F-9001',
    currency: 'EUR',
    total: 1000,
    total_sek: 11500,
    exchange_rate: 11.5,
    remaining_amount: 1000,
    paid_amount: null,
    status: 'sent',
    invoice_date: '2026-06-01',
    due_date: '2026-06-30',
  })
}

function entry(
  id: string,
  voucherNumber: number,
  description: string,
  lines: FixtureLine[]
): FixtureEntry {
  return {
    id,
    voucher_series: 'A',
    voucher_number: voucherNumber,
    entry_date: '2026-06-28',
    description,
    status: 'posted',
    source_type: 'manual',
    fiscal_period_id: 'fp-1',
    company_id: 'company-1',
    journal_entry_lines: lines,
  }
}

/**
 * The RIGHT voucher: the 1000 EUR payment. `credit_amount` is the SEK figure
 * (11 500 kr), `amount_in_currency` is the 1000 EUR the invoice is quoted in.
 */
const correctEurVoucher = entry('je-correct', 11, 'Inbetalning utländsk kund', [
  {
    id: 'l-correct-ar',
    account_number: '1510',
    debit_amount: 0,
    credit_amount: 11500,
    currency: 'EUR',
    amount_in_currency: 1000,
  },
  {
    id: 'l-correct-bank',
    account_number: '1930',
    debit_amount: 11500,
    credit_amount: 0,
    currency: 'EUR',
    amount_in_currency: 1000,
  },
])

/**
 * The DECOY: an unrelated 87 EUR payment, which happens to be ~1000 kr. Its SEK
 * `credit_amount` sits inside a band built from a EUR remainder, so the broken
 * pre-filter kept precisely this one and threw away the voucher above.
 */
const decoySameMagnitudeVoucher = entry('je-decoy', 12, 'Inbetalning smabelopp', [
  {
    id: 'l-decoy-ar',
    account_number: '1510',
    debit_amount: 0,
    credit_amount: 1000.5,
    currency: 'EUR',
    amount_in_currency: 87,
  },
])

/** A plain 1000 kr domestic payment: same magnitude, wrong unit, no rate. */
const domesticSekVoucher = entry('je-sek', 13, 'Inbetalning inrikes', [
  {
    id: 'l-sek-ar',
    account_number: '1510',
    debit_amount: 0,
    credit_amount: 1000,
    currency: 'SEK',
  },
])

// ============================================================
// findMatchingVouchersForInvoice: the shared voucher search
// ============================================================

type RecordedQuery = { table: string; columns: string; filters: AnyRecordedFilter[]; limit?: number }

/** The settlement-line leg of the shared search (voucher-matching-shared.ts). */
function candidateLineQuery(queries: RecordedQuery[]): RecordedQuery {
  const query = queries.find((q) => q.table === 'journal_entry_lines' && q.columns.includes('amount_in_currency'))
  if (!query) throw new Error('no candidate line query recorded')
  return query
}

function plainFilters(query: RecordedQuery): RecordedFilter[] {
  return query.filters.filter((f): f is RecordedFilter => f.op !== 'or')
}

/** 1000 EUR paid by a verifikat that carries its 1510 credit in kronor only (an SIE import). */
const sekBookedEurPayment = entry('je-sek-booked', 21, 'Inbetalning faktura', [
  {
    id: 'l-sekb-ar',
    account_number: '1510',
    debit_amount: 0,
    credit_amount: 11600,
    currency: 'SEK',
  },
  {
    id: 'l-sekb-bank',
    account_number: '1930',
    debit_amount: 11600,
    credit_amount: 0,
    currency: 'SEK',
  },
])

describe('findMatchingVouchersForInvoice: foreign-currency invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not exclude the correct EUR voucher in the SQL pre-filter', async () => {
    const { supabase } = createFilteringSupabase({
      entries: [correctEurVoucher, decoySameMagnitudeVoucher, domesticSekVoucher],
    })

    const result = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      eurInvoice() as never
    )

    expect(result.map((c) => c.journal_entry_id)).toContain('je-correct')
  })

  it('quotes the matched amount in the invoice currency, not the SEK column', async () => {
    const { supabase } = createFilteringSupabase({ entries: [correctEurVoucher] })

    const [candidate] = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      eurInvoice() as never
    )

    // 1000 EUR, the figure the invoice's 1000 EUR remainder can be compared
    // with. 11 500 here would be the SEK column leaking through.
    expect(candidate.ar_credit_amount).toBe(1000)
    expect(candidate.currency).toBe('EUR')
  })

  it('prefers the correct voucher over a same-magnitude decoy', async () => {
    const { supabase } = createFilteringSupabase({
      entries: [decoySameMagnitudeVoucher, correctEurVoucher],
    })

    const result = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      eurInvoice() as never
    )

    expect(result[0].journal_entry_id).toBe('je-correct')
    // 87 EUR is not a plausible settlement of a 1000 EUR invoice at all: it
    // must not merely rank lower, it must not be offered.
    expect(result.map((c) => c.journal_entry_id)).not.toContain('je-decoy')
  })

  it('never offers a rate-less domestic voucher for a EUR invoice', async () => {
    const { supabase } = createFilteringSupabase({ entries: [domesticSekVoucher] })

    const result = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      eurInvoice() as never
    )

    expect(result).toEqual([])
  })

  it('reads every 1510 credit in the window, whatever its label, with both FX columns', async () => {
    // The AR side is read unbanded, as the supplier's 244x side always was: a
    // payment booked in kronor only carries no EUR label and no EUR figure, and
    // a currency filter or an amount_in_currency band would hide it before the
    // SEK-booked fallback could judge it.
    const { supabase, queries } = createFilteringSupabase({ entries: [correctEurVoucher] })

    await findMatchingVouchersForInvoice(supabase as never, 'company-1', eurInvoice() as never)

    const lineQuery = candidateLineQuery(queries)
    expect(plainFilters(lineQuery)).toEqual(
      expect.arrayContaining([
        { op: 'like', column: 'account_number', value: '151%' },
        { op: 'gt', column: 'credit_amount', value: 0 },
      ]),
    )
    expect(plainFilters(lineQuery).some((f) => f.column === 'currency')).toBe(false)
    expect(lineQuery.filters.some((f) => f.op === 'gte' || f.op === 'lte' || f.op === 'or')).toBe(false)
    // Both FX columns must be projected or every line is unconvertible.
    expect(lineQuery.columns).toContain('amount_in_currency')
    expect(lineQuery.columns).toContain('currency')
  })

  it('reads every voucher in the window: no row cap on the search', async () => {
    // The old search capped an unordered query at limit * 10 rows, so the
    // exact-amount voucher could be dropped before scoring ever saw it.
    const { supabase, queries } = createFilteringSupabase({ entries: [correctEurVoucher] })

    await findMatchingVouchersForInvoice(supabase as never, 'company-1', eurInvoice() as never, { limit: 1 })

    for (const query of queries.filter((q) => q.table === 'journal_entries' || q.table === 'journal_entry_lines')) {
      expect(query.limit).toBeUndefined()
    }
  })

  it('offers a EUR invoice the payment booked in kronor only, valued at the invoice rate', async () => {
    const { supabase } = createFilteringSupabase({ entries: [sekBookedEurPayment] })

    const result = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      eurInvoice() as never,
    )

    expect(result).toHaveLength(1)
    expect(result[0].journal_entry_id).toBe('je-sek-booked')
    // 11 600 kr at the invoice's 11.50: 1008.70 EUR, inside the fuzzy band.
    expect(result[0].ar_credit_amount).toBe(1008.7)
    expect(result[0].ar_line_currency).toBeNull()
    expect(result[0].match_reason).toContain('bokförd i SEK')
    expect(result[0].match_reason).toMatch(/11.600/)
  })

  it('offers only what the link accepts: the SEK-booked candidate validates', async () => {
    const { supabase } = createFilteringSupabase({ entries: [sekBookedEurPayment] })

    const [candidate] = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      eurInvoice() as never,
    )
    const validated = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      candidate.journal_entry_id,
    )

    expect(validated.ok).toBe(true)
  })

  it('on kontantmetoden reads only 19xx lines labelled with the invoice currency', async () => {
    // Every receipt debits 19xx, so the unfiltered set would be the whole bank
    // history in the window; only labelled lines are expressible in EUR.
    const { supabase, queries } = createFilteringSupabase({
      accountingMethod: 'cash',
      entries: [correctEurVoucher],
    })

    const result = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      eurInvoice() as never,
    )

    expect(result.map((c) => c.journal_entry_id)).toEqual(['je-correct'])
    expect(plainFilters(candidateLineQuery(queries))).toEqual(
      expect.arrayContaining([
        { op: 'like', column: 'account_number', value: '19%' },
        { op: 'gt', column: 'debit_amount', value: 0 },
        { op: 'eq', column: 'currency', value: 'EUR' },
      ]),
    )
  })

  it('keeps a negatively-stored foreign figure inside the floored band', async () => {
    // A few production rows store amount_in_currency with a negative sign; the
    // direction comes off the debit/credit side. The floor must not evict them.
    const negativeStored = entry('je-negative', 18, 'Inbetalning utländsk kund', [
      {
        id: 'l-negative',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 11500,
        currency: 'EUR',
        amount_in_currency: -1000,
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [negativeStored] })

    const result = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      eurInvoice() as never
    )

    expect(result.map((c) => c.journal_entry_id)).toContain('je-negative')
  })

  it('does not offer a voucher whose 1510 credits exceed the invoice, which the link refuses', async () => {
    // One receipt for two invoices of the same foreign customer: 1000 EUR for
    // this one and 87 EUR for another. The link sums every 151x credit on the
    // voucher (1087 EUR) and answers LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING, so
    // the search does not offer it either (the old line-level floor did, and
    // the person picking it then met the refusal).
    const withSmallSibling = entry('je-sibling', 19, 'Inbetalning utländsk kund', [
      {
        id: 'l-sib-main',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 11500,
        currency: 'EUR',
        amount_in_currency: 1000,
      },
      {
        id: 'l-sib-small',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 1000.5,
        currency: 'EUR',
        amount_in_currency: 87,
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [withSmallSibling] })

    const result = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      eurInvoice() as never
    )
    const validated = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-sibling',
    )

    expect(result).toEqual([])
    expect(validated).toMatchObject({ ok: false, code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING' })
  })
})

// ============================================================
// SEK-only companies: the 95% path must not move at all
// ============================================================

describe('findMatchingVouchersForInvoice: SEK is untouched', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function sekInvoice() {
    return makeInvoice({
      id: 'inv-sek',
      invoice_number: 'F-9002',
      currency: 'SEK',
      total: 1000,
      remaining_amount: 1000,
      paid_amount: null,
      status: 'sent',
      invoice_date: '2026-06-01',
      due_date: '2026-06-30',
    })
  }

  it('still matches a plain SEK voucher on the raw ledger column', async () => {
    const { supabase } = createFilteringSupabase({ entries: [domesticSekVoucher] })

    const [candidate] = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      sekInvoice() as never
    )

    expect(candidate.journal_entry_id).toBe('je-sek')
    expect(candidate.ar_credit_amount).toBe(1000)
  })

  it('adds no currency filter and bands only the 19xx side, on the SEK column', async () => {
    const accrual = createFilteringSupabase({ entries: [domesticSekVoucher] })
    await findMatchingVouchersForInvoice(accrual.supabase as never, 'company-1', sekInvoice() as never)
    const arQuery = candidateLineQuery(accrual.queries)
    expect(plainFilters(arQuery).some((f) => f.column === 'currency')).toBe(false)
    expect(arQuery.filters.some((f) => f.op === 'gte' || f.op === 'lte' || f.op === 'or')).toBe(false)

    const cash = createFilteringSupabase({ accountingMethod: 'cash', entries: [] })
    await findMatchingVouchersForInvoice(cash.supabase as never, 'company-1', sekInvoice() as never)
    const bankQuery = cash.queries.find((q) => q.table === 'journal_entries')
    // No voucher in the window: the line leg never runs. The band itself is
    // the shared candidateAmountBand, covered with the supplier side.
    expect(bankQuery).toBeDefined()
  })

  it('reads the SEK column even when the line is labelled with a foreign document', async () => {
    // A SEK invoice settled by a voucher that also carries a EUR document
    // label: the ledger column is kronor either way, so the label is irrelevant
    // and the match must still happen.
    const mixed = entry('je-mixed', 14, 'Inbetalning', [
      {
        id: 'l-mixed',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 1000,
        currency: 'SEK',
        amount_in_currency: null,
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [mixed] })

    const [candidate] = await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      sekInvoice() as never
    )

    expect(candidate.ar_credit_amount).toBe(1000)
  })

  it('treats a legacy NULL invoice currency as SEK, not as foreign', async () => {
    // `invoices.currency` is `text default 'SEK'` and therefore nullable, while
    // the TS type says otherwise. A NULL must not test `!== 'SEK'` and send a
    // domestic invoice down the amount_in_currency path.
    const { supabase, queries } = createFilteringSupabase({ entries: [domesticSekVoucher] })

    await findMatchingVouchersForInvoice(
      supabase as never,
      'company-1',
      makeInvoice({
        currency: null as unknown as 'SEK',
        total: 1000,
        remaining_amount: 1000,
        paid_amount: null,
        due_date: '2026-06-30',
        invoice_number: 'F-9003',
      }) as never
    )

    const lineQuery = candidateLineQuery(queries)
    expect(plainFilters(lineQuery).some((f) => f.column === 'currency')).toBe(false)
    expect(
      lineQuery.filters.some(
        (f) =>
          (f.op === 'or' && f.conditions.some((c) => c.column === 'amount_in_currency')) ||
          (f.op !== 'or' && f.column === 'amount_in_currency')
      )
    ).toBe(false)
  })
})

// ============================================================
// validateVoucherForInvoiceLink: EXCEEDS_REMAINING + payment amount
// ============================================================

describe('validateVoucherForInvoiceLink: foreign-currency invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts the correct EUR voucher instead of EXCEEDS_REMAINING', async () => {
    const { supabase } = createFilteringSupabase({ entries: [correctEurVoucher] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-correct'
    )

    // Comparing the 11 500 kr credit against the 1000 EUR remainder rejected
    // the one voucher that was actually right.
    expect(result.ok).toBe(true)
  })

  it('writes the payment amount in the invoice currency', async () => {
    const { supabase } = createFilteringSupabase({ entries: [correctEurVoucher] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-correct'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Math.min(11500, 1000) = 1000 by accident; Math.min(1000, 1000) = 1000 on
    // purpose. The distinguishing figure is arCreditAmount.
    expect(result.arCreditAmount).toBe(1000)
    expect(result.paymentAmount).toBe(1000)
    expect(result.remainingAfter).toBe(0)
    expect(result.isFullyPaid).toBe(true)
  })

  it('reports a partial settlement in the invoice currency', async () => {
    // 400 EUR of a 1000 EUR invoice, booked at 11.50 = 4600 kr.
    const partial = entry('je-partial', 15, 'Delbetalning', [
      {
        id: 'l-partial',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 4600,
        currency: 'EUR',
        amount_in_currency: 400,
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [partial] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-partial'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paymentAmount).toBe(400)
    expect(result.remainingAfter).toBe(600)
    expect(result.isFullyPaid).toBe(false)
  })

  it('still rejects a voucher that genuinely exceeds the remainder', async () => {
    // 1500 EUR against a 1000 EUR remainder: the guard must keep working in the
    // invoice's own unit.
    const tooBig = entry('je-toobig', 16, 'Inbetalning', [
      {
        id: 'l-toobig',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 17250,
        currency: 'EUR',
        amount_in_currency: 1500,
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [tooBig] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-toobig'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING')
    expect(result.details).toMatchObject({ ar_credit: 1500, remaining: 1000 })
  })

  it('refuses a rate-less AR credit rather than reading it as EUR', async () => {
    // A 151x credit with no amount_in_currency carries no figure in EUR. Summing
    // only the readable lines would understate the voucher, so this fails closed.
    const rateless = entry('je-rateless', 17, 'Inbetalning', [
      {
        id: 'l-rateless',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 11500,
        currency: 'EUR',
        amount_in_currency: null,
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [rateless] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-rateless'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
  })

  it('settles a plain SEK-booked voucher via the FX fallback (RPC gate mirror)', async () => {
    // The receivable was booked in kronor (SIE import / manual voucher): the
    // RPC (migration 20260830140000) now settles this and books the residual
    // to 7960/3960, so the validator must stop refusing it at stage time.
    const sekBooked = entry('je-sekbooked', 18, 'Inbetalning', [
      {
        id: 'l-sekbooked-ar',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 11200,
        currency: 'SEK',
      },
      {
        id: 'l-sekbooked-bank',
        account_number: '1930',
        debit_amount: 11200,
        credit_amount: 0,
        currency: 'SEK',
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [sekBooked] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-sekbooked'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Full-remaining settlement in the invoice currency, like the RPC.
    expect(result.arCreditAmount).toBe(1000)
    expect(result.paymentAmount).toBe(1000)
    expect(result.remainingAfter).toBe(0)
    expect(result.isFullyPaid).toBe(true)
    expect(result.arLineCurrency).toBeNull()
  })

  it('keeps the refusal when the SEK total deviates more than 10% from booked', async () => {
    // 1000 kr against an 11 500 kr booked receivable: wrong voucher, not FX.
    const { supabase } = createFilteringSupabase({ entries: [domesticSekVoucher] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-sek'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
    expect(result.details).toMatchObject({ reason: 'fx_deviation_too_large' })
  })

  it('keeps the refusal when a readable line carries amount_in_currency 0', async () => {
    // Skeptic counterexample: the EUR-labelled zero line is a readable LINE
    // whose 50 kr ledger credit is excluded from the SEK sum; engaging the
    // fallback would understate the settlement. The gate counts lines.
    const mixedZero = entry('je-mixed-zero', 19, 'Inbetalning', [
      {
        id: 'l-mz-sek',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 950,
        currency: 'SEK',
      },
      {
        id: 'l-mz-zero',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 50,
        currency: 'EUR',
        amount_in_currency: 0,
      },
      {
        id: 'l-mz-bank',
        account_number: '1930',
        debit_amount: 1000,
        credit_amount: 0,
        currency: 'SEK',
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [mixedZero] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      makeInvoice({
        id: 'inv-eur-small',
        invoice_number: 'F-9010',
        currency: 'EUR',
        total: 100,
        total_sek: 1000,
        exchange_rate: 10,
        remaining_amount: 100,
        paid_amount: null,
        status: 'sent',
        due_date: '2026-06-30',
      }) as never,
      'je-mixed-zero'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
  })

  it('accepts a SEK-booked voucher on kontantmetoden (migration 20260919110000)', async () => {
    // The bank row carries slightly less than the invoice's booked SEK value,
    // the everyday spread between the bank's rate and Riksbankens. On
    // kontantmetoden that is not a delbetalning and not a kursdifferens: with
    // no receivable there is nothing to true up, so the link settles the full
    // remaining and the RPC writes no residual verifikat.
    const cashVoucher = entry('je-cash-sek', 20, 'Inbetalning', [
      {
        id: 'l-cash-bank',
        account_number: '1930',
        debit_amount: 11450,
        credit_amount: 0,
        currency: 'SEK',
      },
      {
        id: 'l-cash-rev',
        account_number: '3001',
        debit_amount: 0,
        credit_amount: 11450,
        currency: 'SEK',
      },
    ])
    const { supabase } = createFilteringSupabase({
      accountingMethod: 'cash',
      entries: [cashVoucher],
    })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-cash-sek'
    )

    expect(result.ok).toBe(true)
  })

  it('refuses on kontantmetoden when the invoice was booked at issue', async () => {
    // journal_entry_id means a 1510 balance at the invoice rate: a kronor
    // settlement leaves a kursdifferens the cash path never books, so the
    // validator refuses exactly where the RPC does.
    const cashVoucher = entry('je-cash-booked', 22, 'Inbetalning', [
      {
        id: 'l-booked-bank',
        account_number: '1930',
        debit_amount: 11450,
        credit_amount: 0,
        currency: 'SEK',
      },
      {
        id: 'l-booked-ar',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 11450,
        currency: 'SEK',
      },
    ])
    const { supabase } = createFilteringSupabase({
      accountingMethod: 'cash',
      entries: [cashVoucher],
    })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      { ...eurInvoice(), journal_entry_id: 'je-registration' } as never,
      'je-cash-booked'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
  })

  it('still refuses the wrong voucher on kontantmetoden', async () => {
    const wrongVoucher = entry('je-cash-wrong', 21, 'Inbetalning', [
      {
        id: 'l-wrong-bank',
        account_number: '1930',
        debit_amount: 1000,
        credit_amount: 0,
        currency: 'SEK',
      },
      {
        id: 'l-wrong-rev',
        account_number: '3001',
        debit_amount: 0,
        credit_amount: 1000,
        currency: 'SEK',
      },
    ])
    const { supabase } = createFilteringSupabase({
      accountingMethod: 'cash',
      entries: [wrongVoucher],
    })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-cash-wrong'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
  })

  it('keeps the refusal when the invoice has no exchange rate', async () => {
    const sekBooked = entry('je-sekbooked-norate', 25, 'Inbetalning', [
      {
        id: 'l-norate-ar',
        account_number: '1510',
        debit_amount: 0,
        credit_amount: 11500,
        currency: 'SEK',
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [sekBooked] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      makeInvoice({
        id: 'inv-eur-norate',
        invoice_number: 'F-9011',
        currency: 'EUR',
        total: 1000,
        total_sek: null,
        exchange_rate: null,
        remaining_amount: 1000,
        paid_amount: null,
        status: 'sent',
        due_date: '2026-06-30',
      }) as never,
      'je-sekbooked-norate'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_VOUCHER_CURRENCY_MISMATCH')
  })

  it('selects currency + amount_in_currency off the lines', async () => {
    // The fix is inert if the column list omits them: the sweep has already hit
    // that once, via RPCs that projected neither.
    const { supabase, queries } = createFilteringSupabase({ entries: [correctEurVoucher] })

    await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      eurInvoice() as never,
      'je-correct'
    )

    const lineQuery = queries.find((q) => q.table === 'journal_entry_lines')
    expect(lineQuery!.columns).toContain('currency')
    expect(lineQuery!.columns).toContain('amount_in_currency')
  })

  it('SEK: the happy path is unchanged', async () => {
    const { supabase } = createFilteringSupabase({ entries: [domesticSekVoucher] })

    const result = await validateVoucherForInvoiceLink(
      supabase as never,
      'company-1',
      makeInvoice({
        currency: 'SEK',
        total: 1000,
        remaining_amount: 1000,
        paid_amount: null,
        status: 'sent',
        due_date: '2026-06-30',
        invoice_number: 'F-9004',
      }) as never,
      'je-sek'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arCreditAmount).toBe(1000)
    expect(result.paymentAmount).toBe(1000)
  })
})

// ============================================================
// Supplier side: 244x debits
// ============================================================

/** 1000 EUR supplier invoice, booked at 11.50 = 11 500 kr. */
function eurSupplierInvoice() {
  return makeSupplierInvoice({
    id: 'sinv-eur',
    supplier_invoice_number: 'L-9001',
    currency: 'EUR',
    total: 1000,
    total_sek: 11500,
    exchange_rate: 11.5,
    remaining_amount: 1000,
    paid_amount: 0,
    status: 'registered',
    invoice_date: '2026-06-01',
    due_date: '2026-06-30',
    // A number that appears in none of the voucher descriptions below: the OCR
    // pass matches on arrival_number and would short-circuit the amount logic
    // these tests are about. `arrival_number` is NOT NULL, hence a sentinel.
    arrival_number: 999999,
  })
}

const correctEurApVoucher = entry('je-ap-correct', 21, 'Betalning utlandsleverantor', [
  {
    id: 'l-ap-correct',
    account_number: '2440',
    debit_amount: 11500,
    credit_amount: 0,
    currency: 'EUR',
    amount_in_currency: 1000,
  },
])

const domesticApVoucher = entry('je-ap-sek', 22, 'Betalning leverantor', [
  {
    id: 'l-ap-sek',
    account_number: '2440',
    debit_amount: 1000,
    credit_amount: 0,
    currency: 'SEK',
  },
])

describe('findMatchingVouchersForSupplierInvoice: foreign-currency invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('quotes the AP debit in the invoice currency', async () => {
    const { supabase } = createFilteringSupabase({ entries: [correctEurApVoucher] })

    const [candidate] = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never
    )

    expect(candidate.journal_entry_id).toBe('je-ap-correct')
    expect(candidate.ap_debit_amount).toBe(1000)
    expect(candidate.currency).toBe('EUR')
  })

  it('never offers a rate-less domestic AP debit for a EUR invoice', async () => {
    const { supabase } = createFilteringSupabase({ entries: [domesticApVoucher] })

    const result = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never
    )

    expect(result).toEqual([])
  })

  it('reads every 244x debit, whatever its label, and projects both FX columns (feedback seq 930807)', async () => {
    // A SEK-booked payment voucher can settle a foreign invoice (the link
    // validator's SEK-booked fallback), so the 244x side is no longer narrowed
    // to lines labelled with the invoice's currency: it reads the same set a
    // SEK invoice reads.
    const { supabase, queries } = createFilteringSupabase({ entries: [correctEurApVoucher] })

    await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never
    )

    const lineQuery = queries.find((q) => q.table === 'journal_entry_lines')
    expect(lineQuery!.columns).toContain('amount_in_currency')
    expect(lineQuery!.columns).toContain('currency')
    expect(
      lineQuery!.filters.some((f) => f.op !== 'or' && f.column === 'currency')
    ).toBe(false)
  })

  // Feedback seq 930807: a USD invoice paid by an SIE-imported voucher whose
  // 2440 debit carries SEK only. The link validator accepted the pair and
  // settled it in full; the finder never proposed it.
  function usdInvoicePaidInSek() {
    return makeSupplierInvoice({
      id: 'sinv-usd',
      supplier_invoice_number: 'US-501',
      currency: 'USD',
      total: 4.8,
      total_sek: 45,
      exchange_rate: 9.375,
      remaining_amount: 4.8,
      paid_amount: 0,
      status: 'registered',
      invoice_date: '2026-06-01',
      due_date: '2026-06-30',
      arrival_number: 999999,
    })
  }

  const sekBookedUsdPayment = entry('je-usd-sek', 31, 'Betalning molntjanst', [
    { id: 'l-usd-sek-ap', account_number: '2440', debit_amount: 45, credit_amount: 0, currency: null },
    { id: 'l-usd-sek-bank', account_number: '1930', debit_amount: 0, credit_amount: 45, currency: null },
  ])

  it('proposes a SEK-booked 2440 debit for a foreign invoice, converted at the invoice rate, as the validator accepts it', async () => {
    const { supabase } = createFilteringSupabase({ entries: [sekBookedUsdPayment] })

    const candidates = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      usdInvoicePaidInSek() as never
    )

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      journal_entry_id: 'je-usd-sek',
      ap_debit_amount: 4.8,
      currency: 'USD',
      ap_line_currency: null,
      settlement_side: 'ap_debit',
    })
    expect(candidates[0].match_reason).toMatch(/bokförd i SEK/)

    const validation = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      usdInvoicePaidInSek() as never,
      'je-usd-sek'
    )
    expect(validation.ok).toBe(true)
    if (!validation.ok) return
    expect(validation.paymentAmount).toBe(4.8)
    expect(validation.isFullyPaid).toBe(true)
  })

  it('proposes nothing the validator would refuse: a SEK-booked debit far from the invoice rate', async () => {
    const offRate = entry('je-usd-off', 32, 'Betalning', [
      { id: 'l-usd-off-ap', account_number: '2440', debit_amount: 60, credit_amount: 0, currency: 'SEK' },
    ])
    const { supabase } = createFilteringSupabase({ entries: [offRate] })

    const candidates = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      usdInvoicePaidInSek() as never
    )
    expect(candidates).toEqual([])

    const validation = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      usdInvoicePaidInSek() as never,
      'je-usd-off'
    )
    expect(validation.ok).toBe(false)
    if (validation.ok) return
    expect(validation.details).toMatchObject({ reason: 'fx_deviation_too_large' })
  })

  it('proposes nothing the validator would refuse: a readable line next to a SEK-booked one', async () => {
    const mixed = entry('je-eur-mixed', 33, 'Betalning', [
      { id: 'l-mixed-eur', account_number: '2440', debit_amount: 5750, credit_amount: 0, currency: 'EUR', amount_in_currency: 500 },
      { id: 'l-mixed-sek', account_number: '2440', debit_amount: 5750, credit_amount: 0, currency: 'SEK' },
    ])
    const { supabase } = createFilteringSupabase({ entries: [mixed] })

    const candidates = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never
    )
    expect(candidates).toEqual([])

    const validation = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never,
      'je-eur-mixed'
    )
    expect(validation.ok).toBe(false)
    if (validation.ok) return
    expect(validation.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
  })

  it('SEK: matches on the raw column and adds no currency filter', async () => {
    const { supabase, queries } = createFilteringSupabase({ entries: [domesticApVoucher] })

    const [candidate] = await findMatchingVouchersForSupplierInvoice(
      supabase as never,
      'company-1',
      makeSupplierInvoice({
        currency: 'SEK',
        total: 1000,
        remaining_amount: 1000,
        paid_amount: 0,
        status: 'registered',
        due_date: '2026-06-30',
        supplier_invoice_number: 'L-9002',
        // A number that appears in none of the voucher descriptions below: the OCR
    // pass matches on arrival_number and would short-circuit the amount logic
    // these tests are about. `arrival_number` is NOT NULL, hence a sentinel.
    arrival_number: 999999,
      }) as never
    )

    expect(candidate.ap_debit_amount).toBe(1000)
    const lineQuery = queries.find((q) => q.table === 'journal_entry_lines')
    expect(
      lineQuery!.filters.some((f) => f.op !== 'or' && f.column === 'currency')
    ).toBe(false)
  })
})

describe('validateVoucherForSupplierInvoiceLink: foreign-currency invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts the correct EUR voucher instead of EXCEEDS_REMAINING', async () => {
    const { supabase } = createFilteringSupabase({ entries: [correctEurApVoucher] })

    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never,
      'je-ap-correct'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.apDebitAmount).toBe(1000)
    expect(result.paymentAmount).toBe(1000)
  })

  it('still rejects an AP debit that genuinely exceeds the remainder', async () => {
    const tooBig = entry('je-ap-toobig', 23, 'Betalning', [
      {
        id: 'l-ap-toobig',
        account_number: '2440',
        debit_amount: 17250,
        credit_amount: 0,
        currency: 'EUR',
        amount_in_currency: 1500,
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [tooBig] })

    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never,
      'je-ap-toobig'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING')
    expect(result.details).toMatchObject({ ap_debit: 1500, remaining: 1000 })
  })

  it('refuses a rate-less AP debit rather than reading it as EUR', async () => {
    const rateless = entry('je-ap-rateless', 24, 'Betalning', [
      {
        id: 'l-ap-rateless',
        account_number: '2440',
        debit_amount: 11500,
        credit_amount: 0,
        currency: 'EUR',
        amount_in_currency: null,
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [rateless] })

    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never,
      'je-ap-rateless'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
  })

  it('settles a plain SEK-booked 244x voucher via the FX fallback (RPC gate mirror)', async () => {
    const sekBooked = entry('je-ap-sekbooked', 26, 'Betalning', [
      {
        id: 'l-ap-sekbooked',
        account_number: '2440',
        debit_amount: 11200,
        credit_amount: 0,
        currency: 'SEK',
      },
      {
        id: 'l-ap-sekbooked-bank',
        account_number: '1930',
        debit_amount: 0,
        credit_amount: 11200,
        currency: 'SEK',
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [sekBooked] })

    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never,
      'je-ap-sekbooked'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.apDebitAmount).toBe(1000)
    expect(result.paymentAmount).toBe(1000)
    expect(result.remainingAfter).toBe(0)
    expect(result.isFullyPaid).toBe(true)
    expect(result.apLineCurrency).toBeNull()
  })

  it('keeps the refusal when a readable 244x line carries amount_in_currency 0', async () => {
    const mixedZero = entry('je-ap-mixed-zero', 27, 'Betalning', [
      {
        id: 'l-apmz-sek',
        account_number: '2440',
        debit_amount: 950,
        credit_amount: 0,
        currency: 'SEK',
      },
      {
        id: 'l-apmz-zero',
        account_number: '2440',
        debit_amount: 50,
        credit_amount: 0,
        currency: 'EUR',
        amount_in_currency: 0,
      },
      {
        id: 'l-apmz-bank',
        account_number: '1930',
        debit_amount: 0,
        credit_amount: 1000,
        currency: 'SEK',
      },
    ])
    const { supabase } = createFilteringSupabase({ entries: [mixedZero] })

    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      makeSupplierInvoice({
        id: 'sinv-eur-small',
        supplier_invoice_number: 'L-9010',
        currency: 'EUR',
        total: 100,
        total_sek: 1000,
        exchange_rate: 10,
        remaining_amount: 100,
        paid_amount: 0,
        status: 'registered',
        due_date: '2026-06-30',
        arrival_number: 999999,
      }) as never,
      'je-ap-mixed-zero'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
  })

  it('keeps the refusal when the SEK total deviates more than 10% from booked', async () => {
    const { supabase } = createFilteringSupabase({ entries: [domesticApVoucher] })

    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      eurSupplierInvoice() as never,
      'je-ap-sek'
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('LINK_SI_VOUCHER_CURRENCY_MISMATCH')
    expect(result.details).toMatchObject({ reason: 'fx_deviation_too_large' })
  })

  it('SEK: the happy path is unchanged', async () => {
    const { supabase } = createFilteringSupabase({ entries: [domesticApVoucher] })

    const result = await validateVoucherForSupplierInvoiceLink(
      supabase as never,
      'company-1',
      makeSupplierInvoice({
        currency: 'SEK',
        total: 1000,
        remaining_amount: 1000,
        paid_amount: 0,
        status: 'registered',
        due_date: '2026-06-30',
        supplier_invoice_number: 'L-9003',
        // A number that appears in none of the voucher descriptions below: the OCR
    // pass matches on arrival_number and would short-circuit the amount logic
    // these tests are about. `arrival_number` is NOT NULL, hence a sentinel.
    arrival_number: 999999,
      }) as never,
      'je-ap-sek'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.apDebitAmount).toBe(1000)
  })
})

// ============================================================
// The shared rule itself
// ============================================================

describe('ledgerLineSideAmountIn contract as used here', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is the same helper bank reconciliation uses', async () => {
    // The promotion to lib/bookkeeping/ledger-line-amount.ts must not have left
    // bank-reconciliation.ts without its export: a second implementation of
    // this rule is how the two sides drift apart again.
    const promoted = await import('@/lib/bookkeeping/ledger-line-amount')
    const reexported = await import('@/lib/reconciliation/bank-reconciliation')
    expect(reexported.ledgerLineAmountIn).toBe(promoted.ledgerLineAmountIn)
  })

  it('unused queued mock helper stays importable', () => {
    // Guards against the shared fixture factory drifting out from under the
    // sibling suites in this directory.
    expect(typeof createQueuedMockSupabase).toBe('function')
  })
})
