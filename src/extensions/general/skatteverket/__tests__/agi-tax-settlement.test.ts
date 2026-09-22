import { describe, it, expect } from 'vitest'
import { settleAgiTaxPayments } from '../lib/agi-tax-settlement'

const COMPANY = 'company-1'

/**
 * Minimal recording mock for the two query shapes the settlement uses:
 * a filtered select on agi_declarations and a guarded update. The generic
 * queued mock in tests/helpers.ts doesn't record call arguments, and the
 * update payload/filters are exactly what these tests need to assert.
 */
function createSettlementMock(opts: {
  declarations?: unknown[]
  selectError?: { message: string }
  updateError?: { message: string }
} = {}) {
  const updates: Array<{
    payload: Record<string, unknown>
    filters: Record<string, unknown>
  }> = []
  const selects: Array<Record<string, unknown>> = []

  const makeChain = (
    kind: 'select' | 'update',
    payload?: Record<string, unknown>,
  ) => {
    const filters: Record<string, unknown> = {}
    const chain = {
      eq(col: string, val: unknown) {
        filters[col] = val
        return chain
      },
      in(col: string, val: unknown) {
        filters[col] = val
        return chain
      },
      is(col: string, val: unknown) {
        filters[col] = val
        return chain
      },
      then(resolve: (v: unknown) => void) {
        if (kind === 'select') {
          selects.push(filters)
          resolve({
            data: opts.selectError ? null : opts.declarations ?? [],
            error: opts.selectError ?? null,
          })
        } else {
          updates.push({ payload: payload ?? {}, filters })
          resolve({ error: opts.updateError ?? null })
        }
      },
    }
    return chain
  }

  const supabase = {
    from(_table: string) {
      return {
        select: () => makeChain('select'),
        update: (payload: Record<string, unknown>) =>
          makeChain('update', payload),
      }
    },
  }

  return { supabase, updates, selects }
}

function declaration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agi-may',
    period_year: 2026,
    period_month: 5,
    total_tax: 3391,
    total_avgifter: 6284,
    tax_paid_at: null,
    ...overrides,
  }
}

function agiDebitRow(overrides: Record<string, unknown> = {}) {
  return {
    transaktionsdatum: '2026-06-12',
    transaktionstext: 'Arbetsgivardeklaration 202605',
    belopp_skatteverket: -9675,
    ...overrides,
  }
}

describe('settleAgiTaxPayments', () => {
  it('settles the declaration when the AGI debit matches period and exact amount', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [agiDebitRow()],
      1500,
    )

    expect(settled).toBe(1)
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ tax_paid_at: '2026-06-12T00:00:00Z' })
    // Guarded update: right row, right company, still unpaid.
    expect(updates[0].filters).toMatchObject({
      id: 'agi-may',
      company_id: COMPANY,
      tax_paid_at: null,
    })
  })

  it('settles nothing when the skattekonto is in deficit', async () => {
    const { supabase, updates, selects } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [agiDebitRow()],
      -0.01,
    )

    expect(settled).toBe(0)
    expect(updates).toHaveLength(0)
    expect(selects).toHaveLength(0)
  })

  it('skips amount mismatches, including ore-level drift', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [
        agiDebitRow({ belopp_skatteverket: -9675.01 }),
        agiDebitRow({ belopp_skatteverket: -9674 }),
      ],
      0,
    )

    expect(settled).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('compares amounts to the ore, tolerating float representation', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [
        declaration({ total_tax: 3390.55, total_avgifter: 6284.45 }),
      ],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [agiDebitRow({ belopp_skatteverket: -9675 })],
      0,
    )

    expect(settled).toBe(1)
    expect(updates).toHaveLength(1)
  })

  it('ignores positive rows and rows without an AGI period token', async () => {
    const { supabase, updates, selects } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [
        // Inbetalning: positive, and no period token anyway.
        agiDebitRow({
          transaktionstext: 'Inbetalning bokförd 260610',
          belopp_skatteverket: 9675,
        }),
        // Debit but not AGI.
        agiDebitRow({
          transaktionstext: 'Moms 202605',
          belopp_skatteverket: -9675,
        }),
      ],
      1000,
    )

    expect(settled).toBe(0)
    expect(updates).toHaveLength(0)
    // No candidates at all: the declaration lookup is skipped entirely.
    expect(selects).toHaveLength(0)
  })

  it('settles each declaration at most once per batch', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [agiDebitRow(), agiDebitRow()],
      0,
    )

    expect(settled).toBe(1)
    expect(updates).toHaveLength(1)
  })

  it('handles multiple periods in one batch', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [
        declaration(),
        declaration({
          id: 'agi-june',
          period_month: 6,
          total_tax: 3400,
          total_avgifter: 6300,
        }),
      ],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [
        agiDebitRow(),
        agiDebitRow({
          transaktionsdatum: '2026-07-12',
          transaktionstext: 'Arbetsgivardeklaration 202606',
          belopp_skatteverket: -9700,
        }),
      ],
      250,
    )

    expect(settled).toBe(2)
    expect(updates).toHaveLength(2)
    expect(updates.map(u => u.filters.id).sort()).toEqual(['agi-june', 'agi-may'].sort())
  })

  it('returns 0 and does not throw when the lookup fails', async () => {
    const { supabase, updates } = createSettlementMock({
      selectError: { message: 'boom' },
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [agiDebitRow()],
      0,
    )

    expect(settled).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('returns 0 and does not throw when the update fails', async () => {
    const { supabase } = createSettlementMock({
      declarations: [declaration()],
      updateError: { message: 'boom' },
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [agiDebitRow()],
      0,
    )

    expect(settled).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Production format: the draw books as two rows with Swedish month names
// ("Avdragen skatt maj 2026" = total_tax, "Arbetsgivaravgift maj 2026" =
// total_avgifter) instead of the test environment's single combined
// "Arbetsgivardeklaration YYYYMM" row.
// ──────────────────────────────────────────────────────────────────────

function taxDrawRow(overrides: Record<string, unknown> = {}) {
  return {
    transaktionsdatum: '2026-06-12',
    transaktionstext: 'Avdragen skatt maj 2026',
    belopp_skatteverket: -3391,
    ...overrides,
  }
}

function avgiftDrawRow(overrides: Record<string, unknown> = {}) {
  return {
    transaktionsdatum: '2026-06-12',
    transaktionstext: 'Arbetsgivaravgift maj 2026',
    belopp_skatteverket: -6284,
    ...overrides,
  }
}

describe('settleAgiTaxPayments: production two-row format', () => {
  it('settles when the tax + avgift pair matches the declared amounts exactly', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [taxDrawRow(), avgiftDrawRow()],
      2538,
    )

    expect(settled).toBe(1)
    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({ tax_paid_at: '2026-06-12T00:00:00Z' })
    expect(updates[0].filters).toMatchObject({
      id: 'agi-may',
      company_id: COMPANY,
      tax_paid_at: null,
    })
  })

  it('settles on the later date when the pair books on different days', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [
        taxDrawRow({ transaktionsdatum: '2026-06-12' }),
        avgiftDrawRow({ transaktionsdatum: '2026-06-13' }),
      ],
      0,
    )

    expect(settled).toBe(1)
    expect(updates[0].payload).toEqual({ tax_paid_at: '2026-06-13T00:00:00Z' })
  })

  it('does not settle from a lone tax row', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [taxDrawRow()],
      0,
    )

    expect(settled).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('does not settle when one side of the pair mismatches', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [taxDrawRow(), avgiftDrawRow({ belopp_skatteverket: -6283 })],
      0,
    )

    expect(settled).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('skips the period when duplicate rows of one kind make it ambiguous', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [taxDrawRow(), taxDrawRow(), avgiftDrawRow()],
      0,
    )

    expect(settled).toBe(0)
    expect(updates).toHaveLength(0)
  })

  it('never classifies beslut correction rows as draws', async () => {
    const { supabase, updates, selects } = createSettlementMock({
      declarations: [declaration({ period_month: 3 })],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [
        {
          transaktionsdatum: '2026-08-12',
          transaktionstext: 'Beslut 260703 arbetsgivaravgift mars 2026',
          belopp_skatteverket: -2524,
        },
      ],
      0,
    )

    expect(settled).toBe(0)
    expect(updates).toHaveLength(0)
    // The beslut row is not a draw candidate at all: no lookup happens.
    expect(selects).toHaveLength(0)
  })

  it('a beslut row for the same period does not block the pair from settling', async () => {
    const { supabase, updates } = createSettlementMock({
      declarations: [declaration()],
    })

    const settled = await settleAgiTaxPayments(
      supabase as never,
      COMPANY,
      [
        taxDrawRow(),
        avgiftDrawRow(),
        {
          transaktionsdatum: '2026-08-12',
          transaktionstext: 'Beslut 260703 arbetsgivaravgift maj 2026',
          belopp_skatteverket: -2524,
        },
      ],
      0,
    )

    expect(settled).toBe(1)
    expect(updates).toHaveLength(1)
  })
})
