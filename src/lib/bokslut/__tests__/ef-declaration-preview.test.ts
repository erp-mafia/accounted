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

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(async () => ({ net_result: 120_000 })),
}))

const PERIOD = { id: 'fp-1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }

/** Table-routed mock: companies.entity_type and the fiscal period row. */
function makeSupabase(entityType: string | null) {
  const reads: string[] = []
  const rows: Record<string, unknown> = {
    companies: entityType ? { entity_type: entityType } : null,
    fiscal_periods: PERIOD,
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

    expect(preview.fiscalPeriod).toEqual(PERIOD)
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
