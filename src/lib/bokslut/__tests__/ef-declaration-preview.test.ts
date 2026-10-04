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
    company_settings: settingsEntityType ? { entity_type: settingsEntityType } : null,
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

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1')
    const egenavgifter = preview.items.find((i) => i.kind === 'egenavgifter')

    expect(egenavgifter?.computation).toMatchObject({ surplusBeforeEgenavgifter: 130_000 })
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

    // 1 000 000 x 8,55 % = 85 500 in R30; R33 = 120 000 - 85 500 = 34 500.
    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      kapitalunderlag: 1_000_000,
    })

    expect(pfondOf(preview.items)?.computation).toMatchObject({ surplus: 34_500 })
    expect(pfondOf(preview.items)?.amount).toBe(10_350)
  })

  it('adds negativ räntefördelning (R31) before the 30 % cap', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    // 600 000 x 3,55 % = 21 300 in R31; R33 = 120 000 + 21 300 = 141 300.
    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      kapitalunderlag: -600_000,
    })

    expect(pfondOf(preview.items)?.computation).toMatchObject({ surplus: 141_300 })
    expect(pfondOf(preview.items)?.amount).toBe(42_390)
  })
})

describe('computeEfDeclarationPreview: expansionsfond uses the closing kapitalunderlag (IL 34 kap 7 §)', () => {
  const expansionsfondOf = (items: Array<{ kind: string }>) =>
    items.find((i) => i.kind.startsWith('expansionsfond_')) as
      | { kind: string; amount: number; ne_ruta: string; computation: Record<string, unknown> }
      | undefined

  it('caps the fund at 125,94 % of the closing kapitalunderlag, not the opening one', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      // Opening, for räntefördelning (IL 33 kap 8 §): cap would be 125 940.
      kapitalunderlag: 100_000,
      // Closing, for expansionsfond: cap is 503 760.
      expansionsfondKapitalunderlag: 400_000,
      expansionsfondDesiredChange: 300_000,
    })

    const exp = expansionsfondOf(preview.items)
    expect(exp?.computation).toMatchObject({ kapitalunderlag: 400_000, maxTotalBalance: 503_760 })
    expect(exp?.amount).toBe(300_000)
    expect(exp?.ne_ruta).toBe('R36')
  })

  it('never borrows the opening kapitalunderlag when the closing one is missing', async () => {
    const { supabase } = makeSupabase('enskild_firma')

    const preview = await computeEfDeclarationPreview(supabase, 'co-1', 'fp-1', {
      kapitalunderlag: 1_000_000,
      expansionsfondDesiredChange: 50_000,
    })

    const exp = expansionsfondOf(preview.items)
    expect(exp?.kind).toBe('expansionsfond_avsattning')
    expect(exp?.computation).toMatchObject({ kapitalunderlag: 0, actualChange: 0 })
    expect(exp?.amount).toBe(0)
  })
})
