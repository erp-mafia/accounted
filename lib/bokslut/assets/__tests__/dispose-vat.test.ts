import { describe, it, expect, vi } from 'vitest'
import { disposeAsset } from '../asset-service'
import type { Asset } from '@/types'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({
    id: 'entry-1',
    voucher_series: 'A',
    voucher_number: 1,
  }),
}))

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'u',
    company_id: 'co',
    name: 'Test',
    category: 'equipment',
    acquisition_date: '2023-01-01',
    acquisition_cost: 100_000,
    salvage_value: 0,
    useful_life_months: 60,
    depreciation_method: 'linear',
    bas_asset_account: '1220',
    bas_accumulated_account: '1229',
    bas_expense_account: '7832',
    restvarde_target: null,
    disposed_at: null,
    disposed_proceeds: null,
    disposed_proceeds_vat: 0,
    disposed_vat_treatment: null,
    jamkning_amount: 0,
    jamkning_remaining_months: null,
    jamkning_total_months: null,
    jamkning_original_input_vat: null,
    k3_components: null,
    notes: null,
    created_at: '2023-01-01T00:00:00Z',
    updated_at: '2023-01-01T00:00:00Z',
    ...overrides,
  }
}

interface CapturedLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

function makeSupabaseForDispose(asset: Asset, schedules: Array<{ planned_depreciation: number }>) {
  const builders = {
    getBuilder: {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: asset, error: null }),
    },
    schedulesBuilder: (() => {
      const b: Record<string, unknown> = {
        select: vi.fn(),
        eq: vi.fn(),
        not: vi.fn(),
        then: undefined,
      }
      ;(b.select as ReturnType<typeof vi.fn>).mockReturnValue(b)
      ;(b.eq as ReturnType<typeof vi.fn>).mockReturnValue(b)
      ;(b.not as ReturnType<typeof vi.fn>).mockReturnValue(b)
      b.then = (resolve: (v: { data: unknown; error: unknown }) => void) =>
        resolve({ data: schedules, error: null })
      return b as {
        select: ReturnType<typeof vi.fn>
        eq: ReturnType<typeof vi.fn>
        not: ReturnType<typeof vi.fn>
      }
    })(),
    updateBuilder: {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...asset, disposed_at: '2026-05-26' },
        error: null,
      }),
    },
  }
  let calls = 0
  const supabase = {
    from: vi.fn((table: string) => {
      calls++
      if (table === 'depreciation_schedules') return builders.schedulesBuilder
      return calls === 1 ? builders.getBuilder : builders.updateBuilder
    }),
  }
  return { supabase, builders } as const
}

async function captureLines(asset: Asset, schedules: Array<{ planned_depreciation: number }>, input: Parameters<typeof disposeAsset>[4]): Promise<{ lines: CapturedLine[]; updateArgs: Record<string, unknown> }> {
  const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
  vi.mocked(createJournalEntry).mockClear()
  const { supabase, builders } = makeSupabaseForDispose(asset, schedules)
  await disposeAsset(
    supabase as unknown as Parameters<typeof disposeAsset>[0],
    'co',
    'u',
    'asset-1',
    input,
  )
  const call = vi.mocked(createJournalEntry).mock.calls[0]
  const lines = (call![3] as { lines: CapturedLine[] }).lines
  const updateArgs = (builders.updateBuilder.update.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>
  return { lines, updateArgs }
}

function sumDebit(lines: CapturedLine[]): number {
  return Math.round(lines.reduce((s, l) => s + l.debit_amount, 0) * 100) / 100
}
function sumCredit(lines: CapturedLine[]): number {
  return Math.round(lines.reduce((s, l) => s + l.credit_amount, 0) * 100) / 100
}

describe('disposeAsset — VAT on proceeds', () => {
  it('standard_25 sale appends a 2611 credit and balances', async () => {
    // Acquisition 100 000, accumulated 40 000 → NBV 60 000.
    // Gross proceeds 100 000 → net 80 000 → vat 20 000 → gain 20 000.
    const asset = makeAsset({ category: 'equipment' })
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-05-26',
        disposed_proceeds: 100_000,
        proceeds_vat: 20_000,
        vat_treatment: 'standard_25',
        fiscal_period_id: 'fp',
      },
    )
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe(20_000)
    // Gain on NET proceeds, not gross: 80 000 net − 60 000 NBV = 20 000 gain
    expect(lines.find((l) => l.account_number === '3973')?.credit_amount).toBe(20_000)
    // No loss line on a gain scenario
    expect(lines.find((l) => l.account_number === '7973')).toBeUndefined()
    // Bank debit = gross
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe(100_000)
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('reduced_12 sale uses BAS 2621', async () => {
    const asset = makeAsset()
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-05-26',
        disposed_proceeds: 100_000,
        proceeds_vat: 100_000 - 100_000 / 1.12,
        vat_treatment: 'reduced_12',
        fiscal_period_id: 'fp',
      },
    )
    expect(lines.find((l) => l.account_number === '2621')).toBeDefined()
    expect(lines.find((l) => l.account_number === '2611')).toBeUndefined()
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('reduced_6 sale uses BAS 2631', async () => {
    const asset = makeAsset()
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-05-26',
        disposed_proceeds: 100_000,
        proceeds_vat: 100_000 - 100_000 / 1.06,
        vat_treatment: 'reduced_6',
        fiscal_period_id: 'fp',
      },
    )
    expect(lines.find((l) => l.account_number === '2631')).toBeDefined()
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('reverse_charge sale posts NO VAT line', async () => {
    const asset = makeAsset()
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-05-26',
        disposed_proceeds: 80_000,
        proceeds_vat: 0,
        vat_treatment: 'reverse_charge',
        fiscal_period_id: 'fp',
      },
    )
    expect(lines.find((l) => l.account_number.startsWith('261'))).toBeUndefined()
    // The full proceeds counts as net (no VAT taken out) → gain = 80 000 − 60 000 = 20 000
    expect(lines.find((l) => l.account_number === '3973')?.credit_amount).toBe(20_000)
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('export sale posts NO VAT line', async () => {
    const asset = makeAsset()
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-05-26',
        disposed_proceeds: 80_000,
        proceeds_vat: 0,
        vat_treatment: 'export',
        fiscal_period_id: 'fp',
      },
    )
    expect(lines.find((l) => l.account_number.startsWith('26'))).toBeUndefined()
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('throws when proceeds_vat > 0 but no vat_treatment is supplied', async () => {
    const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
    vi.mocked(createJournalEntry).mockClear()
    const { supabase } = makeSupabaseForDispose(makeAsset(), [{ planned_depreciation: 40_000 }])
    await expect(
      disposeAsset(supabase as unknown as Parameters<typeof disposeAsset>[0], 'co', 'u', 'asset-1', {
        disposed_at: '2026-05-26',
        disposed_proceeds: 100_000,
        proceeds_vat: 20_000,
        fiscal_period_id: 'fp',
      }),
    ).rejects.toThrow(/vat_treatment/)
  })

  it('throws when reverse_charge is selected but proceeds_vat > 0', async () => {
    const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
    vi.mocked(createJournalEntry).mockClear()
    const { supabase } = makeSupabaseForDispose(makeAsset(), [{ planned_depreciation: 40_000 }])
    await expect(
      disposeAsset(supabase as unknown as Parameters<typeof disposeAsset>[0], 'co', 'u', 'asset-1', {
        disposed_at: '2026-05-26',
        disposed_proceeds: 80_000,
        proceeds_vat: 5_000,
        vat_treatment: 'reverse_charge',
        fiscal_period_id: 'fp',
      }),
    ).rejects.toThrow(/reverse_charge/)
  })

  it('zero-VAT sale (no fields passed) still posts a balanced entry', async () => {
    const asset = makeAsset()
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-05-26',
        disposed_proceeds: 50_000,
        fiscal_period_id: 'fp',
      },
    )
    // No VAT line
    expect(lines.find((l) => l.account_number.startsWith('26'))).toBeUndefined()
    // Loss on 50 000 − 60 000 = -10 000 → 7973 debit
    expect(lines.find((l) => l.account_number === '7973')?.debit_amount).toBe(10_000)
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })
})

describe('disposeAsset — jämkning (input VAT correction)', () => {
  it('credits 2641 and debits 6991 for the jämkning amount', async () => {
    const asset = makeAsset({ category: 'equipment' })
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-01-01',
        disposed_proceeds: 60_000,
        fiscal_period_id: 'fp',
        // 5-year asset sold after 3 years; 24 months remain × 20 000 VAT × 24/60 = 8 000
        jamkning_amount: 8_000,
        jamkning_remaining_months: 24,
        jamkning_total_months: 60,
        jamkning_original_input_vat: 20_000,
      },
    )
    // 2641 credit (reverses prior input VAT deduction)
    expect(lines.find((l) => l.account_number === '2641')?.credit_amount).toBe(8_000)
    // Jämkning is a VAT correction (ML 8a kap), not a disposal loss — it must
    // route to 6991 "Övriga externa kostnader, avdragsgilla", NOT to 78xx.
    expect(lines.find((l) => l.account_number === '6991')?.debit_amount).toBe(8_000)
    // No 78xx line — proceeds 60 000 = NBV 60 000 means no gain/loss, and the
    // jämkning explicitly does not contaminate the disposal-loss accounts.
    expect(lines.find((l) => l.account_number === '7973')).toBeUndefined()
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('combined VAT + jämkning + gain stays balanced', async () => {
    const asset = makeAsset({ category: 'equipment' })
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-01-01',
        disposed_proceeds: 100_000, // gross
        proceeds_vat: 20_000, // 25%
        vat_treatment: 'standard_25',
        fiscal_period_id: 'fp',
        jamkning_amount: 8_000,
        jamkning_remaining_months: 24,
        jamkning_total_months: 60,
        jamkning_original_input_vat: 20_000,
      },
    )
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe(20_000)
    expect(lines.find((l) => l.account_number === '2641')?.credit_amount).toBe(8_000)
    // Gain 20 000 on net proceeds → 3973 credit; jämkning 8 000 → 6991 debit
    // (NOT 7973 — see ML 8a kap, jämkning is a VAT correction not a loss).
    expect(lines.find((l) => l.account_number === '3973')?.credit_amount).toBe(20_000)
    expect(lines.find((l) => l.account_number === '6991')?.debit_amount).toBe(8_000)
    expect(lines.find((l) => l.account_number === '7973')).toBeUndefined()
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('zero jämkning amount produces no extra lines', async () => {
    const asset = makeAsset()
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-01-01',
        disposed_proceeds: 60_000,
        fiscal_period_id: 'fp',
        jamkning_amount: 0,
      },
    )
    expect(lines.find((l) => l.account_number === '2641')).toBeUndefined()
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('routes jämkning to 6991 even for building category (never to 78xx)', async () => {
    const asset = makeAsset({
      category: 'building',
      bas_asset_account: '1110',
      bas_accumulated_account: '1119',
      bas_expense_account: '7821',
      acquisition_cost: 2_000_000,
    })
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 200_000 }],
      {
        disposed_at: '2026-01-01',
        disposed_proceeds: 1_800_000,
        fiscal_period_id: 'fp',
        // 10-year fastighet, 60 months remaining out of 120, original 200 000 → 100 000
        jamkning_amount: 100_000,
        jamkning_remaining_months: 60,
        jamkning_total_months: 120,
        jamkning_original_input_vat: 200_000,
      },
    )
    // Jämkning goes to 6991 regardless of asset category — it's a VAT
    // correction per ML 8a kap, NOT a förlust vid avyttring (78xx).
    expect(lines.find((l) => l.account_number === '6991')?.debit_amount).toBe(100_000)
    // The disposal itself is at a loss (NBV 1.8M = proceeds 1.8M? Let's check:
    // acq 2.0M − ack 0.2M = NBV 1.8M, proceeds 1.8M → no gain/loss line). The
    // only debit-side cost line is the 6991 jämkning entry.
    expect(lines.find((l) => l.account_number === '7971')).toBeUndefined()
    expect(lines.find((l) => l.account_number === '7973')).toBeUndefined()
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('persists jämkning + VAT audit metadata on the asset row', async () => {
    const asset = makeAsset()
    const { updateArgs } = await captureLines(
      asset,
      [{ planned_depreciation: 40_000 }],
      {
        disposed_at: '2026-01-01',
        disposed_proceeds: 100_000,
        proceeds_vat: 20_000,
        vat_treatment: 'standard_25',
        fiscal_period_id: 'fp',
        jamkning_amount: 8_000,
        jamkning_remaining_months: 24,
        jamkning_total_months: 60,
        jamkning_original_input_vat: 20_000,
      },
    )
    expect(updateArgs.disposed_proceeds).toBe(100_000)
    expect(updateArgs.disposed_proceeds_vat).toBe(20_000)
    expect(updateArgs.disposed_vat_treatment).toBe('standard_25')
    expect(updateArgs.jamkning_amount).toBe(8_000)
    expect(updateArgs.jamkning_remaining_months).toBe(24)
    expect(updateArgs.jamkning_total_months).toBe(60)
    expect(updateArgs.jamkning_original_input_vat).toBe(20_000)
  })
})

describe('disposeAsset — gain vs loss with VAT', () => {
  it('gain scenario: net proceeds > NBV → 3973 credit', async () => {
    const asset = makeAsset({ category: 'equipment' })
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 50_000 }],
      {
        disposed_at: '2026-05-26',
        // NBV = 50 000, net proceeds = 80 000 → gain 30 000
        disposed_proceeds: 100_000,
        proceeds_vat: 20_000,
        vat_treatment: 'standard_25',
        fiscal_period_id: 'fp',
      },
    )
    expect(lines.find((l) => l.account_number === '3973')?.credit_amount).toBe(30_000)
    expect(lines.find((l) => l.account_number === '7973')).toBeUndefined()
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('loss scenario: net proceeds < NBV → 7973 debit', async () => {
    const asset = makeAsset({ category: 'equipment' })
    const { lines } = await captureLines(
      asset,
      [{ planned_depreciation: 20_000 }],
      {
        disposed_at: '2026-05-26',
        // NBV = 80 000, net proceeds = 40 000 → loss 40 000
        disposed_proceeds: 50_000,
        proceeds_vat: 10_000,
        vat_treatment: 'standard_25',
        fiscal_period_id: 'fp',
      },
    )
    expect(lines.find((l) => l.account_number === '7973')?.debit_amount).toBe(40_000)
    expect(lines.find((l) => l.account_number === '3973')).toBeUndefined()
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })
})
