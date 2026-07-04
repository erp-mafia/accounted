/**
 * Dimensions PR4: the shared `dimensions` filter arg on the report tools
 * (gnubok_get_trial_balance / gnubok_get_income_statement /
 * gnubok_get_general_ledger).
 *
 * The report generators are mocked; what is under test is the MCP layer:
 * resolve-don't-select (names → registry codes via the real
 * resolveDimensionBags against a queued supabase mock), the options handoff
 * to each generator, and the dimension_filter / dimension_resolutions echoes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { tools } from '../server'

vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/reports/income-statement', () => ({ generateIncomeStatement: vi.fn() }))
vi.mock('@/lib/reports/general-ledger', () => ({ generateGeneralLedger: vi.fn() }))

const trialBalance = tools.find((t) => t.name === 'gnubok_get_trial_balance')!
const incomeStatement = tools.find((t) => t.name === 'gnubok_get_income_statement')!
const generalLedger = tools.find((t) => t.name === 'gnubok_get_general_ledger')!

const mockTrialBalance = vi.mocked(generateTrialBalance)
const mockIncomeStatement = vi.mocked(generateIncomeStatement)
const mockGeneralLedger = vi.mocked(generateGeneralLedger)

const PERIOD_ROW = {
  id: 'fp-1',
  name: '2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
}

/** Registry fixtures matching dimension-tools.test.ts conventions. */
function enqueueRegistry(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: { dimensions_enabled: true }, error: null }) // company_settings
  enqueue({ data: null, error: null }) // ensure_company_dimensions rpc
  enqueue({
    data: [
      { id: 'dim-6', sie_dim_no: 6, name: 'Projekt', resets_annually: false, is_system: true, is_active: true, sort_order: 20 },
    ],
    error: null,
  })
  enqueue({
    data: [
      { id: 'v1', dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren takrenovering', is_active: true, start_date: null, end_date: null },
    ],
    error: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('report tools declare the dimensions filter arg', () => {
  it('is present with string-map shape on all three tools', () => {
    for (const tool of [trialBalance, incomeStatement, generalLedger]) {
      const props = (tool.inputSchema as { properties: Record<string, { type?: string; additionalProperties?: unknown }> }).properties
      expect(props.dimensions, tool.name).toBeDefined()
      expect(props.dimensions.type, tool.name).toBe('object')
      expect(props.dimensions.additionalProperties, tool.name).toEqual({ type: 'string' })
    }
  })

  it('echo fields are declared but never required', () => {
    for (const tool of [trialBalance, incomeStatement, generalLedger]) {
      const schema = tool.outputSchema as { properties?: Record<string, unknown>; required?: string[] }
      expect(schema.properties?.dimension_filter, tool.name).toBeDefined()
      expect(schema.properties?.dimension_resolutions, tool.name).toBeDefined()
      expect(schema.required ?? [], tool.name).not.toContain('dimension_filter')
      expect(schema.required ?? [], tool.name).not.toContain('dimension_resolutions')
    }
  })
})

describe('gnubok_get_trial_balance: dimensions filter', () => {
  it('resolves a value NAME to its registry code, filters, and echoes both', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null }) // period info
    enqueueRegistry(enqueue)
    mockTrialBalance.mockResolvedValueOnce({ rows: [], totalDebit: 0, totalCredit: 0 } as never)

    const result = (await trialBalance.execute(
      { period_id: 'fp-1', dimensions: { '6': 'villa almgren tak' } },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      dimension_filter?: Record<string, string>
      dimension_resolutions?: Array<{ resolved_code: string; input: string }>
    }

    expect(mockTrialBalance).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', {
      dimensions: { '6': 'P001' },
    })
    expect(result.dimension_filter).toEqual({ '6': 'P001' })
    expect(result.dimension_resolutions).toHaveLength(1)
    expect(result.dimension_resolutions![0]).toMatchObject({
      input: 'villa almgren tak',
      resolved_code: 'P001',
    })
  })

  it('passes undefined options and omits echoes when no filter is given', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })
    mockTrialBalance.mockResolvedValueOnce({ rows: [], totalDebit: 0, totalCredit: 0 } as never)

    const result = (await trialBalance.execute(
      { period_id: 'fp-1' },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(mockTrialBalance).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', undefined)
    expect(result).not.toHaveProperty('dimension_filter')
    expect(result).not.toHaveProperty('dimension_resolutions')
    // Zero registry queries when nothing is tagged.
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('lets DimensionResolutionError propagate with the create-first hint', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })
    enqueueRegistry(enqueue)

    await expect(
      trialBalance.execute(
        { period_id: 'fp-1', dimensions: { '6': 'Bryggeriet ombyggnad' } },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/Okänt projekt[\s\S]*gnubok_create_dimension_value/)
    expect(mockTrialBalance).not.toHaveBeenCalled()
  })
})

describe('gnubok_get_income_statement: dimensions filter', () => {
  it('accepts an exact code without echoing resolutions', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null }) // period info
    enqueueRegistry(enqueue)
    mockIncomeStatement.mockResolvedValueOnce({ net_result: 42 } as never)

    const result = (await incomeStatement.execute(
      { period_id: 'fp-1', dimensions: { '6': 'P001' } },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      net_result: number
      period: { start: string; end: string }
      dimension_filter?: Record<string, string>
      dimension_resolutions?: unknown
    }

    expect(mockIncomeStatement).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', {
      dimensions: { '6': 'P001' },
    })
    expect(result.net_result).toBe(42)
    expect(result.period).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(result.dimension_filter).toEqual({ '6': 'P001' })
    // Exact code match is not a resolution: no echo.
    expect(result.dimension_resolutions).toBeUndefined()
  })
})

describe('gnubok_get_general_ledger: dimensions filter', () => {
  it('passes the bag through verbatim when dimensions_enabled is false (free-text passthrough)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { dimensions_enabled: false }, error: null }) // company_settings
    mockGeneralLedger.mockResolvedValueOnce({ accounts: [] } as never)

    const result = (await generalLedger.execute(
      { period_id: 'fp-1', dimensions: { '6': 'fritext-projekt' } },
      'company-1',
      'user-1',
      supabase as never,
    )) as { dimension_filter?: Record<string, string> }

    expect(mockGeneralLedger).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', undefined, undefined, {
      dimensions: { '6': 'fritext-projekt' },
    })
    expect(result.dimension_filter).toEqual({ '6': 'fritext-projekt' })
    // Disabled → no ensure RPC, no registry reads.
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
