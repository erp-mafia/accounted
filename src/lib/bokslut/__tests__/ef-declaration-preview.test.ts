/**
 * computeEfDeclarationPreview refuses every legal form but the NE filer.
 *
 * Before this, the MCP tool gnubok_preview_ef_declaration (and anything else
 * calling the preview) computed egenavgifter, räntefördelning and the EF
 * periodiseringsfond for any company, so an agent working an aktiebolag or an
 * ideell förening got figures that mean nothing for that form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import {
  computeEfDeclarationPreview,
  EfDeclarationNotApplicableError,
  R29_FROM_BOOKED_RESULT,
} from '../enskild-firma/ef-declaration-preview'

// The real NE engine runs on top of a mocked trial balance, so the preview
// base is whatever NE R11 says for these rows.
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'

const PERIOD = { id: 'fp-1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }

type Row = { account_number: string; account_name: string; closing_debit: number; closing_credit: number }

function row(account_number: string, side: 'debit' | 'credit', amount: number): Row {
  return {
    account_number,
    account_name: `Konto ${account_number}`,
    closing_debit: side === 'debit' ? amount : 0,
    closing_credit: side === 'credit' ? amount : 0,
  }
}

/** One sale of 120 000 kr: NE R11 = 120 000. */
function useRows(rowsFor: (closingEntry: string | undefined) => Row[]) {
  vi.mocked(generateTrialBalance).mockImplementation((async (
    _supabase: unknown,
    _companyId: unknown,
    _periodId: unknown,
    options?: { closingEntry?: string },
  ) => ({ rows: rowsFor(options?.closingEntry) })) as never)
}

/**
 * Table-routed mock: companies.entity_type, the fiscal period row, and the
 * company_settings row the NE engine reads its form from.
 */
function makeSupabase(entityType: string | null, settingsEntityType: string | null = 'enskild_firma') {
  const reads: string[] = []
  const rows: Record<string, unknown> = {
    companies: entityType ? { entity_type: entityType } : null,
    fiscal_periods: { ...PERIOD, is_closed: false },
    company_settings: settingsEntityType ? { entity_type: settingsEntityType, org_number: '800374-0118' } : null,
  }
  const from = vi.fn((table: string) => {
    reads.push(table)
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'eq']) chain[name] = () => chain
    chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null })
    chain.single = async () => ({ data: rows[table] ?? null, error: null })
    return chain
  })
  return { supabase: { from } as unknown as SupabaseClient, reads }
}

beforeEach(() => {
  vi.clearAllMocks()
  useRows(() => [row('3001', 'credit', 120_000)])
})

describe('computeEfDeclarationPreview: legal-form gate', () => {
  it.each(['aktiebolag', 'ideell_forening'])(
    'refuses %s with a typed, coded error before reading the period',
    async (entityType) => {
      const { supabase, reads } = makeSupabase(entityType)

      const attempt = computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')
      await expect(attempt).rejects.toBeInstanceOf(EfDeclarationNotApplicableError)
      await expect(attempt).rejects.toMatchObject({
        code: 'EF_DECLARATION_WRONG_LEGAL_FORM',
        entityType,
      })
      expect(reads).toEqual(['companies'])
    },
  )

  it('still computes the preview for an enskild firma', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')

    expect(preview.fiscalPeriod).toMatchObject(PERIOD)
    expect(preview.bookedSurplus).toBe(120_000)
    expect(preview.items.map((i) => i.kind)).toContain('egenavgifter')
  })

  it('takes the caller-resolved form as a hint and skips the companies read', async () => {
    const { supabase, reads } = makeSupabase(null)

    await expect(
      computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', { entityType: 'enskild_firma' }),
    ).resolves.toMatchObject({ bookedSurplus: 120_000 })
    expect(reads).not.toContain('companies')

    await expect(
      computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', { entityType: 'aktiebolag' }),
    ).rejects.toMatchObject({ code: 'EF_DECLARATION_WRONG_LEGAL_FORM' })
  })

  it('never defaults the form: an unresolvable entity_type is an error, not an enskild firma', async () => {
    const { supabase } = makeSupabase(null)
    await expect(computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')).rejects.toMatchObject({
      code: 'COMPANY_ENTITY_TYPE_UNKNOWN',
    })
  })

  it('resolves to a registered 400 code with Swedish and English text', () => {
    const structured = getStructuredError(new EfDeclarationNotApplicableError('aktiebolag'))
    expect(structured.code).toBe('EF_DECLARATION_WRONG_LEGAL_FORM')
    const entry = getErrorEntry('EF_DECLARATION_WRONG_LEGAL_FORM')
    expect(entry?.httpStatus).toBe(400)
    expect(entry?.message_sv).toMatch(/enskild firma/)
    expect(entry?.message_en).toMatch(/enskild firma/)
  })
})

describe('computeEfDeclarationPreview: base is NE R11', () => {
  // Sale 200 000, rent 50 000, and a year-end depreciation entry of 20 000
  // (source_type 'year_end'). The operating income statement reads the books
  // with 'exclude-all-year-end' and would leave the depreciation out (150 000);
  // NE R11 keeps every bokslut entry but the result transfer (130 000).
  beforeEach(() => {
    useRows((closingEntry) => [
      row('3001', 'credit', 200_000),
      row('5010', 'debit', 50_000),
      ...(closingEntry === 'exclude-all-year-end' ? [] : [row('7832', 'debit', 20_000)]),
    ])
  })

  it('takes the booked surplus from NE R11, year-end depreciation included', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')
    const ne = await generateNEDeclaration(supabase, 'co-1', 'fp-1')

    expect(ne.rutor.R11).toBe(130_000)
    expect(preview.bookedSurplus).toBe(ne.rutor.R11)
    for (const call of vi.mocked(generateTrialBalance).mock.calls) {
      expect(call[3]).toMatchObject({ closingEntry: 'exclude-final' })
    }
  })

  it('computes egenavgifter on that base', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    // No periodiseringsfond, so nothing stands between R29 and R42.
    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', { pfondDesiredAmount: 0 })
    const egenavgifter = preview.items.find((i) => i.kind === 'egenavgifter')

    expect(egenavgifter?.computation).toMatchObject({ surplusBeforeEgenavgifter: 130_000 })
    expect(preview.rutor).toMatchObject({ R29: 130_000, R42: 130_000, R43: 32_500 })
  })
})

describe('computeEfDeclarationPreview: periodiseringsfond base is NE R33 (IL 30 kap 6 §)', () => {
  // NE R11 = 120 000 (one sale). The engine has no R12-R28 adjustments, so
  // R29 = R11. R33 = R29 - R30 (positiv räntefördelning) + R31 (negativ).
  // Egenavgifter (R40-R43) come after R34 on the form: IL 30 kap 6 § adds
  // the avdrag back, so it never reduces the base.
  const pfondOf = (items: Array<{ kind: string }>) =>
    items.find((i) => i.kind === 'periodiseringsfond_avsattning') as
      | { amount: number; ne_ruta: string; computation: Record<string, unknown> }
      | undefined

  it('does not deduct egenavgifter from the base', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')

    // 30 % of 120 000, not 30 % of (120 000 - 30 000 schablonavdrag).
    expect(pfondOf(preview.items)?.amount).toBe(36_000)
    expect(pfondOf(preview.items)?.computation).toMatchObject({ surplus: 120_000 })
    expect(pfondOf(preview.items)?.ne_ruta).toBe('R34')
  })

  it('deducts positiv räntefördelning (R30) before the 30 % cap', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    // Inkomstår 2025: 1 000 000 x 7,96 % = 79 600 in R30 (8,55 % is the
    // 2026 rate); R33 = 120 000 - 79 600 = 40 400.
    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      kapitalunderlag: 1_000_000,
    })

    expect(preview.rutor).toMatchObject({ R30: 79_600, R33: 40_400 })
    expect(pfondOf(preview.items)?.computation).toMatchObject({ surplus: 40_400 })
    expect(pfondOf(preview.items)?.amount).toBe(12_120)
  })

  it('adds negativ räntefördelning (R31) before the 30 % cap', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    // Inkomstår 2025: 600 000 x 2,96 % = 17 760 in R31; R33 = 137 760.
    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      kapitalunderlag: -600_000,
    })

    expect(preview.rutor).toMatchObject({ R31: 17_760, R33: 137_760 })
    expect(pfondOf(preview.items)?.computation).toMatchObject({ surplus: 137_760 })
    expect(pfondOf(preview.items)?.amount).toBe(41_328)
  })
})

describe('computeEfDeclarationPreview: expansionsfond uses the closing kapitalunderlag (IL 34 kap)', () => {
  const expansionsfondOf = (items: Array<{ kind: string }>) =>
    items.find((i) => i.kind.startsWith('expansionsfond_')) as
      | { kind: string; amount: number; ne_ruta: string; computation: Record<string, unknown> }
      | undefined

  it('caps the fund at 125,94 % of the closing kapitalunderlag, not the opening one', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      // Opening, for räntefördelning (IL 33 kap): cap would be 12 594.
      kapitalunderlag: 10_000,
      // Closing, for expansionsfond: cap is 503 760.
      expansionsfondKapitalunderlag: 400_000,
      expansionsfondDesiredChange: 50_000,
    })

    const exp = expansionsfondOf(preview.items)
    expect(exp?.computation).toMatchObject({ kapitalunderlag: 400_000, maxTotalBalance: 503_760 })
    expect(exp?.amount).toBe(50_000)
    expect(exp?.ne_ruta).toBe('R36')
  })

  it('caps the ökning (R36) at the result before it (R35)', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    // R11 = 120 000, no räntefördelning, no periodiseringsfond: R35 = 120 000.
    // Before this fix R36 was the asked 300 000, an underskott the form
    // forbids ("dock högst överskott vid R35").
    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      pfondDesiredAmount: 0,
      expansionsfondKapitalunderlag: 400_000,
      expansionsfondDesiredChange: 300_000,
    })

    expect(expansionsfondOf(preview.items)?.amount).toBe(120_000)
    expect(preview.rutor).toMatchObject({ R35: 120_000, R36: 120_000, R42: 0, R43: 0 })
  })

  it('returns the part of an earlier fund above the cap in R37 without being asked', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      pfondDesiredAmount: 0,
      expansionsfondKapitalunderlag: 100_000,
      expansionsfondExistingBalance: 200_000,
    })

    expect(expansionsfondOf(preview.items)).toMatchObject({ kind: 'expansionsfond_ateforing', amount: 74_060 })
    // R42 = 120 000 + 74 060; R43 = 25 %.
    expect(preview.rutor).toMatchObject({ R37: 74_060, R42: 194_060, R43: 48_515 })
    expect(preview.ovrigaUppgifter).toEqual([
      { faltkod: '8012', label: 'Kapitalunderlag expansionsfond (positivt)', amount: 100_000 },
    ])
  })

  it('never borrows the opening kapitalunderlag when the closing one is missing', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      kapitalunderlag: 1_000_000,
      expansionsfondDesiredChange: 50_000,
    })

    const exp = expansionsfondOf(preview.items)
    expect(exp?.kind).toBe('expansionsfond_avsattning')
    expect(exp?.computation).toMatchObject({ kapitalunderlag: null, actualChange: 0 })
    expect(exp?.amount).toBe(0)
  })
})

describe('computeEfDeclarationPreview: återföring (R32) of earlier periodiseringsfonder', () => {
  // NE R11 = 120 000 (one sale), fiscal year 2025. Per the
  // swedish-ef-skatteplanering skill a fund returns at the latest in the sixth
  // year after the avsättning (a 2019 fund in 2025), oldest first, in R32, and
  // R33 is the result after räntefördelning and återföring, before this
  // year's avsättning (IL 30 kap 6 §).
  const ateforingOf = (items: Array<{ kind: string }>) =>
    items.find((i) => i.kind === 'periodiseringsfond_ateforing') as
      | { amount: number; label: string; ne_ruta: string; warnings: string[]; computation: Record<string, unknown> }
      | undefined
  const avsattningOf = (items: Array<{ kind: string }>) =>
    items.find((i) => i.kind === 'periodiseringsfond_avsattning') as
      | { amount: number; computation: Record<string, unknown> }
      | undefined

  it('returns a fund in its last year in R32 and adds it to the R33 base', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      pfondExistingFonder: [{ cohort_year: 2019, balance: 50_000 }],
    })

    const ateforing = ateforingOf(preview.items)
    expect(ateforing?.amount).toBe(50_000)
    expect(ateforing?.ne_ruta).toBe('R32')
    expect(ateforing?.label).toBe('Periodiseringsfond 2019: återföring')
    // R33 = 120 000 + 50 000; R34 max 30 % = 51 000.
    expect(avsattningOf(preview.items)?.computation).toMatchObject({ surplus: 170_000 })
    expect(avsattningOf(preview.items)?.amount).toBe(51_000)
    const kinds = preview.items.map((i) => i.kind)
    expect(kinds.indexOf('periodiseringsfond_ateforing')).toBeLessThan(kinds.indexOf('periodiseringsfond_avsattning'))
    expect(preview.pfondFonder).toEqual([
      { cohort_year: 2019, balance: 50_000, latest_return_year: 2025, status: 'mandatory' },
    ])
  })

  it('lists a fund not yet due with its last year and never returns it on its own', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      pfondExistingFonder: [{ cohort_year: 2021, balance: 30_000 }],
    })

    expect(ateforingOf(preview.items)).toBeUndefined()
    expect(avsattningOf(preview.items)?.amount).toBe(36_000)
    expect(preview.pfondFonder).toEqual([
      { cohort_year: 2021, balance: 30_000, latest_return_year: 2027, status: 'optional' },
    ])
  })

  it('changes nothing without earlier funds', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')

    expect(ateforingOf(preview.items)).toBeUndefined()
    expect(avsattningOf(preview.items)?.amount).toBe(36_000)
    expect(preview.pfondFonder).toEqual([])
  })

  it('puts every fund that cannot wait in one R32 line naming the years', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      pfondExistingFonder: [
        { cohort_year: 2019, balance: 20_000 },
        { cohort_year: 2018, balance: 10_000 },
      ],
    })

    const ateforing = ateforingOf(preview.items)
    expect(preview.items.filter((i) => i.kind === 'periodiseringsfond_ateforing')).toHaveLength(1)
    expect(ateforing?.amount).toBe(30_000)
    expect(ateforing?.label).toBe('Periodiseringsfonder 2018 och 2019: återföring')
    expect(ateforing?.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('senast i 2024 års deklaration')]),
    )
  })
})

describe('computeEfDeclarationPreview: R13 and R14 from the tax adjustments', () => {
  it('adds non-deductible representation back and takes tax-free income out before every later ruta', async () => {
    // R11 = 203 850 + 150 - 4 000 = 200 000 (each ruta öre-truncated).
    useRows(() => [
      row('3001', 'credit', 203_850.6),
      row('6072', 'debit', 4_000.6),
      row('8314', 'credit', 150),
    ])
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {})

    // R13 and R14 are the NE-bilaga's own sida 2, the figures its SRU file carries.
    expect(preview.rutor).toMatchObject({ R12: 200_000, R13: 4_000, R14: 150, R29: 203_850 })
    // Every base after R29 moves with them: the periodiseringsfond cap is 30 %
    // of R33 (no räntefördelning or återföring here), 61 155 kr, not 60 000.
    expect(preview.rutor.R33).toBe(203_850)
    expect(preview.rutor.R34).toBe(61_155)
  })
})

describe('computeEfDeclarationPreview: NE sida 2 from R29 to R43 (SKV 2161)', () => {
  // The form's sums: R33 = R29 - R30 + R31 + R32, R35 = R33 - R34,
  // R42 = R35 - R36 + R37 - R38 - R39 + R40 - R41, and R43 at most 25 % of
  // "det resultat som näringsverksamheten visar före ruta R43" (Skatteverket,
  // NE hjälptext). Inkomstår 2025.
  it('fills every ruta from one worked example', async () => {
    useRows(() => [row('3001', 'credit', 500_000)])
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      kapitalunderlag: 1_000_000,
      pfondExistingFonder: [{ cohort_year: 2019, balance: 50_000 }],
      expansionsfondKapitalunderlag: 400_000,
      expansionsfondExistingBalance: 100_000,
      expansionsfondDesiredChange: 200_000,
      priorYearSchablonavdrag: 30_000,
      priorYearActualCharged: 25_000,
    })

    expect(preview.rutor).toEqual({
      R12: 500_000,
      R13: 0,
      R14: 0,
      R29: 500_000,
      R30: 79_600, // 7,96 % of 1 000 000
      R31: 0,
      R32: 50_000, // the 2019 fund, in its sixth year
      R33: 470_400,
      R34: 141_120, // 30 % of R33
      R35: 329_280,
      R36: 200_000, // under both R35 and the 125,94 % room (403 760)
      R37: 0,
      R40: 30_000,
      R41: 25_000,
      R42: 134_280,
      // Before this fix R43 was 25 % of R11 + R40 - R41 = 126 250, with
      // every deduction above it left out.
      R43: 33_570,
    })
    expect(preview.items.map((i) => [i.ne_ruta, i.amount])).toEqual([
      ['R30', 79_600],
      ['R32', 50_000],
      ['R34', 141_120],
      ['R36', 200_000],
      ['R43', 33_570],
    ])
    expect(preview.ovrigaUppgifter).toEqual([
      { faltkod: '8009', label: 'Kapitalunderlag för räntefördelning (positivt)', amount: 1_000_000 },
      { faltkod: '8012', label: 'Kapitalunderlag expansionsfond (positivt)', amount: 400_000 },
    ])
  })

  it('caps R30 at R29 and reports the saved fördelningsbelopp under Övriga uppgifter', async () => {
    useRows(() => [row('3001', 'credit', 50_000)])
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', { kapitalunderlag: 1_000_000 })

    expect(preview.rutor).toMatchObject({ R29: 50_000, R30: 50_000, R33: 0, R34: 0, R42: 0, R43: 0 })
    expect(preview.ovrigaUppgifter).toEqual([
      { faltkod: '8009', label: 'Kapitalunderlag för räntefördelning (positivt)', amount: 1_000_000 },
      { faltkod: '8011', label: 'Positivt fördelningsbelopp som sparas till nästa beskattningsår', amount: 29_600 },
    ])
  })

  it('uses a sparat fördelningsbelopp and states a negative kapitalunderlag in 8010', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      kapitalunderlag: -100_000,
      sparatFordelningsbelopp: 20_000,
    })

    expect(preview.rutor).toMatchObject({ R30: 20_000, R31: 0, R33: 100_000 })
    expect(preview.ovrigaUppgifter).toEqual([
      { faltkod: '8010', label: 'Kapitalunderlag för räntefördelning (negativt)', amount: 100_000 },
    ])
  })

  it('tells the owner that R13-R28 are not included', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')

    expect(preview.warnings).toEqual([R29_FROM_BOOKED_RESULT])
    expect(preview.ovrigaUppgifter).toEqual([])
  })
})
