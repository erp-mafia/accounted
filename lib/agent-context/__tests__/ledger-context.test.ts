import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildLedgerContext } from '../ledger-context'

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
          counterparty: `Leverantör Aktiebolag med långt namn nr ${i}`,
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
  })
})
