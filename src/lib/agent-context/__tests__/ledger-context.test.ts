import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildLedgerContext, buildLedgerDigest } from '../ledger-context'

const COMPANY_ID = 'company-1'
const NOW = new Date('2026-07-07T10:00:00Z')

// Queue order mirrors the Promise.all call order in buildLedgerContext:
// rpc stats, company_settings, mapping_rules, categorization_templates,
// posted-entry count, voucher_sequences, salary_runs.
function enqueueAll(
  mock: ReturnType<typeof createQueuedMockSupabase>,
  overrides: {
    stats?: unknown
    settings?: unknown
    rules?: unknown[]
    templates?: unknown[]
    entryCount?: number
    voucherSeries?: unknown[]
    salaryCount?: number
  } = {},
) {
  mock.enqueueMany([
    { data: overrides.stats ?? emptyStats() },
    { data: overrides.settings ?? null },
    { data: overrides.rules ?? [] },
    { data: overrides.templates ?? [] },
    { count: overrides.entryCount ?? 0 },
    { data: overrides.voucherSeries ?? [] },
    { count: overrides.salaryCount ?? 0 },
  ])
}

function emptyStats() {
  return {
    account_usage: [],
    counterparty_patterns: [],
    supplier_patterns: [],
    vat_treatments_used: [],
    median_booking_lag_days: null,
  }
}

describe('buildLedgerContext', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
  })

  it('builds the meta window 12 months back from now', async () => {
    enqueueAll(mock, { entryCount: 42 })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.meta.window).toEqual({ from: '2025-07-07', to: '2026-07-07' })
    expect(ctx.meta.coverage.posted_entries_window).toBe(42)
    expect(ctx.meta.computed_at).toBe(NOW.toISOString())
  })

  // accounted#18: 23:30 UTC is already the next day in Stockholm, in summer
  // (UTC+2) and in winter (UTC+1); the window ends on that day and every
  // read starts twelve months before it.
  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2025-07-02', '2026-07-02'],
    ['winter', '2026-01-15T23:30:00Z', '2025-01-16', '2026-01-16'],
  ])('%s: the window at %s runs %s to %s', async (_season, instant, from, to) => {
    enqueueAll(mock)
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, new Date(instant))

    expect(ctx.meta.window).toEqual({ from, to })
    expect(mock.supabase.rpc).toHaveBeenCalledWith('get_ledger_usage_stats', { p_company_id: COMPANY_ID, p_from_date: from })
  })

  it('maps account usage rows', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        account_usage: [
          { account_number: '1930', account_name: 'Företagskonto', postings: 890, last_used: '2026-07-05' },
        ],
      },
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.account_usage).toEqual([
      { account_number: '1930', account_name: 'Företagskonto', postings_12m: 890, last_used: '2026-07-05' },
    ])
  })

  it('excludes counterparty patterns below the 0.7 share floor', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        counterparty_patterns: [
          { counterparty: 'KLARNA AB', counterparty_key: 'klarna', occurrences: 10, last_booked: '2026-07-01', dominant_category: 'expense_bank_fees', dominant_category_count: 9, dominant_account_number: '6570' },
          { counterparty: 'MIXED AB', counterparty_key: 'mixed', occurrences: 10, last_booked: '2026-07-01', dominant_category: 'expense_other', dominant_category_count: 5, dominant_account_number: '4010' },
          { counterparty: 'NOCAT AB', counterparty_key: 'nocat', occurrences: 4, last_booked: '2026-07-01', dominant_category: null, dominant_category_count: 0, dominant_account_number: '4010' },
        ],
      },
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns).toHaveLength(1)
    expect(ctx.counterparty_patterns[0]).toMatchObject({
      counterparty: 'KLARNA AB',
      source: 'history',
      dominant: { category: 'expense_bank_fees', account_number: '6570', vat_treatment: null },
      evidence: { seen_12m: 10, agree: 9, share: 0.9, last_booked: '2026-07-01' },
    })
  })

  it('prefers template account and vat_treatment when a counterparty template exists', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        counterparty_patterns: [
          { counterparty: 'KLARNA AB', counterparty_key: 'klarna', occurrences: 10, last_booked: '2026-07-01', dominant_category: 'expense_bank_fees', dominant_category_count: 10, dominant_account_number: '6570' },
        ],
      },
      templates: [
        // counterparty_name is stored through normalizeCounterpartyName(),
        // i.e. legal suffix stripped: matches counterparty_key exactly.
        { counterparty_name: 'klarna', debit_account: '6580', vat_treatment: 'standard_25', occurrence_count: 8, confidence: 0.9, last_seen_date: '2026-07-01' },
      ],
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns[0].source).toBe('template')
    expect(ctx.counterparty_patterns[0].dominant.account_number).toBe('6580')
    expect(ctx.counterparty_patterns[0].dominant.vat_treatment).toBe('standard_25')
  })

  // Imported verifikat (migration 20261109090100): a second basis that
  // fills the slots the bank rows leave.
  function imported(over: Record<string, unknown> = {}) {
    return {
      counterparty: 'Telia Sverige AB',
      counterparty_key: 'telia sverige',
      vouchers: 12,
      last_booked: '2026-06-28',
      settled_via: 'payable',
      dominant_account_number: '6212',
      dominant_account_count: 12,
      vat_treatment: 'standard_25',
      vat_treatment_count: 12,
      ...over,
    }
  }

  it('fills counterparty patterns from imported verifikat after the bank rows, with their basis', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        counterparty_patterns: [
          { counterparty: 'KLARNA AB', counterparty_key: 'klarna', occurrences: 10, last_booked: '2026-07-01', dominant_category: 'expense_bank_fees', dominant_category_count: 9, dominant_account_number: '6570' },
        ],
        imported_counterparty_patterns: [imported()],
      },
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns.map((p) => p.source)).toEqual(['history', 'imported_vouchers'])
    expect(ctx.counterparty_patterns[1]).toEqual({
      counterparty: 'Telia Sverige AB',
      dominant: { category: null, account_number: '6212', vat_treatment: 'standard_25' },
      evidence: { seen_12m: 12, agree: 12, share: 1, last_booked: '2026-06-28' },
      source: 'imported_vouchers',
      settled_via: 'payable',
    })
  })

  it('needs two imported verifikat and the 0.7 share on the account', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        imported_counterparty_patterns: [
          imported({ counterparty: 'Once AB', counterparty_key: 'once', vouchers: 1, dominant_account_count: 1, vat_treatment_count: 1 }),
          imported({ counterparty: 'Mixed AB', counterparty_key: 'mixed', vouchers: 10, dominant_account_count: 6, vat_treatment_count: 6 }),
          imported({ counterparty: 'No Account AB', counterparty_key: 'no account', dominant_account_number: null, dominant_account_count: 0 }),
          imported({ counterparty: 'Twice AB', counterparty_key: 'twice', vouchers: 2, dominant_account_count: 2, vat_treatment_count: 2 }),
        ],
      },
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns.map((p) => p.counterparty)).toEqual(['Twice AB'])
  })

  it('never lets imported history override a counterparty Accounted already categorized', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        counterparty_patterns: [
          // Categorized but mixed: below the floor, so no bank pattern, and
          // the imported history must not stand in for it.
          { counterparty: 'TELIA', counterparty_key: 'telia sverige', occurrences: 10, last_booked: '2026-07-01', dominant_category: 'expense_telecom', dominant_category_count: 5, dominant_account_number: '6212' },
          // Linked but never categorized: no bank pattern, imported fills in.
          { counterparty: 'ANTHROPIC', counterparty_key: 'anthropic', occurrences: 4, last_booked: '2026-07-01', dominant_category: null, dominant_category_count: 0, dominant_account_number: null },
        ],
        imported_counterparty_patterns: [
          imported(),
          imported({ counterparty: 'ANTHROPIC* CLAUDE SUB', counterparty_key: 'anthropic', settled_via: 'bank', dominant_account_number: '6540', vat_treatment: 'reverse_charge' }),
        ],
      },
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns).toHaveLength(1)
    expect(ctx.counterparty_patterns[0]).toMatchObject({
      counterparty: 'ANTHROPIC* CLAUDE SUB',
      source: 'imported_vouchers',
      settled_via: 'bank',
      dominant: { account_number: '6540', vat_treatment: 'reverse_charge' },
    })
  })

  it('reports the imported VAT treatment only above the floor and adds it to the observed profile', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        vat_treatments_used: ['standard_25'],
        imported_counterparty_patterns: [
          imported({ counterparty: 'Restaurang AB', counterparty_key: 'restaurang', vat_treatment: 'reduced_12', vat_treatment_count: 9, dominant_account_count: 10, vouchers: 10 }),
          imported({ counterparty: 'Blandad Moms AB', counterparty_key: 'blandad moms', vat_treatment: 'reduced_6', vat_treatment_count: 6, dominant_account_count: 10, vouchers: 10 }),
          imported({ counterparty: 'Bygg AB', counterparty_key: 'bygg', vat_treatment: 'reverse_charge_domestic', vat_treatment_count: 4, dominant_account_count: 4, vouchers: 4 }),
        ],
      },
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns.map((p) => [p.counterparty, p.dominant.vat_treatment])).toEqual([
      ['Restaurang AB', 'reduced_12'],
      ['Blandad Moms AB', null],
      ['Bygg AB', 'reverse_charge_domestic'],
    ])
    expect(ctx.vat_profile.treatments_used_12m).toEqual(['standard_25', 'reduced_12', 'reverse_charge_domestic'])
  })

  it('keeps the 15-pattern cap across both bases', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        counterparty_patterns: Array.from({ length: 10 }, (_, i) => ({
          counterparty: `BANK ${i}`, counterparty_key: `bank ${i}`, occurrences: 20, last_booked: '2026-07-01',
          dominant_category: 'expense_other', dominant_category_count: 20, dominant_account_number: '4010',
        })),
        imported_counterparty_patterns: Array.from({ length: 25 }, (_, i) => imported({ counterparty: `Imported ${i}`, counterparty_key: `imported ${i}` })),
      },
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns).toHaveLength(15)
    expect(ctx.counterparty_patterns.filter((p) => p.source === 'imported_vouchers')).toHaveLength(5)
  })

  it('reads an RPC without the imported section (before the migration) as no imported patterns', async () => {
    enqueueAll(mock, { stats: { ...emptyStats(), vat_treatments_used: ['standard_25'] } })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns).toEqual([])
    expect(ctx.vat_profile.treatments_used_12m).toEqual(['standard_25'])
  })

  it('digests the top patterns for the briefing with their basis and VAT', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        counterparty_patterns: [
          { counterparty: 'KLARNA AB', counterparty_key: 'klarna', occurrences: 10, last_booked: '2026-07-01', dominant_category: 'expense_bank_fees', dominant_category_count: 9, dominant_account_number: '6570' },
        ],
        imported_counterparty_patterns: [imported()],
      },
      entryCount: 42,
    })
    const digest = buildLedgerDigest(await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW))

    expect(digest).toEqual({
      resource_uri: 'Accounted://ledger/context',
      window_from: '2025-07-07',
      posted_entries_window: 42,
      top_counterparty_patterns: [
        {
          counterparty: 'KLARNA AB',
          dominant_category: 'expense_bank_fees',
          dominant_account_number: '6570',
          vat_treatment: null,
          source: 'history',
          evidence: { seen_12m: 10, agree: 9, last_booked: '2026-07-01' },
        },
        {
          counterparty: 'Telia Sverige AB',
          dominant_category: null,
          dominant_account_number: '6212',
          vat_treatment: 'standard_25',
          source: 'imported_vouchers',
          settled_via: 'payable',
          evidence: { seen_12m: 12, agree: 12, last_booked: '2026-06-28' },
        },
      ],
      top_supplier_patterns: [],
    })
  })

  it('maps supplier patterns with the same evidence shape and share floor', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        supplier_patterns: [
          { supplier: 'Telia Sverige AB', invoices: 12, last_invoice: '2026-06-28', vat_treatment: 'standard_25', dominant_account_number: '6212', dominant_account_count: 12 },
          { supplier: 'Blandat AB', invoices: 10, last_invoice: '2026-06-01', vat_treatment: 'standard_25', dominant_account_number: '4010', dominant_account_count: 5 },
          { supplier: 'Inga Rader AB', invoices: 3, last_invoice: '2026-05-01', vat_treatment: null, dominant_account_number: null, dominant_account_count: 0 },
        ],
      },
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.supplier_patterns).toHaveLength(1)
    expect(ctx.supplier_patterns[0]).toEqual({
      supplier: 'Telia Sverige AB',
      dominant: { account_number: '6212', vat_treatment: 'standard_25' },
      evidence: { seen_12m: 12, agree: 12, share: 1, last_booked: '2026-06-28' },
      source: 'supplier_invoices',
    })
  })

  it('lists explicit mapping rules separately, skipping matchless rules', async () => {
    enqueueAll(mock, {
      rules: [
        { rule_name: 'SL resor', merchant_pattern: 'SL*', description_pattern: null, debit_account: '5810', vat_treatment: 'standard_6' },
        { rule_name: 'broken', merchant_pattern: null, description_pattern: null, debit_account: '4010', vat_treatment: null },
      ],
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.explicit_rules).toEqual([
      { rule_name: 'SL resor', match: 'SL*', account_number: '5810', vat_treatment: 'standard_6', source: 'mapping_rule' },
    ])
  })

  it('derives vat profile and conventions from settings, stats, and series', async () => {
    enqueueAll(mock, {
      stats: { ...emptyStats(), vat_treatments_used: ['standard_25'], median_booking_lag_days: 2.6 },
      settings: { vat_registered: true, moms_period: 'quarterly', accounting_method: 'accrual', pays_salaries: true },
      voucherSeries: [{ voucher_series: 'B' }, { voucher_series: 'A' }, { voucher_series: 'A' }],
      salaryCount: 3,
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.vat_profile).toEqual({
      registered: true,
      moms_period: 'quarterly',
      treatments_used_12m: ['standard_25'],
    })
    expect(ctx.conventions).toEqual({
      accounting_method: 'accrual',
      voucher_series_in_use: ['A', 'B'],
      salary_run_active: true,
      typical_booking_lag_days: 3,
    })
  })

  it('throws when the stats RPC fails', async () => {
    mock.enqueueMany([
      { error: { message: 'boom' } },
      { data: null },
      { data: [] },
      { data: [] },
      { count: 0 },
      { data: [] },
      { count: 0 },
    ])
    await expect(
      buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW),
    ).rejects.toThrow('ledger usage stats failed: boom')
  })

  it('throws when a secondary read fails instead of reporting empty data', async () => {
    mock.enqueueMany([
      { data: emptyStats() },
      { data: null },
      { error: { message: 'rls denied' } },
      { data: [] },
      { count: 0 },
      { data: [] },
      { count: 0 },
    ])
    await expect(
      buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW),
    ).rejects.toThrow('ledger context read failed (mapping_rules): rls denied')
  })

  it('stays under the 12 KB payload budget on a dense fixture', async () => {
    enqueueAll(mock, {
      stats: {
        account_usage: Array.from({ length: 20 }, (_, i) => ({
          account_number: String(4000 + i),
          account_name: `Konto med ett ganska långt namn nummer ${i}`,
          postings: 500 - i,
          last_used: '2026-07-01',
        })),
        counterparty_patterns: Array.from({ length: 25 }, (_, i) => ({
          // At the RPC's 60-character display cap: a bank text can be longer.
          counterparty: `Leverantör Aktiebolag med långt namn nr ${i}`.padEnd(60, '.'),
          counterparty_key: `leverantör aktiebolag med långt namn nr ${i}`,
          occurrences: 100 - i,
          last_booked: '2026-07-01',
          dominant_category: 'expense_office_supplies',
          dominant_category_count: 100 - i,
          dominant_account_number: '4010',
        })),
        supplier_patterns: Array.from({ length: 15 }, (_, i) => ({
          supplier: `Leverantörsfaktura Aktiebolag med långt namn nr ${i}`,
          invoices: 50 - i,
          last_invoice: '2026-07-01',
          vat_treatment: 'standard_25',
          dominant_account_number: '6212',
          dominant_account_count: 50 - i,
        })),
        // Worst case for the budget: every slot the bank rows leave is an
        // imported pattern, which also carries settled_via.
        imported_counterparty_patterns: Array.from({ length: 25 }, (_, i) => ({
          counterparty: `Importerad leverantör Aktiebolag långt namn ${i}`.padEnd(60, '.'),
          counterparty_key: `importerad leverantör aktiebolag långt namn ${i}`,
          vouchers: 80 - i,
          last_booked: '2026-07-01',
          settled_via: 'receivable',
          dominant_account_number: '3041',
          dominant_account_count: 80 - i,
          vat_treatment: 'reverse_charge_domestic',
          vat_treatment_count: 80 - i,
        })),
        vat_treatments_used: ['standard_25', 'standard_12', 'standard_6', 'reverse_charge_eu'],
        median_booking_lag_days: 2,
      },
      rules: Array.from({ length: 25 }, (_, i) => ({
        rule_name: `Regel med beskrivande namn nummer ${i}`,
        merchant_pattern: `MÖNSTER-${i}*`,
        description_pattern: null,
        debit_account: '4010',
        vat_treatment: 'standard_25',
      })),
      templates: Array.from({ length: 50 }, (_, i) => ({
        counterparty_name: `leverantör aktiebolag med långt namn nr ${i}`,
        debit_account: '4010',
        vat_treatment: 'standard_25',
        occurrence_count: 10,
        confidence: 0.9,
        last_seen_date: '2026-07-01',
      })),
      entryCount: 5000,
      voucherSeries: [{ voucher_series: 'A' }, { voucher_series: 'B' }, { voucher_series: 'C' }],
      salaryCount: 12,
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns).toHaveLength(15)
    expect(ctx.supplier_patterns).toHaveLength(10)
    const bytes = Buffer.byteLength(JSON.stringify(ctx), 'utf8')
    expect(bytes).toBeLessThan(12 * 1024)
    // The briefing stanza stays small whichever basis fills its five rows.
    expect(Buffer.byteLength(JSON.stringify(buildLedgerDigest(ctx)), 'utf8')).toBeLessThan(2.5 * 1024)
  })

  it('stays under the 12 KB budget when imported verifikat fill every slot', async () => {
    enqueueAll(mock, {
      stats: {
        ...emptyStats(),
        imported_counterparty_patterns: Array.from({ length: 25 }, (_, i) => ({
          counterparty: `Importerad leverantör Aktiebolag långt namn ${i}`.padEnd(60, '.'),
          counterparty_key: `importerad leverantör aktiebolag långt namn ${i}`,
          vouchers: 80 - i,
          last_booked: '2026-07-01',
          settled_via: 'receivable',
          dominant_account_number: '3041',
          dominant_account_count: 80 - i,
          vat_treatment: 'reverse_charge_domestic',
          vat_treatment_count: 80 - i,
        })),
      },
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.counterparty_patterns).toHaveLength(15)
    expect(ctx.counterparty_patterns.every((p) => p.source === 'imported_vouchers')).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(ctx), 'utf8')).toBeLessThan(12 * 1024)
    expect(Buffer.byteLength(JSON.stringify(buildLedgerDigest(ctx)), 'utf8')).toBeLessThan(2.5 * 1024)
  })
})
