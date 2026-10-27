import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: sequential result queue (mirrors vat-declaration.test.ts)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'or', 'not', 'order', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

// get_vat_ruta_source_lines pages, in call order, on a queue of their own so
// the `.from()` queue above keeps its order. Empty: the declaration counts
// none of the unattributed verifikat.
let rpcResults: Array<{ data?: unknown; error?: unknown }>

// get_entries_with_account_lines (the period's verifikat on the PS accounts):
// 'missing' answers as a database without the function (PGRST202), so the
// generator reads the paged way and the queue above starts with that
// journal_entries page; 'queue' serves the same page through the function.
let entriesRpc: 'missing' | 'queue'

/** An entry fixture as get_entries_with_account_lines returns it. */
function asRpcRow(entry: { id: string; journal_entry_lines?: unknown[] | null }) {
  const { journal_entry_lines: lines, ...rest } = entry
  return {
    description: '',
    ...rest,
    lines: (lines ?? []).map((line, i) => ({ id: `${entry.id}-line-${i}`, ...(line as object) })),
  }
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
    rpc: vi.fn().mockImplementation(async (fn: string) => {
      if (fn === 'get_entries_with_account_lines') {
        if (entriesRpc === 'missing') {
          return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
        }
        const page = results[resultIdx++] ?? { data: [], error: null }
        const rows = (page.data ?? []) as Array<{ id: string; journal_entry_lines?: unknown[] | null }>
        return { data: page.error ? null : rows.map(asRpcRow), error: page.error ?? null }
      }
      return rpcResults.shift() ?? { data: [], error: null }
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

/** The get_vat_ruta_source_lines calls, in order (the declaration's drill-down). */
function sourceLineCalls(): unknown[][] {
  return (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => c[0] === 'get_vat_ruta_source_lines')
}

// The company's own momskoder on its accounts. Empty: the fixed BAS map
// (3308 → ruta 39, 3108 → ruta 35, 3107 → ruta 38) alone.
const dynamicAccounts = vi.hoisted(() => ({
  mappingByAccount: new Map<string, { box: string; side: 'credit' | 'debit' }>(),
  explicitAccounts: new Set<string>(),
}))
vi.mock('../vat-revenue-accounts', async (orig) => ({
  ...(await orig<typeof import('../vat-revenue-accounts')>()),
  fetchDynamicVatAccounts: vi.fn(async () => dynamicAccounts),
}))

// The momsdeklaration rutor the reconciliation compares against.
const declaredRutor = vi.hoisted(() => ({ ruta35: 0, ruta38: 0, ruta39: 0 }))
const calculateVatDeclarationMock = vi.hoisted(() => vi.fn())
vi.mock('../vat-declaration', async (orig) => ({
  ...(await orig<typeof import('../vat-declaration')>()),
  calculateVatDeclaration: calculateVatDeclarationMock,
}))

import {
  findUnattributedEuSales,
  generatePeriodiskSammanstallning,
  normalizeVatNumber,
  reconcilePsAgainstVatDeclaration,
} from '../periodisk-sammanstallning'
import { calculatePeriodDates, formatPeriodLabel } from '../period-dates'
import { buildPeriodiskSammanstallningCsv, PsCsvBuildError } from '../periodisk-sammanstallning-csv'

const FILER = {
  organizationNumber: '5560000167',
  contactName: 'Test Person',
  contactPhone: '0123-45690',
  contactEmail: 'ps@example.com',
}

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  rpcResults = []
  entriesRpc = 'missing'
  dynamicAccounts.mappingByAccount.clear()
  dynamicAccounts.explicitAccounts.clear()
  supabase = makeClient()
})

// ============================================================
// Pure helpers
// ============================================================

describe('calculatePeriodDates', () => {
  it('monthly January', () => {
    expect(calculatePeriodDates('monthly', 2025, 1)).toEqual({ start: '2025-01-01', end: '2025-01-31' })
  })
  it('monthly December', () => {
    expect(calculatePeriodDates('monthly', 2025, 12)).toEqual({ start: '2025-12-01', end: '2025-12-31' })
  })
  it('quarterly Q2', () => {
    expect(calculatePeriodDates('quarterly', 2025, 2)).toEqual({ start: '2025-04-01', end: '2025-06-30' })
  })
  it('quarterly Q4', () => {
    expect(calculatePeriodDates('quarterly', 2025, 4)).toEqual({ start: '2025-10-01', end: '2025-12-31' })
  })
})

describe('formatPeriodLabel', () => {
  it('monthly', () => expect(formatPeriodLabel('monthly', 2025, 5)).toBe('Maj 2025'))
  it('quarterly', () => expect(formatPeriodLabel('quarterly', 2025, 2)).toBe('Kvartal 2 2025'))
})

describe('normalizeVatNumber', () => {
  it('strips Swedish country prefix', () => {
    expect(normalizeVatNumber('SE556677889901')).toBe('556677889901')
  })
  it('strips whitespace and uppercases', () => {
    expect(normalizeVatNumber('  de 123456789  ')).toBe('123456789')
  })
  it('handles EL prefix', () => {
    expect(normalizeVatNumber('EL123456789')).toBe('123456789')
  })
  it('handles already-stripped numbers', () => {
    expect(normalizeVatNumber('556677889901')).toBe('556677889901')
  })
  it('handles null/empty', () => {
    expect(normalizeVatNumber(null)).toBe('')
    expect(normalizeVatNumber('')).toBe('')
  })
})

// ============================================================
// Generator
// ============================================================

interface InvoiceFx {
  id: string
  customer: {
    id: string
    name: string
    country: string | null
    vat_number: string | null
    vat_number_validated?: boolean
    vat_number_validated_at?: string | null
  } | null
}

interface LineFx {
  account_number: string
  debit_amount: number
  credit_amount: number
}

// Recent validation so VIES_UNVALIDATED warnings don't fire by default.
const RECENT = new Date().toISOString()

// The generator fetches the period's entries with their PS-account lines
// embedded (journal_entries + journal_entry_lines!inner, one page here), then
// resolves each entry's invoice: the engine's own entries by source_id,
// everything else through getInvoiceReferencesForJournalEntries (invoices by
// journal_entry_id, then invoice_payments), and finally loads the invoices
// with their customer. Queue order per test:
//   1. journal_entries page (with embedded lines)
//   2. invoices by journal_entry_id   only when a non-engine entry exists
//   3. invoice_payments               only when a non-engine entry exists
//   4. invoices by id                 only when some invoice id resolved
function je(sourceId: string) {
  return `je-${sourceId}`
}

function entryEU(sourceId: string, lines: LineFx[] = []) {
  return {
    id: je(sourceId),
    entry_date: '2025-05-15',
    status: 'posted',
    source_type: 'invoice_created',
    source_id: sourceId,
    journal_entry_lines: lines,
  }
}

function entryCredit(sourceId: string, lines: LineFx[] = []) {
  return {
    id: je(sourceId),
    entry_date: '2025-05-20',
    status: 'posted',
    source_type: 'credit_note',
    source_id: sourceId,
    journal_entry_lines: lines,
  }
}

/** A verifikat that did not come from the invoice engine (SIE import, manual). */
function entryOther(id: string, sourceType: string, lines: LineFx[] = []) {
  return {
    id,
    entry_date: '2025-05-15',
    status: 'posted',
    source_type: sourceType,
    source_id: null as string | null,
    journal_entry_lines: lines,
  }
}

function lineEU(account: string, credit: number): LineFx {
  return { account_number: account, debit_amount: 0, credit_amount: credit }
}

function lineCredit(account: string, debit: number): LineFx {
  return { account_number: account, debit_amount: debit, credit_amount: 0 }
}

/** A get_vat_ruta_source_lines row: the declaration counts this verifikat. */
function sourceLine(entryId: string, lineId = `line-${entryId}`) {
  return { line_id: lineId, journal_entry_id: entryId, voucher_number: 1, voucher_series: 'A', entry_date: '2025-05-15' }
}

function invDE(id = 'inv-de', customer = 'cust-de', name = 'DE Customer', vat = 'DE123456789'): InvoiceFx {
  return {
    id,
    customer: {
      id: customer,
      name,
      country: 'DE',
      vat_number: vat,
      vat_number_validated: true,
      vat_number_validated_at: RECENT,
    },
  }
}

describe('generatePeriodiskSammanstallning', () => {
  it('empty period returns zero rows and zero warnings', async () => {
    // journal_entries: none match → every lookup is skipped.
    results = [{ data: [], error: null }]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.totals.rowCount).toBe(0)
    expect(report.totals.grand).toBe(0)
    expect(report.period.label).toBe('Maj 2025')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('single EU service sale → 1 row, type 3 only', async () => {
    results = [
      { data: [entryEU('inv-de', [lineEU('3308', 10000)])], error: null },
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({
      country: 'DE',
      vatNumber: '123456789',
      services: 10000,
      goods: 0,
      triangulation: 0,
    })
    expect(report.totals).toMatchObject({ services: 10000, goods: 0, triangulation: 0, grand: 10000, rowCount: 1 })
    expect(report.warnings).toEqual([])
    // Engine entries resolve by source_id: no invoice-link round trips.
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('aggregates multiple invoices to same customer', async () => {
    results = [
      {
        data: [
          entryEU('inv1', [lineEU('3308', 4000)]),
          entryEU('inv2', [lineEU('3308', 3500)]),
          entryEU('inv3', [lineEU('3308', 2500)]),
        ],
        error: null,
      },
      {
        data: [
          { ...invDE('inv1') },
          { ...invDE('inv2') },
          { ...invDE('inv3') },
        ],
        error: null,
      },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].services).toBe(10000)
  })

  it('one customer with both services and goods → 1 row with both filled', async () => {
    results = [
      {
        data: [
          entryEU('inv1', [lineEU('3308', 7000)]),
          entryEU('inv2', [lineEU('3108', 5000)]),
        ],
        error: null,
      },
      {
        data: [invDE('inv1'), invDE('inv2')],
        error: null,
      },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ services: 7000, goods: 5000, triangulation: 0 })
  })

  it('credit invoice nets against original in same period', async () => {
    results = [
      {
        data: [
          entryEU('inv1', [lineEU('3308', 10000)]),
          entryCredit('cn1', [lineCredit('3308', 3000)]),
        ],
        error: null,
      },
      {
        data: [invDE('inv1'), invDE('cn1')],
        error: null,
      },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].services).toBe(7000)
  })

  it('credit fully cancels → row excluded with ZERO_NET_EXCLUDED warning', async () => {
    results = [
      {
        data: [
          entryEU('inv1', [lineEU('3308', 10000)]),
          entryCredit('cn1', [lineCredit('3308', 10000)]),
        ],
        error: null,
      },
      { data: [invDE('inv1'), invDE('cn1')], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toHaveLength(0)
    expect(report.warnings.some(w => w.code === 'ZERO_NET_EXCLUDED')).toBe(true)
  })

  it('customer missing country → MISSING_COUNTRY error and row blocked', async () => {
    results = [
      { data: [entryEU('inv1', [lineEU('3308', 5000)])], error: null },
      {
        data: [{
          id: 'inv1',
          customer: { id: 'c1', name: 'No Country', country: null, vat_number: 'DE123', vat_number_validated: true, vat_number_validated_at: RECENT },
        }],
        error: null,
      },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings.some(w => w.code === 'MISSING_COUNTRY' && w.level === 'error')).toBe(true)
    expect(report.rows[0]?.hasBlockingIssue).toBe(true)
  })

  it('customer missing vat_number → MISSING_VAT_NUMBER error', async () => {
    results = [
      { data: [entryEU('inv1', [lineEU('3308', 5000)])], error: null },
      {
        data: [{
          id: 'inv1',
          customer: { id: 'c1', name: 'No VAT', country: 'DE', vat_number: null, vat_number_validated: false, vat_number_validated_at: null },
        }],
        error: null,
      },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings.some(w => w.code === 'MISSING_VAT_NUMBER' && w.level === 'error')).toBe(true)
    expect(report.rows[0]?.hasBlockingIssue).toBe(true)
  })

  it('VAT prefix mismatch surfaces COUNTRY_PREFIX_MISMATCH warning', async () => {
    results = [
      { data: [entryEU('inv1', [lineEU('3308', 5000)])], error: null },
      {
        data: [{
          id: 'inv1',
          customer: { id: 'c1', name: 'Mixed', country: 'DE', vat_number: 'FR123456', vat_number_validated: true, vat_number_validated_at: RECENT },
        }],
        error: null,
      },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings.some(w => w.code === 'COUNTRY_PREFIX_MISMATCH')).toBe(true)
    expect(report.rows).toHaveLength(1)
  })

  it('non-EU country on EU account → NON_EU_COUNTRY_ON_EU_ACCOUNT and excluded from CSV', async () => {
    results = [
      { data: [entryEU('inv1', [lineEU('3308', 5000)])], error: null },
      {
        data: [{
          id: 'inv1',
          customer: { id: 'c1', name: 'US Co', country: 'US', vat_number: 'US123', vat_number_validated: true, vat_number_validated_at: RECENT },
        }],
        error: null,
      },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings.some(w => w.code === 'NON_EU_COUNTRY_ON_EU_ACCOUNT')).toBe(true)
    expect(report.rows[0].hasBlockingIssue).toBe(true)
  })

  it('Greek customer → country code emitted as EL', async () => {
    results = [
      { data: [entryEU('inv1', [lineEU('3308', 4200)])], error: null },
      {
        data: [{
          id: 'inv1',
          customer: { id: 'c1', name: 'Hellas', country: 'GR', vat_number: 'EL123456', vat_number_validated: true, vat_number_validated_at: RECENT },
        }],
        error: null,
      },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows[0].country).toBe('EL')
  })

  it('goods sold in quarterly period → GOODS_SOLD_WITH_QUARTERLY_PERIOD warning', async () => {
    results = [
      { data: [entryEU('inv1', [lineEU('3108', 9000)])], error: null },
      { data: [{ ...invDE('inv1') }], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 2)

    expect(report.warnings.some(w => w.code === 'GOODS_SOLD_WITH_QUARTERLY_PERIOD')).toBe(true)
  })

  it('sorts rows by country then vat_number', async () => {
    results = [
      {
        data: [
          entryEU('inv-fr', [lineEU('3308', 1000)]),
          entryEU('inv-de', [lineEU('3308', 2000)]),
          entryEU('inv-at', [lineEU('3308', 3000)]),
        ],
        error: null,
      },
      {
        data: [
          { id: 'inv-fr', customer: { id: 'fr', name: 'FR', country: 'FR', vat_number: 'FR999', vat_number_validated: true, vat_number_validated_at: RECENT } },
          { id: 'inv-de', customer: { id: 'de', name: 'DE', country: 'DE', vat_number: 'DE888', vat_number_validated: true, vat_number_validated_at: RECENT } },
          { id: 'inv-at', customer: { id: 'at', name: 'AT', country: 'AT', vat_number: 'ATU111', vat_number_validated: true, vat_number_validated_at: RECENT } },
        ],
        error: null,
      },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows.map(r => r.country)).toEqual(['AT', 'DE', 'FR'])
  })

  it('an engine entry whose invoice is gone → CUSTOMER_NOT_FOUND error (a data defect, never silence)', async () => {
    results = [
      { data: [entryEU('inv-gone', [lineEU('3308', 5000)])], error: null },
      { data: [], error: null }, // invoices by id: nothing
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings.some(w => w.code === 'CUSTOMER_NOT_FOUND' && w.level === 'error')).toBe(true)
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].hasBlockingIssue).toBe(true)
  })

  it('rejects yearly period type', async () => {
    await expect(
      generatePeriodiskSammanstallning(supabase, 'c1', 'yearly' as 'monthly', 2025, 1),
    ).rejects.toThrow()
  })
})

// ============================================================
// Invoice links beyond the engine's own source columns (#2298)
// ============================================================

describe('invoice links beyond the engine source columns (#2298)', () => {
  it('files a SIE-imported sale matched to its invoice through invoice_payments', async () => {
    // The reported case: the importer wrote debit 1930 / credit 3308 with
    // source_type 'import', the user created the invoice in Accounted and
    // matched it to the imported verifikat (link_invoice_to_voucher). The link
    // lives on invoice_payments only; the entry keeps its source columns.
    results = [
      { data: [entryOther('je-imp', 'import', [lineEU('3308', 12000)])], error: null },
      { data: [], error: null }, // invoices by journal_entry_id: none
      { data: [{ id: 'pay-1', invoice_id: 'inv-de', journal_entry_id: 'je-imp' }], error: null },
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings).toEqual([])
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ country: 'DE', vatNumber: '123456789', services: 12000 })
    expect(report.totals.services).toBe(12000)
  })

  it('files a manual verifikat the invoice register points at through invoices.journal_entry_id', async () => {
    results = [
      { data: [entryOther('je-man', 'manual', [lineEU('3308', 8000)])], error: null },
      { data: [{ id: 'inv-de', journal_entry_id: 'je-man' }], error: null },
      { data: [], error: null }, // invoice_payments: none
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings).toEqual([])
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ country: 'DE', services: 8000 })
  })

  it('files a kontantmetod inbetalning (invoice_cash_payment) by its source_id', async () => {
    // Cash-method companies book revenue at payment, so this is the only
    // entry that ever carries their 3308 postings.
    const entry = { ...entryOther('je-cash', 'invoice_cash_payment', [lineEU('3308', 6000)]), source_id: 'inv-de' }
    results = [
      { data: [entry], error: null },
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings).toEqual([])
    expect(report.rows[0]).toMatchObject({ country: 'DE', services: 6000 })
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('reports an imported 3308 posting no invoice points at as an UNATTRIBUTED_EU_SALE warning, without an invoice lookup', async () => {
    results = [
      { data: [entryOther('je-loose', 'import', [lineEU('3308', 9000)])], error: null },
      { data: [], error: null }, // invoices by journal_entry_id: none
      { data: [], error: null }, // invoice_payments: none
    ]
    rpcResults = [{ data: [sourceLine('je-loose')], error: null }]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toEqual([])
    expect(report.warnings).toEqual([
      expect.objectContaining({ level: 'warning', code: 'UNATTRIBUTED_EU_SALE', journalEntryId: 'je-loose', amount: 9000 }),
    ])
    // No invoice ids resolved → the invoices-by-id lookup is skipped.
    expect(supabase.from).toHaveBeenCalledTimes(3)
  })

  it('aggregates an engine invoice and a linked import to the same customer into one row', async () => {
    results = [
      {
        data: [
          entryEU('inv-a', [lineEU('3308', 4000)]),
          entryOther('je-imp', 'import', [lineEU('3308', 6000)]),
        ],
        error: null,
      },
      { data: [], error: null }, // invoices by journal_entry_id
      { data: [{ id: 'pay-1', invoice_id: 'inv-b', journal_entry_id: 'je-imp' }], error: null },
      { data: [invDE('inv-a'), invDE('inv-b')], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].services).toBe(10000)
    expect(report.warnings).toEqual([])
  })

  it('does not double count an entry the engine tagged AND a payment row points at', async () => {
    // invoice_cash_payment entries carry source_id = invoice AND an
    // invoice_payments row: one posting, one attribution.
    const entry = { ...entryOther('je-cash', 'invoice_cash_payment', [lineEU('3308', 6000)]), source_id: 'inv-de' }
    results = [
      { data: [entry, entryOther('je-imp', 'import', [lineEU('3308', 1000)])], error: null },
      { data: [], error: null },
      { data: [
        { id: 'pay-1', invoice_id: 'inv-de', journal_entry_id: 'je-cash' },
        { id: 'pay-2', invoice_id: 'inv-de', journal_entry_id: 'je-imp' },
      ], error: null },
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].services).toBe(7000)
  })
})

// ============================================================
// Reconciliation
// ============================================================

describe('reconcilePsAgainstVatDeclaration', () => {
  beforeEach(() => {
    Object.assign(declaredRutor, { ruta35: 0, ruta38: 0, ruta39: 0 })
    calculateVatDeclarationMock.mockImplementation(async () => ({ rutor: { ...declaredRutor } }))
  })

  it('reconciles a quarterly list against the rutor of the same dates, whatever the momsperiod (crm#1336)', async () => {
    // A manual EU service sale no invoice names a buyer for: the list is empty, ruta 39 is not.
    const manual = { ...entryOther('je-manual', 'manual', [lineEU('3308', 4431.88)]), voucher_series: 'A', voucher_number: 66 }
    results = [
      { data: [manual], error: null },
      { data: [], error: null }, // invoices by journal_entry_id: none
      { data: [], error: null }, // invoice_payments: none
    ]
    rpcResults = [{ data: [sourceLine('je-manual')], error: null }]
    declaredRutor.ruta39 = 4432

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 2)
    const reconciled = await reconcilePsAgainstVatDeclaration(supabase, 'c1', report)

    expect(calculateVatDeclarationMock).toHaveBeenCalledWith(supabase, 'c1', 'quarterly', 2025, 2)
    expect(reconciled.reconciliation).toMatchObject({ ruta39: 4432, matches: false })
    expect(reconciled.warnings.find((w) => w.code === 'UNATTRIBUTED_EU_SALE')).toMatchObject({
      voucher: 'A66',
      ruta: '39',
      resolveWith: 'register_booked_invoice',
      journalEntryId: 'je-manual',
    })
    const difference = reconciled.warnings.find((w) => w.code === 'RUTA_DIFFERENCE')
    expect(difference).toMatchObject({ level: 'warning', ruta: '39', amount: 4432 })
    expect(difference?.message).toContain('ruta 39')
    expect(difference?.message).toContain('A66')
    // A warning, never a new refusal: no error-level finding is added.
    expect(reconciled.warnings.filter((w) => w.level === 'error')).toEqual([])
  })

  it('matches without a difference warning when the listed buyers carry the whole ruta', async () => {
    results = [
      { data: [entryEU('inv-de', [lineEU('3308', 15000)])], error: null },
      { data: [invDE()], error: null },
    ]
    declaredRutor.ruta39 = 15000

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)
    const reconciled = await reconcilePsAgainstVatDeclaration(supabase, 'c1', report)

    expect(reconciled.reconciliation).toMatchObject({ ruta39: 15000, ruta35: 0, ruta38: 0, matches: true })
    expect(reconciled.warnings.map((w) => w.code)).not.toContain('RUTA_DIFFERENCE')
  })

  it('names no verifikat when the difference has another cause', async () => {
    results = [
      { data: [entryEU('inv-de', [lineEU('3108', 10000)])], error: null },
      { data: [invDE()], error: null },
    ]
    declaredRutor.ruta35 = 12000

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)
    const reconciled = await reconcilePsAgainstVatDeclaration(supabase, 'c1', report)

    const difference = reconciled.warnings.find((w) => w.code === 'RUTA_DIFFERENCE')
    expect(difference).toMatchObject({ ruta: '35', amount: 2000 })
    expect(difference?.message).toContain('Kontrollera bokföringen')
  })
})

describe('legacy country names on customers (#2028)', () => {
  it('reads a stored country name as its ISO code: no false warnings, correct CSV country', async () => {
    const legacy = invDE()
    legacy.customer!.country = 'Germany'
    results = [
      { data: [entryEU('inv-de', [lineEU('3308', 15000)])], error: null },
      { data: [legacy], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings).toEqual([])
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ country: 'DE', vatNumber: '123456789', services: 15000 })
  })

  it('still names an unmapped country in the warning', async () => {
    const legacy = invDE()
    legacy.customer!.country = 'Atlantis'
    results = [
      { data: [entryEU('inv-de', [lineEU('3308', 15000)])], error: null },
      { data: [legacy], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings.map((w) => w.code)).toContain('NON_EU_COUNTRY_ON_EU_ACCOUNT')
    expect(report.warnings.find((w) => w.code === 'NON_EU_COUNTRY_ON_EU_ACCOUNT')?.message).toContain('ATLANTIS')
  })
})

// ============================================================
// One verifikat settling several invoices (#2298 review)
// ============================================================

describe('one verifikat settling several invoices (#2298 review)', () => {
  function invFR(id: string): InvoiceFx {
    return {
      id,
      customer: {
        id: 'cust-fr',
        name: 'FR Customer',
        country: 'FR',
        vat_number: 'FR999',
        vat_number_validated: true,
        vat_number_validated_at: RECENT,
      },
    }
  }

  /** An imported deposit (two PS lines) that a payment row links to two invoices. */
  function settlement(lines: LineFx[]) {
    return {
      ...entryOther('je-imp', 'import', lines),
      voucher_series: 'A',
      voucher_number: 7,
    }
  }
  const twoPayments = [
    { id: 'pay-1', invoice_id: 'inv-a', journal_entry_id: 'je-imp' },
    { id: 'pay-2', invoice_id: 'inv-b', journal_entry_id: 'je-imp' },
  ]

  it('same customer on every linked invoice: filed once, in full', async () => {
    results = [
      { data: [settlement([lineEU('3308', 10000)])], error: null },
      { data: [], error: null }, // invoices by journal_entry_id
      { data: twoPayments, error: null },
      { data: [invDE('inv-a'), invDE('inv-b')], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings).toEqual([])
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ country: 'DE', vatNumber: '123456789', services: 10000 })
  })

  it('different customers on the linked invoices: blocking MIXED_CUSTOMER_SETTLEMENT, amount left out', async () => {
    results = [
      { data: [settlement([lineEU('3308', 6000), lineEU('3108', 4000)])], error: null },
      { data: [], error: null },
      { data: twoPayments, error: null },
      { data: [invDE('inv-a'), invFR('inv-b')], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toEqual([])
    expect(report.totals.grand).toBe(0)
    // Once per verifikat even though it carries two PS lines; blocking, so
    // the CSV route refuses the file (it keys on level === 'error').
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toMatchObject({
      level: 'error',
      code: 'MIXED_CUSTOMER_SETTLEMENT',
      journalEntryId: 'je-imp',
      amount: 10000,
    })
    expect(report.warnings[0].message).toContain('A7')
    expect(report.warnings[0].message).toContain('2 olika kunder')
  })

  it('two customer rows with the same VAT number still count as different customers', async () => {
    results = [
      { data: [settlement([lineEU('3308', 10000)])], error: null },
      { data: [], error: null },
      { data: twoPayments, error: null },
      { data: [invDE('inv-a', 'cust-de'), invDE('inv-b', 'cust-de-duplicate')], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toEqual([])
    expect(report.warnings.map((w) => w.code)).toEqual(['MIXED_CUSTOMER_SETTLEMENT'])
  })

  it('an engine entry is never a settlement: source_id names exactly one invoice', async () => {
    // Even if a payment row also points at it (invoice_cash_payment does),
    // the engine's own source_id wins and no settlement check runs.
    const entry = { ...entryOther('je-cash', 'invoice_cash_payment', [lineEU('3308', 5000)]), source_id: 'inv-a' }
    results = [
      { data: [entry], error: null },
      { data: [invDE('inv-a')], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings).toEqual([])
    expect(report.rows[0]).toMatchObject({ services: 5000 })
  })
})

// ============================================================
// Storno and rättelse chains (#2351)
// ============================================================

describe('storno and rättelse chains (#2351)', () => {
  /**
   * What reverseEntry() / correctEntry() write for the storno: source_type
   * 'storno' and reverses_id. reverseEntry() also copies the original's
   * source_id; correctEntry() copies nothing. The resolver follows the link
   * column either way, so the fixtures leave source_id null unless a test
   * says otherwise.
   */
  function entryStorno(id: string, reversesId: string, lines: LineFx[], extra: Record<string, unknown> = {}) {
    return {
      id,
      entry_date: '2025-05-25',
      status: 'posted',
      source_type: 'storno',
      source_id: null as string | null,
      reverses_id: reversesId,
      correction_of_id: null,
      journal_entry_lines: lines,
      ...extra,
    }
  }

  /** The correction correctEntry() writes: source_type 'correction', correction_of_id. */
  function entryCorrection(id: string, correctionOfId: string, lines: LineFx[]) {
    return {
      id,
      entry_date: '2025-05-25',
      status: 'posted',
      source_type: 'correction',
      source_id: null as string | null,
      reverses_id: null,
      correction_of_id: correctionOfId,
      journal_entry_lines: lines,
    }
  }

  /** Table of every `.from()` call, in order: pins which lookups ran. */
  const fromTables = () => (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])

  it('a reversed EU invoice voucher and its storno in the same period net to ZERO_NET_EXCLUDED', async () => {
    // The reported case: the registration voucher was stornoed with
    // reverseEntry(). status 'reversed' keeps the original in the fetch; the
    // storno (source_id copied, reverses_id set) must be filed under the same
    // invoice or the makulerad sale is over-reported while ruta 39 nets it.
    results = [
      {
        data: [
          { ...entryEU('inv-de', [lineEU('3308', 10000)]), status: 'reversed' },
          entryStorno('je-storno', je('inv-de'), [lineCredit('3308', 10000)], { source_id: 'inv-de' }),
        ],
        error: null,
      },
      { data: [], error: null }, // invoices by journal_entry_id: the storno
      { data: [], error: null }, // invoice_payments: the storno
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toEqual([])
    expect(report.totals.grand).toBe(0)
    expect(report.warnings.map((w) => w.code)).toEqual(['ZERO_NET_EXCLUDED'])
    expect(report.warnings[0].message).toContain('makulering')
    // The original is in the batch: no parent fetch.
    expect(fromTables()).toEqual(['journal_entries', 'invoices', 'invoice_payments', 'invoices'])
  })

  it('a rättelse chain (original, storno, correction) is filed once, at the corrected amount', async () => {
    // correctEntry() copies no source_id onto either new entry: only the
    // link columns tie them to the invoice.
    results = [
      {
        data: [
          { ...entryEU('inv-de', [lineEU('3308', 10000)]), status: 'reversed' },
          entryStorno('je-storno', je('inv-de'), [lineCredit('3308', 10000)]),
          entryCorrection('je-correction', je('inv-de'), [lineEU('3308', 12000)]),
        ],
        error: null,
      },
      { data: [], error: null },
      { data: [], error: null },
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings).toEqual([])
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ country: 'DE', vatNumber: '123456789', services: 12000 })
  })

  it('a storno booked in a later period is filed under the original\'s customer, like a later credit note', async () => {
    // June holds only the storno; the May original is loaded by id so the
    // PS for June nets the same way ruta 39 does for June.
    results = [
      {
        data: [
          entryStorno('je-storno', 'je-may', [lineCredit('3308', 10000)], { entry_date: '2025-06-03' }),
        ],
        error: null,
      },
      { data: [], error: null }, // invoices by journal_entry_id
      { data: [], error: null }, // invoice_payments
      {
        data: [{ id: 'je-may', source_type: 'invoice_created', source_id: 'inv-de', reverses_id: null, correction_of_id: null }],
        error: null,
      }, // journal_entries by id: the May original
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 6)

    expect(report.warnings).toEqual([])
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ country: 'DE', vatNumber: '123456789', services: -10000 })
    expect(fromTables()).toEqual(['journal_entries', 'invoices', 'invoice_payments', 'journal_entries', 'invoices'])
  })

  it('mirror: a manual 3308 posting no invoice points at and its storno net to nothing, in neither figure', async () => {
    results = [
      {
        data: [
          { ...entryOther('je-man', 'manual', [lineEU('3308', 5000)]), status: 'reversed' },
          entryStorno('je-storno', 'je-man', [lineCredit('3308', 5000)]),
        ],
        error: null,
      },
      { data: [], error: null }, // invoices by journal_entry_id: both
      { data: [], error: null }, // invoice_payments: both
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toEqual([])
    expect(report.warnings).toEqual([])
    // The original is in the batch and unexplained: no parent fetch, no
    // invoice load; the chain nets to zero, so the declaration is not asked.
    expect(fromTables()).toEqual(['journal_entries', 'invoices', 'invoice_payments'])
    expect(sourceLineCalls()).toHaveLength(0)
  })

  it('a rättelse chain of a manual EU sale is one UNATTRIBUTED_EU_SALE at the corrected amount, on the correction (crm#1336)', async () => {
    results = [
      {
        data: [
          { ...entryOther('je-man', 'manual', [lineEU('3308', 5000)]), status: 'reversed', voucher_series: 'A', voucher_number: 10 },
          { ...entryStorno('je-storno', 'je-man', [lineCredit('3308', 5000)]), voucher_series: 'A', voucher_number: 11 },
          { ...entryCorrection('je-correction', 'je-man', [lineEU('3308', 6000)]), voucher_series: 'A', voucher_number: 12 },
        ],
        error: null,
      },
      { data: [], error: null },
      { data: [], error: null },
    ]
    rpcResults = [{ data: [sourceLine('je-man'), sourceLine('je-storno'), sourceLine('je-correction')], error: null }]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toMatchObject({ code: 'UNATTRIBUTED_EU_SALE', level: 'warning', journalEntryId: 'je-correction', amount: 6000 })
    expect(report.warnings[0].message).toContain('A10, A11, A12')
  })

  it('a storno booked in a later period of an unattributed sale is reported negative, as ruta 39 nets it there', async () => {
    results = [
      {
        data: [entryStorno('je-storno', 'je-may-manual', [lineCredit('3308', 5000)], { entry_date: '2025-06-03' })],
        error: null,
      },
      { data: [], error: null }, // invoices by journal_entry_id
      { data: [], error: null }, // invoice_payments
      {
        data: [{ id: 'je-may-manual', source_type: 'manual', source_id: null, reverses_id: null, correction_of_id: null }],
        error: null,
      }, // journal_entries by id: the May original, unexplained too
    ]
    rpcResults = [{ data: [sourceLine('je-storno')], error: null }]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 6)

    expect(report.rows).toEqual([])
    expect(report.warnings).toEqual([
      expect.objectContaining({ code: 'UNATTRIBUTED_EU_SALE', journalEntryId: 'je-storno', amount: -5000 }),
    ])
  })

  it('a storno of a linked import nets it: the link lives on the original', async () => {
    results = [
      {
        data: [
          entryOther('je-imp', 'import', [lineEU('3308', 12000)]),
          entryStorno('je-storno', 'je-imp', [lineCredit('3308', 12000)]),
        ],
        error: null,
      },
      { data: [], error: null },
      { data: [{ id: 'pay-1', invoice_id: 'inv-de', journal_entry_id: 'je-imp' }], error: null },
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toEqual([])
    expect(report.warnings.map((w) => w.code)).toEqual(['ZERO_NET_EXCLUDED'])
  })

  it('a storno of an engine entry whose invoice is gone is reported, never silenced', async () => {
    results = [
      {
        data: [
          { ...entryEU('inv-gone', [lineEU('3308', 5000)]), status: 'reversed' },
          entryStorno('je-storno', je('inv-gone'), [lineCredit('3308', 5000)]),
        ],
        error: null,
      },
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null }, // invoices by id: nothing
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    // One blocking error per posting, the same verdict the original gets.
    expect(report.warnings.filter((w) => w.code === 'CUSTOMER_NOT_FOUND' && w.level === 'error')).toHaveLength(2)
  })
})

describe('EU sales the declaration counts but no invoice names a buyer for (crm#1336)', () => {
  /** A manual verifikat, as the bookkeeping form posts it: 1510 / 3308 (only the PS line is embedded). */
  function manualSale(id: string, voucherNumber: number, lines: LineFx[], extra: Record<string, unknown> = {}) {
    return {
      ...entryOther(id, 'manual', lines),
      voucher_series: 'A',
      voucher_number: voucherNumber,
      entry_date: '2025-09-13',
      reverses_id: null,
      correction_of_id: null,
      ...extra,
    }
  }

  it('the reported case: a manual EU service sale in a quarterly PS is a warning naming the verifikat, not an empty report', async () => {
    results = [
      { data: [manualSale('je-a7', 7, [lineEU('3308', 1234.56)])], error: null },
      { data: [], error: null }, // invoices by journal_entry_id
      { data: [], error: null }, // invoice_payments
    ]
    rpcResults = [{ data: [sourceLine('je-a7')], error: null }]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 3)

    // Nothing to file under a buyer...
    expect(report.rows).toEqual([])
    expect(report.totals.grand).toBe(0)
    // ...but the sale is named, with what the declaration holds for it.
    expect(report.warnings).toHaveLength(1)
    const [warning] = report.warnings
    // A warning, not a block: a service is owed a PS row only when the buyer
    // has a VAT number and it is taxed in the buyer's country.
    expect(warning).toMatchObject({ level: 'warning', code: 'UNATTRIBUTED_EU_SALE', journalEntryId: 'je-a7', amount: 1234.56 })
    expect(warning.message).toContain('Verifikat A7 (2025-09-13)')
    expect(warning.message).toContain('konto 3308 (ruta 39)')
    expect(warning.message).toMatch(/1\s234,56\s*kr/)
    expect(warning.message).toContain('kan vara ofullständig')
    expect(warning.message).toContain('Om köparen har ett VAT-nummer och tjänsten beskattas i köparens land')
    // The declaration was asked for the period, on the PS accounts, with
    // the settlement-shape parameters the figure uses.
    expect(sourceLineCalls()).toHaveLength(1)
    expect(supabase.rpc).toHaveBeenCalledWith('get_vat_ruta_source_lines', expect.objectContaining({
      p_company_id: 'c1',
      p_start: '2025-07-01',
      p_end: '2025-09-30',
      p_accounts: expect.arrayContaining(['3308', '3108', '3107']),
      p_net_accounts: ['2650', '1650'],
      p_cursor_date: null,
    }))
  })

  it('a posting the declaration does not count (the posted bokslut zeroing 3308) is in neither figure: no warning', async () => {
    results = [
      { data: [manualSale('je-bokslut', 99, [lineCredit('3308', 50000)], { source_type: 'year_end', entry_date: '2025-12-31' })], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]
    rpcResults = [{ data: [], error: null }]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 4)

    expect(report.rows).toEqual([])
    expect(report.warnings).toEqual([])
    expect(sourceLineCalls()).toHaveLength(1)
  })

  it('an invoiced EU service sale is filed next to an unattributed one, and the file is still allowed', async () => {
    results = [
      {
        data: [
          entryEU('inv-de', [lineEU('3308', 10000)]),
          manualSale('je-a8', 8, [lineEU('3308', 2500)]),
        ],
        error: null,
      },
      { data: [], error: null }, // invoices by journal_entry_id
      { data: [], error: null }, // invoice_payments
      { data: [invDE()], error: null },
    ]
    rpcResults = [{ data: [sourceLine(je('inv-de')), sourceLine('je-a8')], error: null }]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 3)

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ country: 'DE', services: 10000, hasBlockingIssue: false })
    expect(report.warnings.map((w) => [w.code, w.level])).toEqual([['UNATTRIBUTED_EU_SALE', 'warning']])
    expect(report.warnings[0].amount).toBe(2500)
    const csv = buildPeriodiskSammanstallningCsv(report, FILER).content.toString('utf-8')
    expect(csv).toContain('DE123456789;10000;')
  })

  it.each([
    ['3108', 'ruta 35', 'goods'],
    ['3107', 'ruta 38', 'triangulation'],
  ])('an unattributed sale on %s (%s) blocks the file, next to an invoiced row', async (account, ruta, bucket) => {
    results = [
      {
        data: [
          entryEU('inv-de', [lineEU(account, 10000)]),
          manualSale('je-a9', 9, [lineEU(account, 2500)]),
        ],
        error: null,
      },
      { data: [], error: null },
      { data: [], error: null },
      { data: [invDE()], error: null },
    ]
    rpcResults = [{ data: [sourceLine(je('inv-de')), sourceLine('je-a9')], error: null }]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 9)

    expect(report.rows).toEqual([expect.objectContaining({ country: 'DE', [bucket]: 10000 })])
    const unattributed = report.warnings.filter((w) => w.code === 'UNATTRIBUTED_EU_SALE')
    expect(unattributed).toEqual([expect.objectContaining({ level: 'error', journalEntryId: 'je-a9', amount: 2500 })])
    expect(unattributed[0].message).toContain(`konto ${account} (${ruta})`)
    expect(unattributed[0].message).toContain('Skatteverkets e-tjänst')
    expect(() => buildPeriodiskSammanstallningCsv(report, FILER)).toThrow(PsCsvBuildError)
  })

  it('pages the declaration\'s source lines until a short page', async () => {
    results = [
      { data: [manualSale('je-late', 9, [lineEU('3308', 700)])], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]
    const fullPage = Array.from({ length: 500 }, (_, i) => ({
      line_id: `line-${i}`,
      journal_entry_id: `je-other-${i}`,
      voucher_number: i + 1,
      voucher_series: 'A',
      entry_date: '2025-07-01',
    }))
    rpcResults = [
      { data: fullPage, error: null },
      { data: [sourceLine('je-late')], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 3)

    expect(report.warnings.map((w) => w.code)).toEqual(['UNATTRIBUTED_EU_SALE'])
    expect(sourceLineCalls()).toHaveLength(2)
    expect(sourceLineCalls()[1][1]).toMatchObject({
      p_cursor_date: '2025-07-01',
      p_cursor_voucher_number: 500,
      p_cursor_entry_id: 'je-other-499',
      p_cursor_line_id: 'line-499',
    })
  })

  it('a failed declaration read fails the report instead of guessing', async () => {
    results = [
      { data: [manualSale('je-a7', 7, [lineEU('3308', 100)])], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]
    rpcResults = [{ data: null, error: { message: 'boom' } }]

    await expect(generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 3))
      .rejects.toThrow('get_vat_ruta_source_lines failed: boom')
  })
})

describe('the declaration\'s account-to-ruta mapping (crm#1336)', () => {
  /** The account filter the journal_entries fetch was given. */
  function fetchedAccounts(): string[] {
    const builder = (supabase.from as ReturnType<typeof vi.fn>).mock.results[0].value
    const call = builder.in.mock.calls.find((c: unknown[]) => c[0] === 'journal_entry_lines.account_number')
    return call[1]
  }

  it('files a sale on the company\'s own EU goods account under goods, as ruta 35 counts it', async () => {
    dynamicAccounts.explicitAccounts.add('3058')
    dynamicAccounts.mappingByAccount.set('3058', { box: 'ruta35', side: 'credit' })
    results = [
      {
        data: [{ ...entryEU('inv-de', [lineEU('3058', 8000)]), entry_date: '2025-05-15' }],
        error: null,
      },
      { data: [invDE()], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(fetchedAccounts()).toEqual(expect.arrayContaining(['3308', '3108', '3107', '3058']))
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ goods: 8000, services: 0 })
  })

  it('leaves out a BAS EU account the company classified into another ruta, as the declaration does', async () => {
    dynamicAccounts.explicitAccounts.add('3308')
    dynamicAccounts.mappingByAccount.set('3308', { box: 'ruta42', side: 'credit' })
    results = [{ data: [], error: null }]

    await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(fetchedAccounts()).not.toContain('3308')
    expect(fetchedAccounts()).toEqual(expect.arrayContaining(['3108', '3107']))
  })
})

describe('findUnattributedEuSales: the PS finding for any date range (crm#1362)', () => {
  /**
   * The reported shape: a bank-booked sale posted on the wrong account, then
   * corrected with correctEntry() onto 3308. Only the correction carries a
   * PS line; its original (status reversed) is fetched as the chain parent,
   * and nothing in the invoice register points at either.
   */
  function bankSaleCorrection(id: string, voucherNumber: number, lines: LineFx[]) {
    return {
      ...entryOther(id, 'correction', lines),
      voucher_series: 'A',
      voucher_number: voucherNumber,
      entry_date: '2026-07-22',
      reverses_id: null,
      correction_of_id: 'je-bank',
    }
  }

  it('names a corrected bank-booked EU service sale over a helårsmoms range, with the PS severity', async () => {
    results = [
      { data: [bankSaleCorrection('je-a210', 210, [lineEU('3308', 1501.71)])], error: null },
      { data: [], error: null }, // invoices by journal_entry_id
      { data: [], error: null }, // invoice_payments
      {
        data: [{ id: 'je-bank', source_type: 'bank_transaction', source_id: 'tx-1', reverses_id: null, correction_of_id: null }],
        error: null,
      }, // journal_entries by id: the original, unexplained too
    ]
    rpcResults = [{ data: [sourceLine('je-a210')], error: null }]

    const warnings = await findUnattributedEuSales(supabase, 'c1', '2025-10-01', '2026-09-30')

    expect(warnings).toEqual([
      expect.objectContaining({ code: 'UNATTRIBUTED_EU_SALE', level: 'warning', journalEntryId: 'je-a210', amount: 1501.71 }),
    ])
    expect(warnings[0].message).toContain('Verifikat A210 (2026-07-22)')
    expect(warnings[0].message).toContain('konto 3308 (ruta 39)')
    // The range is the caller's, not a PS month or quarter.
    expect(supabase.rpc).toHaveBeenCalledWith('get_vat_ruta_source_lines', expect.objectContaining({
      p_start: '2025-10-01',
      p_end: '2026-09-30',
    }))
  })

  it('an invoiced EU sale is no finding, and the invoices are never loaded', async () => {
    results = [{ data: [entryEU('inv-de', [lineEU('3108', 10000)])], error: null }]

    const warnings = await findUnattributedEuSales(supabase, 'c1', '2025-05-01', '2025-05-31')

    expect(warnings).toEqual([])
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(sourceLineCalls()).toHaveLength(0)
  })

  it('an unattributed goods sale is an error, as it is in the report', async () => {
    results = [
      { data: [{ ...entryOther('je-man', 'manual', [lineEU('3108', 2500)]), voucher_series: 'A', voucher_number: 9 }], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]
    rpcResults = [{ data: [sourceLine('je-man')], error: null }]

    const warnings = await findUnattributedEuSales(supabase, 'c1', '2025-05-01', '2025-05-31')

    expect(warnings).toEqual([expect.objectContaining({ level: 'error', journalEntryId: 'je-man', amount: 2500 })])
  })
})

describe('the period\'s verifikat through get_entries_with_account_lines', () => {
  /**
   * Runs `run` against the same fixtures twice: once with the database
   * answering get_entries_with_account_lines, once without the function (the
   * paged journal_entries read), and pins the two results equal.
   */
  async function bothWays<T>(setup: () => void, run: () => Promise<T>): Promise<T> {
    const read = async (mode: 'missing' | 'queue') => {
      vi.clearAllMocks()
      resultIdx = 0
      results = []
      rpcResults = []
      setup()
      entriesRpc = mode
      supabase = makeClient()
      return run()
    }
    const paged = await read('missing')
    const viaRpc = await read('queue')
    expect(viaRpc).toEqual(paged)
    // The function answered: no paged journal_entries read ran first.
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(tables[0]).not.toBe('journal_entries')
    return viaRpc
  }

  const invFR = (): InvoiceFx => ({
    id: 'inv-fr',
    customer: {
      id: 'cust-fr',
      name: 'FR Customer',
      country: 'FR',
      vat_number: 'FR12345678901',
      vat_number_validated: true,
      vat_number_validated_at: RECENT,
    },
  })

  it('asks for the period\'s posted and reversed verifikat with just their PS-account lines', async () => {
    entriesRpc = 'queue'
    results = [{ data: [], error: null }]

    await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 2)

    expect(supabase.rpc).toHaveBeenCalledWith('get_entries_with_account_lines', {
      p_company_id: 'c1',
      p_start: '2025-04-01',
      p_end: '2025-06-30',
      p_accounts: expect.arrayContaining(['3308', '3108', '3107']),
      p_statuses: ['posted', 'reversed'],
      p_all_lines: false,
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('files engine invoices, a split verifikat and a credit note the same way', async () => {
    const report = await bothWays(() => {
      results = [
        {
          data: [
            entryEU('inv-de', [lineEU('3308', 10000)]),
            entryEU('inv-fr', [lineEU('3108', 2500), lineEU('3308', 500)]),
            entryCredit('inv-de-credit', [lineCredit('3308', 1000)]),
          ],
          error: null,
        },
        { data: [invDE(), invFR(), invDE('inv-de-credit')], error: null },
      ]
    }, () => generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5))
    expect(report.rows.map((r) => [r.country, r.services, r.goods])).toEqual([['DE', 9000, 0], ['FR', 500, 2500]])
  })

  it('reports an unattributed sale next to an invoiced one the same way', async () => {
    const report = await bothWays(() => {
      results = [
        {
          data: [
            { ...entryOther('je-man', 'manual', [lineEU('3308', 1234.56)]), voucher_series: 'A', voucher_number: 7 },
            entryEU('inv-de', [lineEU('3308', 5000)]),
          ],
          error: null,
        },
        { data: [], error: null }, // invoices by journal_entry_id
        { data: [], error: null }, // invoice_payments
        { data: [invDE()], error: null }, // invoices by id
      ]
      rpcResults = [{ data: [sourceLine('je-man')], error: null }]
    }, () => generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 2))
    expect(report.warnings.map((w) => w.code)).toEqual(['UNATTRIBUTED_EU_SALE'])
    expect(report.rows).toHaveLength(1)
  })

  it('nets a reversed sale and its storno the same way', async () => {
    const report = await bothWays(() => {
      results = [
        {
          data: [
            { ...entryEU('inv-de', [lineEU('3308', 10000)]), status: 'reversed' },
            { ...entryOther('je-storno', 'storno', [lineCredit('3308', 10000)]), source_id: 'inv-de', reverses_id: je('inv-de') },
          ],
          error: null,
        },
        { data: [], error: null },
        { data: [], error: null },
        { data: [invDE()], error: null },
      ]
    }, () => generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5))
    expect(report.warnings.map((w) => w.code)).toEqual(['ZERO_NET_EXCLUDED'])
  })

  it('reads the company\'s own EU goods account and the close check\'s findings the same way', async () => {
    dynamicAccounts.explicitAccounts.add('3058')
    dynamicAccounts.mappingByAccount.set('3058', { box: 'ruta35', side: 'credit' })
    const warnings = await bothWays(() => {
      results = [
        { data: [{ ...entryOther('je-goods', 'manual', [lineEU('3058', 2500)]), voucher_series: 'A', voucher_number: 9 }], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ]
      rpcResults = [{ data: [sourceLine('je-goods')], error: null }]
    }, () => findUnattributedEuSales(supabase, 'c1', '2025-05-01', '2025-05-31'))
    expect(warnings).toEqual([expect.objectContaining({ level: 'error', journalEntryId: 'je-goods', amount: 2500 })])
  })

  it('a failed read fails the report instead of falling back', async () => {
    entriesRpc = 'queue'
    results = [{ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }]

    await expect(generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5))
      .rejects.toThrow('get_entries_with_account_lines failed: canceling statement due to statement timeout')
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
