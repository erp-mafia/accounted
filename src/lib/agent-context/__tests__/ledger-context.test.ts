import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, createRowsMockSupabase } from '@/tests/helpers'
import { buildLedgerContext, buildLedgerDigest, readWrittenRules } from '../ledger-context'

const COMPANY_ID = 'company-1'
const NOW = new Date('2026-07-07T10:00:00Z')

// Queue order mirrors the Promise.all call order in buildLedgerContext:
// rpc stats, company_settings, mapping_rules, categorization_templates,
// posted-entry count, voucher_sequences, salary_runs, and the names of the
// switched-off counterparty rules (empty unless given).
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
    /** The read of the switched-off counterparty rules' names, as the table answers it. */
    switchedOff?: { data: unknown[] | null; error?: { message: string } }
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
    overrides.switchedOff ?? { data: [] },
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

  it('leaves out a rule learned from a generic bank text, which the matcher never applies (crm#1707)', async () => {
    enqueueAll(mock, {
      rules: [
        { rule_name: 'Learned: INSÄTTNING', merchant_pattern: 'INSÄTTNING', description_pattern: null, debit_account: '1930', vat_treatment: null },
        { rule_name: 'Learned: KORTKÖP ICA MAXI', merchant_pattern: 'KORTKÖP ICA MAXI', description_pattern: null, debit_account: '4010', vat_treatment: null },
      ],
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.explicit_rules.map((r) => r.match)).toEqual(['KORTKÖP ICA MAXI'])
  })

  it('lists a rule learned on money in by the account it books, not the bank', async () => {
    enqueueAll(mock, {
      rules: [
        { rule_name: 'Learned: Shop payout', merchant_pattern: 'Shop payout', description_pattern: null, debit_account: '1930', credit_account: '3001', vat_treatment: null },
        { rule_name: 'Learned: Telia', merchant_pattern: 'Telia', description_pattern: null, debit_account: '6212', credit_account: '1930', vat_treatment: null },
      ],
    })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(ctx.explicit_rules.map((r) => r.account_number)).toEqual(['3001', '6212'])
  })

  it('leaves out a learned rule whose counterparty rule the company switched off; a failed read of them lists the rules as stored', async () => {
    const rules = [
      { rule_name: 'Learned: Shop payout', merchant_pattern: 'Shop payout', description_pattern: null, debit_account: '1930', credit_account: '3001', vat_treatment: null, company_id: COMPANY_ID, source: 'auto' },
      { rule_name: 'Learned: Telia', merchant_pattern: 'Telia', description_pattern: null, debit_account: '6212', credit_account: '1930', vat_treatment: null, company_id: COMPANY_ID, source: 'auto' },
      { rule_name: 'Described: SL', merchant_pattern: 'SL', description_pattern: null, debit_account: '5810', vat_treatment: null, company_id: COMPANY_ID, source: 'user_description' },
    ]
    const pausedPayout = { id: 'tpl-1', counterparty_name: 'shop payout', counterparty_aliases: ['shop payout'], debit_account: '1930', credit_account: '3001' }
    enqueueAll(mock, { rules, switchedOff: { data: [pausedPayout] } })
    const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)
    expect(ctx.explicit_rules.map((r) => r.rule_name)).toEqual(['Learned: Telia', 'Described: SL'])
    // Who wrote a row is read with it, so a learned row can be told from a described one.
    expect(mock.findCalls('mapping_rules', 'select')[0][0]).toContain('company_id, source')

    const failed = createQueuedMockSupabase()
    enqueueAll(failed, { rules, switchedOff: { data: null, error: { message: 'read failed' } } })
    const asStored = await buildLedgerContext(failed.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)
    expect(asStored.explicit_rules.map((r) => r.rule_name)).toEqual(['Learned: Shop payout', 'Learned: Telia', 'Described: SL'])
  })

  it('reads every active mapping row of the company while its auto-learned rows are read', async () => {
    enqueueAll(mock)
    await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

    expect(mock.findCalls('mapping_rules', 'eq')).toEqual([['company_id', COMPANY_ID], ['is_active', true]])
    expect(mock.findCalls('mapping_rules', 'neq')).toEqual([])
    expect(mock.findCalls('mapping_rules', 'limit')).toEqual([[25]])
  })

  it('leaves the auto-learned rows out of the read for a company that does not read them', async () => {
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', COMPANY_ID)
    try {
      enqueueAll(mock, {
        rules: [
          { rule_name: 'Described: SL', merchant_pattern: 'SL', description_pattern: null, debit_account: '5810', vat_treatment: null },
        ],
      })
      const ctx = await buildLedgerContext(mock.supabase as unknown as SupabaseClient, COMPANY_ID, NOW)

      expect(mock.findCalls('mapping_rules', 'neq')).toEqual([['source', 'auto']])
      expect(mock.findCalls('mapping_rules', 'limit')).toEqual([[25]])
      expect(ctx.explicit_rules.map((r) => r.rule_name)).toEqual(['Described: SL'])
    } finally {
      vi.unstubAllEnvs()
    }
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

describe('readWrittenRules', () => {
  const OTHER_COMPANY = 'company-2'

  /** A mapping_rules row as the table holds it: `source` says who wrote it, a booking ('auto') or a person ('user_description'). */
  const row = (rule_name: string, source: 'auto' | 'user_description', priority: number, over: Record<string, unknown> = {}) => ({
    company_id: COMPANY_ID,
    is_active: true,
    source,
    priority,
    rule_name,
    merchant_pattern: `${rule_name.split(': ')[1].toUpperCase()} AB`,
    description_pattern: null,
    debit_account: '5010',
    vat_treatment: null,
    ...over,
  })
  const LEARNED = [row('Learned: Telia', 'auto', 8), row('Learned: Ica', 'auto', 9)]
  const WRITTEN = [row('Described: Hyresvärden', 'user_description', 3, { vat_treatment: 'exempt' }), row('Described: Banken', 'user_description', 5, { debit_account: '6570' })]

  /** The table with the read's own filters run over its rows, as the database runs them. */
  const table = (rows: Record<string, unknown>[]) => createRowsMockSupabase({ mapping_rules: rows }).supabase as unknown as SupabaseClient
  const written = async (rows: Record<string, unknown>[]) => (await readWrittenRules(table(rows), COMPANY_ID)).map((rule) => rule.rule_name)
  const inProfile = async (rows: Record<string, unknown>[]) => (await buildLedgerContext(table(rows), COMPANY_ID, NOW)).explicit_rules.map((rule) => rule.rule_name)

  /** Each case once for a company whose learned rows are read, and once for one in the precedent switch, where they are not. */
  const SWITCH = [
    ['outside the precedent switch', undefined],
    ['inside the precedent switch', COMPANY_ID],
  ] as const

  describe.each(SWITCH)('%s', (_name, precedent) => {
    beforeEach(() => {
      if (precedent) vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', precedent)
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('is empty for a company with only learned rows', async () => {
      expect(await written(LEARNED)).toEqual([])
    })

    it('holds only the written rules of a company with both', async () => {
      expect(await written([...LEARNED, ...WRITTEN])).toEqual(['Described: Hyresvärden', 'Described: Banken'])
    })

    it('holds every written rule of a company with no learned rows', async () => {
      expect(await written(WRITTEN)).toEqual(['Described: Hyresvärden', 'Described: Banken'])
    })

    it("leaves out another company's rules and a rule that is switched off", async () => {
      const rows = [...WRITTEN, row('Described: Grannen', 'user_description', 1, { company_id: OTHER_COMPANY }), row('Described: Avslutad', 'user_description', 2, { is_active: false })]
      expect(await written(rows)).toEqual(['Described: Hyresvärden', 'Described: Banken'])
    })
  })

  it('gives each rule as the bookkeeping profile gives it', async () => {
    expect(await readWrittenRules(table([...LEARNED, ...WRITTEN]), COMPANY_ID)).toEqual([
      { rule_name: 'Described: Hyresvärden', match: 'HYRESVÄRDEN AB', account_number: '5010', vat_treatment: 'exempt', source: 'mapping_rule' },
      { rule_name: 'Described: Banken', match: 'BANKEN AB', account_number: '6570', vat_treatment: null, source: 'mapping_rule' },
    ])
  })

  it("leaves the profile's own list as it was: the learned rows are in it where they are read, and out where they are not", async () => {
    const rows = [...LEARNED, ...WRITTEN]
    expect(await inProfile(rows)).toEqual(['Described: Hyresvärden', 'Described: Banken', 'Learned: Telia', 'Learned: Ica'])
    vi.stubEnv('BOOKING_PRECEDENT_COMPANY_IDS', COMPANY_ID)
    try {
      expect(await inProfile(rows)).toEqual(['Described: Hyresvärden', 'Described: Banken'])
      // There the two lists are the same.
      expect(await written(rows)).toEqual(await inProfile(rows))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  describe('the read', () => {
    let mock: ReturnType<typeof createQueuedMockSupabase>

    beforeEach(() => {
      vi.clearAllMocks()
      mock = createQueuedMockSupabase()
    })

    it("is one read of the company's own active rows, without the learned ones, for every company", async () => {
      mock.enqueue({ data: [] })
      await readWrittenRules(mock.supabase as unknown as SupabaseClient, COMPANY_ID)

      expect(mock.supabase.from.mock.calls).toEqual([['mapping_rules']])
      expect(mock.supabase.rpc).not.toHaveBeenCalled()
      expect(mock.findCalls('mapping_rules', 'eq')).toEqual([['company_id', COMPANY_ID], ['is_active', true]])
      // The mark of a learned row: the source the booking path writes.
      expect(mock.findCalls('mapping_rules', 'neq')).toEqual([['source', 'auto']])
      expect(mock.findCalls('mapping_rules', 'limit')).toEqual([[25]])
    })

    it('leaves out a rule on a text that names no one and a rule that matches nothing, as the profile does', async () => {
      mock.enqueue({
        data: [
          { rule_name: 'Described: SL', merchant_pattern: 'SL*', description_pattern: null, debit_account: '5810', vat_treatment: 'standard_6' },
          { rule_name: 'Described: avgift', merchant_pattern: null, description_pattern: 'MÅNADSAVGIFT', debit_account: '6570', vat_treatment: null },
          { rule_name: 'Described: INSÄTTNING', merchant_pattern: 'INSÄTTNING', description_pattern: null, debit_account: '1930', vat_treatment: null },
          { rule_name: 'broken', merchant_pattern: null, description_pattern: null, debit_account: '4010', vat_treatment: null },
        ],
      })
      const rules = await readWrittenRules(mock.supabase as unknown as SupabaseClient, COMPANY_ID)

      expect(rules).toEqual([
        { rule_name: 'Described: SL', match: 'SL*', account_number: '5810', vat_treatment: 'standard_6', source: 'mapping_rule' },
        { rule_name: 'Described: avgift', match: 'MÅNADSAVGIFT', account_number: '6570', vat_treatment: null, source: 'mapping_rule' },
      ])
    })

    it('keeps the first fifteen, as the profile does', async () => {
      mock.enqueue({ data: Array.from({ length: 20 }, (_, i) => ({ rule_name: `Regel ${i}`, merchant_pattern: `LEVERANTÖR ${i} AB`, description_pattern: null, debit_account: '4010', vat_treatment: null })) })
      const rules = await readWrittenRules(mock.supabase as unknown as SupabaseClient, COMPANY_ID)

      expect(rules).toHaveLength(15)
      expect(rules[0].rule_name).toBe('Regel 0')
    })

    it('throws when the read fails', async () => {
      mock.enqueue({ data: null, error: { message: 'rls denied' } })
      await expect(readWrittenRules(mock.supabase as unknown as SupabaseClient, COMPANY_ID)).rejects.toThrow('written rules read failed: rls denied')
    })
  })
})
