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

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import {
  generatePeriodiskSammanstallning,
  normalizeVatNumber,
  reconcilePsAgainstVatDeclaration,
} from '../periodisk-sammanstallning'
import { calculatePeriodDates, formatPeriodLabel } from '../period-dates'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
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

// Recent validation so VIES_UNVALIDATED warnings don't fire by default.
const RECENT = new Date().toISOString()

// The generator fetches lines via the two-step entry-lines helper
// (lib/bookkeeping/entry-lines.ts): journal_entries first, then
// journal_entry_lines by entry id with the parent reattached under
// `journal_entries`. Each fixture invoice gets one entry (je-<sourceId>).
function je(sourceId: string) {
  return `je-${sourceId}`
}

function entryEU(sourceId: string) {
  return {
    id: je(sourceId),
    company_id: 'c1',
    entry_date: '2025-05-15',
    status: 'posted',
    source_type: 'invoice_created',
    source_id: sourceId,
  }
}

function entryCredit(sourceId: string) {
  return {
    id: je(sourceId),
    company_id: 'c1',
    entry_date: '2025-05-20',
    status: 'posted',
    source_type: 'credit_note',
    source_id: sourceId,
  }
}

function lineEU(account: string, credit: number, sourceId: string) {
  return {
    account_number: account,
    debit_amount: 0,
    credit_amount: credit,
    journal_entry_id: je(sourceId),
  }
}

function lineCredit(account: string, debit: number, sourceId: string) {
  return {
    account_number: account,
    debit_amount: debit,
    credit_amount: 0,
    journal_entry_id: je(sourceId),
  }
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
    // journal_entries: none match → the line fetch is skipped entirely.
    results = [{ data: [], error: null }]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.totals.rowCount).toBe(0)
    expect(report.totals.grand).toBe(0)
    expect(report.period.label).toBe('Maj 2025')
  })

  it('single EU service sale → 1 row, type 3 only', async () => {
    results = [
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv-de')], error: null },
      { data: [lineEU('3308', 10000, 'inv-de')], error: null },
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
  })

  it('aggregates multiple invoices to same customer', async () => {
    results = [
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1'), entryEU('inv2'), entryEU('inv3')], error: null },
      {
        data: [
          lineEU('3308', 4000, 'inv1'),
          lineEU('3308', 3500, 'inv2'),
          lineEU('3308', 2500, 'inv3'),
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
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1'), entryEU('inv2')], error: null },
      {
        data: [
          lineEU('3308', 7000, 'inv1'),
          lineEU('3108', 5000, 'inv2'),
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
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1'), entryCredit('cn1')], error: null },
      {
        data: [
          lineEU('3308', 10000, 'inv1'),
          lineCredit('3308', 3000, 'cn1'),
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
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1'), entryCredit('cn1')], error: null },
      {
        data: [
          lineEU('3308', 10000, 'inv1'),
          lineCredit('3308', 10000, 'cn1'),
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
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1')], error: null },
      { data: [lineEU('3308', 5000, 'inv1')], error: null },
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
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1')], error: null },
      { data: [lineEU('3308', 5000, 'inv1')], error: null },
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
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1')], error: null },
      { data: [lineEU('3308', 5000, 'inv1')], error: null },
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
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1')], error: null },
      { data: [lineEU('3308', 5000, 'inv1')], error: null },
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
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1')], error: null },
      { data: [lineEU('3308', 4200, 'inv1')], error: null },
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
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv1')], error: null },
      { data: [lineEU('3108', 9000, 'inv1')], error: null },
      { data: [{ ...invDE('inv1') }], error: null },
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 2)

    expect(report.warnings.some(w => w.code === 'GOODS_SOLD_WITH_QUARTERLY_PERIOD')).toBe(true)
  })

  it('sorts rows by country then vat_number', async () => {
    results = [
      // journal_entries page for the two-step entry-lines fetch
      { data: [entryEU('inv-fr'), entryEU('inv-de'), entryEU('inv-at')], error: null },
      {
        data: [
          lineEU('3308', 1000, 'inv-fr'),
          lineEU('3308', 2000, 'inv-de'),
          lineEU('3308', 3000, 'inv-at'),
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

  it('rejects yearly period type', async () => {
    await expect(
      generatePeriodiskSammanstallning(supabase, 'c1', 'yearly' as 'monthly', 2025, 1),
    ).rejects.toThrow()
  })
})

// ============================================================
// Reconciliation
// ============================================================

describe('reconcilePsAgainstVatDeclaration', () => {
  it('returns null matches when periods do not coincide', async () => {
    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 2)
    // No data calls expected: function bails before invoking calculateVatDeclaration.
    results = []
    const reconciled = await reconcilePsAgainstVatDeclaration(supabase, 'c1', report, 'monthly')
    expect(reconciled.reconciliation.matches).toBeNull()
  })
})
