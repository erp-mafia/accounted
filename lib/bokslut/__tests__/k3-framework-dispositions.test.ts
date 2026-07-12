/**
 * K3 framework integration test for the dispositions builder.
 *
 * Verifies that:
 *   - K3 companies get an `uppskjuten_skatt` proposal at the end of the chain.
 *   - K2 companies (the default) do NOT receive that proposal.
 *   - The latent tax amount equals 20.6 % × projected closing 21xx − current
 *     2240 balance.
 *
 * Mocks generateIncomeStatement and generateTrialBalance directly so the
 * test can drive numeric inputs without touching the database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { buildDispositionsProposal } from '../dispositions-proposal-builder'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateTrialBalance } from '@/lib/reports/trial-balance'

interface ChainableMock {
  from: ReturnType<typeof vi.fn>
}

function makeSupabase(opts: {
  entityType: 'aktiebolag' | 'enskild_firma'
  accountingFramework: 'k2' | 'k3' | null
  periodEnd?: string
  /** Existing periodiseringsfond rows the builder queries. */
  periodiseringsfondRows?: Array<{ account_number: string; cohort_year: number; balance: number; must_return_this_year: boolean }>
}): ChainableMock {
  const periodEnd = opts.periodEnd ?? '2026-12-31'
  // The builder makes several .from(...) queries. We respond per-table.
  const from = vi.fn((table: string) => {
    if (table === 'fiscal_periods') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: 'fp1',
                    name: '2026',
                    period_start: '2026-01-01',
                    period_end: periodEnd,
                  },
                  error: null,
                }),
            }),
          }),
        }),
      }
    }
    if (table === 'company_settings') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: { entity_type: opts.entityType },
                error: null,
              }),
          }),
        }),
      }
    }
    if (table === 'companies') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: { accounting_framework: opts.accountingFramework },
                error: null,
              }),
          }),
        }),
      }
    }
    if (table === 'journal_entry_lines') {
      // Used by listExistingPeriodiseringsfonder and calculateSarskildLoneskatt.
      // We return either the test-supplied periodiseringsfond rows (when the
      // builder is walking 21xx) or an empty SLP result.
      const rows = opts.periodiseringsfondRows
        ? opts.periodiseringsfondRows.flatMap((f) => [
            {
              account_number: f.account_number,
              credit_amount: f.balance,
              debit_amount: 0,
              entry_date: `${f.cohort_year}-12-31`,
              journal_entries: { entry_date: `${f.cohort_year}-12-31`, status: 'posted' },
            },
          ])
        : []
      return {
        select: () => {
          // Make the chainable builder resolve to { data: rows, error: null }
          const result: { data: typeof rows; error: null } = { data: rows, error: null }
          const handler: ProxyHandler<object> = {
            get(_t, prop) {
              if (prop === 'then') {
                return (resolve: (v: unknown) => void) => resolve(result)
              }
              return () => new Proxy({}, handler)
            },
          }
          return new Proxy({}, handler)
        },
      }
    }
    // Catch-all chainable that resolves to empty.
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: null })
        }
        return () => new Proxy({}, handler)
      },
    }
    return new Proxy({}, handler)
  })
  return { from } as ChainableMock
}

beforeEach(() => {
  vi.clearAllMocks()
  // Zero result so the builder doesn't propose a new avsättning: keeps the
  // 21xx balance stable at the trial-balance value, which makes the latent
  // tax math testable in isolation.
  vi.mocked(generateIncomeStatement).mockResolvedValue({
    net_result: 0,
  } as Awaited<ReturnType<typeof generateIncomeStatement>>)
  vi.mocked(generateTrialBalance).mockResolvedValue({
    rows: [
      // 100 000 in periodiseringsfond → 20 600 latent tax target.
      {
        account_number: '2125',
        account_name: 'Periodiseringsfond 2025',
        account_class: 2,
        closing_credit: 100_000,
        closing_debit: 0,
        opening_credit: 0,
        opening_debit: 0,
        period_credit: 100_000,
        period_debit: 0,
      },
      // No existing 2240 balance.
    ],
    totalDebit: 0,
    totalCredit: 100_000,
    isBalanced: false,
  } as unknown as Awaited<ReturnType<typeof generateTrialBalance>>)
})

describe('buildDispositionsProposal: K3 framework', () => {
  it('appends an uppskjuten_skatt proposal for K3 aktiebolag', async () => {
    const supabase = makeSupabase({ entityType: 'aktiebolag', accountingFramework: 'k3' })
    const result = await buildDispositionsProposal(
      supabase as unknown as Parameters<typeof buildDispositionsProposal>[0],
      'co',
      'fp1',
    )
    expect(result.entityType).toBe('aktiebolag')
    const latentTax = result.proposals.find((p) => p.kind === 'uppskjuten_skatt')
    expect(latentTax).toBeDefined()
    expect(latentTax!.amount).toBe(20_600)
    expect(latentTax!.lines).toHaveLength(2)
    // Liability increased → debit 8940 / credit 2240.
    const debit = latentTax!.lines.find((l) => l.account_number === '8940')!
    const credit = latentTax!.lines.find((l) => l.account_number === '2240')!
    expect(debit.debit_amount).toBe(20_600)
    expect(credit.credit_amount).toBe(20_600)
  })

  it('computes bolagsskatt on the result AFTER the periodiseringsfond avsättning', async () => {
    // Regression (customer report): the preview computed bolagsskatt on the
    // pre-disposition net result, ignoring the avsättning it proposes in the
    // same snapshot: so the previewed/agent-facing tax was too high and
    // diverged from ÅR/INK2. With a 1,000,000 result and no existing fonder:
    //   avsättning   = 25 % × 1,000,000          = 250,000
    //   skattem. res = 1,000,000 − 250,000        = 750,000
    //   bolagsskatt  = 20.6 % × 750,000           = 154,500  (NOT 206,000)
    vi.mocked(generateIncomeStatement).mockResolvedValue({
      net_result: 1_000_000,
    } as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const supabase = makeSupabase({ entityType: 'aktiebolag', accountingFramework: 'k2' })
    const result = await buildDispositionsProposal(
      supabase as unknown as Parameters<typeof buildDispositionsProposal>[0],
      'co',
      'fp1',
    )

    const avsattning = result.proposals.find((p) => p.kind === 'periodiseringsfond_avsattning')
    const bolagsskatt = result.proposals.find((p) => p.kind === 'bolagsskatt')
    expect(avsattning?.amount).toBe(250_000)
    expect(bolagsskatt?.amount).toBe(154_500)
  })

  it('does NOT add an uppskjuten_skatt proposal for K2 aktiebolag', async () => {
    const supabase = makeSupabase({ entityType: 'aktiebolag', accountingFramework: 'k2' })
    const result = await buildDispositionsProposal(
      supabase as unknown as Parameters<typeof buildDispositionsProposal>[0],
      'co',
      'fp1',
    )
    expect(result.entityType).toBe('aktiebolag')
    expect(result.proposals.find((p) => p.kind === 'uppskjuten_skatt')).toBeUndefined()
  })

  it('defaults to K2 when accounting_framework is null on the company row', async () => {
    const supabase = makeSupabase({ entityType: 'aktiebolag', accountingFramework: null })
    const result = await buildDispositionsProposal(
      supabase as unknown as Parameters<typeof buildDispositionsProposal>[0],
      'co',
      'fp1',
    )
    expect(result.proposals.find((p) => p.kind === 'uppskjuten_skatt')).toBeUndefined()
  })

  it('does NOT add an uppskjuten_skatt proposal for enskild firma even if mislabelled K3', async () => {
    // EF should never carry K3 (validation rejects it on the API side), but if
    // somehow set the EF branch returns early with an empty proposal list.
    const supabase = makeSupabase({ entityType: 'enskild_firma', accountingFramework: 'k3' })
    const result = await buildDispositionsProposal(
      supabase as unknown as Parameters<typeof buildDispositionsProposal>[0],
      'co',
      'fp1',
    )
    expect(result.entityType).toBe('enskild_firma')
    expect(result.proposals).toEqual([])
  })

  it('skips uppskjuten_skatt when 2240 already matches target (no change)', async () => {
    // Bump 2240 to exactly 20 600 so the delta is zero: calculator should
    // return null and the builder skip the proposal entirely.
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        {
          account_number: '2125',
          account_name: 'Periodiseringsfond 2025',
          account_class: 2,
          closing_credit: 100_000,
          closing_debit: 0,
          opening_credit: 0,
          opening_debit: 0,
          period_credit: 100_000,
          period_debit: 0,
        },
        {
          account_number: '2240',
          account_name: 'Avsättningar för uppskjutna skatter',
          account_class: 2,
          closing_credit: 20_600,
          closing_debit: 0,
          opening_credit: 20_600,
          opening_debit: 0,
          period_credit: 0,
          period_debit: 0,
        },
      ],
      totalDebit: 0,
      totalCredit: 120_600,
      isBalanced: false,
    } as unknown as Awaited<ReturnType<typeof generateTrialBalance>>)
    const supabase = makeSupabase({ entityType: 'aktiebolag', accountingFramework: 'k3' })
    const result = await buildDispositionsProposal(
      supabase as unknown as Parameters<typeof buildDispositionsProposal>[0],
      'co',
      'fp1',
    )
    expect(result.proposals.find((p) => p.kind === 'uppskjuten_skatt')).toBeUndefined()
  })
})
