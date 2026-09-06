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

  it('leaves an imported 3308 posting no invoice points at out of the filing, silently and without an invoice lookup', async () => {
    results = [
      { data: [entryOther('je-loose', 'import', [lineEU('3308', 9000)])], error: null },
      { data: [], error: null }, // invoices by journal_entry_id: none
      { data: [], error: null }, // invoice_payments: none
    ]

    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'monthly', 2025, 5)

    expect(report.rows).toEqual([])
    expect(report.warnings).toEqual([])
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
  it('returns null matches when periods do not coincide', async () => {
    const report = await generatePeriodiskSammanstallning(supabase, 'c1', 'quarterly', 2025, 2)
    // No data calls expected: function bails before invoking calculateVatDeclaration.
    results = []
    const reconciled = await reconcilePsAgainstVatDeclaration(supabase, 'c1', report, 'monthly')
    expect(reconciled.reconciliation.matches).toBeNull()
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
