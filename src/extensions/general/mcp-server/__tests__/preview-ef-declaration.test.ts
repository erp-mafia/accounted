/**
 * gnubok_preview_ef_declaration surfaces the preview's legal-form refusal as
 * its normal coded error result: the tool throws what
 * computeEfDeclarationPreview throws, and the dispatcher maps a thrown
 * `.code` to the structured error the agent can dispatch on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getStructuredError } from '@/lib/errors/get-structured-error'

vi.mock('@/lib/reports/ne-bilaga/ne-engine', () => ({
  generateNEDeclaration: vi.fn(async () => ({ rutor: { R11: 120_000 } })),
}))

import { tools } from '../server'

const tool = tools.find((candidate) => candidate.name === 'gnubok_preview_ef_declaration')!

const PERIOD = { id: 'fp-1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }

function makeSupabase(entityType: string) {
  const rows: Record<string, unknown> = {
    companies: { entity_type: entityType },
    fiscal_periods: PERIOD,
  }
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'eq']) chain[name] = () => chain
    chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null })
    chain.single = async () => ({ data: rows[table] ?? null, error: null })
    return chain
  })
  return { auth: {}, from }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_preview_ef_declaration: legal-form gate', () => {
  it.each(['aktiebolag', 'ideell_forening'])(
    'rejects %s with EF_DECLARATION_WRONG_LEGAL_FORM',
    async (entityType) => {
      let thrown: unknown
      try {
        await tool.execute({ fiscal_period_id: 'fp-1' }, 'company-1', 'user-1', makeSupabase(entityType) as never, {
          type: 'api_key',
        } as never)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeDefined()
      expect((thrown as { code?: string }).code).toBe('EF_DECLARATION_WRONG_LEGAL_FORM')
      // What the dispatcher hands the agent: the registry code, not UNKNOWN_ERROR.
      expect(getStructuredError(thrown).code).toBe('EF_DECLARATION_WRONG_LEGAL_FORM')
    },
  )

  it('still previews an enskild firma', async () => {
    const result = (await tool.execute(
      { fiscal_period_id: 'fp-1', category: 'full' },
      'company-1',
      'user-1',
      makeSupabase('enskild_firma') as never,
      { type: 'api_key' } as never,
    )) as { bookedSurplus: number; items: Array<{ kind: string }> }

    expect(result.bookedSurplus).toBe(120_000)
    expect(result.items.map((i) => i.kind)).toContain('egenavgifter')
  })

  it('caps an expansionsfond avsättning on expansionsfond_kapitalunderlag, not kapitalunderlag', async () => {
    const result = (await tool.execute(
      {
        fiscal_period_id: 'fp-1',
        kapitalunderlag: 100_000,
        expansionsfond_kapitalunderlag: 400_000,
        expansionsfond_desired_change: 300_000,
      },
      'company-1',
      'user-1',
      makeSupabase('enskild_firma') as never,
      { type: 'api_key' } as never,
    )) as {
      items: Array<{ kind: string; amount: number; computation: Record<string, unknown> }>
      rutor: Record<string, number>
    }

    // Cap 125,94 % x 400 000 = 503 760, but the ökning is also at most R35:
    // R29 120 000 - R30 7 960 (7,96 % of 100 000, inkomstår 2025) = R33
    // 112 040, less R34 33 612 (30 %) = R35 78 428.
    const exp = result.items.find((i) => i.kind === 'expansionsfond_avsattning')
    expect(exp?.computation).toMatchObject({ kapitalunderlag: 400_000, maxTotalBalance: 503_760 })
    expect(exp?.amount).toBe(78_428)
    expect(result.rutor).toMatchObject({ R30: 7_960, R35: 78_428, R36: 78_428 })
  })

  it('uses sparat_fordelningsbelopp in R30 on top of the year\'s fördelningsbelopp', async () => {
    const result = (await tool.execute(
      { fiscal_period_id: 'fp-1', kapitalunderlag: 110_000, sparat_fordelningsbelopp: 10_000 },
      'company-1',
      'user-1',
      makeSupabase('enskild_firma') as never,
      { type: 'api_key' } as never,
    )) as { rutor: Record<string, number> }

    // Skatteverket's example: 7,96 % x 110 000 = 8 756, plus the sparat 10 000.
    expect(result.rutor.R30).toBe(18_756)
  })

  it('returns the fund in its last year in R32 and lists the rest with their last year', async () => {
    const result = (await tool.execute(
      {
        fiscal_period_id: 'fp-1',
        pfond_existing_fonder: [
          { cohort_year: 2019, balance: 50_000 },
          { cohort_year: 2022, balance: 10_000 },
        ],
      },
      'company-1',
      'user-1',
      makeSupabase('enskild_firma') as never,
      { type: 'api_key' } as never,
    )) as {
      items: Array<{ kind: string; amount: number; ne_ruta: string; computation: Record<string, unknown> }>
      pfondFonder: Array<{ cohort_year: number; status: string; latest_return_year: number }>
    }

    const ateforing = result.items.find((i) => i.kind === 'periodiseringsfond_ateforing')
    expect(ateforing).toMatchObject({ amount: 50_000, ne_ruta: 'R32' })
    expect(result.items.find((i) => i.kind === 'periodiseringsfond_avsattning')?.computation).toMatchObject({
      surplus: 170_000,
    })
    expect(result.pfondFonder.map((f) => [f.cohort_year, f.status, f.latest_return_year])).toEqual([
      [2019, 'mandatory', 2025],
      [2022, 'optional', 2028],
    ])
  })
})

