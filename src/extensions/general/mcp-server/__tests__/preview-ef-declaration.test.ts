/**
 * gnubok_preview_ef_declaration surfaces the preview's legal-form refusal as
 * its normal coded error result: the tool throws what
 * computeEfDeclarationPreview throws, and the dispatcher maps a thrown
 * `.code` to the structured error the agent can dispatch on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getStructuredError } from '@/lib/errors/get-structured-error'

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(async () => ({ net_result: 120_000 })),
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
})
